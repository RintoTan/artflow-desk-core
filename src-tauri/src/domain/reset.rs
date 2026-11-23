//! DEV-0.1.1-04：数据重置。
//!
//! 规则来自 `docs/architecture/DATA-LIFECYCLE.md` §6，这里只做工程实现：
//!
//! - **业务数据包**走「新代际 + 选择性回填」，绝不逐表 DELETE；
//! - **用户设置**就地事务；
//! - 备份 / 提醒 / 日志 / 隔离区各自独立，永远不与前两项耦合；
//! - 不追求全局原子性，改为「逐项结果 + 准确报告」。
//!
//! 三条硬约束：
//!
//! 1. `highwater.sqlite` 永远不动——编号创建后不变、不复用；
//! 2. 业务数据重置前必须成功生成快照；若同时勾了「本地备份」，这份快照不参与清理；
//! 3. 业务数据失败时，**不切换 active 指针**，后续文件类操作全部跳过，
//!    避免出现「业务数据没清空、备份却已经被删掉」。

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::backup::{create as backup_create, state as backup_state};
use crate::error::{AppError, AppResult};
use crate::store::environment::{open_connection, validate, Environment};
use crate::store::highwater::HighWater;
use crate::store::migrations;
use crate::store::{generation, settings, timezone};

pub const OPT_BUSINESS: &str = "business";
pub const OPT_SETTINGS: &str = "settings";
pub const OPT_BACKUPS: &str = "backups";
pub const OPT_REMINDER: &str = "reminder";
pub const OPT_LOGS: &str = "logs";
pub const OPT_QUARANTINE: &str = "quarantine";

/// §6.2 的六项，顺序即 §7 的执行顺序。
pub const ORDER: [&str; 6] = [
    OPT_BUSINESS,
    OPT_SETTINGS,
    OPT_REMINDER,
    OPT_BACKUPS,
    OPT_LOGS,
    OPT_QUARANTINE,
];

/// 不进重置选项、也不允许被清理的环境文件（§6.5）。
const PROTECTED: [&str; 5] = [
    "environment.json",
    ".write.lock",
    "active.json",
    "highwater.sqlite",
    "recovery",
];

/// 重置时要恢复默认值的偏好键之外，属于系统状态、必须保留的键。
const KEEP_KEYS: [&str; 2] = ["defaults_seeded", "schema_version"];

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetInput {
    #[serde(default)]
    pub business: bool,
    #[serde(default)]
    pub settings: bool,
    #[serde(default)]
    pub backups: bool,
    #[serde(default)]
    pub reminder: bool,
    #[serde(default)]
    pub logs: bool,
    #[serde(default)]
    pub quarantine: bool,
    /// 仅重试这些项（失败重试入口）；为空表示按勾选执行。
    #[serde(default)]
    pub only: Vec<String>,
}

impl ResetInput {
    fn checked(&self) -> Vec<&'static str> {
        let mut picked = Vec::new();
        for (name, on) in [
            (OPT_BUSINESS, self.business),
            (OPT_SETTINGS, self.settings),
            (OPT_BACKUPS, self.backups),
            (OPT_REMINDER, self.reminder),
            (OPT_LOGS, self.logs),
            (OPT_QUARANTINE, self.quarantine),
        ] {
            if on {
                picked.push(name);
            }
        }
        picked
    }

    fn requested(&self) -> AppResult<Vec<&'static str>> {
        if self.only.is_empty() {
            let picked = self.checked();
            if picked.is_empty() {
                return Err(AppError::invalid("没有选择任何要重置的项目"));
            }
            return Ok(picked);
        }
        // 硬白名单：这些是环境自身的一部分，界面不展示，后端也必须拒绝。
        if let Some(bad) = self
            .only
            .iter()
            .find(|name| PROTECTED.contains(&name.as_str()))
        {
            return Err(AppError::invalid(format!(
                "{bad} 属于数据环境自身，不可重置"
            )));
        }
        let asked: BTreeSet<&str> = self.only.iter().map(|s| s.as_str()).collect();
        let mut picked = Vec::new();
        for name in ORDER {
            if asked.contains(name) {
                picked.push(name);
            }
        }
        if picked.is_empty() {
            return Err(AppError::invalid("没有选择任何要重置的项目"));
        }
        Ok(picked)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetItem {
    pub option: String,
    /// ok | failed | skipped
    pub status: String,
    pub reason: Option<String>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetReport {
    pub items: Vec<ResetItem>,
    /// all_ok | partial | all_failed
    pub overall: String,
    pub new_generation: Option<String>,
    pub old_generation: String,
    pub old_generation_path: String,
    pub old_generation_bytes: u64,
    /// 本次强制生成的安全快照（业务数据重置时）
    pub snapshot_path: Option<String>,
}

fn ok(name: &str, detail: Option<String>) -> ResetItem {
    ResetItem {
        option: name.into(),
        status: "ok".into(),
        reason: None,
        detail,
    }
}

fn failed(name: &str, reason: String) -> ResetItem {
    ResetItem {
        option: name.into(),
        status: "failed".into(),
        reason: Some(reason),
        detail: None,
    }
}

fn skipped(name: &str, reason: &str) -> ResetItem {
    ResetItem {
        option: name.into(),
        status: "skipped".into(),
        reason: Some(reason.into()),
        detail: None,
    }
}

/// 逻辑文件大小，不跟随符号链接（与 §9 的口径一致）。
fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let entries = match fs::read_dir(path) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let meta = match fs::symlink_metadata(&p) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.file_type().is_dir() {
            total += dir_size(&p);
        } else if meta.file_type().is_file() {
            total += meta.len();
        }
    }
    total
}

/// 逐项删除目录下的文件；只删普通文件，不跟随符号链接，缺文件不算失败。
fn clear_files(dir: &Path, keep: Option<&Path>) -> (usize, Vec<String>) {
    let mut removed = 0usize;
    let mut problems = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return (0, problems),
        Err(e) => return (0, vec![format!("{}：{}", dir.display(), e)]),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if let Some(keep) = keep {
            if path == keep {
                continue;
            }
        }
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(e) => {
                problems.push(format!("{}：{}", path.display(), e));
                continue;
            }
        };
        if meta.file_type().is_dir() {
            // 备份目录里可能有多层（分段包），但绝不越过 backups/ 这一层边界。
            match fs::remove_dir_all(&path) {
                Ok(()) => removed += 1,
                Err(e) => problems.push(format!("{}：{}", path.display(), e)),
            }
        } else if meta.file_type().is_file() {
            match fs::remove_file(&path) {
                Ok(()) => removed += 1,
                Err(e) => problems.push(format!("{}：{}", path.display(), e)),
            }
        }
    }
    (removed, problems)
}

struct Prefs {
    settings: Vec<(String, String)>,
    themes: Vec<(String, String, String, String, String)>,
}

fn read_prefs(conn: &Connection) -> AppResult<Prefs> {
    let mut stmt = conn.prepare("SELECT key, value FROM app_settings")?;
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    let kept: Vec<(String, String)> = rows
        .into_iter()
        .filter(|(k, _)| !KEEP_KEYS.contains(&k.as_str()))
        .collect();

    let mut theme_stmt = conn.prepare(
        "SELECT id, name, mode, tokens, created_at FROM themes WHERE builtin = 0 ORDER BY created_at",
    )?;
    let themes: Vec<(String, String, String, String, String)> = theme_stmt
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Prefs {
        settings: kept,
        themes,
    })
}

fn backfill(conn: &mut Connection, prefs: &Prefs, now: &str) -> AppResult<()> {
    let tx = conn.transaction()?;
    for (key, value) in &prefs.settings {
        tx.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now],
        )?;
    }
    for (id, name, mode, tokens, created_at) in &prefs.themes {
        tx.execute(
            "INSERT OR REPLACE INTO themes (id, name, mode, tokens, builtin, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)",
            params![id, name, mode, tokens, created_at, now],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// 就地重置用户设置与主题。
fn reset_settings_in_place(conn: &mut Connection, tz_name: &str, now: &str) -> AppResult<()> {
    let tx = conn.transaction()?;
    tx.execute(
        "DELETE FROM app_settings WHERE key NOT IN (?1, ?2)",
        params![KEEP_KEYS[0], KEEP_KEYS[1]],
    )?;
    for (key, value) in [
        (settings::KEY_WORKING_TIMEZONE, tz_name),
        (settings::KEY_LIST_DENSITY, "comfortable"),
        (settings::KEY_STARTUP_PAGE, "dashboard"),
        (settings::KEY_ACTIVE_LIGHT_THEME, settings::BUILTIN_THEME_ID),
        (settings::KEY_DEFAULTS_SEEDED, "1"),
    ] {
        tx.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now],
        )?;
    }
    // 自定义主题删除；内置主题保留（缺了则补回）。
    tx.execute("DELETE FROM themes WHERE builtin = 0", [])?;
    tx.execute(
        "INSERT OR IGNORE INTO themes (id, name, mode, tokens, builtin, created_at, updated_at)
         VALUES (?1, ?2, 'light', ?3, 1, ?4, ?4)",
        params![
            settings::BUILTIN_THEME_ID,
            "Arctic Blue 浅色",
            settings::BUILTIN_THEME_LIGHT,
            now
        ],
    )?;
    tx.commit()?;
    Ok(())
}

/// 业务数据包：快照 → 新代际 → 按需回填 → 校验 → 原子切指针。
fn reset_business(
    env: &Environment,
    highwater: &HighWater,
    reset_settings_too: bool,
    now: &str,
) -> AppResult<(String, PathBuf)> {
    let layout = env.layout();
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let snapshot = layout.backups_dir().join(format!("pre-reset-{stamp}.zip"));
    // 1) 先保护现有数据。
    backup_create::create(env, highwater, &snapshot)?;

    // 2) 读出偏好（是否回填由调用方决定）。
    let prefs = {
        let conn = env.open_db()?;
        read_prefs(&conn)?
    };

    // 3) 新代际：建库 → 迁移到最新 → 填默认 → 校验。
    let new_id = generation::new_generation_id();
    let dir = layout.generation_dir(&new_id);
    let tz = timezone::system_timezone();
    let built = (|| -> AppResult<String> {
        fs::create_dir_all(dir.join("attachments").join("originals"))?;
        fs::create_dir_all(dir.join("attachments").join("thumbs"))?;
        let db = layout.generation_db(&new_id);
        let mut conn = open_connection(&db)?;
        let version = migrations::migrate_to(&mut conn, &migrations::production(), migrations::APP_SCHEMA_VERSION)?;
        if version != migrations::APP_SCHEMA_VERSION {
            return Err(AppError::schema(format!(
                "新代际结构版本 v{version} 与预期 v{} 不符",
                migrations::APP_SCHEMA_VERSION
            )));
        }
        settings::seed_defaults_once(&mut conn, tz, now)?;
        // 4) 不勾「用户设置」时，把原偏好回填进来（§6.3）。
        if !reset_settings_too {
            backfill(&mut conn, &prefs, now)?;
        }
        // 5) 校验新库。
        validate(&conn)?;
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM app_settings", [], |r| r.get(0))?;
        if count == 0 {
            return Err(AppError::db("新代际缺少设置行"));
        }
        // 走可见视图读，别为这一条自检去开"裸表"的口子：
        // 新代际的可见与回收站两边都必须是 0。
        let visible: i64 =
            conn.query_row("SELECT COUNT(*) FROM orders_visible", [], |r| r.get(0))?;
        let trashed: i64 =
            conn.query_row("SELECT COUNT(*) FROM orders_trashed", [], |r| r.get(0))?;
        if visible != 0 || trashed != 0 {
            return Err(AppError::db("新代际不是空库，拒绝切换"));
        }
        Ok(new_id.clone())
    })();

    let new_id = match built {
        Ok(id) => id,
        Err(e) => {
            // 半成品代际必须清掉：留着会被当成"已存在的旧代际"。
            let _ = fs::remove_dir_all(&dir);
            return Err(e);
        }
    };

    // 6) 原子切换指针。失败则新旧都不动。
    if let Err(e) = generation::write_active(layout, &new_id, now) {
        let _ = fs::remove_dir_all(&dir);
        return Err(e);
    }
    Ok((new_id, snapshot))
}

/// 执行一次重置。`log_dir` 是 `app_data_dir/logs`——日志不在数据根里，必须由调用方给。
pub fn run(
    env: &Environment,
    highwater: &HighWater,
    log_dir: &Path,
    input: &ResetInput,
) -> AppResult<ResetReport> {
    let layout = env.layout();
    let now = timezone::now_timestamp();
    let old_generation = env.active_generation().to_string();
    let old_dir = layout.generation_dir(&old_generation);
    let old_bytes = dir_size(&old_dir);

    // 隔离区归属在开始执行时就锁定：业务数据重置会切代际，
    // 之后再读「活动代际」就变成新代际了，会静默漏掉用户要清理的那份。
    let quarantine_dir = layout.attachments_dir(&old_generation).join("quarantine");

    let targets = input.requested()?;
    let business = targets.contains(&OPT_BUSINESS);
    let settings_too = targets.contains(&OPT_SETTINGS);

    let mut items: Vec<ResetItem> = Vec::new();
    let mut snapshot_path: Option<PathBuf> = None;
    let mut new_generation: Option<String> = None;
    let mut abort_rest = false;

    for name in targets.iter().copied() {
        if abort_rest {
            items.push(skipped(
                name,
                "业务数据包重置失败，已中止后续文件操作",
            ));
            continue;
        }
        match name {
            OPT_BUSINESS => match reset_business(env, highwater, settings_too, &now) {
                Ok((gen, snap)) => {
                    snapshot_path = Some(snap);
                    new_generation = Some(gen.clone());
                    items.push(ok(
                        name,
                        Some(format!("已切换到新代际 {gen}（旧代际保留）")),
                    ));
                }
                Err(e) => {
                    items.push(failed(name, e.message.clone()));
                    abort_rest = true;
                }
            },
            OPT_SETTINGS => {
                // 两项都勾时不执行第二次：新代际 seed 出来的默认值就是结果。
                if business {
                    items.push(ok(name, Some("新代际已按默认值建立，不再重复重置".into())));
                } else {
                    match env.open_db().and_then(|mut conn| {
                        reset_settings_in_place(&mut conn, timezone::system_timezone().name(), &now)
                    }) {
                        Ok(()) => items.push(ok(name, Some("设置已恢复默认，自定义主题已删除".into()))),
                        Err(e) => items.push(failed(name, e.message.clone())),
                    }
                }
            }
            OPT_REMINDER => match reset_reminder(layout) {
                Ok(detail) => items.push(ok(name, Some(detail))),
                Err(e) => items.push(failed(name, e.message.clone())),
            },
            OPT_BACKUPS => {
                // 安全快照不参与清理：它是本次重置的兜底。
                let keep = snapshot_path.clone();
                let (removed, problems) = clear_files(&layout.backups_dir(), keep.as_deref());
                if problems.is_empty() {
                    let mut detail = format!("删除 {removed} 项");
                    if keep.is_some() {
                        detail.push_str("；本次安全快照已保留");
                    }
                    items.push(ok(name, Some(detail)));
                } else {
                    let mut reason = format!("{} 项未能删除：{}", problems.len(), problems.join("；"));
                    if removed > 0 {
                        reason.push_str(&format!("（已删除 {removed} 项）"));
                    }
                    items.push(failed(name, reason));
                }
            }
            OPT_LOGS => {
                let (removed, problems) = clear_files(log_dir, None);
                if problems.is_empty() {
                    items.push(ok(name, Some(format!("删除 {removed} 个日志文件"))));
                } else {
                    items.push(failed(name, problems.join("；")));
                }
            }
            OPT_QUARANTINE => {
                let (removed, problems) = clear_files(&quarantine_dir, None);
                if problems.is_empty() {
                    items.push(ok(
                        name,
                        Some(format!("清理 {removed} 个文件（代际 {old_generation}）")),
                    ));
                } else {
                    items.push(failed(name, problems.join("；")));
                }
            }
            _ => unreachable!("targets 只包含已登记项"),
        }
    }

    let ok_count = items.iter().filter(|i| i.status == "ok").count();
    let overall = if ok_count == items.len() {
        "all_ok"
    } else if ok_count == 0 {
        "all_failed"
    } else {
        "partial"
    };

    if new_generation.is_some() {
        // 指针已经切走，但本进程仍持有旧代际；必须重启才能继续使用。
        crate::infra::diag::log("reset", "业务数据已重置，等待重启应用");
    }

    Ok(ResetReport {
        items,
        overall: overall.into(),
        new_generation,
        old_generation,
        old_generation_path: old_dir.display().to_string(),
        old_generation_bytes: old_bytes,
        snapshot_path: snapshot_path.map(|p| p.display().to_string()),
    })
}

fn reset_reminder(layout: &crate::store::paths::Layout) -> AppResult<String> {
    let mut state = backup_state::load(layout);
    let kept = state.last_success_at.clone();
    state.reminder_days = 0;
    state.last_error = None;
    backup_state::save(layout, &state)?;
    Ok(match kept {
        Some(at) => format!("提醒已关闭；保留上次成功备份时间 {at}"),
        None => "提醒已关闭".into(),
    })
}
