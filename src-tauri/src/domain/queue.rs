//! 活动队列：插入位置、上移/下移、拖拽重排。
//!
//! 队列顺序与订单展示编号完全无关。重排只改 `queue_position` 与
//! `queue_state.revision`，**不 bump 订单自身的 revision**，
//! 因此排序不会让无关订单的资料编辑变成冲突。

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::domain::lifecycle::{self, WorkState};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub order_id: String,
    pub code: String,
    pub title: String,
    pub queue_position: i64,
    pub work_state: WorkState,
    pub current_stage_title: Option<String>,
    pub client_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshot {
    pub revision: i64,
    pub entries: Vec<QueueEntry>,
}

pub fn revision(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row("SELECT revision FROM queue_state WHERE id = 1", [], |r| {
        r.get(0)
    })?)
}

pub fn list(conn: &Connection) -> AppResult<Vec<QueueEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM orders WHERE status = 'active' ORDER BY queue_position, code",
    )?;
    let ids: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);

    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let facts = lifecycle::load_facts(conn, &id)?;
        let (code, title, position, client_name) = conn.query_row(
            "SELECT o.code, o.title, o.queue_position, c.display_name
             FROM orders o LEFT JOIN clients c ON c.id = o.client_id
             WHERE o.id = ?1",
            [&id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            },
        )?;
        out.push(QueueEntry {
            order_id: id.clone(),
            code,
            title,
            queue_position: position,
            work_state: lifecycle::work_state(&facts),
            current_stage_title: facts
                .current_index
                .and_then(|i| facts.stages.get(i))
                .map(|(_, t)| t.clone()),
            client_name,
        });
    }
    Ok(out)
}

pub fn snapshot(conn: &Connection) -> AppResult<QueueSnapshot> {
    Ok(QueueSnapshot {
        revision: revision(conn)?,
        entries: list(conn)?,
    })
}

/// 把给定的订单 ID 序列重写为 0..n 的连续位置。
/// 只影响 `queue_position`，不触碰订单 revision。
pub fn renumber(tx: &Connection, ids: &[String]) -> AppResult<()> {
    for (index, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE orders SET queue_position = ?1 WHERE id = ?2 AND status = 'active'",
            params![index as i64, id],
        )?;
    }
    Ok(())
}

/// 活动订单 ID 列表（按当前位置）。
pub fn active_ids(conn: &Connection) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM orders WHERE status = 'active' ORDER BY queue_position, code",
    )?;
    let ids = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

pub fn bump_revision(tx: &Connection) -> AppResult<i64> {
    tx.execute("UPDATE queue_state SET revision = revision + 1 WHERE id = 1", [])?;
    revision(tx)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveInput {
    pub order_id: String,
    /// 客户端看到的队列版本；不匹配即冲突，避免基于旧顺序的重排覆盖新顺序。
    pub expected_queue_revision: i64,
    /// 目标位置（0 基）。超出范围会被夹到首尾。
    pub to_index: i64,
}

pub fn move_order(conn: &mut Connection, input: MoveInput) -> AppResult<QueueSnapshot> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = revision(&tx)?;
    if current != input.expected_queue_revision {
        return Err(AppError::conflict(format!(
            "队列顺序已被修改（当前版本 {current}，你基于 {}）。请刷新后重试。",
            input.expected_queue_revision
        )));
    }

    let mut ids = active_ids(&tx)?;
    let index = ids
        .iter()
        .position(|id| id == &input.order_id)
        .ok_or_else(|| {
            AppError::invalid("该订单不在活动队列中（可能已完成或已取消）")
        })?;

    if ids.len() <= 1 {
        let snap = QueueSnapshot {
            revision: current,
            entries: list(&tx)?,
        };
        tx.commit()?;
        return Ok(snap);
    }

    let target = input.to_index.clamp(0, ids.len() as i64 - 1) as usize;
    if target != index {
        let moved = ids.remove(index);
        ids.insert(target, moved);
        renumber(&tx, &ids)?;
        bump_revision(&tx)?;
    }

    let snap = QueueSnapshot {
        revision: revision(&tx)?,
        entries: list(&tx)?,
    };
    tx.commit()?;
    Ok(snap)
}

/// 相对移动：上移/下移的共用实现，供命令层与 UI 的键盘操作使用。
pub fn shift(conn: &mut Connection, order_id: &str, expected_revision: i64, delta: i64) -> AppResult<QueueSnapshot> {
    let ids = active_ids(conn)?;
    let index = ids
        .iter()
        .position(|id| id == order_id)
        .ok_or_else(|| AppError::invalid("该订单不在活动队列中"))?;
    let to_index = index as i64 + delta;
    move_order(
        conn,
        MoveInput {
            order_id: order_id.to_string(),
            expected_queue_revision: expected_revision,
            to_index,
        },
    )
}

/// 建单时按指定位置插入；`position` 为 None 时追加到末尾。
/// 由 `orders::create_order` 在同一个事务里调用。
pub fn insert_new(tx: &Connection, order_id: &str, position: Option<i64>) -> AppResult<()> {
    let mut stmt = tx.prepare(
        "SELECT id FROM orders WHERE status = 'active' AND id <> ?1
         ORDER BY queue_position, code",
    )?;
    let mut ids: Vec<String> = stmt
        .query_map([order_id], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    let index = match position {
        None => ids.len(),
        Some(value) => (value.max(0) as usize).min(ids.len()),
    };
    ids.insert(index, order_id.to_string());
    renumber(tx, &ids)?;
    bump_revision(tx)?;
    Ok(())
}

/// 供测试与诊断：某订单当前的队列位置。
pub fn position_of(conn: &Connection, order_id: &str) -> AppResult<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT queue_position FROM orders WHERE id = ?1 AND status = 'active'",
            [order_id],
            |r| r.get::<_, i64>(0),
        )
        .optional()?)
}
