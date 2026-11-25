//! 订单：创建、资料整体保存、读取。

use chrono_tz::Tz;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::domain::attachments;
use crate::domain::deadline::{self, DeadlineState};
use crate::domain::events::{self, NewEvent};
use crate::domain::lifecycle::{self, Capabilities, WorkState};
use crate::domain::numbering;
use crate::domain::queue;
use crate::error::{AppError, AppResult};
use crate::store::highwater::HighWater;
use crate::store::paths::Layout;
use crate::store::settings;
use crate::store::timezone;
use crate::store::visibility;

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
    /// 归档时间；`Some` 表示已从「订单信息」的普通列表收起。
    /// 只影响该列表的归属，不影响客户、工作台、日历与统计。
    pub archived_at: Option<String>,
    /// 置顶时间；`Some` 只说明「曾经置顶」。是否**有效**还要看状态与归档，
    /// 判据统一为 `PIN_EFFECTIVE_SQL`，见该常量的说明。
    pub pinned_at: Option<String>,
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
                o.revision, o.created_at, o.updated_at, o.source, o.stage_template_id,
                o.archived_at, o.pinned_at
         FROM orders_visible o
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
                r.get::<_, Option<String>>(21)?,
                r.get::<_, Option<String>>(22)?,
            ))
        },
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("订单不存在"))?;

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
        archived_at: row.21,
        pinned_at: row.22,
        capabilities: caps,
    })
}

/// 活动订单按队列顺序在前，终态订单按更新时间在后。
pub fn list(conn: &Connection) -> AppResult<Vec<OrderView>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM orders_visible
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
    Ok(conn.query_row("SELECT COUNT(*) FROM orders_visible", [], |r| r.get(0))?)
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

// ---------------------------------------------------------------- 插入活动订单（创建与复制共用）

/// 一笔新活动订单的最小组成：订单行 + 阶段快照 + 队列位置 + 创建事件。
///
/// 创建（阶段来自模板）与复制（阶段来自来源订单的快照）差别只在阶段来源，
/// 其余必须完全一致，所以收敛到这一个函数里，避免两条 INSERT 各自漂移。
struct ActiveOrderRow<'a> {
    id: &'a str,
    code: &'a str,
    title: &'a str,
    client_id: Option<&'a str>,
    commission_type: Option<&'a str>,
    source: Option<&'a str>,
    amount_cents: Option<i64>,
    note: Option<&'a str>,
    template_id: &'a str,
    current_stage_id: &'a str,
    planned_start_date: Option<&'a str>,
    planned_delivery_date: Option<&'a str>,
    request_id: Option<&'a str>,
    now: &'a str,
}

fn insert_active_order(
    tx: &rusqlite::Transaction<'_>,
    row: ActiveOrderRow<'_>,
    stages: &[(String, String, i64)],
    queue_insert_position: Option<i64>,
) -> AppResult<()> {
    if stages.is_empty() {
        return Err(AppError::invalid("订单没有可用的制作阶段"));
    }

    // 先落一个临时位置，随后由 queue::insert_new 统一重排为连续位置。
    let queue_position: i64 = tx.query_row(
        "SELECT COALESCE(MAX(queue_position), -1) + 1 FROM orders_visible WHERE status = 'active'",
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
            row.id,
            row.code,
            row.title,
            row.client_id,
            row.commission_type,
            row.source,
            row.amount_cents,
            row.note,
            row.template_id,
            row.current_stage_id,
            queue_position,
            row.planned_start_date,
            row.planned_delivery_date,
            row.request_id,
            row.now
        ],
    )?;

    for (stage_id, stage_title, position) in stages {
        tx.execute(
            "INSERT INTO order_stages (order_id, stage_id, title, position)
             VALUES (?1, ?2, ?3, ?4)",
            params![row.id, stage_id, stage_title, position],
        )?;
    }

    queue::insert_new(tx, row.id, queue_insert_position)?;

    events::append(
        tx,
        row.id,
        &NewEvent {
            kind: events::CREATED,
            to_stage_id: Some(&stages[0].0),
            to_stage_title: Some(&stages[0].1),
            to_status: Some(lifecycle::STATUS_ACTIVE),
            occurred_at: row.now,
            ..Default::default()
        },
    )?;

    Ok(())
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
            visibility::require_visible_client(conn, client_id)?;
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

    insert_active_order(
        &tx,
        ActiveOrderRow {
            id: &order_id,
            code: &code,
            title: &title,
            client_id: client_id.as_deref(),
            commission_type: commission_type.as_deref(),
            source: source.as_deref(),
            amount_cents: input.amount_cents,
            note: note.as_deref(),
            template_id: &template_id,
            current_stage_id: &first_stage_id,
            planned_start_date: start_date.as_deref(),
            planned_delivery_date: delivery_date.as_deref(),
            request_id: request_id.as_deref(),
            now: &now,
        },
        &steps,
        input.queue_insert_position,
    )?;

    tx.commit()?;
    load(conn, &order_id)
}

// ---------------------------------------------------------------- 复制订单

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateOrderInput {
    /// 来源订单；必须在当前可见范围内（回收站里的订单按「请先恢复」拒绝）。
    pub source_order_id: String,
    pub title: String,
    pub client_id: Option<String>,
    pub commission_type: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    pub amount_cents: Option<i64>,
    pub note: Option<String>,
    /// 默认由界面勾选；false 时不复制任何附件。
    #[serde(default)]
    pub copy_attachments: bool,
    pub request_id: Option<String>,
}

/// 从一笔已有订单复制出一笔**全新的活动订单**。
///
/// 复制的是「资料」，不是「历史」：
/// - 资料（标题、客户、委托类型、来源、金额、备注）按界面提交值落库；
/// - 流程取来源订单**当时保存的阶段快照**，不重新读模板；
/// - 当前阶段、开工/完成时间、计划日期、事件历史一律重置；
/// - 附件做真正的文件副本（新 ID、新路径、字节与 SHA-256 不变）。
///
/// 来源订单只读，不会被修改。
pub fn duplicate_order(
    conn: &mut Connection,
    hw: &HighWater,
    tz: Tz,
    layout: &Layout,
    generation: &str,
    input: DuplicateOrderInput,
) -> AppResult<OrderView> {
    // 回收站里的订单回「请先恢复」，不回「不存在」——与其它业务读一致。
    visibility::require_visible_order(conn, &input.source_order_id)?;

    let title = clean_title(&input.title)?;
    let commission_type = clean_optional(&input.commission_type, 80, "委托类型")?;
    let source = clean_source(&input.source)?;
    let note = clean_optional(&input.note, 4000, "委托说明")?;
    validate_amount(input.amount_cents)?;
    let request_id = clean_request_id(&input.request_id)?;

    // 重复提交（连点保存）不产生第二笔副本。
    if let Some(rid) = &request_id {
        if let Some(existing) = find_by_request_id(conn, rid)? {
            return load(conn, &existing);
        }
    }

    if let Some(client_id) = &input.client_id {
        visibility::require_visible_client(conn, client_id)?;
    }

    // 模板归属沿用来源订单：阶段快照跟着它，模板使用数才对得上。
    let template_id: String = conn.query_row(
        "SELECT stage_template_id FROM orders_visible WHERE id = ?1",
        [&input.source_order_id],
        |r| r.get(0),
    )?;

    let mut stage_stmt = conn.prepare(
        "SELECT stage_id, title, position FROM order_stages
         WHERE order_id = ?1 ORDER BY position, stage_id",
    )?;
    let stages: Vec<(String, String, i64)> = stage_stmt
        .query_map([&input.source_order_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stage_stmt);
    if stages.is_empty() {
        return Err(AppError::not_found("来源订单没有制作阶段，无法复制"));
    }

    // 附件先落文件（走 attachment_jobs 的既有机制），元数据行随后与订单同事务写入。
    let source_rows = if input.copy_attachments {
        attachments::source_rows(conn, &input.source_order_id)?
    } else {
        Vec::new()
    };
    let mut staged = Vec::with_capacity(source_rows.len());
    for row in &source_rows {
        match attachments::stage_copy(conn, layout, generation, row) {
            Ok(copy) => staged.push(copy),
            Err(e) => {
                attachments::discard_staged(conn, layout, generation, &staged);
                return Err(e);
            }
        }
    }

    let now = timezone::now_timestamp();
    // 编号由独立高水位分配：绝不复用来源订单的编号。
    let code = match numbering::reserve(hw, &now, tz) {
        Ok(code) => code,
        Err(e) => {
            attachments::discard_staged(conn, layout, generation, &staged);
            return Err(e);
        }
    };

    let order_id = uuid::Uuid::new_v4().to_string();
    let first_stage_id = stages[0].0.clone();

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let written = (|| -> AppResult<()> {
        insert_active_order(
            &tx,
            ActiveOrderRow {
                id: &order_id,
                code: &code,
                title: &title,
                client_id: input.client_id.as_deref(),
                commission_type: commission_type.as_deref(),
                source: source.as_deref(),
                amount_cents: input.amount_cents,
                note: note.as_deref(),
                template_id: &template_id,
                current_stage_id: &first_stage_id,
                // 复制不继承旧排期：计划日期一律清空。
                planned_start_date: None,
                planned_delivery_date: None,
                request_id: request_id.as_deref(),
                now: &now,
            },
            &stages,
            // 追加到活动队列末尾。
            None,
        )?;
        for item in &staged {
            attachments::attach_staged(&tx, &order_id, item)?;
        }
        Ok(())
    })();

    match written {
        Ok(()) => tx.commit()?,
        Err(e) => {
            // 事务回滚后，把已经落盘的副本文件删掉：不留半个副本，也不留孤立文件。
            drop(tx);
            attachments::discard_staged(conn, layout, generation, &staged);
            return Err(e);
        }
    }

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
    /// `calendar` | `order_details`；缺省视为订单详情。
    #[serde(default)]
    pub change_source: Option<String>,
    /// 改期原因，选填。
    #[serde(default)]
    pub reason: Option<String>,
}

/// 一次整体保存"资料"字段。不写制作历史；不改阶段、不改开工记录。
///
/// 例外：计划日期发生实际改动时，会在同一个事务里追加一条 `rescheduled` 事件。
pub fn update_details(conn: &mut Connection, input: UpdateDetailsInput) -> AppResult<OrderView> {
    let title = clean_title(&input.title)?;
    let commission_type = clean_optional(&input.commission_type, 80, "委托类型")?;
    let source = clean_source(&input.source)?;
    let note = clean_optional(&input.note, 4000, "委托说明")?;
    validate_amount(input.amount_cents)?;
    let start_date = clean_date(&input.planned_start_date, "计划开始日期")?;
    let delivery_date = clean_date(&input.planned_delivery_date, "预计交付日期")?;
    validate_date_order(&start_date, &delivery_date)?;
    let change_source = input
        .change_source
        .as_deref()
        .unwrap_or("order_details")
        .trim()
        .to_string();
    events::require_change_source(&change_source)?;
    let reason = clean_optional(&input.reason, 200, "改期原因")?;
    let client_id = match &input.client_id {
        None => None,
        Some(id) if id.trim().is_empty() => None,
        Some(id) => Some(id.trim().to_string()),
    };

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    visibility::require_visible_order(&tx, &input.order_id)?;

    let current = tx
        .query_row(
            "SELECT title, client_id, commission_type, amount_cents, note,
                    planned_start_date, planned_delivery_date, revision, source, status
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
                    r.get::<_, String>(9)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("订单不存在"))?;

    if let Some(id) = &client_id {
        visibility::require_visible_client(&tx, id)?;
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

    let dates_changed = current.5 != start_date || current.6 != delivery_date;
    if dates_changed && current.9 != "active" {
        return Err(AppError::invalid(
            "已结束的订单不能改期：请先在订单详情重新打开并进入返工",
        ));
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

    // 日期确有改动才写历史；与订单更新同事务，失败一起回滚。
    if dates_changed {
        events::append_reschedule(
            &tx,
            &input.order_id,
            current.5.as_deref(),
            current.6.as_deref(),
            start_date.as_deref(),
            delivery_date.as_deref(),
            reason.as_deref(),
            &change_source,
            &now,
        )?;
    }

    let view = load(&tx, &input.order_id)?;
    tx.commit()?;
    Ok(view)
}

// ---------------------------------------------------------------- 归档

/// 归档 / 取消归档。
///
/// 归档是收纳，不是业务变更：
/// - 只写 `archived_at`，不碰 `status`、阶段、金额、排期、附件，也不写事件；
/// - 不动 `revision`：归档不是编辑，不应该让正在编辑的人保存失败；
/// - 只有已完成订单能归档；取消归档对任何已归档订单都允许，
///   这样「归档后又被重新打开」的订单仍然可以取回。
pub fn set_archived(
    conn: &mut Connection,
    order_id: &str,
    archived: bool,
) -> AppResult<OrderView> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    visibility::require_visible_order(&tx, order_id)?;

    let (status, current): (String, Option<String>) = tx.query_row(
        "SELECT status, archived_at FROM orders_visible WHERE id = ?1",
        [order_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;

    if archived {
        if status != lifecycle::STATUS_COMPLETE {
            return Err(AppError::invalid(
                "只有已完成的订单可以归档；进行中或已取消的订单请先处理业务状态",
            ));
        }
        if current.is_none() {
            tx.execute(
                "UPDATE orders SET archived_at = ?1, pinned_at = NULL WHERE id = ?2",
                params![timezone::now_timestamp(), order_id],
            )?;
        }
    } else if current.is_some() {
        tx.execute(
            "UPDATE orders SET archived_at = NULL, pinned_at = NULL WHERE id = ?1",
            params![order_id],
        )?;
    }

    let view = load(&tx, order_id)?;
    tx.commit()?;
    Ok(view)
}

// ---------------------------------------------------------------- 置顶

/// 最多同时置顶的活动订单数。
pub const MAX_PINNED: i64 = 5;

/// 「有效置顶」的唯一判据。
///
/// `pinned_at` 非空只说明历史上置过顶：完成、取消、归档、进回收站都会清空它。
/// 但**不能只依赖清理**——漏一处就会出现第六个置顶，或者一个看不见的订单占着名额。
/// 数量上限、列表分组、界面标记三处都过这个条件，结论才会一致。
/// 查询一律走 `orders_visible`，因此 `deleted_at` 已由视图排除。
pub const PIN_EFFECTIVE_SQL: &str =
    "pinned_at IS NOT NULL AND status = 'active' AND archived_at IS NULL";

pub fn pinned_count(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row(
        &format!("SELECT COUNT(*) FROM orders_visible WHERE {PIN_EFFECTIVE_SQL}"),
        [],
        |r| r.get(0),
    )?)
}

/// 置顶。已置顶时幂等返回，不重复消耗名额、也不刷新时间。
pub fn pin(conn: &mut Connection, order_id: &str) -> AppResult<OrderView> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    visibility::require_visible_order(&tx, order_id)?;

    let (status, archived, pinned): (String, Option<String>, Option<String>) = tx.query_row(
        "SELECT status, archived_at, pinned_at FROM orders_visible WHERE id = ?1",
        [order_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?;
    if status != lifecycle::STATUS_ACTIVE {
        return Err(AppError::invalid("只有进行中的订单可以置顶"));
    }
    if archived.is_some() {
        return Err(AppError::invalid("已归档的订单不能置顶"));
    }

    if pinned.is_none() {
        if pinned_count(&tx)? >= MAX_PINNED {
            return Err(AppError::invalid(format!(
                "最多只能置顶 {MAX_PINNED} 个订单，请先取消其他订单的置顶。"
            )));
        }
        tx.execute(
            "UPDATE orders SET pinned_at = ?1 WHERE id = ?2",
            params![timezone::now_timestamp(), order_id],
        )?;
    }

    let view = load(&tx, order_id)?;
    tx.commit()?;
    Ok(view)
}

/// 取消置顶。不改 queue_position，也不改订单状态。
pub fn unpin(conn: &mut Connection, order_id: &str) -> AppResult<OrderView> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    visibility::require_visible_order(&tx, order_id)?;
    tx.execute(
        "UPDATE orders SET pinned_at = NULL WHERE id = ?1",
        params![order_id],
    )?;
    let view = load(&tx, order_id)?;
    tx.commit()?;
    Ok(view)
}
