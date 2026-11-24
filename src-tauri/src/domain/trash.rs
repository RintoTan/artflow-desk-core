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

// ---------------------------------------------------------------- 永久删除

/// 一次永久删除的附件清理结果。
///
/// 刻意分成「数据库里的附件记录」「登记的文件数」「实际清理结果」三个数字：
/// 一条附件记录对应原图 + 缩略图两个文件，混成一个数字会让用户以为清理得不彻底。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeCleanup {
    /// 本次登记的清理任务里已经完成的文件数。
    pub cleaned: i64,
    /// 仍未完成（失败 / 被拒绝 / 未轮询到）的文件数。
    pub pending: i64,
    /// 未完成文件的相对路径，用于界面提示具体是哪些。
    pub pending_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeResult {
    pub orders_purged: i64,
    /// 删除的附件**记录**数。
    pub attachments_removed: i64,
    /// 登记清理的**文件**数（原图 + 缩略图）。
    pub files_registered: i64,
    pub cleanup: PurgeCleanup,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeGroupResult {
    pub client_id: String,
    pub clients_purged: i64,
    pub orders_purged: i64,
    pub attachments_removed: i64,
    pub files_registered: i64,
    pub cleanup: PurgeCleanup,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashBatchOutcome {
    /// 给用户看的批次名：`客户「Alice」+3 单` 或 `订单 AF-2026-0001`。
    pub label: String,
    pub ok: bool,
    pub orders_purged: i64,
    pub files_registered: i64,
    pub cleanup_pending: i64,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmptyTrashResult {
    pub batches: Vec<TrashBatchOutcome>,
    pub purged_batches: i64,
    pub failed_batches: i64,
    pub orders_purged: i64,
    pub files_registered: i64,
    pub cleanup_pending: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PurgeCleanupStatus {
    /// 当前代际下 `reason='purge'` 的失败任务数。
    pub failed: i64,
    pub oldest_created_at: Option<String>,
}

/// 登记一条清理任务，并返回**真实存在**的任务 ID。
///
/// `INSERT OR IGNORE` 遇到「同代际同路径已有 pending 任务」时会静默不插入——
/// 那个任务可能来自 `attachment_removed`，`id` 也不是我们生成的。
/// 因此插入后必须回查真实行；若复用了既有任务，把它的 `reason` 提升为 `purge`，
/// 否则它一旦失败就进不了 purge 专属重试，成为「无人知晓的残留文件」。
fn register_cleanup_task(
    tx: &Connection,
    generation: &str,
    order_id: &str,
    rel_path: &str,
    id_seed: &str,
    now: &str,
    ids: &mut Vec<String>,
) -> AppResult<()> {
    tx.execute(
        "INSERT OR IGNORE INTO cleanup_tasks (id, generation, order_id, rel_path, reason, created_at)
         VALUES (?1, ?2, ?3, ?4, 'purge', ?5)",
        params![id_seed, generation, order_id, rel_path, now],
    )?;

    let actual: Option<String> = tx
        .query_row(
            "SELECT id FROM cleanup_tasks
              WHERE generation = ?1 AND rel_path = ?2 AND state = 'pending'",
            params![generation, rel_path],
            |r| r.get(0),
        )
        .optional()?;
    let actual = actual.ok_or_else(|| integrity(format!("清理任务未能登记（{rel_path}）")))?;

    tx.execute(
        "UPDATE cleanup_tasks SET reason = 'purge', order_id = COALESCE(order_id, ?2)
          WHERE id = ?1 AND state = 'pending'",
        params![actual, order_id],
    )?;
    ids.push(actual);
    Ok(())
}

/// 事务内的删除动作：读路径 → 登记任务 → 删记录。
///
/// 顺序不可换。`attachments` / `order_events` / `order_stages` 对 `orders` 都是
/// `ON DELETE CASCADE`，先删订单就会把路径一起带走，文件从此无从清理。
fn purge_order_rows(
    tx: &Connection,
    generation: &str,
    order_id: &str,
    now: &str,
    group_batch: Option<&str>,
) -> AppResult<(i64, i64, Vec<String>)> {
    let row: Option<(Option<String>, Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT deleted_at, client_id, deleted_batch FROM orders WHERE id = ?1",
            [order_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let (deleted_at, client_id, order_batch) =
        row.ok_or_else(|| AppError::not_found(format!("订单 {order_id} 不存在")))?;

    if deleted_at.is_none() {
        return Err(AppError::conflict(format!(
            "订单 {order_id} 仍在业务中，只能永久删除回收站里的订单"
        )));
    }

    match group_batch {
        Some(batch) => {
            if order_batch.as_deref() != Some(batch) {
                return Err(integrity(format!("订单 {order_id} 不属于本批次")));
            }
        }
        None => {
            // 单独永久删除：客户若也在回收站，必须走整批，否则会留下指向已删客户的孤儿。
            if let Some(client_id) = client_id {
                let client_deleted: Option<Option<String>> = tx
                    .query_row(
                        "SELECT deleted_at FROM clients WHERE id = ?1",
                        [&client_id],
                        |r| r.get(0),
                    )
                    .optional()?;
                if matches!(client_deleted, Some(Some(_))) {
                    return Err(AppError::conflict(format!(
                        "订单 {order_id} 属于回收站中的客户组，请在客户组上整批永久删除"
                    )));
                }
            }
        }
    }

    let attachment_rows: Vec<(String, Option<String>)> = {
        let mut stmt =
            tx.prepare("SELECT rel_path, thumb_rel_path FROM attachments WHERE order_id = ?1")?;
        let rows = stmt
            .query_map([order_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };

    let mut ids = Vec::new();
    for (index, (original, thumb)) in attachment_rows.iter().enumerate() {
        register_cleanup_task(
            tx,
            generation,
            order_id,
            original,
            &format!("pg-{order_id}-{index}-o"),
            now,
            &mut ids,
        )?;
        if let Some(thumb) = thumb {
            register_cleanup_task(
                tx,
                generation,
                order_id,
                thumb,
                &format!("pg-{order_id}-{index}-t"),
                now,
                &mut ids,
            )?;
        }
    }

    // 显式删子表，不依赖 CASCADE：这里的行数要能对账。
    tx.execute("DELETE FROM attachments WHERE order_id = ?1", [order_id])?;
    tx.execute("DELETE FROM order_events WHERE order_id = ?1", [order_id])?;
    tx.execute("DELETE FROM order_stages WHERE order_id = ?1", [order_id])?;
    // 财务三表：流水先于计划删（流水对计划是 SET NULL，顺序换了会白写两次）。
    // 退款先删：它对收款是 SET NULL，对订单是 CASCADE，显式删与既有风格一致。
    tx.execute("DELETE FROM refund_records WHERE order_id = ?1", [order_id])?;
    tx.execute("DELETE FROM payment_records WHERE order_id = ?1", [order_id])?;
    tx.execute("DELETE FROM payment_schedules WHERE order_id = ?1", [order_id])?;
    let removed = tx.execute("DELETE FROM orders WHERE id = ?1", [order_id])?;
    if removed != 1 {
        return Err(AppError::conflict("订单状态已变化，请刷新后重试"));
    }

    Ok((
        attachment_rows.len() as i64,
        ids.len() as i64,
        ids,
    ))
}

/// 只按本次登记的 ID 汇总，不用 `run_cleanup` 的全局报告。
///
/// 全局报告会顺带算上库里别人的 `<attachment_removed>` 任务，
/// 用它的数字去写「本次删除成功清理了 N 个文件」会张冠李戴。
fn summarize_cleanup(conn: &Connection, ids: &[String]) -> AppResult<PurgeCleanup> {
    let mut out = PurgeCleanup::default();
    for id in ids {
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT state, rel_path FROM cleanup_tasks WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        match row {
            Some((state, _)) if state == "done" => out.cleaned += 1,
            Some((_, rel_path)) => {
                out.pending += 1;
                out.pending_paths.push(rel_path);
            }
            None => {
                out.pending += 1;
                out.pending_paths.push(format!("（任务 {id} 已不存在）"));
            }
        }
    }
    Ok(out)
}

/// 永久删除一张回收站订单。数据库事务提交后才动文件。
pub fn purge_order(
    conn: &mut Connection,
    layout: &crate::store::paths::Layout,
    generation: &str,
    order_id: &str,
) -> AppResult<PurgeResult> {
    let now = timezone::now_timestamp();

    let (attachments_removed, files_registered, ids) = {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = purge_order_rows(&tx, generation, order_id, &now, None)?;
        tx.commit()?;
        result
    };

    // 事务已提交，文件才允许消失。失败会留下 failed 任务交给重试。
    let _ = crate::domain::attachments::run_cleanup(conn, layout, generation)?;
    let cleanup = summarize_cleanup(conn, &ids)?;

    Ok(PurgeResult {
        orders_purged: 1,
        attachments_removed,
        files_registered,
        cleanup,
    })
}

/// 永久删除一个客户组：客户 + 该批次全部订单。
///
/// 先按 `client_id + deleted_batch` 确认范围；任何订单未删除、缺批次或批次不符都中止。
/// 删客户之前断言「已无订单引用它」，否则就是孤儿订单。
pub fn purge_client_group(
    conn: &mut Connection,
    layout: &crate::store::paths::Layout,
    generation: &str,
    client_id: &str,
) -> AppResult<PurgeGroupResult> {
    let now = timezone::now_timestamp();

    let (orders_purged, attachments_removed, files_registered, ids) = {
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
        if deleted_at.is_none() {
            return Err(AppError::conflict(format!(
                "客户 {client_id} 仍在业务中，只能永久删除回收站里的客户"
            )));
        }
        let batch = batch.ok_or_else(|| integrity("客户在回收站中但缺少删除批次"))?;

        // 与恢复共用同一条完整性检查：批次外不允许夹带。
        assert_client_orders_in_batch(&tx, client_id, &batch)?;

        let order_ids: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT id FROM orders WHERE client_id = ?1 AND deleted_batch = ?2 ORDER BY code",
            )?;
            let rows = stmt
                .query_map(params![client_id, batch], |r| r.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };

        let mut attachments_removed = 0i64;
        let mut files_registered = 0i64;
        let mut ids = Vec::new();
        for order_id in &order_ids {
            let (a, f, mut task_ids) =
                purge_order_rows(&tx, generation, order_id, &now, Some(&batch))?;
            attachments_removed += a;
            files_registered += f;
            ids.append(&mut task_ids);
        }

        // 标签关联随客户移除，标签本身不动。
        tx.execute("DELETE FROM client_tag_link WHERE client_id = ?1", [client_id])?;
        tx.execute("DELETE FROM clients WHERE id = ?1", [client_id])?;

        let orphans: i64 = tx.query_row(
            "SELECT COUNT(*) FROM orders WHERE client_id = ?1",
            [client_id],
            |r| r.get(0),
        )?;
        if orphans != 0 {
            return Err(integrity(format!(
                "永久删除客户 {client_id} 后仍有 {orphans} 个订单引用该客户"
            )));
        }

        tx.commit()?;
        (order_ids.len() as i64, attachments_removed, files_registered, ids)
    };

    let _ = crate::domain::attachments::run_cleanup(conn, layout, generation)?;
    let cleanup = summarize_cleanup(conn, &ids)?;

    Ok(PurgeGroupResult {
        client_id: client_id.to_string(),
        clients_purged: 1,
        orders_purged,
        attachments_removed,
        files_registered,
        cleanup,
    })
}

/// 清空回收站：每个客户组 / 独立订单各自一个事务，逐批提交。
///
/// 一批失败只回滚它自己，不影响已完成的批次，也不阻止后续批次。
/// 这是唯一能让「部分成功」如实反映到界面的做法——把全部塞进一个事务，
/// 一条失败就会把已删的数据「复活」，用户看到的结果与数据库不一致。
pub fn empty_trash(
    conn: &mut Connection,
    layout: &crate::store::paths::Layout,
    generation: &str,
) -> AppResult<EmptyTrashResult> {
    let groups: Vec<(String, String, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.display_name,
                    (SELECT COUNT(*) FROM orders o WHERE o.client_id = c.id AND o.deleted_at IS NOT NULL)
               FROM clients c
              WHERE c.deleted_at IS NOT NULL
              ORDER BY c.deleted_at, c.display_name",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let loose: Vec<(String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT o.id, o.code
               FROM orders o
               LEFT JOIN clients c ON c.id = o.client_id
              WHERE o.deleted_at IS NOT NULL
                AND (c.id IS NULL OR c.deleted_at IS NULL)
              ORDER BY o.deleted_at, o.code",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };

    let mut result = EmptyTrashResult {
        batches: Vec::new(),
        purged_batches: 0,
        failed_batches: 0,
        orders_purged: 0,
        files_registered: 0,
        cleanup_pending: 0,
    };

    for (client_id, name, count) in groups {
        let label = format!("客户「{name}」+{count} 单");
        match purge_client_group(conn, layout, generation, &client_id) {
            Ok(done) => {
                result.purged_batches += 1;
                result.orders_purged += done.orders_purged;
                result.files_registered += done.files_registered;
                result.cleanup_pending += done.cleanup.pending;
                result.batches.push(TrashBatchOutcome {
                    label,
                    ok: true,
                    orders_purged: done.orders_purged,
                    files_registered: done.files_registered,
                    cleanup_pending: done.cleanup.pending,
                    error: None,
                });
            }
            Err(e) => {
                result.failed_batches += 1;
                result.batches.push(TrashBatchOutcome {
                    label,
                    ok: false,
                    orders_purged: 0,
                    files_registered: 0,
                    cleanup_pending: 0,
                    error: Some(e.message),
                });
            }
        }
    }

    for (order_id, code) in loose {
        match purge_order(conn, layout, generation, &order_id) {
            Ok(done) => {
                result.purged_batches += 1;
                result.orders_purged += done.orders_purged;
                result.files_registered += done.files_registered;
                result.cleanup_pending += done.cleanup.pending;
                result.batches.push(TrashBatchOutcome {
                    label: format!("订单 {code}"),
                    ok: true,
                    orders_purged: done.orders_purged,
                    files_registered: done.files_registered,
                    cleanup_pending: done.cleanup.pending,
                    error: None,
                });
            }
            Err(e) => {
                result.failed_batches += 1;
                result.batches.push(TrashBatchOutcome {
                    label: format!("订单 {code}"),
                    ok: false,
                    orders_purged: 0,
                    files_registered: 0,
                    cleanup_pending: 0,
                    error: Some(e.message),
                });
            }
        }
    }

    Ok(result)
}

// ---------------------------------------------------------------- 清理重试

/// 把失败的 purge 任务重新排队。
///
/// `max_attempts` 为 `Some(3)` 用于启动时的有限自动重试（三次是**总**尝试次数，
/// 因为 `attempts` 只由执行器递增，重置时不动它）；
/// 为 `None` 用于用户手动重试——手动不受上限约束，但也不清零计数。
pub fn reset_purge_failures(
    conn: &Connection,
    generation: &str,
    max_attempts: Option<i64>,
) -> AppResult<usize> {
    let changed = match max_attempts {
        Some(limit) => conn.execute(
            "UPDATE cleanup_tasks SET state = 'pending'
              WHERE reason = 'purge' AND state = 'failed'
                AND generation = ?1 AND attempts < ?2",
            params![generation, limit],
        )?,
        None => conn.execute(
            "UPDATE cleanup_tasks SET state = 'pending'
              WHERE reason = 'purge' AND state = 'failed' AND generation = ?1",
            [generation],
        )?,
    };
    Ok(changed)
}

pub fn purge_cleanup_status(conn: &Connection, generation: &str) -> AppResult<PurgeCleanupStatus> {
    let (failed, oldest): (i64, Option<String>) = conn.query_row(
        "SELECT COUNT(*), MIN(created_at) FROM cleanup_tasks
          WHERE reason = 'purge' AND state = 'failed' AND generation = ?1",
        [generation],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(PurgeCleanupStatus {
        failed,
        oldest_created_at: oldest,
    })
}

pub fn retry_purge_cleanup(
    conn: &mut Connection,
    layout: &crate::store::paths::Layout,
    generation: &str,
) -> AppResult<PurgeCleanupStatus> {
    reset_purge_failures(conn, generation, None)?;
    let _ = crate::domain::attachments::run_cleanup(conn, layout, generation)?;
    purge_cleanup_status(conn, generation)
}
