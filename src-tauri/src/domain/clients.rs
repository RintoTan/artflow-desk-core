//! 客户档案：轻量资料 + 关联订单历史。
//!
//! 同名客户**不自动合并**：客户身份由稳定 ID 决定，名称只是显示值。
//! 改名字不会影响订单的关联，订单读取时通过 JOIN 拿到最新名称。

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::store::timezone;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientView {
    pub id: String,
    pub display_name: String,
    pub contact: Option<String>,
    pub note: Option<String>,
    pub revision: i64,
    pub order_count: i64,
    pub active_count: i64,
    pub completed_count: i64,
    pub created_at: String,
    pub updated_at: String,
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
    conn.query_row(
        "SELECT c.id, c.display_name, c.contact, c.note, c.revision,
                (SELECT COUNT(*) FROM orders o WHERE o.client_id = c.id),
                (SELECT COUNT(*) FROM orders o WHERE o.client_id = c.id AND o.status = 'active'),
                (SELECT COUNT(*) FROM orders o WHERE o.client_id = c.id AND o.status = 'complete'),
                c.created_at, c.updated_at
         FROM clients c WHERE c.id = ?1",
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
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("客户不存在"))
}

pub fn list(conn: &Connection) -> AppResult<Vec<ClientView>> {
    let mut stmt = conn.prepare("SELECT id FROM clients ORDER BY display_name, id")?;
    let ids: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    ids.iter().map(|id| read_one(conn, id)).collect()
}

pub fn detail(conn: &Connection, id: &str) -> AppResult<ClientDetail> {
    let client = read_one(conn, id)?;
    let mut stmt = conn.prepare(
        "SELECT o.id, o.code, o.title, o.status, o.current_stage_id, o.amount_cents, o.created_at
         FROM orders o WHERE o.client_id = ?1
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
                "SELECT s.title FROM orders o
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
