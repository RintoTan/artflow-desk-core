//! 数据环境的打开与自检。
//!
//! 关键约束（FIX-12）：**严格区分"真正首次启动"与"已有数据环境异常"**。
//! 只有当环境标记、代际目录、活动指针三者都不存在时才允许初始化空库。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono_tz::Tz;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::infra::lock::{canonical_root, DirLock};
use crate::store::generation;
use crate::store::migrations::{self, Migration};
use crate::store::paths::Layout;
use crate::store::settings;
use crate::store::timezone;

pub const APP_MARKER_FORMAT: i64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentMarker {
    pub app: String,
    pub format: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupOutcome {
    /// true = 本次是真正的首次启动并初始化了空库。
    pub first_run: bool,
    pub generation: String,
    pub schema_version: i64,
    /// 若本次发生了代际升级，记录升级前的 schema 版本。
    pub upgraded_from: Option<i64>,
    pub working_timezone: String,
}

pub struct Environment {
    layout: Layout,
    // 必须在整个进程生命周期内持有；drop 即释放跨进程锁。
    _lock: DirLock,
    active: String,
    outcome: StartupOutcome,
}

impl Environment {
    /// 生产入口：使用正式迁移表。
    pub fn open(root: &Path) -> AppResult<Self> {
        let migrations = migrations::production();
        Self::open_with(root, &migrations, migrations::APP_SCHEMA_VERSION, None)
    }

    /// 可注入迁移表与目标版本（测试用），便于演练 v1 → v2。
    pub fn open_with(
        root: &Path,
        migration_list: &[Migration],
        target_version: i64,
        tz_override: Option<Tz>,
    ) -> AppResult<Self> {
        let root = canonical_root(root)?;
        let lock = DirLock::acquire(&root)?;
        Self::assemble(root, lock, migration_list, target_version, tz_override)
    }

    /// 用调用方已经持有的锁打开环境。
    ///
    /// 迁移时先锁住目标根再切换指针，锁不能中途断掉——否则切换的那一瞬间
    /// 会有第二个进程从同一个根启动。
    pub fn open_with_lock(
        root: PathBuf,
        lock: crate::infra::lock::DirLock,
        migration_list: &[Migration],
        target_version: i64,
        tz_override: Option<Tz>,
    ) -> AppResult<Self> {
        Self::assemble(root, lock, migration_list, target_version, tz_override)
    }

    fn assemble(
        root: PathBuf,
        lock: crate::infra::lock::DirLock,
        migration_list: &[Migration],
        target_version: i64,
        tz_override: Option<Tz>,
    ) -> AppResult<Self> {
        let layout = Layout::new(root);

        let marker_exists = layout.marker().exists();
        let generations = generation::list_generations(&layout)?;
        let active = generation::read_active(&layout)?;
        let tz = tz_override.unwrap_or_else(timezone::system_timezone);
        let now = timezone::now_timestamp();

        let outcome = if !marker_exists && generations.is_empty() && active.is_none() {
            Self::initialize(&layout, migration_list, target_version, tz, &now)?
        } else {
            Self::resume(&layout, migration_list, target_version, &now)?
        };

        Ok(Self {
            layout,
            _lock: lock,
            active: outcome.generation.clone(),
            outcome,
        })
    }

    fn initialize(
        layout: &Layout,
        migration_list: &[Migration],
        target_version: i64,
        tz: Tz,
        now: &str,
    ) -> AppResult<StartupOutcome> {
        fs::create_dir_all(layout.generations_dir())?;
        fs::create_dir_all(layout.state_dir())?;
        fs::create_dir_all(layout.backups_dir())?;

        let id = generation::new_generation_id();
        let dir = layout.generation_dir(&id);
        fs::create_dir_all(dir.join("attachments").join("originals"))?;
        fs::create_dir_all(dir.join("attachments").join("thumbs"))?;

        let db_path = layout.generation_db(&id);
        let mut conn = open_connection(&db_path)?;
        let version = migrations::migrate_to(&mut conn, migration_list, target_version)?;
        settings::seed_defaults_once(&mut conn, tz, now)?;
        validate(&conn)?;
        drop(conn);

        // 编号记录属于"环境已建立"的组成部分：先于标记写入，避免出现
        // "有环境但无编号记录"的半成品状态。
        crate::store::highwater::HighWater::open(&layout.highwater_db())?;

        generation::write_json_atomic(
            &layout.marker(),
            &EnvironmentMarker {
                app: "artflow-minidesk".into(),
                format: APP_MARKER_FORMAT,
                created_at: now.into(),
            },
        )?;
        generation::write_active(layout, &id, now)?;

        Ok(StartupOutcome {
            first_run: true,
            generation: id,
            schema_version: version,
            upgraded_from: None,
            working_timezone: tz.name().to_string(),
        })
    }

    fn resume(
        layout: &Layout,
        migration_list: &[Migration],
        target_version: i64,
        now: &str,
    ) -> AppResult<StartupOutcome> {
        let active = generation::read_active(layout)?.ok_or_else(|| {
            AppError::env(
                "数据环境异常：存在数据代际但缺少活动指针。已停止，不会自动创建空数据库。\
                 请检查数据目录或从备份恢复。",
            )
        })?;

        if !layout.marker().exists() {
            return Err(AppError::env(
                "数据环境不完整：缺少环境标记文件。已停止，不会覆盖既有数据。",
            ));
        }
        let gen_dir = layout.generation_dir(&active.generation);
        if !gen_dir.is_dir() {
            return Err(AppError::env(format!(
                "活动数据代际 {} 的目录不存在，已停止。",
                active.generation
            )));
        }
        let db_path = layout.generation_db(&active.generation);
        if !db_path.exists() {
            return Err(AppError::env(
                "活动代数据库文件缺失，已停止，不会自动创建空数据库。",
            ));
        }

        let conn = open_connection(&db_path)?;
        validate(&conn)?;
        let current = migrations::schema_version(&conn)?;

        if current > target_version {
            return Err(AppError::schema(format!(
                "数据库结构版本 {current} 高于本程序支持的 {target_version}：\
                 请使用较新版本的 ArtFlow Desk Core，旧版本不会写入新结构。"
            )));
        }

        let upgraded_from = if current < target_version {
            Some(Self::upgrade_generation(
                layout,
                &active.generation,
                migration_list,
                target_version,
                now,
            )?)
        } else {
            None
        };

        let active_id = generation::read_active(layout)?
            .map(|p| p.generation)
            .unwrap_or_else(|| active.generation.clone());

        let mut conn = open_connection(&layout.generation_db(&active_id))?;
        let tz = settings::working_timezone(&conn)?;
        settings::seed_defaults_once(&mut conn, tz, now)?;
        validate(&conn)?;
        let version = migrations::schema_version(&conn)?;

        Ok(StartupOutcome {
            first_run: false,
            generation: active_id,
            schema_version: version,
            upgraded_from,
            working_timezone: tz.name().to_string(),
        })
    }

    /// 在**隔离的新代际**里升级：复制 → 迁移 → 校验 → 原子切换指针。
    /// 任何一步失败都删除新代际并保持旧代际可用。
    fn upgrade_generation(
        layout: &Layout,
        previous: &str,
        migration_list: &[Migration],
        target_version: i64,
        now: &str,
    ) -> AppResult<i64> {
        let new_id = generation::new_generation_id();
        let target_dir = layout.generation_dir(&new_id);

        let result = (|| -> AppResult<i64> {
            fs::create_dir_all(target_dir.join("attachments").join("originals"))?;
            fs::create_dir_all(target_dir.join("attachments").join("thumbs"))?;

            let source = open_connection(&layout.generation_db(previous))?;
            let from = migrations::schema_version(&source)?;
            let target_db = layout.generation_db(&new_id);
            source.execute(
                "VACUUM INTO ?1",
                [target_db.to_string_lossy().to_string()],
            )?;
            drop(source);

            copy_dir(
                &layout.attachments_dir(previous),
                &layout.attachments_dir(&new_id),
            )?;

            let mut conn = open_connection(&target_db)?;
            migrations::migrate_to(&mut conn, migration_list, target_version)?;
            validate(&conn)?;
            let reached = migrations::schema_version(&conn)?;
            if reached != target_version {
                return Err(AppError::schema(format!(
                    "升级后结构版本为 {reached}，期望 {target_version}"
                )));
            }
            drop(conn);

            generation::write_json_atomic(
                &layout.recovery_state(),
                &generation::RecoveryState {
                    phase: "upgrade".into(),
                    previous_generation: previous.to_string(),
                    target_generation: new_id.clone(),
                    reason: format!("schema v{from} → v{target_version}"),
                    written_at: now.to_string(),
                },
            )?;
            generation::write_active(layout, &new_id, now)?;
            generation::clear_recovery_state(layout)?;
            Ok(from)
        })();

        match result {
            Ok(from) => Ok(from),
            Err(e) => {
                let _ = fs::remove_dir_all(&target_dir);
                // 指针未被切换，旧代际仍在服务。
                let _ = generation::clear_recovery_state(layout);
                Err(e)
            }
        }
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    pub fn active_generation(&self) -> &str {
        &self.active
    }

    pub fn outcome(&self) -> &StartupOutcome {
        &self.outcome
    }

    pub fn root(&self) -> &Path {
        self.layout.root()
    }

    /// 校验跨进程锁仍然有效（锁文件未被替换）。
    pub fn lock_verify(&self) -> AppResult<()> {
        self._lock.verify()
    }

    pub fn db_path(&self) -> PathBuf {
        self.layout.generation_db(&self.active)
    }

    pub fn open_db(&self) -> AppResult<Connection> {
        open_connection(&self.db_path())
    }
}

pub fn open_connection(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "wal")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

/// 结构完整性 + 引用完整性。
pub fn validate(conn: &Connection) -> AppResult<()> {
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if integrity != "ok" {
        return Err(AppError::db(format!("数据库完整性检查失败：{integrity}")));
    }
    let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
    let mut rows = stmt.query([])?;
    if let Some(row) = rows.next()? {
        let table: String = row.get(0)?;
        return Err(AppError::db(format!("数据引用不完整：表 {table} 存在孤立引用")));
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> AppResult<()> {
    if !from.exists() {
        return Ok(());
    }
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)?.flatten() {
        let target = to.join(entry.file_name());
        let meta = fs::symlink_metadata(entry.path())?;
        if meta.file_type().is_symlink() {
            // 不跟随符号链接，避免把外部文件拖进新代际。
            continue;
        }
        if meta.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if meta.is_file() {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}
