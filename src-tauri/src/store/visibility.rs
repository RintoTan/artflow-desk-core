//! 数据可见性守卫。
//!
//! 回收站上线后，「这条数据该不该被普通业务看见」不再靠每个调用点自己手写
//! `deleted_at IS NULL`，而是分两层收敛：
//!
//! - **读**：v8 的三个视图（`orders_visible` / `orders_trashed` / `clients_visible`）
//!   决定列表与聚合能看见什么；
//! - **按 id 的读与写**：本模块的守卫决定这条数据此刻允许被怎么操作。
//!
//! 为什么按 id 的入口不能只靠 WHERE：
//! 加 `deleted_at IS NULL` 会让回收站页面查不到该订单的历史；不加又会让业务动作
//! （推进阶段、改金额、加附件、入队）作用在已删除订单上。两者都不对，
//! 因此这类入口必须先显式声明「我要的是哪一侧」。
//!
//! 错误码沿用既有体系：缺失用 `NOT_FOUND`，状态不符用 `CONFLICT`。
//! 「在回收站中」不用 `NOT_FOUND` 表示——前端若按 `NOT_FOUND` 处理会当成
//! 「数据不存在」并刷新列表，把提示抹掉，用户看不到「请先恢复」。

use rusqlite::{Connection, OptionalExtension};

use crate::error::{AppError, AppResult};

/// 期望的可见性范围。
///
/// 只覆盖按 id 的操作；列表与聚合的可见性由 v8 视图承担。
/// `All`（备份、诊断、幂等）不在此枚举内——需要全量时直接读基表，
/// 不走守卫，避免「守卫被传参绕过」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// 业务对象：只有未删除的才允许操作。
    Visible,
    /// 回收站对象：只有已删除的才允许操作（恢复、永久删除）。
    Trashed,
}

enum Presence {
    Missing,
    Live,
    Trashed,
}

fn order_presence(conn: &Connection, id: &str) -> AppResult<Presence> {
    let row: Option<Option<String>> = conn
        .query_row("SELECT deleted_at FROM orders WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(match row {
        None => Presence::Missing,
        Some(Some(_)) => Presence::Trashed,
        Some(None) => Presence::Live,
    })
}

fn client_presence(conn: &Connection, id: &str) -> AppResult<Presence> {
    let row: Option<Option<String>> = conn
        .query_row("SELECT deleted_at FROM clients WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(match row {
        None => Presence::Missing,
        Some(Some(_)) => Presence::Trashed,
        Some(None) => Presence::Live,
    })
}

/// 订单可见性守卫：业务侧操作前必须调用。
///
/// 覆盖范围：订单详情与编辑、阶段推进/返工/跳级、附件导入、入队与重排、
/// 按订单读取事件。
pub fn require_visible_order(conn: &Connection, id: &str) -> AppResult<()> {
    match order_presence(conn, id)? {
        Presence::Live => Ok(()),
        Presence::Trashed => Err(AppError::conflict(format!(
            "订单 {id} 在回收站中，请先恢复后再操作"
        ))),
        Presence::Missing => Err(AppError::not_found(format!("订单 {id} 不存在"))),
    }
}

/// 订单回收站守卫：只有已删除订单才允许被恢复或永久删除。
///
/// 用它拦住「对一条还活着的订单执行永久删除」这类误调用。
pub fn require_trashed_order(conn: &Connection, id: &str) -> AppResult<()> {
    match order_presence(conn, id)? {
        Presence::Trashed => Ok(()),
        Presence::Live => Err(AppError::conflict(format!(
            "订单 {id} 不在回收站中，无法执行该操作"
        ))),
        Presence::Missing => Err(AppError::not_found(format!(
            "回收站中没有订单 {id}"
        ))),
    }
}

/// 客户可见性守卫：新建订单、编辑订单、客户下钻等业务入口前调用。
pub fn require_visible_client(conn: &Connection, id: &str) -> AppResult<()> {
    match client_presence(conn, id)? {
        Presence::Live => Ok(()),
        Presence::Trashed => Err(AppError::conflict(format!(
            "客户 {id} 在回收站中，请先恢复后再操作"
        ))),
        Presence::Missing => Err(AppError::not_found(format!("客户 {id} 不存在"))),
    }
}

/// 客户回收站守卫：恢复客户（连带整批订单）或永久删除客户时调用。
pub fn require_trashed_client(conn: &Connection, id: &str) -> AppResult<()> {
    match client_presence(conn, id)? {
        Presence::Trashed => Ok(()),
        Presence::Live => Err(AppError::conflict(format!(
            "客户 {id} 不在回收站中，无法执行该操作"
        ))),
        Presence::Missing => Err(AppError::not_found(format!(
            "回收站中没有客户 {id}"
        ))),
    }
}

/// 按 `Scope` 分派，便于调用点把「期望哪一侧」作为参数一路传下来。
pub fn require_order(conn: &Connection, id: &str, scope: Scope) -> AppResult<()> {
    match scope {
        Scope::Visible => require_visible_order(conn, id),
        Scope::Trashed => require_trashed_order(conn, id),
    }
}

/// 返回订单此刻的真实归属；调用方需要区分「不存在」与「在回收站」时用它，
/// 而不是自己写一遍 SELECT。
pub fn order_scope(conn: &Connection, id: &str) -> AppResult<Scope> {
    match order_presence(conn, id)? {
        Presence::Live => Ok(Scope::Visible),
        Presence::Trashed => Ok(Scope::Trashed),
        Presence::Missing => Err(AppError::not_found(format!("订单 {id} 不存在"))),
    }
}
