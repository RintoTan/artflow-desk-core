//! 订单：创建、资料整体保存、读取。

use chrono_tz::Tz;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::domain::deadline::{self, DeadlineState};
use crate::domain::events::{self, NewEvent};
use crate::domain::lifecycle::{self, Capabilities, WorkState};
use crate::domain::numbering;
use crate::domain::queue;
use crate::error::{AppError, AppResult};
use crate::store::highwater::HighWater;
use crate::store::settings;
use crate::store::timezone;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageView {
    pub id: String,
    pub title: String,
    pub position: i64,
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderView {
    pub id: String,
    pub code: String,
    pub title: String,
    pub client_id: Option<String>,
    pub client_name: Option<String>,
    pub commission_type: Option<String>,
    /// 所属流程模板；阶段筛选必须按 (模板, 阶段) 匹配，不能只看阶段名。
    pub stage_template_id: String,
    /// 接稿渠道；可空。旧订单为 NULL = 未设置，不回填虚构值。
    pub source: Option<String>,
    pub amount_cents: Option<i64>,
    pub note: Option<String>,
    pub status: String,
    pub work_state: WorkState,
    pub current_stage_id: Option<String>,
    pub current_stage_title: Option<String>,
    pub current_stage_index: Option<i64>,
    pub stage_count: i64,
    pub stages: Vec<StageView>,
    pub queue_position: i64,
    pub planned_start_date: Option<String>,
    pub planned_delivery_date: Option<String>,
    /// 按工作时时区判定的交付风险；终态订单恒为 `scheduled`（不参与提醒）。
    pub deadline_state: DeadlineState,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub cancelled_at: Option<String>,
    pub revision: i64,
    pub created_at: String,
    pub updated_at: String,
    pub capabilities: Capabilities,
}

// ---------------------------------------------------------------- 校验

pub fn clean_title(raw: &str) -> AppResult<String> {
    let title = raw.trim();
    let count = title.chars().count();
    if count == 0 {
        return Err(AppError::invalid("委托标题不能为空"));
    }
    if count > 120 {
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

/// 来源是自由文本，但要挡住纯空白与超长值；不做枚举白名单（渠道会变）。
pub fn clean_source(raw: &Option<String>) -> AppResult<Option<String>> {
    clean_optional(raw, 40, "来源")
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

fn validate_amount(amount: Option<i64>) -> AppResult<()> {
    if let Some(value) = amount {
        if value < 0 {
            return Err(AppError::invalid("委托金额不能为负数"));
        }
    }
    Ok(())
}

fn validate_date_order(start: &Option<String>, delivery: &Option<String>) -> AppResult<()> {
    if let (Some(start), Some(delivery)) = (start, delivery) {
        if delivery < start {
            return Err(AppError::invalid("预计交付日期不能早于计划开始日期"));
        }
    }
    Ok(())
}

fn clean_request_id(raw: &Option<String>) -> AppResult<Option<String>> {
    match raw {
        None => Ok(None),
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            if trimmed.chars().count() > 120 {
                return Err(AppError::invalid("请求标识过长"));
            }
            Ok(Some(trimmed.to_string()))
        }
    }
}

// ---------------------------------------------------------------- 读取

/// 当前流程的阶段（按位置排序）。名称取订单自己的副本，不受模板影响。
pub fn stages(conn: &Connection, order_id: &str) -> AppResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT stage_id, title FROM order_stages WHERE order_id = ?1 ORDER BY position, stage_id",
    )?;
    let rows = stmt
        .query_map([order_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn load(conn: &Connection, order_id: &str) -> AppResult<OrderView> {
    let facts = lifecycle::load_facts(conn, order_id)?;
    let caps = lifecycle::capabilities(&facts);

    let row = conn.query_row(
        "SELECT o.id, o.code, o.title, o.client_id, c.display_name, o.commission_type,
                o.amount_cents, o.note, o.status, o.current_stage_id, o.queue_position,
                o.planned_start_date, o.planned_delivery_date,
                o.started_at, o.completed_at, o.cancelled_at,
                o.revision, o.created_at, o.updated_at, o.source, o.stage_template_id
         FROM orders o
         LEFT JOIN clients c ON c.id = o.client_id
         WHERE o.id = ?1",
        [order_id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<i64>>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, String>(8)?,
                r.get::<_, Option<String>>(9)?,
                r.get::<_, i64>(10)?,
                r.get::<_, Option<String>>(11)?,
                r.get::<_, Option<String>>(12)?,
                r.get::<_, Option<String>>(13)?,
                r.get::<_, Option<String>>(14)?,
                r.get::<_, Option<String>>(15)?,
                r.get::<_, i64>(16)?,
                r.get::<_, String>(17)?,
                r.get::<_, String>(18)?,
                r.get::<_, Option<String>>(19)?,
                r.get::<_, Option<String>>(20)?,
            ))
        },
    )?;

    let current_stage_id = row.9.clone();
    let stage_views: Vec<StageView> = facts
        .stages
        .iter()
        .enumerate()
        .map(|(index, (id, title))| StageView {
            id: id.clone(),
            title: title.clone(),
            position: index as i64,
            is_current: Some(id) == current_stage_id.as_ref(),
        })
        .collect();

    let current_title = facts
        .current_index
        .and_then(|i| facts.stages.get(i))
        .map(|(_, title)| title.clone());

    // 风险分类只对活动订单有意义；终态订单不进入提醒。
    let deadline_state = if row.8 == lifecycle::STATUS_ACTIVE {
        let tz = settings::working_timezone(conn).unwrap_or(chrono_tz::Tz::UTC);
        deadline::classify_str(row.12.as_deref(), tz)?
    } else {
        DeadlineState::Scheduled
    };

    Ok(OrderView {
        id: row.0,
        code: row.1,
        title: row.2,
        client_id: row.3,
        client_name: row.4,
        commission_type: row.5,
        stage_template_id: row.20.unwrap_or_default(),
        source: row.19,
        amount_cents: row.6,
        note: row.7,
        status: row.8,
        work_state: lifecycle::work_state(&facts),
        current_stage_id,
        current_stage_title: current_title,
        current_stage_index: facts.current_index.map(|i| i as i64),
        stage_count: facts.stages.len() as i64,
        stages: stage_views,
        queue_position: row.10,
        planned_start_date: row.11,
        planned_delivery_date: row.12,
        deadline_state,
        started_at: row.13,
        completed_at: row.14,
        cancelled_at: row.15,
        revision: row.16,
        created_at: row.17,
        updated_at: row.18,
        capabilities: caps,
    })
}

/// 活动订单按队列顺序在前，终态订单按更新时间在后。
pub fn list(conn: &Connection) -> AppResult<Vec<OrderView>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM orders
         ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END,
                  CASE WHEN status = 'active' THEN queue_position ELSE 0 END,
                  updated_at DESC,
                  code",
    )?;
    let ids: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    ids.iter().map(|id| load(conn, id)).collect()
}

pub fn count_orders(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))?)
}

// ---------------------------------------------------------------- 创建

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ClientChoice {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "existing")]
    Existing { client_id: String },
    #[serde(rename = "new")]
    New {
        display_name: String,
        contact: Option<String>,
        note: Option<String>,
    },
}

impl Default for ClientChoice {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateOrderInput {
    pub title: String,
    #[serde(default)]
    pub client: ClientChoice,
    pub commission_type: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    pub amount_cents: Option<i64>,
    pub planned_start_date: Option<String>,
    pub planned_delivery_date: Option<String>,
    pub note: Option<String>,
    pub template_id: Option<String>,
    pub request_id: Option<String>,
    /// 插入到活动队列的第几位；None = 追加到末尾。
    pub queue_insert_position: Option<i64>,
    /// 指定插入位置时必须提供当前队列版本，用于并发保护。
    pub expected_queue_revision: Option<i64>,
}

pub fn create_order(
    conn: &mut Connection,
    hw: &HighWater,
    tz: Tz,
    input: CreateOrderInput,
) -> AppResult<OrderView> {
    let title = clean_title(&input.title)?;
    let commission_type = clean_optional(&input.commission_type, 80, "委托类型")?;
    let source = clean_source(&input.source)?;
    let note = clean_optional(&input.note, 4000, "委托说明")?;
    validate_amount(input.amount_cents)?;
    let start_date = clean_date(&input.planned_start_date, "计划开始日期")?;
    let delivery_date = clean_date(&input.planned_delivery_date, "预计交付日期")?;
    validate_date_order(&start_date, &delivery_date)?;
    let request_id = clean_request_id(&input.request_id)?;

    if let Some(rid) = &request_id {
        if let Some(existing) = find_by_request_id(conn, rid)? {
            return load(conn, &existing);
        }
    }

    // 解析客户：已有客户 / 新建客户（与订单同事务）/ 无客户。
    let new_client = match &input.client {
        ClientChoice::None => None,
        ClientChoice::Existing { client_id } => {
            let exists: Option<String> = conn
                .query_row("SELECT id FROM clients WHERE id = ?1", [client_id], |r| {
                    r.get(0)
                })
                .optional()?;
            if exists.is_none() {
                return Err(AppError::not_found("选择的客户不存在"));
            }
            None
        }
        ClientChoice::New {
            display_name,
            contact,
            note,
        } => {
            let name = display_name.trim();
            if name.is_empty() {
                return Err(AppError::invalid("新客户名称不能为空"));
            }
            if name.chars().count() > 120 {
                return Err(AppError::invalid("客户名称不能超过 120 字"));
            }
            Some((
                name.to_string(),
                clean_optional(contact, 200, "客户联系方式")?,
                clean_optional(note, 2000, "客户备注")?,
            ))
        }
    };

    // 未指定模板时使用数据库中标记为默认的那一个（不是硬编码常量）。
    let template_id = match &input.template_id {
        Some(id) if !id.trim().is_empty() => id.trim().to_string(),
        _ => {
            let fallback: Option<String> = conn
                .query_row(
                    "SELECT id FROM stage_templates WHERE is_default = 1",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            fallback.unwrap_or_else(|| settings::DEFAULT_TEMPLATE_ID.to_string())
        }
    };

    let mut step_stmt = conn.prepare(
        "SELECT step_id, title, position FROM stage_template_steps
         WHERE template_id = ?1 ORDER BY position, step_id",
    )?;
    let steps: Vec<(String, String, i64)> = step_stmt
        .query_map([&template_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(step_stmt);
    if steps.is_empty() {
        return Err(AppError::not_found("所选制作流程模板不存在或没有阶段"));
    }

    if input.queue_insert_position.is_some() {
        let expected = input
            .expected_queue_revision
            .ok_or_else(|| AppError::invalid("指定插入位置时必须同时提供队列版本"))?;
        let actual = queue::revision(conn)?;
        if actual != expected {
            return Err(AppError::conflict(format!(
                "队列顺序已被修改（当前版本 {actual}，你基于 {expected}）。请刷新后重试。"
            )));
        }
    }

    let now = timezone::now_timestamp();
    // 编号：先持久保留，再建单。之后失败只会跳号。
    let code = numbering::reserve(hw, &now, tz)?;

    let order_id = uuid::Uuid::new_v4().to_string();
    let first_stage_id = steps[0].0.clone();
    let first_stage_title = steps[0].1.clone();

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

    let client_id: Option<String> = match (&input.client, new_client) {
        (ClientChoice::Existing { client_id }, _) => Some(client_id.clone()),
        (_, Some((name, contact, cnote))) => {
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO clients (id, display_name, contact, note, revision, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)",
                params![id, name, contact, cnote, now],
            )?;
            Some(id)
        }
        _ => None,
    };

    // 先落一个临时位置，随后由 queue::insert_new 统一重排为连续位置。
    let queue_position: i64 = tx.query_row(
        "SELECT COALESCE(MAX(queue_position), -1) + 1 FROM orders WHERE status = 'active'",
        [],
        |r| r.get(0),
    )?;

    tx.execute(
        "INSERT INTO orders (
            id, code, title, client_id, commission_type, source, amount_cents, note, status,
            stage_template_id, current_stage_id, queue_position,
            planned_start_date, planned_delivery_date,
            started_at, completed_at, cancelled_at, request_id,
            revision, created_at, updated_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active',
            ?9, ?10, ?11,
            ?12, ?13,
            NULL, NULL, NULL, ?14,
            0, ?15, ?15
         )",
        params![
            order_id,
            code,
            title,
            client_id,
            commission_type,
            source,
            input.amount_cents,
            note,
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
            params![order_id, step_id, step_title, position],
        )?;
    }

    queue::insert_new(&tx, &order_id, input.queue_insert_position)?;

    events::append(
        &tx,
        &order_id,
        &NewEvent {
            kind: events::CREATED,
            to_stage_id: Some(&first_stage_id),
            to_stage_title: Some(&first_stage_title),
            to_status: Some(lifecycle::STATUS_ACTIVE),
            occurred_at: &now,
            ..Default::default()
        },
    )?;

    tx.commit()?;
    load(conn, &order_id)
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

// ---------------------------------------------------------------- 资料整体保存

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDetailsInput {
    pub order_id: String,
    pub expected_revision: i64,
    pub title: String,
    pub client_id: Option<String>,
    pub commission_type: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    pub amount_cents: Option<i64>,
    pub planned_start_date: Option<String>,
    pub planned_delivery_date: Option<String>,
    pub note: Option<String>,
}

/// 一次整体保存"资料"字段。不写制作历史；不改阶段、不改开工记录。
pub fn update_details(conn: &mut Connection, input: UpdateDetailsInput) -> AppResult<OrderView> {
    let title = clean_title(&input.title)?;
    let commission_type = clean_optional(&input.commission_type, 80, "委托类型")?;
    let source = clean_source(&input.source)?;
    let note = clean_optional(&input.note, 4000, "委托说明")?;
    validate_amount(input.amount_cents)?;
    let start_date = clean_date(&input.planned_start_date, "计划开始日期")?;
    let delivery_date = clean_date(&input.planned_delivery_date, "预计交付日期")?;
    validate_date_order(&start_date, &delivery_date)?;
    let client_id = match &input.client_id {
        None => None,
        Some(id) if id.trim().is_empty() => None,
        Some(id) => Some(id.trim().to_string()),
    };

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

    let current = tx
        .query_row(
            "SELECT title, client_id, commission_type, amount_cents, note,
                    planned_start_date, planned_delivery_date, revision, source
             FROM orders WHERE id = ?1",
            [&input.order_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, Option<String>>(8)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("订单不存在"))?;

    if let Some(id) = &client_id {
        let exists: Option<String> = tx
            .query_row("SELECT id FROM clients WHERE id = ?1", [id], |r| r.get(0))
            .optional()?;
        if exists.is_none() {
            return Err(AppError::not_found("选择的客户不存在"));
        }
    }

    // 内容完全一致时视为保存成功，不再 bump revision。
    // 这样"保存成功但响应丢失后重试"不会误报冲突。
    let unchanged = current.0 == title
        && current.1 == client_id
        && current.2 == commission_type
        && current.3 == input.amount_cents
        && current.4 == note
        && current.5 == start_date
        && current.6 == delivery_date
        && current.8 == source;

    if unchanged {
        let view = load(&tx, &input.order_id)?;
        tx.commit()?;
        return Ok(view);
    }

    if current.7 != input.expected_revision {
        return Err(AppError::conflict(format!(
            "订单已被修改（当前版本 {}，你基于 {}）。请刷新后重试。",
            current.7, input.expected_revision
        )));
    }

    let now = timezone::now_timestamp();
    let changed = tx.execute(
        "UPDATE orders
         SET title = ?1, client_id = ?2, commission_type = ?3, amount_cents = ?4, note = ?5,
             planned_start_date = ?6, planned_delivery_date = ?7, source = ?11,
             revision = revision + 1, updated_at = ?8
         WHERE id = ?9 AND revision = ?10",
        params![
            title,
            client_id,
            commission_type,
            input.amount_cents,
            note,
            start_date,
            delivery_date,
            now,
            input.order_id,
            input.expected_revision,
            source
        ],
    )?;
    if changed != 1 {
        return Err(AppError::conflict("保存被并发修改阻断，请刷新后重试"));
    }

    let view = load(&tx, &input.order_id)?;
    tx.commit()?;
    Ok(view)
}
