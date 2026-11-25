//! 从备份包恢复：全程在**隔离的新代际**里完成，验证通过才切换指针。
//!
//! 顺序是刻意的：先给当前数据做安全快照 → 解包到新代际 → 校验/迁移/引用核对
//! → 合并高水位 → 原子切换。任何一步失败，旧的 active 代际一字不动。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::backup::create;
use crate::backup::finance_guard;
use crate::backup::manifest::DataSummary;
use crate::backup::zip_read::{self, Manifest};
use crate::error::{AppError, AppResult};
use crate::store::environment::{open_connection, Environment};
use crate::store::generation;
use crate::store::highwater::{HighWater, YearWatermark};
use crate::store::migrations::{self, Migration};
use crate::store::settings;
use crate::store::timezone;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub path: String,
    pub format_version: u32,
    pub app_version: String,
    pub schema_version: i64,
    pub created_at: String,
    pub working_timezone: String,
    pub source_generation_id: Option<String>,
    pub files: usize,
    pub attachment_files: usize,
    pub bytes: u64,
    /// 与当前程序的关系：`current` / `older`（可在隔离代际内迁移）/ `newer`（拒绝）
    pub schema_relation: String,
    pub summary: DataSummary,
    /// FIN-07：这次恢复会「补什么、不补什么」必须提前讲清楚。
    /// 旧备份缺平台表时的平台回填、缺退款表时的空表说明都在这里，界面原样展示。
    pub warnings: Vec<String>,
    pub can_restore: bool,
    pub block_reason: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    pub new_generation: String,
    pub previous_generation: String,
    pub migrated_from: i64,
    pub schema_version: i64,
    pub summary: DataSummary,
    pub raised_watermarks: Vec<YearWatermark>,
    pub missing_thumbs: usize,
    pub cleanup_tasks_retargeted: usize,
    pub stale_jobs_closed: usize,
    pub pre_restore_backup: Option<String>,
    /// 兼容性提示：旧备份缺字段时说明改用了什么，界面原样展示。
    pub warnings: Vec<String>,
}

/// 只读预览：完整校验（路径/大小/SHA-256/manifest）后再给用户看摘要。
pub fn preview(env: &Environment, path: &Path) -> AppResult<Preview> {
    let inspection = zip_read::inspect(path)?;
    let manifest = inspection.manifest.clone();
    let source_generation = source_generation_of(&manifest);
    let current = env.outcome().schema_version;

    let (relation, mut block) = if manifest.schema_version > current {
        (
            "newer".to_string(),
            Some(format!(
                "备份的结构版本 v{} 高于本程序支持的 v{current}，请先升级应用",
                manifest.schema_version
            )),
        )
    } else if manifest.schema_version < 1 {
        ("older".to_string(), Some("备份缺少有效的结构版本".to_string()))
    } else {
        (
            if manifest.schema_version == current {
                "current".to_string()
            } else {
                "older".to_string()
            },
            None,
        )
    };

    // 摘要靠临时解出数据库来读；解到系统临时目录，不碰数据根。
    // 同一份临时库顺带判一次财务结构：版本号与表结构对不上要在预览阶段就拦住，
    // 不能等用户点了「确认恢复」才在隔离代际里失败。
    let (summary, finance_tables, v10_block) = {
        let temp = std::env::temp_dir().join(format!("artflow-preview-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&temp)?;
        let db = temp.join("preview.sqlite");
        let read = extract_entry(path, zip_read::DATABASE_NAME, &db).and_then(|_| {
            let conn = open_connection(&db)?;
            let summary = crate::backup::manifest::summarize(&conn)?;
            let tables = finance_guard::inspect(&conn)?;
            // v10 的升级前提与恢复入口共用同一个谓词，两处不会各自漂移。
            let v10_block = finance_guard::v10_blocker(manifest.schema_version, &conn)?;
            Ok((summary, tables, v10_block))
        });
        let _ = fs::remove_dir_all(&temp);
        read?
    };

    if block.is_none() {
        if let Err(e) = finance_guard::check_consistency(manifest.schema_version, &finance_tables) {
            block = Some(e.message);
        }
    }
    // 结构自洽之后才谈升级路径：缺表 / 版本对不上是另一类问题，先报那个更准确。
    if block.is_none() {
        block = v10_block;
    }

    let mut warnings = inspection.warnings.clone();
    if block.is_none() {
        if !finance_tables.platforms {
            // 规则 B：备份里就没有平台表，恢复后将保留本机配置。数量取当前代际，
            // 但**不能**把本机数量写成备份的数量——摘要里的 0 是备份的事实。
            let current_platforms = finance_guard::read_platforms(&env.open_db()?)?;
            warnings.push(format!(
                "该备份早于收款平台配置功能（包内没有平台表）。恢复后将保留当前设备的 {} 个平台配置：ID、名称、费率、归档状态、排序与创建时间原样，更新时间记为恢复时刻。",
                current_platforms.len()
            ));
        }
        if !finance_tables.records {
            warnings.push(
                "该备份早于财务模块（包内没有付款计划、收款流水与退款记录）。升级后这三张表为空，不会为旧订单生成任何记录。"
                    .to_string(),
            );
        } else if !finance_tables.refunds {
            warnings.push(
                "该备份版本尚未包含退款记录结构。升级后会创建空表，不会自动生成退款记录。"
                    .to_string(),
            );
        }
    }

    Ok(Preview {
        path: path.to_string_lossy().to_string(),
        format_version: manifest.format_version,
        app_version: manifest.app_version,
        schema_version: manifest.schema_version,
        created_at: manifest.created_at,
        working_timezone: manifest
            .working_timezone
            .clone()
            .unwrap_or_else(|| "（备份未记录，恢复后使用当前设备时区）".to_string()),
        source_generation_id: source_generation,
        files: manifest.total_files,
        attachment_files: inspection.attachment_files,
        bytes: manifest.total_bytes,
        schema_relation: relation,
        summary,
        warnings,
        can_restore: block.is_none(),
        block_reason: block,
    })
}

/// 包里没有显式的 generation 字段（格式 v1），从文件名推不出就别猜。
fn source_generation_of(manifest: &Manifest) -> Option<String> {
    manifest
        .files
        .iter()
        .find(|f| f.path.starts_with("generations/"))
        .map(|f| f.path.clone())
}

fn extract_entry(zip_path: &Path, name: &str, dest: &Path) -> AppResult<()> {
    let file = fs::File::open(zip_path)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| AppError::zip(format!("ZIP 解析失败：{e}")))?;
    let mut entry = archive
        .by_name(name)
        .map_err(|_| AppError::zip(format!("备份包缺少 {name}")))?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut out = fs::File::create(dest)?;
    std::io::copy(&mut entry, &mut out)?;
    out.flush()?;
    Ok(())
}

/// 把整包解到 `dest`（新代际根），逐条复用读取侧的路径规则。
fn extract_all(zip_path: &Path, dest: &Path) -> AppResult<(usize, usize)> {
    let file = fs::File::open(zip_path)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| AppError::zip(format!("ZIP 解析失败：{e}")))?;
    let mut attachment_files = 0usize;
    let total = archive.len();
    for i in 0..total {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::zip(format!("读取条目失败：{e}")))?;
        let name = entry
            .name()
            .map_err(|e| AppError::zip(format!("条目名非法：{e}")))?
            .to_string();
        if name == zip_read::MANIFEST_NAME {
            continue;
        }
        if let Some(reason) = zip_read::reject_reason(&name) {
            return Err(AppError::zip(format!("备份包路径不安全（{reason}）：{name}")));
        }
        let mut target = dest.to_path_buf();
        for segment in name.split('/') {
            target.push(segment);
        }
        if !target.starts_with(dest) {
            return Err(AppError::zip("解包路径越界，已终止"));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut out = fs::File::create(&target)?;
        let mut buffer = vec![0u8; 128 * 1024];
        let mut written = 0u64;
        loop {
            let read = entry
                .read(&mut buffer)
                .map_err(|e| AppError::zip(format!("解包失败：{e}")))?;
            if read == 0 {
                break;
            }
            out.write_all(&buffer[..read])?;
            written += read as u64;
        }
        if written != entry.size() {
            return Err(AppError::zip(format!("解包字节数不符：{name}")));
        }
        if name.starts_with("attachments/originals/") {
            attachment_files += 1;
        }
    }
    Ok((total, attachment_files))
}

/// 恢复前安全快照：必须成功，否则整个恢复取消。
fn pre_restore_snapshot(
    env: &Environment,
    highwater: &HighWater,
    now_local: &chrono::DateTime<chrono::Local>,
) -> AppResult<PathBuf> {
    let layout = env.layout();
    let stamp = now_local.format("%Y%m%d-%H%M%S");
    let target = layout
        .backups_dir()
        .join(format!("pre-restore-{stamp}.zip"));
    create::create(env, highwater, &target)?;
    Ok(target)
}

pub fn restore(
    env: &Environment,
    highwater: &HighWater,
    path: &Path,
    migration_list: &[Migration],
) -> AppResult<Restored> {
    let inspection = zip_read::inspect(path)?;
    let manifest = inspection.manifest.clone();
    let target_version = migrations::APP_SCHEMA_VERSION;

    if manifest.schema_version > target_version {
        return Err(AppError::schema(format!(
            "备份结构版本 v{} 高于本程序支持的 v{target_version}",
            manifest.schema_version
        )));
    }

    let layout = env.layout();
    let previous = env.active_generation().to_string();

    // 1) 先保护现有数据。失败即取消。
    let now_local = chrono::Local::now();
    let snapshot = pre_restore_snapshot(env, highwater, &now_local)?;

    let now = timezone::now_timestamp();
    let new_id = generation::new_generation_id();
    let target_dir = layout.generation_dir(&new_id);
    fs::create_dir_all(target_dir.join("attachments").join("originals"))?;
    fs::create_dir_all(target_dir.join("attachments").join("thumbs"))?;

    let result = (|| -> AppResult<Restored> {
        // 2) 解包到新代际。
        let (_, _attachments) = extract_all(path, &target_dir)?;

        // 3) 数据库体检：能打开、结构完整、外键自洽。
        let db = layout.generation_db(&new_id);
        if !db.exists() {
            return Err(AppError::zip("备份包缺少 database.sqlite"));
        }
        let mut conn = open_connection(&db)?;
        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if integrity != "ok" {
            return Err(AppError::zip(format!("备份数据库校验失败：{integrity}")));
        }
        let fk_violations: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_foreign_key_check",
            [],
            |r| r.get(0),
        )?;
        if fk_violations > 0 {
            return Err(AppError::zip(format!(
                "备份数据库存在 {fk_violations} 处外键冲突，拒绝恢复"
            )));
        }

        // 4) 只走已测试的迁移链，不改版本号伪装兼容。
        let from = migrations::schema_version(&conn)?;

        // 4.0) manifest 声明的版本必须与库里写的一致。
        //      后面所有结构判断都以这个版本号为准；对不上就说明包被改过或拼错了，
        //      此时继续猜下去只会得到一份「看起来恢复成功」的错库。
        if from != manifest.schema_version {
            return Err(AppError::schema(format!(
                "备份 manifest 声明 schema v{}，库内实际为 v{from}：版本号与数据库不一致，拒绝恢复。",
                manifest.schema_version
            )));
        }

        // 4.1) 版本号与实际结构必须自洽。
        //      旧备份可能来自不同的 schema 血统：user_version 写着 2，库里却没有
        //      v1 就该建出来的表。迁移只补「更高版本」，这些表会永远缺失，
        //      最后只报一句没上下文的 "no such table"。
        //      在迁移前判出来，给出可执行的结论。
        if from > 1 {
            let required = ["orders", "clients", "order_events", "app_settings"];
            let mut missing: Vec<&str> = Vec::new();
            for table in required {
                let exists: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |r| r.get(0),
                )?;
                if exists == 0 {
                    missing.push(table);
                }
            }
            if !missing.is_empty() {
                return Err(AppError::schema(format!(
                    "备份自称 schema v{from}，但缺少 {} 张基础表（{}）。                     这个文件来自与本程序不兼容的旧结构，无法通过自动迁移恢复；                     请保留原文件，待人工导入。",
                    missing.len(),
                    missing.join("、")
                )));
            }
        }
        // 4.2) 财务结构也必须在迁移**之前**判定。
        //      迁移会把缺的表建出来；事后再问「这份备份有没有平台表」,
        //      答案永远是「有」，规则 B 就再也不会触发。
        let backup_tables = finance_guard::inspect(&conn)?;
        finance_guard::check_consistency(from, &backup_tables)?;
        // 与预览同一个谓词：绕过界面直接调用恢复命令，也必须在这里被拦住。
        if let Some(reason) = finance_guard::v10_blocker(from, &conn)? {
            return Err(AppError::schema(reason));
        }
        let platforms_before = finance_guard::count_table(&conn, "payment_platforms")?;
        let ledger_before = finance_guard::ledger_counts(&conn)?;
        // 规则 B：只有「备份原本就没有平台表」才回填本机配置。
        // 读的是恢复前的活动代际，绝不是正在构建的新代际。
        let carried_platforms = if backup_tables.platforms {
            None
        } else {
            let current = open_connection(&layout.generation_db(&previous))?;
            Some(finance_guard::read_platforms(&current)?)
        };

        if from != target_version {
            migrations::migrate_to(&mut conn, migration_list, target_version)?;
        }
        let reached = migrations::schema_version(&conn)?;
        if reached != target_version {
            return Err(AppError::schema(format!(
                "恢复后结构版本为 v{reached}，期望 v{target_version}"
            )));
        }

        // 4.3) 迁移产物必须齐全：四张财务表 + 12 条约束触发器。
        finance_guard::require_complete_v12(&conn)?;

        // 4.4) 回填平台（仅规则 B）。冲突即整体失败，不用 OR IGNORE 咽下去。
        if let Some(rows) = &carried_platforms {
            finance_guard::backfill_platforms(&mut conn, rows, &now)?;
        }

        // 4.5) 业务历史一行都不许凭空出现，也不许在迁移里丢掉。
        let ledger_after = finance_guard::ledger_counts(&conn)?;
        if ledger_after != ledger_before {
            return Err(AppError::schema(format!(
                "财务记录数量在迁移中发生变化（迁移前 计划/收款/退款 = {}/{}/{}，迁移后 = {}/{}/{}），拒绝切换",
                ledger_before[0],
                ledger_before[1],
                ledger_before[2],
                ledger_after[0],
                ledger_after[1],
                ledger_after[2]
            )));
        }
        let platforms_after = finance_guard::count_table(&conn, "payment_platforms")?;
        let platforms_expected = match &carried_platforms {
            Some(rows) => rows.len() as i64,
            None => platforms_before,
        };
        if platforms_after != platforms_expected {
            return Err(AppError::schema(format!(
                "平台配置数量不符：期望 {platforms_expected} 个，实际 {platforms_after} 个，拒绝切换"
            )));
        }

        crate::store::environment::validate(&conn)?;

        // 5) 附件引用核对：原图必须有，缩略图可重建。
        let mut missing_originals: Vec<String> = Vec::new();
        let mut missing_thumbs = 0usize;
        {
            let mut stmt = conn.prepare(
                "SELECT rel_path, thumb_rel_path FROM attachments
                 WHERE state = 'ok' ORDER BY rel_path",
            )?;
            let rows: Vec<(String, Option<String>)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()?;
            for (rel, thumb) in rows {
                let abs = target_dir.join(&rel);
                if !abs.is_file() {
                    missing_originals.push(rel.clone());
                }
                if let Some(thumb_rel) = thumb {
                    if !target_dir.join(&thumb_rel).is_file() {
                        missing_thumbs += 1;
                    }
                }
            }
        }
        if !missing_originals.is_empty() {
            return Err(AppError::zip(format!(
                "备份包缺少 {} 个原图（例：{}），拒绝不完整恢复",
                missing_originals.len(),
                missing_originals
                    .iter()
                    .take(3)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("、")
            )));
        }

        // 6) 清理任务与作业：代际必须指向新代际，否则永远无法执行。
        let retargeted = conn.execute(
            "UPDATE cleanup_tasks SET generation = ?1
             WHERE state = 'pending' AND generation <> ?1
               AND rel_path LIKE 'attachments/%'",
            [&new_id],
        )?;
        let stale_jobs = conn.execute(
            "UPDATE attachment_jobs SET state = 'failed',
                    note = '恢复后失效：任务来自旧代际', updated_at = ?1
             WHERE state = 'pending' AND generation <> ?2",
            rusqlite::params![now, new_id],
        )?;

        // 7) 工作时区：新备份随包走；旧备份没记录时用当前设备系统时区。
        //    只影响「本地日期怎么解释」，不动任何历史日期与时间戳。
        let declared_tz = manifest
            .working_timezone
            .as_deref()
            .map(str::trim)
            .unwrap_or("");
        let tz_fallback = declared_tz.is_empty();
        let used_tz = if tz_fallback {
            crate::store::timezone::system_timezone().name().to_string()
        } else {
            declared_tz.to_string()
        };
        if let Err(e) = settings::set_working_timezone(&conn, &used_tz, &now) {
            return Err(AppError::env(format!(
                "备份里的工作时区「{}」不可用：{}",
                used_tz, e
            )));
        }
        let summary = crate::backup::manifest::summarize(&conn)?;
        let rebuilt_watermarks = if manifest.number_high_water.is_empty() {
            rebuild_watermarks(&conn)?
        } else {
            Vec::new()
        };

        let mut warnings: Vec<String> = Vec::new();
        if tz_fallback {
            warnings.push(format!(
                "此备份未记录工作时区，已改用当前设备时区「{used_tz}」。历史日期归属可能与原设备存在差异。"
            ));
        }
        if !rebuilt_watermarks.is_empty() {
            warnings.push(
                "此备份未记录编号高水位，已按库内已有编号重建。历史上已永久删除的编号无法还原。"
                    .to_string(),
            );
        }
        // 财务侧的兼容提示必须与预览说同一件事：用户在预览里看到的承诺，
        // 恢复结果里要能对得上账。
        if let Some(rows) = &carried_platforms {
            warnings.push(format!(
                "该备份不含收款平台配置，已保留当前设备的 {} 个平台：ID、名称、费率、归档状态、排序与创建时间原样，更新时间记为本次恢复时刻。",
                rows.len()
            ));
        }
        if !backup_tables.records {
            warnings.push(
                "该备份早于财务模块，升级后付款计划、收款流水与退款记录为空；没有为旧订单生成任何记录。"
                    .to_string(),
            );
        } else if !backup_tables.refunds {
            warnings.push(
                "该备份版本尚未包含退款记录结构，升级后已创建空表；没有自动生成退款记录。"
                    .to_string(),
            );
        }
        drop(conn);

        // 8) 编号高水位逐年取大，绝不下降。
        //    旧备份没有这一项：按库里已有编号重建，避免恢复后新建订单撞号。
        //    历史上永久删除的编号无法还原——这一点在 warnings 里明说，不假装完整。
        let rebuilt = manifest.number_high_water.is_empty();
        let incoming: Vec<YearWatermark> = if rebuilt {
            rebuilt_watermarks
        } else {
            manifest
                .number_high_water
                .iter()
                .map(|w| YearWatermark {
                    year: w.year,
                    last_allocated: w.last_allocated,
                })
                .collect()
        };
        let raised = highwater.merge(&incoming)?;

        // 9) 记录事务状态 → 原子切换 → 清除。
        generation::write_json_atomic(
            &layout.recovery_state(),
            &generation::RecoveryState {
                phase: "restore".into(),
                previous_generation: previous.clone(),
                target_generation: new_id.clone(),
                reason: format!(
                    "从备份恢复：schema v{} → v{target_version}，格式 v{}",
                    manifest.schema_version, manifest.format_version
                ),
                written_at: now.clone(),
            },
        )?;
        generation::write_active(layout, &new_id, &now)?;
        generation::clear_recovery_state(layout)?;

        Ok(Restored {
            new_generation: new_id.clone(),
            previous_generation: previous.clone(),
            migrated_from: from,
            schema_version: target_version,
            summary,
            raised_watermarks: raised,
            missing_thumbs,
            cleanup_tasks_retargeted: retargeted,
            stale_jobs_closed: stale_jobs,
            pre_restore_backup: Some(snapshot.to_string_lossy().to_string()),
            warnings,
        })
    })();

    match result {
        Ok(done) => Ok(done),
        Err(e) => {
            // 不删可能的诊断数据：整体挪到 recovery/ 下，绝不留在 generations/ 里冒充代际。
            let quarantine = layout.recovery_dir().join(format!(
                "failed-restore-{}-{}",
                now_local.format("%Y%m%d-%H%M%S"),
                &new_id.trim_start_matches("gen-")[..8.min(new_id.len() - 4)]
            ));
            if target_dir.exists() {
                let _ = fs::create_dir_all(layout.recovery_dir());
                let _ = fs::rename(&target_dir, &quarantine);
            }
            let _ = generation::clear_recovery_state(layout);
            Err(e)
        }
    }
}

/// 按库内已有订单编号重建编号高水位。
///
/// 用基表而不是 `orders_visible`：回收站里的订单仍然占着编号，
/// 恢复后一旦把它们永久删除，编号也不能被重新发出。
/// 历史永久删除的编号在这张表里已经没有痕迹，因此重建只能保证
/// 「不比现状更小」，不能保证与原设备完全一致——调用方必须把这一点写进 warnings。
fn rebuild_watermarks(conn: &rusqlite::Connection) -> AppResult<Vec<YearWatermark>> {
    let mut stmt = conn.prepare("SELECT code FROM orders")?;
    let mut per_year: std::collections::BTreeMap<i32, i64> = std::collections::BTreeMap::new();
    let codes = stmt.query_map([], |r| r.get::<_, String>(0))?;
    for code in codes {
        let code = code?;
        // 形如 AF-2026-0042
        let mut parts = code.split('-');
        let (Some(_prefix), Some(year), Some(serial)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let (Ok(year), Ok(serial)) = (year.parse::<i32>(), serial.parse::<i64>()) else {
            continue;
        };
        let slot = per_year.entry(year).or_insert(0);
        if serial > *slot {
            *slot = serial;
        }
    }
    Ok(per_year
        .into_iter()
        .map(|(year, last_allocated)| YearWatermark {
            year,
            last_allocated,
        })
        .collect())
}
