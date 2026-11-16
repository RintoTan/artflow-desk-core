//! 订单领域服务（DEV-01 范围：建立订单这一个最小写操作）。
//!
//! 完整 CRUD、推进、返工、开工、重开等属于 DEV-02，这里不实现。
//! 本模块存在的目的是证明三件事：单库承载、编号与队列分离、事件与订单同事务。

use chrono_tz::Tz;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::domain::numbering;
use crate::error::{AppError, AppResult};
use crate::store::highwater::HighWater;
use crate::store::settings;
use crate::store::timezone;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    pub id: String,
    pub code: String,
    pub title: String,
    pub client_id: Option<String>,
    pub commission_type: Option<String>,
    pub amount_cents: Option<i64>,
    pub status: String,
    pub current_stage_id: Option<String>,
    pub current_stage_title: Option<String>,
    pub queue_position: i64,
    pub planned_start_date: Option<String>,
    pub planned_delivery_date: Option<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub cancelled_at: Option<String>,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateOrderInput {
    pub title: String,
    pub client_id: Option<String>,
    pub commission_type: Option<String>,
    pub amount_cents: Option<i64>,
    pub planned_start_date: Option<String>,
    pub planned_delivery_date: Option<String>,
    pub template_id: Option<String>,
    /// 重试幂等键：相同 request_id 只会产生一张订单。
    pub request_id: Option<String>,
}

fn clean_title(raw: &str) -> AppResult<String> {
    let title = raw.trim();
    let len = title.chars().count();
    if len == 0 {
        return Err(AppError::invalid("委托标题不能为空"));
    }
    if len > 120 {
        return Err(AppError::invalid("委托标题不能超过 120 字"));
    }
    Ok(title.to_string())
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

fn clean_date(raw: &Option<String>, field: &str) -> AppResult<Option<String>> {
    match raw {
        None => Ok(None),
        Some(value) if value.trim().is_empty() => Ok(None),
        Some(value) => {
            timezone::parse_calendar_date(value).map_err(|_| {
                AppError::invalid(format!("{field}必须是 YYYY-MM-DD 格式的日历日期"))
            })?;
            Ok(Some(value.trim().to_string()))
        }
    }
}

pub fn create_order(
    conn: &mut Connection,
    hw: &HighWater,
    tz: Tz,
    input: CreateOrderInput,
) -> AppResult<Order> {
    let title = clean_title(&input.title)?;
    let commission_type = clean_optional(&input.commission_type, 80, "委托类型")?;
    if let Some(amount) = input.amount_cents {
        if amount < 0 {
            return Err(AppError::invalid("委托金额不能为负数"));
        }
    }
    let start_date = clean_date(&input.planned_start_date, "计划开始日期")?;
    let delivery_date = clean_date(&input.planned_delivery_date, "预计交付日期")?;
    if let (Some(start), Some(delivery)) = (&start_date, &delivery_date) {
        if delivery < start {
            return Err(AppError::invalid("预计交付日期不能早于计划开始日期"));
        }
    }
    let request_id = clean_optional(&input.request_id, 120, "请求标识")?;

    // 幂等：同一个 request_id 直接返回已存在的订单，不重复建单。
    if let Some(rid) = &request_id {
        if let Some(existing) = find_by_request_id(conn, rid)? {
            return read_order(conn, &existing);
        }
    }

    if let Some(client_id) = &input.client_id {
        let exists: Option<String> = conn
            .query_row("SELECT id FROM clients WHERE id = ?1", [client_id], |r| {
                r.get(0)
            })
            .optional()?;
        if exists.is_none() {
            return Err(AppError::not_found("关联的客户不存在"));
        }
    }

    let template_id = match &input.template_id {
        Some(id) => id.clone(),
        None => settings::get(conn, "default_template_id")?
            .unwrap_or_else(|| settings::DEFAULT_TEMPLATE_ID.to_string()),
    };
    let template_name: String = conn
        .query_row(
            "SELECT name FROM stage_templates WHERE id = ?1",
            [&template_id],
            |r| r.get(0),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("所选制作流程模板不存在"))?;
    let _ = template_name;

    let mut stage_stmt = conn.prepare(
        "SELECT step_id, title, position FROM stage_template_steps
         WHERE template_id = ?1 ORDER BY position, step_id",
    )?;
    let steps: Vec<(String, String, i64)> = stage_stmt
        .query_map([&template_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stage_stmt);
    if steps.is_empty() {
        return Err(AppError::invalid("所选制作流程模板没有任何阶段"));
    }

    let now = timezone::now_timestamp();
    // 编号：先持久保留，再创建订单。此处之后即使失败也只跳号，绝不复用。
    let code = numbering::reserve(hw, &now, tz)?;

    let id = uuid::Uuid::new_v4().to_string();
    let first_stage_id = steps[0].0.clone();

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

    let queue_position: i64 = tx.query_row(
        "SELECT COALESCE(MAX(queue_position), -1) + 1 FROM orders",
        [],
        |r| r.get(0),
    )?;

    tx.execute(
        "INSERT INTO orders (
            id, code, title, client_id, commission_type, amount_cents, status,
            stage_template_id, current_stage_id, queue_position,
            planned_start_date, planned_delivery_date,
            started_at, completed_at, cancelled_at, request_id,
            revision, created_at, updated_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, 'active',
            ?7, ?8, ?9,
            ?10, ?11,
            NULL, NULL, NULL, ?12,
            0, ?13, ?13
         )",
        params![
            id,
            code,
            title,
            input.client_id,
            commission_type,
            input.amount_cents,
            template_id,
            first_stage_id,
            queue_position,
            start_date,
            delivery_date,
            request_id,
            now
        ],
    )?;

    for (step_id, step_title, position) in &steps {
        tx.execute(
            "INSERT INTO order_stages (order_id, stage_id, title, position)
             VALUES (?1, ?2, ?3, ?4)",
            params![id, step_id, step_title, position],
        )?;
    }

    tx.execute(
        "INSERT INTO order_events (
            order_id, kind, from_stage_id, from_stage_title,
            to_stage_id, to_stage_title, from_status, to_status,
            movement, note, occurred_at
         ) VALUES (?1, 'created', NULL, NULL, ?2, ?3, NULL, 'active', NULL, NULL, ?4)",
        params![id, first_stage_id, steps[0].1, now],
    )?;

    tx.commit()?;

    read_order(conn, &id)
}

fn find_by_request_id(conn: &Connection, request_id: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM orders WHERE request_id = ?1",
            [request_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?)
}

pub fn read_order(conn: &Connection, id: &str) -> AppResult<Order> {
    let row = conn
        .query_row(
            "SELECT o.id, o.code, o.title, o.client_id, o.commission_type, o.amount_cents,
                    o.status, o.current_stage_id, s.title, o.queue_position,
                    o.planned_start_date, o.planned_delivery_date,
                    o.started_at, o.completed_at, o.cancelled_at,
                    o.revision, o.created_at, o.updated_at
             FROM orders o
             LEFT JOIN order_stages s ON s.order_id = o.id AND s.stage_id = o.current_stage_id
             WHERE o.id = ?1",
            [id],
            |r| {
                Ok(Order {
                    id: r.get(0)?,
                    code: r.get(1)?,
                    title: r.get(2)?,
                    client_id: r.get(3)?,
                    commission_type: r.get(4)?,
                    amount_cents: r.get(5)?,
                    status: r.get(6)?,
                    current_stage_id: r.get(7)?,
                    current_stage_title: r.get(8)?,
                    queue_position: r.get(9)?,
                    planned_start_date: r.get(10)?,
                    planned_delivery_date: r.get(11)?,
                    started_at: r.get(12)?,
                    completed_at: r.get(13)?,
                    cancelled_at: r.get(14)?,
                    revision: r.get(15)?,
                    created_at: r.get(16)?,
                    updated_at: r.get(17)?,
                })
            },
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("订单不存在"))?;
    Ok(row)
}

pub fn count_orders(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))?)
}
