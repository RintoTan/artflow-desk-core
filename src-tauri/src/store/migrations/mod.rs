//! 可演进的 schema 迁移链。
//!
//! 规则：
//! - 版本号即 `PRAGMA user_version`，只增不减。
//! - 每一步在自己的 `BEGIN IMMEDIATE` 事务内执行，失败整步回滚。
//! - 数据库版本高于程序支持版本时拒绝写入（旧程序不得写新库）。
//! - 测试可用独立迁移表演练 v1 → v2；生产迁移表只含已批准版本。

use rusqlite::{Connection, TransactionBehavior};

use crate::error::{AppError, AppResult};

pub mod v1;
pub mod v2;
pub mod v3;
pub mod v4;
pub mod v5;
pub mod v6;
pub mod v7;
pub mod v8;
pub mod v9;
pub mod v10;
pub mod v11;

/// 当前程序支持的最高 schema 版本。
pub const APP_SCHEMA_VERSION: i64 = 11;

pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub apply: fn(&rusqlite::Transaction<'_>) -> AppResult<()>,
}

/// 已批准的正式迁移。顺序必须从 1 开始连续。
pub fn production() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            name: "v1_initial",
            apply: v1::apply,
        },
        Migration {
            version: 2,
            name: "v2_queue_and_events",
            apply: v2::apply,
        },
        Migration {
            version: 3,
            name: "v3_attachment_jobs",
            apply: v3::apply,
        },
        Migration {
            version: 4,
            name: "v4_source_and_gallery_and_tags",
            apply: v4::apply,
        },
        Migration {
            version: 5,
            name: "v5_gallery_visibility_trigger",
            apply: v5::apply,
        },
        Migration {
            version: 6,
            name: "v6_reschedule_events",
            apply: v6::apply,
        },
        Migration {
            version: 7,
            name: "v7_stage_skipped_events",
            apply: v7::apply,
        },
        Migration {
            version: 8,
            name: "v8_soft_delete_and_visibility_views",
            apply: v8::apply,
        },
        Migration {
            version: 9,
            name: "v9_order_archive",
            apply: v9::apply,
        },
        Migration {
            version: 10,
            name: "v10_finance",
            apply: v10::apply,
        },
        Migration {
            version: 11,
            name: "v11_finance_integrity",
            apply: v11::apply,
        },
    ]
}

pub fn schema_version(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))?)
}

/// 从当前版本迁移到 `target`。`list` 必须覆盖 `[1, target]`。
pub fn migrate_to(conn: &mut Connection, list: &[Migration], target: i64) -> AppResult<i64> {
    let current = schema_version(conn)?;
    if current > target {
        return Err(AppError::schema(format!(
            "数据库结构版本 {current} 高于本程序支持的 {target}：请使用较新版本的 ArtFlow Desk Core"
        )));
    }
    for step in 1..=target {
        if !list.iter().any(|m| m.version == step) {
            return Err(AppError::schema(format!("缺少 schema v{step} 的迁移定义")));
        }
    }

    for migration in list.iter().filter(|m| m.version > current && m.version <= target) {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        (migration.apply)(&tx)?;
        tx.pragma_update(None, "user_version", migration.version)?;
        tx.commit()?;
    }
    Ok(schema_version(conn)?)
}
