//! 订单生命周期：能力判定与状态转移。
//!
//! 所有"能不能做"的判断只在这里实现一次，命令层和读取接口都读同一份结论，
//! 避免不同入口给出互相矛盾的前置条件。

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::Serialize;

use crate::domain::events::{self, NewEvent};
use crate::domain::orders::{self, OrderView};
use crate::domain::queue;
use crate::error::{AppError, AppResult};
use crate::store::timezone;

pub const STATUS_ACTIVE: &str = "active";
pub const STATUS_COMPLETE: &str = "complete";
pub const STATUS_CANCELLED: &str = "cancelled";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkState {
    /// 活动且没有有效开工记录
    Queued,
    /// 活动且已经开工
    InProgress,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub can_start_work: bool,
    pub can_undo_start_work: bool,
    pub undo_blocked_reason: Option<String>,
    pub can_advance: bool,
    pub can_rework: bool,
    /// 是否存在"至少跨过一个中间阶段"的前向目标。
    pub can_skip: bool,
    pub can_complete: bool,
    pub can_cancel: bool,
    pub can_reopen: bool,
    pub can_edit_workflow: bool,
}

/// 一张订单的生命周期事实（从数据库读出的那一份）。
#[derive(Debug, Clone)]
pub struct Facts {
    pub id: String,
    pub status: String,
    pub started_at: Option<String>,
    pub current_stage_id: Option<String>,
    pub revision: i64,
    /// 当前流程的阶段（按 position 排序）：(id, title)
    pub stages: Vec<(String, String)>,
    pub current_index: Option<usize>,
    pub last_work_started_id: Option<i64>,
    pub stage_moved_since_start: bool,
}

pub fn work_state(facts: &Facts) -> WorkState {
    match facts.status.as_str() {
        STATUS_COMPLETE => WorkState::Completed,
        STATUS_CANCELLED => WorkState::Cancelled,
        _ if facts.started_at.is_some() => WorkState::InProgress,
        _ => WorkState::Queued,
    }
}

pub fn load_facts(conn: &Connection, order_id: &str) -> AppResult<Facts> {
    let row = conn
        .query_row(
            "SELECT status, started_at, current_stage_id, revision FROM orders WHERE id = ?1",
            [order_id],
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
        .ok_or_else(|| AppError::not_found("订单不存在"))?;

    let stages = orders::stages(conn, order_id)?;
    let current_index = row
        .2
        .as_ref()
        .and_then(|id| stages.iter().position(|(sid, _)| sid == id));

    let last_work_started_id = events::last_work_started_id(conn, order_id)?;
    let stage_moved_since_start = match (row.1.as_ref(), last_work_started_id) {
        (Some(_), Some(id)) => events::stage_moved_after(conn, order_id, id)?,
        _ => false,
    };

    Ok(Facts {
        id: order_id.to_string(),
        status: row.0,
        started_at: row.1,
        current_stage_id: row.2,
        revision: row.3,
        stages,
        current_index,
        last_work_started_id,
        stage_moved_since_start,
    })
}

pub fn capabilities(facts: &Facts) -> Capabilities {
    let active = facts.status == STATUS_ACTIVE;
    let started = facts.started_at.is_some();
    let index = facts.current_index;
    let last_index = facts.stages.len().checked_sub(1);
    let at_first = index == Some(0);
    let at_last = index.is_some() && index == last_index;

    let undo_blocked_reason = if !active {
        Some("订单已完成或已取消，不能撤销开工".to_string())
    } else if !started {
        Some("订单尚未开工".to_string())
    } else if facts.last_work_started_id.is_none() {
        Some("找不到对应的开工记录".to_string())
    } else if !at_first {
        Some("当前阶段不是流程的第一阶段".to_string())
    } else if facts.stage_moved_since_start {
        Some("本次开工之后已经推进或返工过，不能撤销开工".to_string())
    } else {
        None
    };

    Capabilities {
        can_start_work: active && !started,
        can_undo_start_work: undo_blocked_reason.is_none(),
        undo_blocked_reason,
        can_advance: active && started && index.map(|i| i < last_index.unwrap_or(0)).unwrap_or(false),
        can_rework: active && started && index.map(|i| i > 0).unwrap_or(false),
        can_skip: active
            && started
            && index
                .map(|i| last_index.map(|last| i + 1 < last).unwrap_or(false))
                .unwrap_or(false),
        can_complete: active && started && at_last,
        can_cancel: active,
        can_reopen: !active,
        can_edit_workflow: active,
    }
}

// ---------------------------------------------------------------- 输入

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleInput {
    pub order_id: String,
    pub expected_revision: i64,
    /// 幂等键：同一个 request_id 重复提交不会重复写入事件。
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipInput {
    pub order_id: String,
    pub expected_revision: i64,
    /// 目标阶段必须属于该订单自己的 `order_stages`。
    pub target_stage_id: String,
    /// 选填跳级原因；与改期原因分开存。
    pub reason: Option<String>,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReworkInput {
    pub order_id: String,
    pub expected_revision: i64,
    /// 目标阶段；None = 回退一步。
    pub target_stage_id: Option<String>,
    pub request_id: Option<String>,
}

fn assert_revision(facts: &Facts, expected: i64) -> AppResult<()> {
    if facts.revision != expected {
        return Err(AppError::conflict(format!(
            "订单已被修改（当前版本 {}，你基于 {}）。请刷新后重试。",
            facts.revision, expected
        )));
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

/// 幂等短路：如果该 request_id 已经落过事件，直接返回当前订单。
fn already_applied(tx: &Transaction<'_>, order_id: &str, request_id: &Option<String>) -> AppResult<bool> {
    match request_id {
        None => Ok(false),
        Some(rid) => events::request_already_applied(tx, order_id, rid),
    }
}

fn bump_queue_revision(tx: &Connection) -> AppResult<()> {
    tx.execute("UPDATE queue_state SET revision = revision + 1 WHERE id = 1", [])?;
    Ok(())
}

// ---------------------------------------------------------------- 开始制作

pub fn start_work(conn: &mut Connection, input: LifecycleInput) -> AppResult<OrderView> {
    let request_id = clean_request_id(&input.request_id)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if already_applied(&tx, &input.order_id, &request_id)? {
        let view = orders::load(&tx, &input.order_id)?;
        tx.commit()?;
        return Ok(view);
    }

    let facts = load_facts(&tx, &input.order_id)?;
    assert_revision(&facts, input.expected_revision)?;
    let caps = capabilities(&facts);
    if !caps.can_start_work {
        return Err(AppError::invalid(match facts.status.as_str() {
            STATUS_COMPLETE => "订单已完成，不能开始制作".to_string(),
            STATUS_CANCELLED => "订单已取消，不能开始制作".to_string(),
            _ => "订单已经开始制作".to_string(),
        }));
    }

    let now = timezone::now_timestamp();
    let changed = tx.execute(
        "UPDATE orders SET started_at = ?1, revision = revision + 1, updated_at = ?1
         WHERE id = ?2 AND revision = ?3",
        params![now, input.order_id, input.expected_revision],
    )?;
    if changed != 1 {
        return Err(AppError::conflict("开工被并发修改阻断，请刷新后重试"));
    }

    let stage = facts
        .stages
        .iter()
        .find(|(sid, _)| Some(sid) == facts.current_stage_id.as_ref())
        .cloned();
    events::append(
        &tx,
        &input.order_id,
        &NewEvent {
            kind: events::WORK_STARTED,
            to_stage_id: stage.as_ref().map(|(id, _)| id.as_str()),
            to_stage_title: stage.as_ref().map(|(_, t)| t.as_str()),
            occurred_at: &now,
            request_id: request_id.as_deref(),
            ..Default::default()
        },
    )?;

    let view = orders::load(&tx, &input.order_id)?;
    tx.commit()?;
    Ok(view)
}

// ---------------------------------------------------------------- 撤销开工

pub fn undo_start_work(conn: &mut Connection, input: LifecycleInput) -> AppResult<OrderView> {
    let request_id = clean_request_id(&input.request_id)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if already_applied(&tx, &input.order_id, &request_id)? {
        let view = orders::load(&tx, &input.order_id)?;
        tx.commit()?;
        return Ok(view);
    }

    let facts = load_facts(&tx, &input.order_id)?;
    assert_revision(&facts, input.expected_revision)?;
    let caps = capabilities(&facts);
    if !caps.can_undo_start_work {
        return Err(AppError::invalid(
            caps.undo_blocked_reason
                .unwrap_or_else(|| "当前状态不允许撤销开工".to_string()),
        ));
    }

    let now = timezone::now_timestamp();
    // 只清空有效开工时间；阶段不变，历史保留。
    let changed = tx.execute(
        "UPDATE orders SET started_at = NULL, revision = revision + 1, updated_at = ?1
         WHERE id = ?2 AND revision = ?3",
        params![now, input.order_id, input.expected_revision],
    )?;
    if changed != 1 {
        return Err(AppError::conflict("撤销开工被并发修改阻断，请刷新后重试"));
    }

    events::append(
        &tx,
        &input.order_id,
        &NewEvent {
            kind: events::WORK_START_UNDONE,
            from_status: Some(STATUS_ACTIVE),
            to_status: Some(STATUS_ACTIVE),
            occurred_at: &now,
            request_id: request_id.as_deref(),
            ..Default::default()
        },
    )?;

    let view = orders::load(&tx, &input.order_id)?;
    tx.commit()?;
    Ok(view)
}

// ---------------------------------------------------------------- 推进 / 返工

fn move_to_stage(
    tx: &Transaction<'_>,
    order_id: &str,
    expected_revision: i64,
    from: &(String, String),
    to: &(String, String),
    movement: &str,
    kind: &str,
    note: Option<&str>,
    request_id: Option<&str>,
    now: &str,
) -> AppResult<()> {
    let changed = tx.execute(
        "UPDATE orders SET current_stage_id = ?1, revision = revision + 1, updated_at = ?2
         WHERE id = ?3 AND revision = ?4",
        params![to.0, now, order_id, expected_revision],
    )?;
    if changed != 1 {
        return Err(AppError::conflict("阶段变更被并发修改阻断，请刷新后重试"));
    }
    events::append(
        tx,
        order_id,
        &NewEvent {
            kind,
            from_stage_id: Some(&from.0),
            from_stage_title: Some(&from.1),
            to_stage_id: Some(&to.0),
            to_stage_title: Some(&to.1),
            movement: Some(movement),
            note,
            request_id,
            occurred_at: now,
            ..Default::default()
        },
    )?;
    Ok(())
}

pub fn advance_stage(conn: &mut Connection, input: LifecycleInput) -> AppResult<OrderView> {
    let request_id = clean_request_id(&input.request_id)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if already_applied(&tx, &input.order_id, &request_id)? {
        let view = orders::load(&tx, &input.order_id)?;
        tx.commit()?;
        return Ok(view);
    }

    let facts = load_facts(&tx, &input.order_id)?;
    assert_revision(&facts, input.expected_revision)?;
    let caps = capabilities(&facts);
    if !caps.can_advance {
        return Err(AppError::invalid(if facts.status != STATUS_ACTIVE {
            "订单已完成或已取消，不能推进".to_string()
        } else if facts.started_at.is_none() {
            "订单尚未开始制作，不能推进阶段".to_string()
        } else {
            "已经在最后一个阶段，不能继续推进；请使用「完成」".to_string()
        }));
    }

    let index = facts.current_index.expect("已校验当前阶段");
    let from = facts.stages[index].clone();
    let to = facts.stages[index + 1].clone();
    let now = timezone::now_timestamp();
    move_to_stage(
        &tx,
        &input.order_id,
        input.expected_revision,
        &from,
        &to,
        "forward",
        events::STAGE_ADVANCED,
        None,
        request_id.as_deref(),
        &now,
    )?;

    let view = orders::load(&tx, &input.order_id)?;
    tx.commit()?;
    Ok(view)
}

pub fn rework_stage(conn: &mut Connection, input: ReworkInput) -> AppResult<OrderView> {
    let request_id = clean_request_id(&input.request_id)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if already_applied(&tx, &input.order_id, &request_id)? {
        let view = orders::load(&tx, &input.order_id)?;
        tx.commit()?;
        return Ok(view);
    }

    let facts = load_facts(&tx, &input.order_id)?;
    assert_revision(&facts, input.expected_revision)?;
    let caps = capabilities(&facts);
    if !caps.can_rework {
        return Err(AppError::invalid(if facts.status != STATUS_ACTIVE {
            "订单已完成或已取消，不能返工".to_string()
        } else if facts.started_at.is_none() {
            "订单尚未开始制作，不能返工".to_string()
        } else {
            "已经在第一阶段，没有更早的阶段可以返工".to_string()
        }));
    }

    let index = facts.current_index.expect("已校验当前阶段");
    let target_index = match &input.target_stage_id {
        None => index - 1,
        Some(stage_id) => facts
            .stages
            .iter()
            .position(|(sid, _)| sid == stage_id)
            .ok_or_else(|| AppError::invalid("目标阶段不属于该订单的流程"))?,
    };
    if target_index >= index {
        return Err(AppError::invalid(
            "返工只能回到更早的阶段，不能跳到当前阶段或后续阶段",
        ));
    }

    let from = facts.stages[index].clone();
    let to = facts.stages[target_index].clone();
    let note = if index - target_index > 1 {
        Some("多阶段返工")
    } else {
        None
    };
    let now = timezone::now_timestamp();
    move_to_stage(
        &tx,
        &input.order_id,
        input.expected_revision,
        &from,
        &to,
        "backward",
        events::STAGE_REWORKED,
        note,
        request_id.as_deref(),
        &now,
    )?;

    let view = orders::load(&tx, &input.order_id)?;
    tx.commit()?;
    Ok(view)
}

// ---------------------------------------------------------------- 跳级

/// 被跳过阶段在事件里的快照。名称按跳级当时的 `order_stages` 取值，
/// 之后改模板或改阶段名都不会影响这条历史。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct SkippedStage {
    stage_id: String,
    title: String,
    position: i64,
}

fn clean_skip_reason(raw: &Option<String>) -> AppResult<Option<String>> {
    match raw {
        None => Ok(None),
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            if trimmed.chars().count() > 200 {
                return Err(AppError::invalid("跳级原因不能超过 200 字"));
            }
            Ok(Some(trimmed.to_string()))
        }
    }
}

/// 受控跳级：一次越过一个或多个中间阶段，只改当前阶段。
///
/// 与 `advance_stage` 的区别是语义，不是实现细节：推进永远只走一步，
/// 跳级必须至少跨过一个中间阶段，并把被跳过的阶段快照写进事件。
pub fn skip_stage(conn: &mut Connection, input: SkipInput) -> AppResult<OrderView> {
    let request_id = clean_request_id(&input.request_id)?;
    let reason = clean_skip_reason(&input.reason)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if already_applied(&tx, &input.order_id, &request_id)? {
        let view = orders::load(&tx, &input.order_id)?;
        tx.commit()?;
        return Ok(view);
    }

    let facts = load_facts(&tx, &input.order_id)?;
    assert_revision(&facts, input.expected_revision)?;
    if facts.status != STATUS_ACTIVE {
        return Err(AppError::invalid(
            "订单已完成或已取消，不能跳级".to_string(),
        ));
    }
    if facts.started_at.is_none() {
        return Err(AppError::invalid(
            "订单尚未开始制作，不能跳级阶段".to_string(),
        ));
    }
    let index = facts
        .current_index
        .ok_or_else(|| AppError::invalid("订单当前没有阶段，请先在资料里检查流程"))?;

    let target_index = facts
        .stages
        .iter()
        .position(|(sid, _)| sid == &input.target_stage_id)
        .ok_or_else(|| AppError::invalid("目标阶段不属于该订单的流程"))?;

    if target_index == index {
        return Err(AppError::invalid("目标阶段就是当前阶段，无需跳级"));
    }
    if target_index < index {
        return Err(AppError::invalid(
            "跳级只能往更后的阶段走；回到更早阶段请使用返工",
        ));
    }
    if target_index == index + 1 {
        return Err(AppError::invalid(
            "只跨越一个阶段请使用「推进」；跳级至少要跨过一个中间阶段",
        ));
    }

    let skipped: Vec<SkippedStage> = facts.stages[index + 1..target_index]
        .iter()
        .enumerate()
        .map(|(offset, (sid, title))| SkippedStage {
            stage_id: sid.clone(),
            title: title.clone(),
            position: (index + 1 + offset) as i64,
        })
        .collect();
    let skipped_json = serde_json::to_string(&skipped)
        .map_err(|e| AppError::invalid(format!("跳级快照序列化失败：{e}")))?;

    let from = facts.stages[index].clone();
    let to = facts.stages[target_index].clone();
    let now = timezone::now_timestamp();

    let changed = tx.execute(
        "UPDATE orders SET current_stage_id = ?1, revision = revision + 1, updated_at = ?2
         WHERE id = ?3 AND revision = ?4",
        params![to.0, now, input.order_id, input.expected_revision],
    )?;
    if changed != 1 {
        return Err(AppError::conflict("阶段跳级被并发修改阻断，请刷新后重试"));
    }

    events::append(
        &tx,
        &input.order_id,
        &NewEvent {
            kind: events::STAGE_SKIPPED,
            from_stage_id: Some(&from.0),
            from_stage_title: Some(&from.1),
            to_stage_id: Some(&to.0),
            to_stage_title: Some(&to.1),
            movement: Some("forward"),
            request_id: request_id.as_deref(),
            skipped_stages: Some(&skipped_json),
            skip_reason: reason.as_deref(),
            occurred_at: &now,
            ..Default::default()
        },
    )?;

    let view = orders::load(&tx, &input.order_id)?;
    tx.commit()?;
    Ok(view)
}

// ---------------------------------------------------------------- 完成 / 取消

pub fn complete_order(conn: &mut Connection, input: LifecycleInput) -> AppResult<OrderView> {
    let request_id = clean_request_id(&input.request_id)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if already_applied(&tx, &input.order_id, &request_id)? {
        let view = orders::load(&tx, &input.order_id)?;
        tx.commit()?;
        return Ok(view);
    }

    let facts = load_facts(&tx, &input.order_id)?;
    assert_revision(&facts, input.expected_revision)?;
    let caps = capabilities(&facts);
    if !caps.can_complete {
        return Err(AppError::invalid(if facts.status != STATUS_ACTIVE {
            "订单已完成或已取消".to_string()
        } else if facts.started_at.is_none() {
            "订单尚未开始制作，不能完成".to_string()
        } else {
            "订单还在中间阶段，必须先推进到最后一个阶段".to_string()
        }));
    }

    let now = timezone::now_timestamp();
    let changed = tx.execute(
        "UPDATE orders SET status = ?1, completed_at = ?2, revision = revision + 1, updated_at = ?2
         WHERE id = ?3 AND revision = ?4",
        params![STATUS_COMPLETE, now, input.order_id, input.expected_revision],
    )?;
    if changed != 1 {
        return Err(AppError::conflict("完成操作被并发修改阻断，请刷新后重试"));
    }

    let stage = facts
        .stages
        .iter()
        .find(|(sid, _)| Some(sid) == facts.current_stage_id.as_ref())
        .cloned();
    events::append(
        &tx,
        &input.order_id,
        &NewEvent {
            kind: events::COMPLETED,
            from_stage_id: stage.as_ref().map(|(id, _)| id.as_str()),
            from_stage_title: stage.as_ref().map(|(_, t)| t.as_str()),
            from_status: Some(STATUS_ACTIVE),
            to_status: Some(STATUS_COMPLETE),
            occurred_at: &now,
            request_id: request_id.as_deref(),
            ..Default::default()
        },
    )?;
    bump_queue_revision(&tx)?;

    let view = orders::load(&tx, &input.order_id)?;
    tx.commit()?;
    Ok(view)
}

pub fn cancel_order(conn: &mut Connection, input: LifecycleInput) -> AppResult<OrderView> {
    let request_id = clean_request_id(&input.request_id)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if already_applied(&tx, &input.order_id, &request_id)? {
        let view = orders::load(&tx, &input.order_id)?;
        tx.commit()?;
        return Ok(view);
    }

    let facts = load_facts(&tx, &input.order_id)?;
    assert_revision(&facts, input.expected_revision)?;
    if !capabilities(&facts).can_cancel {
        return Err(AppError::invalid("只有活动订单可以取消"));
    }

    let now = timezone::now_timestamp();
    // 取消不补记开工时间。
    let changed = tx.execute(
        "UPDATE orders SET status = ?1, cancelled_at = ?2, revision = revision + 1, updated_at = ?2
         WHERE id = ?3 AND revision = ?4",
        params![STATUS_CANCELLED, now, input.order_id, input.expected_revision],
    )?;
    if changed != 1 {
        return Err(AppError::conflict("取消操作被并发修改阻断，请刷新后重试"));
    }

    let stage = facts
        .stages
        .iter()
        .find(|(sid, _)| Some(sid) == facts.current_stage_id.as_ref())
        .cloned();
    events::append(
        &tx,
        &input.order_id,
        &NewEvent {
            kind: events::CANCELLED,
            from_stage_id: stage.as_ref().map(|(id, _)| id.as_str()),
            from_stage_title: stage.as_ref().map(|(_, t)| t.as_str()),
            from_status: Some(STATUS_ACTIVE),
            to_status: Some(STATUS_CANCELLED),
            occurred_at: &now,
            request_id: request_id.as_deref(),
            ..Default::default()
        },
    )?;
    bump_queue_revision(&tx)?;

    let view = orders::load(&tx, &input.order_id)?;
    tx.commit()?;
    Ok(view)
}

// ---------------------------------------------------------------- 重新打开

pub fn reopen_order(conn: &mut Connection, input: LifecycleInput) -> AppResult<OrderView> {
    let request_id = clean_request_id(&input.request_id)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if already_applied(&tx, &input.order_id, &request_id)? {
        let view = orders::load(&tx, &input.order_id)?;
        tx.commit()?;
        return Ok(view);
    }

    let facts = load_facts(&tx, &input.order_id)?;
    assert_revision(&facts, input.expected_revision)?;
    if !capabilities(&facts).can_reopen {
        return Err(AppError::invalid("只有已完成或已取消的订单可以重新打开"));
    }
    let previous_status = facts.status.clone();

    let now = timezone::now_timestamp();
    // 保留当前阶段与有效开工记录；清空终态时间。
    // 队列位置交给 queue::insert_new 统一追加并重排，保持活动队列位置连续。
    let changed = tx.execute(
        "UPDATE orders
         SET status = ?1, completed_at = NULL, cancelled_at = NULL,
             revision = revision + 1, updated_at = ?2
         WHERE id = ?3 AND revision = ?4",
        params![STATUS_ACTIVE, now, input.order_id, input.expected_revision],
    )?;
    if changed != 1 {
        return Err(AppError::conflict("重新打开被并发修改阻断，请刷新后重试"));
    }

    queue::insert_new(&tx, &input.order_id, None)?;

    events::append(
        &tx,
        &input.order_id,
        &NewEvent {
            kind: events::REOPENED,
            from_status: Some(&previous_status),
            to_status: Some(STATUS_ACTIVE),
            note: Some("重新打开后加入活动队列末尾"),
            occurred_at: &now,
            request_id: request_id.as_deref(),
            ..Default::default()
        },
    )?;
    bump_queue_revision(&tx)?;

    let view = orders::load(&tx, &input.order_id)?;
    tx.commit()?;
    Ok(view)
}

/// 供测试与诊断：当前队列版本。
pub fn queue_revision(conn: &Connection) -> AppResult<i64> {
    Ok(conn.query_row("SELECT revision FROM queue_state WHERE id = 1", [], |r| {
        r.get(0)
    })?)
}
