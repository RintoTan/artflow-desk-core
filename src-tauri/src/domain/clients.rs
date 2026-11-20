//! 客户档案：轻量资料 + 关联订单历史。
//!
//! 同名客户**不自动合并**：客户身份由稳定 ID 决定，名称只是显示值。
//! 改名字不会影响订单的关联，订单读取时通过 JOIN 拿到最新名称。

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::store::timezone;
use crate::store::visibility;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientView {
    pub id: String,
    pub display_name: String,
    pub contact: Option<String>,
    pub note: Option<String>,
    pub revision: i64,
    /// 当前关联订单数（含已完成与已取消；永久删除后随剩余订单重算）。
    pub order_count: i64,
    pub active_count: i64,
    pub completed_count: i64,
    /// 已知委托金额合计（分）。NULL 金额不计入，也不当成 0。
    /// 名字刻意不叫"实收"：这里没有任何收款事实。
    pub known_amount_cents: i64,
    /// 最近一次下单时间（UTC RFC3339，订单创建时间）；由前端按工作时时区格式化。
    pub last_order_at: Option<String>,
    pub tags: Vec<TagView>,
    pub created_at: String,
    pub updated_at: String,
}

/// 客户标签：画师手工维护的分类，不参与任何自动分层。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagView {
    pub id: String,
    pub name: String,
    /// 被多少客户使用；用于"删除仍在使用"的拒绝说明。
    pub client_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientOrderBrief {
    pub id: String,
    pub code: String,
    pub title: String,
    pub status: String,
    pub current_stage_title: Option<String>,
    pub amount_cents: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientDetail {
    pub client: ClientView,
    pub orders: Vec<ClientOrderBrief>,
}

fn clean_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    let count = name.chars().count();
    if count == 0 {
        return Err(AppError::invalid("客户名称不能为空"));
    }
    if count > 120 {
        return Err(AppError::invalid("客户名称不能超过 120 字"));
    }
    Ok(name.to_string())
}

fn clean_optional(raw: &Option<String>, max: usize, field: &str) -> AppResult<Option<String>> {
    match raw {
        None => Ok(None),
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            if trimmed.chars().count() > max {
                return Err(AppError::invalid(format!("{field}不能超过 {max} 字")));
            }
            Ok(Some(trimmed.to_string()))
        }
    }
}

fn read_one(conn: &Connection, id: &str) -> AppResult<ClientView> {
    let mut view = conn.query_row(
        "SELECT c.id, c.display_name, c.contact, c.note, c.revision,
                (SELECT COUNT(*) FROM orders_visible o WHERE o.client_id = c.id),
                (SELECT COUNT(*) FROM orders_visible o WHERE o.client_id = c.id AND o.status = 'active'),
                (SELECT COUNT(*) FROM orders_visible o WHERE o.client_id = c.id AND o.status = 'complete'),
                (SELECT COALESCE(SUM(o.amount_cents), 0) FROM orders_visible o
                   WHERE o.client_id = c.id AND o.amount_cents IS NOT NULL),
                (SELECT MAX(o.created_at) FROM orders_visible o WHERE o.client_id = c.id),
                c.created_at, c.updated_at
         FROM clients_visible c WHERE c.id = ?1",
        [id],
        |r| {
            Ok(ClientView {
                id: r.get(0)?,
                display_name: r.get(1)?,
                contact: r.get(2)?,
                note: r.get(3)?,
                revision: r.get(4)?,
                order_count: r.get(5)?,
                active_count: r.get(6)?,
                completed_count: r.get(7)?,
                known_amount_cents: r.get(8)?,
                last_order_at: r.get(9)?,
                tags: Vec::new(),
                created_at: r.get(10)?,
                updated_at: r.get(11)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("客户不存在"))?;

    view.tags = tags_of(conn, &view.id)?;
    Ok(view)
}

/// 一个客户身上的标签（按名称排序）。
pub fn tags_of(conn: &Connection, client_id: &str) -> AppResult<Vec<TagView>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name,
                (SELECT COUNT(*) FROM client_tag_link l WHERE l.tag_id = t.id)
         FROM client_tag_link l
         JOIN client_tags t ON t.id = l.tag_id
         WHERE l.client_id = ?1
         ORDER BY t.name, t.id",
    )?;
    let rows = stmt
        .query_map([client_id], |r| {
            Ok(TagView {
                id: r.get(0)?,
                name: r.get(1)?,
                client_count: r.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 全部标签（按名称排序），带使用计数。
pub fn list_tags(conn: &Connection) -> AppResult<Vec<TagView>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.name,
                (SELECT COUNT(*) FROM client_tag_link l WHERE l.tag_id = t.id)
         FROM client_tags t
         ORDER BY t.name, t.id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(TagView {
                id: r.get(0)?,
                name: r.get(1)?,
                client_count: r.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn clean_tag_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    let count = name.chars().count();
    if count == 0 {
        return Err(AppError::invalid("标签名称不能为空"));
    }
    if count > 20 {
        return Err(AppError::invalid("标签名称不能超过 20 字"));
    }
    Ok(name.to_string())
}

/// 新建标签。同名（含大小写与首尾空白归一后）直接拒绝，不做静默合并：
/// 合并会让用户以为新建成功，实际挂到了别的标签上。
pub fn create_tag(conn: &Connection, name: &str) -> AppResult<TagView> {
    let name = clean_tag_name(name)?;
    let existing: Option<String> = conn
        .query_row("SELECT id FROM client_tags WHERE name = ?1", [&name], |r| {
            r.get(0)
        })
        .optional()?;
    if existing.is_some() {
        return Err(AppError::invalid(format!("标签「{name}」已存在")));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = timezone::now_timestamp();
    conn.execute(
        "INSERT INTO client_tags (id, name, created_at) VALUES (?1, ?2, ?3)",
        params![id, name, now],
    )?;
    Ok(TagView {
        id,
        name,
        client_count: 0,
    })
}

/// 删除标签。仍被客户使用时拒绝并说明用量，让用户先解除关联，
/// 而不是让外键 CASCADE 静默抹掉关系。
pub fn delete_tag(conn: &Connection, tag_id: &str) -> AppResult<()> {
    let used: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM client_tag_link WHERE tag_id = ?1",
            [tag_id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);
    if used > 0 {
        return Err(AppError::invalid(format!(
            "该标签仍被 {used} 位客户使用，请先解除关联再删除"
        )));
    }
    let changed = conn.execute("DELETE FROM client_tags WHERE id = ?1", [tag_id])?;
    if changed != 1 {
        return Err(AppError::not_found("标签不存在"));
    }
    Ok(())
}

/// 给客户挂标签。重复挂载视为成功（幂等），因为结果状态相同。
pub fn link_tag(conn: &Connection, client_id: &str, tag_id: &str) -> AppResult<Vec<TagView>> {
    visibility::require_visible_client(conn, client_id)?;
    let tag: Option<String> = conn
        .query_row("SELECT id FROM client_tags WHERE id = ?1", [tag_id], |r| {
            r.get(0)
        })
        .optional()?;
    if tag.is_none() {
        return Err(AppError::not_found("标签不存在"));
    }
    conn.execute(
        "INSERT OR IGNORE INTO client_tag_link (client_id, tag_id) VALUES (?1, ?2)",
        params![client_id, tag_id],
    )?;
    tags_of(conn, client_id)
}

/// 解除关联。不存在的关系视为已达成目标（幂等）。
pub fn unlink_tag(conn: &Connection, client_id: &str, tag_id: &str) -> AppResult<Vec<TagView>> {
    visibility::require_visible_client(conn, client_id)?;
    conn.execute(
        "DELETE FROM client_tag_link WHERE client_id = ?1 AND tag_id = ?2",
        params![client_id, tag_id],
    )?;
    tags_of(conn, client_id)
}

pub fn list(conn: &Connection) -> AppResult<Vec<ClientView>> {
    let mut stmt = conn.prepare("SELECT id FROM clients_visible ORDER BY display_name, id")?;
    let ids: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    ids.iter().map(|id| read_one(conn, id)).collect()
}

pub fn detail(conn: &Connection, id: &str) -> AppResult<ClientDetail> {
    visibility::require_visible_client(conn, id)?;
    let client = read_one(conn, id)?;
    let mut stmt = conn.prepare(
        "SELECT o.id, o.code, o.title, o.status, o.current_stage_id, o.amount_cents, o.created_at
         FROM orders_visible o WHERE o.client_id = ?1
         ORDER BY o.created_at DESC, o.code DESC",
    )?;
    let orders = stmt
        .query_map([id], |r| {
            Ok(ClientOrderBrief {
                id: r.get(0)?,
                code: r.get(1)?,
                title: r.get(2)?,
                status: r.get(3)?,
                current_stage_title: None,
                amount_cents: r.get(5)?,
                created_at: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    // 阶段名称需要从订单流程里取，单独补上，避免在 SQL 里拼 JSON。
    let mut enriched = Vec::with_capacity(orders.len());
    for mut brief in orders {
        let title: Option<String> = conn
            .query_row(
                "SELECT s.title FROM orders_visible o
                 JOIN order_stages s ON s.order_id = o.id AND s.stage_id = o.current_stage_id
                 WHERE o.id = ?1",
                [&brief.id],
                |r| r.get(0),
            )
            .optional()?;
        brief.current_stage_title = title;
        enriched.push(brief);
    }

    Ok(ClientDetail {
        client,
        orders: enriched,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateClientInput {
    pub display_name: String,
    pub contact: Option<String>,
    pub note: Option<String>,
}

pub fn create(conn: &Connection, input: CreateClientInput) -> AppResult<ClientView> {
    let name = clean_name(&input.display_name)?;
    let contact = clean_optional(&input.contact, 200, "客户联系方式")?;
    let note = clean_optional(&input.note, 2000, "客户备注")?;
    let now = timezone::now_timestamp();
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO clients (id, display_name, contact, note, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)",
        params![id, name, contact, note, now],
    )?;
    read_one(conn, &id)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateClientInput {
    pub client_id: String,
    pub expected_revision: i64,
    pub display_name: String,
    pub contact: Option<String>,
    pub note: Option<String>,
}

pub fn update(conn: &mut Connection, input: UpdateClientInput) -> AppResult<ClientView> {
    let name = clean_name(&input.display_name)?;
    let contact = clean_optional(&input.contact, 200, "客户联系方式")?;
    let note = clean_optional(&input.note, 2000, "客户备注")?;

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    visibility::require_visible_client(&tx, &input.client_id)?;
    let current = tx
        .query_row(
            "SELECT display_name, contact, note, revision FROM clients WHERE id = ?1",
            [&input.client_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("客户不存在"))?;

    let unchanged = current.0 == name && current.1 == contact && current.2 == note;
    if unchanged {
        let view = read_one(&tx, &input.client_id)?;
        tx.commit()?;
        return Ok(view);
    }
    if current.3 != input.expected_revision {
        return Err(AppError::conflict(format!(
            "客户资料已被修改（当前版本 {}，你基于 {}）。请刷新后重试。",
            current.3, input.expected_revision
        )));
    }

    let now = timezone::now_timestamp();
    let changed = tx.execute(
        "UPDATE clients SET display_name = ?1, contact = ?2, note = ?3,
                revision = revision + 1, updated_at = ?4
         WHERE id = ?5 AND revision = ?6",
        params![name, contact, note, now, input.client_id, input.expected_revision],
    )?;
    if changed != 1 {
        return Err(AppError::conflict("客户资料保存被并发修改阻断"));
    }

    let view = read_one(&tx, &input.client_id)?;
    tx.commit()?;
    Ok(view)
}
