//! 只读诊断查询。集中放在 store 层，命令层不写 SQL。

use rusqlite::Connection;
use serde::Serialize;

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DataCounts {
    pub orders: i64,
    pub clients: i64,
    pub templates: i64,
    pub attachments: i64,
    pub pending_cleanup: i64,
    pub events: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbFacts {
    pub sqlite_version: String,
    pub journal_mode: String,
    pub user_version: i64,
    pub integrity: String,
    pub counts: DataCounts,
}

pub fn facts(conn: &Connection) -> AppResult<DbFacts> {
    let sqlite_version = conn.query_row("SELECT sqlite_version()", [], |r| r.get(0))?;
    let journal_mode = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
    let user_version = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let integrity = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;

    Ok(DbFacts {
        sqlite_version,
        journal_mode,
        user_version,
        integrity,
        counts: counts(conn)?,
    })
}

pub fn counts(conn: &Connection) -> AppResult<DataCounts> {
    Ok(DataCounts {
        orders: scalar(conn, "SELECT COUNT(*) FROM orders")?,
        clients: scalar(conn, "SELECT COUNT(*) FROM clients")?,
        templates: scalar(conn, "SELECT COUNT(*) FROM stage_templates")?,
        attachments: scalar(conn, "SELECT COUNT(*) FROM attachments")?,
        pending_cleanup: scalar(
            conn,
            "SELECT COUNT(*) FROM cleanup_tasks WHERE state = 'pending'",
        )?,
        events: scalar(conn, "SELECT COUNT(*) FROM order_events")?,
    })
}

fn scalar(conn: &Connection, sql: &str) -> AppResult<i64> {
    Ok(conn.query_row(sql, [], |r| r.get(0))?)
}
