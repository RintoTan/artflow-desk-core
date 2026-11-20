//! 回收站：读模型 + 删除 / 恢复。
//!
//! 这一层只做「可见性」——把订单与客户送进回收站、再取回来。**不做物理删除**，
//! 那属于 03C。历史事件、阶段副本、附件记录、客户标签关联一律不动：
//! 删除是可见性，不是销毁。
//!
//! 三条与守卫的关系：
//! - 删除：`require_visible_*`（只能删有效数据）；
//! - 恢复：先读 `deleted_at` 自行判定，因为「已恢复」要按幂等处理，
//!   而不是报 `CONFLICT`；
//! - 读回收站：本模块是唯一允许直接读基表 `orders` / `clients` 的业务模块，
//!   因为它要的正是「被隐藏的那些行」。SQL lint 为此保留 `TRASH_READ` 豁免。
//!
//! 批次语义（03A-R 裁定）：
//! - 删除客户时，该客户名下**所有**订单并入本次批次（含此前单独删除的）；
//!   已有 `deleted_at` 的订单保留原删除时间，只覆盖 `deleted_batch`；
//! - 恢复与永久删除都限定在「该客户 + 该批次」内；
//! - 若发现该客户名下还有订单不在该批次内，**中止并报数据完整性异常**，
//!   不静默扩大操作范围。

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

use crate::domain::lifecycle::{work_state_from, WorkState};
use crate::error::{AppError, AppResult};
use crate::store::timezone;
use crate::store::visibility;

/// 完整性异常的固定文案前缀：前端按 `INTEGRITY` 码展示，不猜测。
fn integrity(message: impl std::fmt::Display) -> AppError {
    AppError::new(
        "INTEGRITY",
        format!("数据完整性异常：{message}。已中止本次操作，未改动任何数据。"),
    )
}

// ---------------------------------------------------------------- 读模型

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashOrder {
    pub id: String,
    pub code: String,
    pub title: String,
    /// 该订单自己的删除时间。客户组内可能早于客户，因为删客户前它已单独进过回收站。
    pub deleted_at: String,
    /// 删除前的制作进度（不是 `status`）。
    pub work_state: WorkState,
    /// 原客户名。独立订单才有意义；客户组成员这里为空（组头已有名字）。
    pub original_client_name: Option<String>,
    /// 数据库里的附件**记录**数，不等于物理文件数（原图 + 缩略图是两类文件）。
    pub attachment_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashGroup {
    pub client_id: String,
    pub client_name: String,
    /// 客户的删除时间；组内订单各自保留自己的时间。
    pub deleted_at: String,
    pub orders: Vec<TrashOrder>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashSnapshot {
    pub groups: Vec<TrashGroup>,
    pub loose_orders: Vec<TrashOrder>,
    pub group_count: i64,
    pub loose_order_count: i64,
    /// **全部**回收站订单，含客户组内部。三段计数与列表出自同一次读取。
    pub total_order_count: i64,
}

/// 一次读事务内的两条查询，页头数字由结果算出。
///
/// 为什么不用 `COUNT(*)` 另算：两次查询之间数据可能变化，会出现「页头 12、列表 11」。
/// 两条语句包在同一个只读事务里，SQLite 给同一个快照。
pub fn snapshot(conn: &Connection) -> AppResult<TrashSnapshot> {
    let tx = conn.unchecked_transaction()?;

    // 客户组：以客户为主表左连订单，保证「已删除但名下没有订单」也能显示。
    let mut stmt = tx.prepare(
        "SELECT c.id, c.display_name, c.deleted_at,
                o.id, o.code, o.title, o.deleted_at, o.status, o.started_at,
                (SELECT COUNT(*) FROM attachments a WHERE a.order_id = o.id)
           FROM clients c
           LEFT JOIN orders o ON o.client_id = c.id AND o.deleted_at IS NOT NULL
          WHERE c.deleted_at IS NOT NULL
          ORDER BY c.deleted_at DESC, c.display_name, o.code",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
            r.get::<_, Option<String>>(4)?,
            r.get::<_, Option<String>>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, Option<String>>(7)?,
            r.get::<_, Option<String>>(8)?,
            r.get::<_, i64>(9)?,
        ))
    })?;

    let mut groups: Vec<TrashGroup> = Vec::new();
    for row in rows {
        let (
            client_id,
            client_name,
            client_deleted_at,
            order_id,
            code,
            title,
            deleted_at,
            status,
            started_at,
            attachment_count,
        ) = row?;
        if groups.last().map(|g| g.client_id.as_str()) != Some(client_id.as_str()) {
            groups.push(TrashGroup {
                client_id: client_id.clone(),
                client_name,
                deleted_at: client_deleted_at,
                orders: Vec::new(),
            });
        }
        if let (Some(id), Some(code), Some(title), Some(deleted_at), Some(status)) =
            (order_id, code, title, deleted_at, status)
        {
            groups.last_mut().expect("刚推入").orders.push(TrashOrder {
                id,
                code,
                title,
                deleted_at,
                work_state: work_state_from(&status, started_at.as_deref()),
                original_client_name: None,
                attachment_count,
            });
        }
    }
    drop(stmt);

    // 独立订单：客户的关联缺失、或客户仍有效，都归到这里（异常数据也有归宿）。
    let mut stmt = tx.prepare(
        "SELECT o.id, o.code, o.title, o.deleted_at, o.status, o.started_at,
                c.display_name,
                (SELECT COUNT(*) FROM attachments a WHERE a.order_id = o.id)
           FROM orders o
           LEFT JOIN clients c ON c.id = o.client_id
          WHERE o.deleted_at IS NOT NULL
            AND (c.id IS NULL OR c.deleted_at IS NULL)
          ORDER BY o.deleted_at DESC, o.code",
    )?;
    let loose_orders: Vec<TrashOrder> = stmt
        .query_map([], |r| {
            let status: String = r.get(4)?;
            let started_at: Option<String> = r.get(5)?;
            Ok(TrashOrder {
                id: r.get(0)?,
                code: r.get(1)?,
                title: r.get(2)?,
                deleted_at: r.get(3)?,
                work_state: work_state_from(&status, started_at.as_deref()),
                original_client_name: r.get(6)?,
                attachment_count: r.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let group_count = groups.len() as i64;
    let loose_order_count = loose_orders.len() as i64;
    let grouped_orders: i64 = groups.iter().map(|g| g.orders.len() as i64).sum();
    let total_order_count = grouped_orders + loose_order_count;

    Ok(TrashSnapshot {
        groups,
        loose_orders,
        group_count,
        loose_order_count,
        total_order_count,
    })
}

/// 删除客户前的影响范围：用于确认框，不产生任何写入。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientDeleteImpact {
    pub client_id: String,
    pub client_name: String,
    /// 客户名下全部订单（含已在回收站的）。
    pub order_count: i64,
    /// 其中已经在回收站的：确认框要说明它们会被并入本次客户组。
    pub already_trashed: i64,
}

pub fn client_delete_impact(conn: &Connection, client_id: &str) -> AppResult<ClientDeleteImpact> {
    let client_name: String = conn
        .query_row(
            "SELECT display_name FROM clients WHERE id = ?1",
            [client_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found(format!("客户 {client_id} 不存在")))?;

    let order_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM orders WHERE client_id = ?1",
        [client_id],
        |r| r.get(0),
    )?;
    let already_trashed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM orders WHERE client_id = ?1 AND deleted_at IS NOT NULL",
        [client_id],
        |r| r.get(0),
    )?;
    Ok(ClientDeleteImpact {
        client_id: client_id.to_string(),
        client_name,
        order_count,
        already_trashed,
    })
}

// ---------------------------------------------------------------- 删除

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedOrder {
    pub order_id: String,
    pub deleted_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedClient {
    pub client_id: String,
    pub deleted_at: String,
    /// 本次新进回收站的订单数。
    pub orders_trashed: i64,
    /// 此前已单独删除、本次被并入客户组的订单数。
    pub orders_already_trashed: i64,
}

pub fn delete_order(conn: &mut Connection, order_id: &str) -> AppResult<DeletedOrder> {
    let now = timezone::now_timestamp();
    let batch = uuid::Uuid::new_v4().to_string();

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    visibility::require_visible_order(&tx, order_id)?;
    let changed = tx.execute(
        "UPDATE orders SET deleted_at = ?2, deleted_batch = ?3
          WHERE id = ?1 AND deleted_at IS NULL",
        params![order_id, now, batch],
    )?;
    if changed != 1 {
        return Err(AppError::conflict("订单状态已变化，请刷新后重试"));
    }
    tx.commit()?;

    Ok(DeletedOrder {
        order_id: order_id.to_string(),
        deleted_at: now,
    })
}

/// 删除客户：把该客户名下**全部**订单并入本次批次。
///
/// `deleted_at = COALESCE(deleted_at, ?now)` 是这条规则的核心：
/// 早先单独删除的订单保留自己的删除时间，但仍然被收进客户批次，
/// 否则后续永久删除客户会把它变成 `client_id = NULL` 的孤儿。
pub fn delete_client(conn: &mut Connection, client_id: &str) -> AppResult<DeletedClient> {
    let now = timezone::now_timestamp();
    let batch = uuid::Uuid::new_v4().to_string();

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    visibility::require_visible_client(&tx, client_id)?;

    let order_count: i64 = tx.query_row(
        "SELECT COUNT(*) FROM orders WHERE client_id = ?1",
        [client_id],
        |r| r.get(0),
    )?;
    let already_trashed: i64 = tx.query_row(
        "SELECT COUNT(*) FROM orders WHERE client_id = ?1 AND deleted_at IS NOT NULL",
        [client_id],
        |r| r.get(0),
    )?;

    tx.execute(
        "UPDATE orders SET deleted_batch = ?2, deleted_at = COALESCE(deleted_at, ?3)
          WHERE client_id = ?1",
        params![client_id, batch, now],
    )?;

    let changed = tx.execute(
        "UPDATE clients SET deleted_at = ?2, deleted_batch = ?3
          WHERE id = ?1 AND deleted_at IS NULL",
        params![client_id, now, batch],
    )?;
    if changed != 1 {
        return Err(AppError::conflict("客户状态已变化，请刷新后重试"));
    }
    tx.commit()?;

    Ok(DeletedClient {
        client_id: client_id.to_string(),
        deleted_at: now,
        orders_trashed: order_count - already_trashed,
        orders_already_trashed: already_trashed,
    })
}

// ---------------------------------------------------------------- 恢复

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredOrder {
    pub order_id: String,
    /// 0 表示它本来就是有效的（幂等重放）。
    pub orders_restored: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredClient {
    pub client_id: String,
    /// 本次实际被恢复的订单数。**包含此前单独删除、被并入本批次的订单**——
    /// 它们是同一批 UPDATE 改到的行，不能只数"本次才进回收站"的那些。
    pub orders_restored: i64,
    /// 已经是有效状态时返回 0（幂等重放）。
    pub clients_restored: i64,
}

/// 恢复单张订单。
///
/// 允许恢复的前提是它所属客户已不在回收站——否则会出现「客户被删、订单却可见」
/// 的半条链，这正是整批规则的初衷。
pub fn restore_order(conn: &mut Connection, order_id: &str) -> AppResult<RestoredOrder> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

    let row: Option<(Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT deleted_at, client_id FROM orders WHERE id = ?1",
            [order_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (deleted_at, client_id) =
        row.ok_or_else(|| AppError::not_found(format!("订单 {order_id} 不存在")))?;

    // 幂等：已经有效就不再动，也不报错。
    if deleted_at.is_none() {
        tx.commit()?;
        return Ok(RestoredOrder {
            order_id: order_id.to_string(),
            orders_restored: 0,
        });
    }

    if let Some(client_id) = client_id {
        match visibility::require_visible_client(&tx, &client_id) {
            Ok(()) => {}
            Err(e) if e.code == "CONFLICT" => {
                return Err(AppError::conflict(format!(
                    "订单 {order_id} 的客户仍在回收站中，请先恢复所属客户"
                )))
            }
            Err(e) => return Err(e),
        }
    }

    let changed = tx.execute(
        "UPDATE orders SET deleted_at = NULL, deleted_batch = NULL
          WHERE id = ?1 AND deleted_at IS NOT NULL",
        [order_id],
    )?;
    tx.commit()?;

    Ok(RestoredOrder {
        order_id: order_id.to_string(),
        orders_restored: changed as i64,
    })
}

/// 恢复客户组：只恢复「该客户 + 该批次」。
///
/// 若该客户名下还有订单不在这个批次里（包括仍未删除的），本次操作**中止**。
/// 静默扩大范围会把「另一批删除」的数据一起恢复，用户看不到为什么多了几单。
pub fn restore_client(conn: &mut Connection, client_id: &str) -> AppResult<RestoredClient> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

    let row: Option<(Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT deleted_at, deleted_batch FROM clients WHERE id = ?1",
            [client_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (deleted_at, batch) =
        row.ok_or_else(|| AppError::not_found(format!("客户 {client_id} 不存在")))?;

    // 幂等：已经有效就不再动。
    if deleted_at.is_none() {
        tx.commit()?;
        return Ok(RestoredClient {
            client_id: client_id.to_string(),
            orders_restored: 0,
            clients_restored: 0,
        });
    }

    let batch = batch.ok_or_else(|| integrity("客户在回收站中但缺少删除批次"))?;
    assert_client_orders_in_batch(&tx, client_id, &batch)?;

    let orders_restored = tx.execute(
        "UPDATE orders SET deleted_at = NULL, deleted_batch = NULL
          WHERE client_id = ?1 AND deleted_batch = ?2",
        params![client_id, batch],
    )?;
    tx.execute(
        "UPDATE clients SET deleted_at = NULL, deleted_batch = NULL WHERE id = ?1",
        [client_id],
    )?;
    tx.commit()?;

    Ok(RestoredClient {
        client_id: client_id.to_string(),
        orders_restored: orders_restored as i64,
        clients_restored: 1,
    })
}

/// 该客户名下的订单必须全部、且只属于这一个批次。
///
/// 三种情况都算异常：仍有未删除的订单、订单缺少批次、批次不是本批。
/// 任何一条命中都不允许继续——宁可让用户看到错误，也不要把别的批次一起恢复。
fn assert_client_orders_in_batch(
    tx: &Connection,
    client_id: &str,
    batch: &str,
) -> AppResult<()> {
    let strays: Vec<(String, Option<String>)> = {
        let mut stmt = tx.prepare(
            "SELECT code, deleted_batch FROM orders
              WHERE client_id = ?1
                AND (deleted_at IS NULL OR deleted_batch IS NULL OR deleted_batch <> ?2)
              ORDER BY code",
        )?;
        let rows = stmt
            .query_map(params![client_id, batch], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };

    if strays.is_empty() {
        return Ok(());
    }

    let codes: Vec<String> = strays
        .iter()
        .take(3)
        .map(|(code, _)| code.clone())
        .collect();
    let more = if strays.len() > codes.len() {
        " 等"
    } else {
        ""
    };
    Err(integrity(format!(
        "客户 {client_id} 名下有 {} 个订单不在本批次内（{}）{}",
        strays.len(),
        codes.join("、"),
        more
    )))
}
