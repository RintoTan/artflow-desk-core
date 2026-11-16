//! 生命周期事件写入与读取。
//!
//! 事件只能追加，不能被普通资料编辑覆盖。每个操作与订单更新在同一事务内完成。
//! `request_id` 作为幂等键：同一个请求重复提交只写一条事件。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::error::{AppError, AppResult};

pub const CREATED: &str = "created";
pub const WORK_STARTED: &str = "work_started";
pub const WORK_START_UNDONE: &str = "work_start_undone";
pub const STAGE_ADVANCED: &str = "stage_advanced";
pub const STAGE_REWORKED: &str = "stage_reworked";
pub const WORKFLOW_CHANGED: &str = "workflow_changed";
pub const COMPLETED: &str = "completed";
pub const CANCELLED: &str = "cancelled";
pub const REOPENED: &str = "reopened";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: i64,
    pub order_id: String,
    pub kind: String,
    pub from_stage_id: Option<String>,
    pub from_stage_title: Option<String>,
    pub to_stage_id: Option<String>,
    pub to_stage_title: Option<String>,
    pub from_status: Option<String>,
    pub to_status: Option<String>,
    pub movement: Option<String>,
    pub note: Option<String>,
    pub occurred_at: String,
}

#[derive(Debug, Default, Clone)]
pub struct NewEvent<'a> {
    pub kind: &'a str,
    pub from_stage_id: Option<&'a str>,
    pub from_stage_title: Option<&'a str>,
    pub to_stage_id: Option<&'a str>,
    pub to_stage_title: Option<&'a str>,
    pub from_status: Option<&'a str>,
    pub to_status: Option<&'a str>,
    pub movement: Option<&'a str>,
    pub note: Option<&'a str>,
    pub request_id: Option<&'a str>,
    pub occurred_at: &'a str,
}

pub fn append(tx: &Connection, order_id: &str, event: &NewEvent<'_>) -> AppResult<()> {
    tx.execute(
        "INSERT INTO order_events (
            order_id, kind, from_stage_id, from_stage_title, to_stage_id, to_stage_title,
            from_status, to_status, movement, note, request_id, occurred_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            order_id,
            event.kind,
            event.from_stage_id,
            event.from_stage_title,
            event.to_stage_id,
            event.to_stage_title,
            event.from_status,
            event.to_status,
            event.movement,
            event.note,
            event.request_id,
            event.occurred_at
        ],
    )?;
    Ok(())
}

/// 该请求是否已经成功执行过（用于"保存成功但响应丢失"后的重试）。
pub fn request_already_applied(tx: &Connection, order_id: &str, request_id: &str) -> AppResult<bool> {
    let found: Option<i64> = tx
        .query_row(
            "SELECT id FROM order_events WHERE order_id = ?1 AND request_id = ?2",
            params![order_id, request_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

pub fn list(conn: &Connection, order_id: &str) -> AppResult<Vec<Event>> {
    let mut stmt = conn.prepare(
        "SELECT id, order_id, kind, from_stage_id, from_stage_title,
                to_stage_id, to_stage_title, from_status, to_status,
                movement, note, occurred_at
         FROM order_events WHERE order_id = ?1 ORDER BY id",
    )?;
    let rows = stmt
        .query_map([order_id], |r| {
            Ok(Event {
                id: r.get(0)?,
                order_id: r.get(1)?,
                kind: r.get(2)?,
                from_stage_id: r.get(3)?,
                from_stage_title: r.get(4)?,
                to_stage_id: r.get(5)?,
                to_stage_title: r.get(6)?,
                from_status: r.get(7)?,
                to_status: r.get(8)?,
                movement: r.get(9)?,
                note: r.get(10)?,
                occurred_at: r.get(11)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 最近一次有效开工事件的 id（撤销开工的判定基准）。
pub fn last_work_started_id(conn: &Connection, order_id: &str) -> AppResult<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT MAX(id) FROM order_events WHERE order_id = ?1 AND kind = ?2",
            params![order_id, WORK_STARTED],
            |r| r.get::<_, Option<i64>>(0),
        )
        .optional()?
        .flatten())
}

/// 指定事件之后是否发生过阶段推进或返工。
pub fn stage_moved_after(conn: &Connection, order_id: &str, event_id: i64) -> AppResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM order_events
         WHERE order_id = ?1 AND id > ?2 AND kind IN (?3, ?4)",
        params![order_id, event_id, STAGE_ADVANCED, STAGE_REWORKED],
        |r| r.get(0),
    )?;
    Ok(count > 0)
}

pub fn require_known_kind(kind: &str) -> AppResult<()> {
    const ALL: &[&str] = &[
        CREATED,
        WORK_STARTED,
        WORK_START_UNDONE,
        STAGE_ADVANCED,
        STAGE_REWORKED,
        WORKFLOW_CHANGED,
        COMPLETED,
        CANCELLED,
        REOPENED,
    ];
    if ALL.contains(&kind) {
        Ok(())
    } else {
        Err(AppError::invalid(format!("未知的生命周期事件：{kind}")))
    }
}
