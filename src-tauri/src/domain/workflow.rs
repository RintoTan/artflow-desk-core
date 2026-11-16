//! 订单独立制作流程的结构编辑。
//!
//! 只改这一张订单的阶段，不影响全局模板。阶段使用稳定 ID，重命名不改写历史快照。
//! 流程结构变更写入 `workflow_changed` 事件，且必须检查订单 `revision`。

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;

use crate::domain::events::{self, NewEvent};
use crate::domain::lifecycle::{self, STATUS_ACTIVE};
use crate::domain::orders::{self, OrderView};
use crate::error::{AppError, AppResult};
use crate::store::timezone;

fn clean_stage_title(raw: &str) -> AppResult<String> {
    let title = raw.trim();
    let count = title.chars().count();
    if count == 0 {
        return Err(AppError::invalid("阶段名称不能为空"));
    }
    if count > 80 {
        return Err(AppError::invalid("阶段名称不能超过 80 字"));
    }
    Ok(title.to_string())
}

struct Frame {
    stages: Vec<(String, String)>,
    current_stage_id: Option<String>,
    revision: i64,
    status: String,
}

fn load_frame(tx: &Connection, order_id: &str) -> AppResult<Frame> {
    let row = tx
        .query_row(
            "SELECT current_stage_id, revision, status FROM orders WHERE id = ?1",
            [order_id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("订单不存在"))?;

    Ok(Frame {
        stages: orders::stages(tx, order_id)?,
        current_stage_id: row.0,
        revision: row.1,
        status: row.2,
    })
}

fn assert_editable(frame: &Frame, expected_revision: i64) -> AppResult<()> {
    if frame.status != STATUS_ACTIVE {
        return Err(AppError::invalid(
            "订单已完成或已取消，不能修改制作流程",
        ));
    }
    if frame.revision != expected_revision {
        return Err(AppError::conflict(format!(
            "订单已被修改（当前版本 {}，你基于 {}）。请刷新后重试。",
            frame.revision, expected_revision
        )));
    }
    Ok(())
}

fn ensure_unique_titles(stages: &[(String, String)]) -> AppResult<()> {
    let mut seen: Vec<&str> = Vec::new();
    for (_, title) in stages {
        if seen.contains(&title.as_str()) {
            return Err(AppError::invalid(format!("同一流程内不允许重复阶段名：{title}")));
        }
        seen.push(title);
    }
    Ok(())
}

fn ensure_not_empty(stages: &[(String, String)]) -> AppResult<()> {
    if stages.is_empty() {
        return Err(AppError::invalid("流程至少需要保留一个阶段"));
    }
    Ok(())
}

/// 用新的阶段序列整体重写这张订单的流程（位置连续，从 0 开始）。
fn rewrite(tx: &Connection, order_id: &str, stages: &[(String, String)]) -> AppResult<()> {
    tx.execute("DELETE FROM order_stages WHERE order_id = ?1", [order_id])?;
    for (index, (stage_id, title)) in stages.iter().enumerate() {
        tx.execute(
            "INSERT INTO order_stages (order_id, stage_id, title, position)
             VALUES (?1, ?2, ?3, ?4)",
            params![order_id, stage_id, title, index as i64],
        )?;
    }
    Ok(())
}

fn commit_change(
    tx: &rusqlite::Transaction<'_>,
    order_id: &str,
    expected_revision: i64,
    stages: &[(String, String)],
    current_stage_id: Option<&str>,
    note: &str,
    from_stage: Option<(&str, &str)>,
    to_stage: Option<(&str, &str)>,
    request_id: Option<&str>,
    now: &str,
) -> AppResult<()> {
    rewrite(tx, order_id, stages)?;

    let changed = tx.execute(
        "UPDATE orders SET current_stage_id = ?1, revision = revision + 1, updated_at = ?2
         WHERE id = ?3 AND revision = ?4",
        params![current_stage_id, now, order_id, expected_revision],
    )?;
    if changed != 1 {
        return Err(AppError::conflict("流程修改被并发修改阻断，请刷新后重试"));
    }

    events::append(
        tx,
        order_id,
        &NewEvent {
            kind: events::WORKFLOW_CHANGED,
            from_stage_id: from_stage.map(|(id, _)| id),
            from_stage_title: from_stage.map(|(_, t)| t),
            to_stage_id: to_stage.map(|(id, _)| id),
            to_stage_title: to_stage.map(|(_, t)| t),
            note: Some(note),
            request_id,
            occurred_at: now,
            ..Default::default()
        },
    )?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddStageInput {
    pub order_id: String,
    pub expected_revision: i64,
    pub title: String,
    /// 插入位置；None = 追加到末尾。
    pub position: Option<i64>,
    pub request_id: Option<String>,
}

pub fn add_stage(conn: &mut Connection, input: AddStageInput) -> AppResult<OrderView> {
    let title = clean_stage_title(&input.title)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(rid) = input.request_id.as_deref() {
        if events::request_already_applied(&tx, &input.order_id, rid)? {
            let view = orders::load(&tx, &input.order_id)?;
            tx.commit()?;
            return Ok(view);
        }
    }

    let frame = load_frame(&tx, &input.order_id)?;
    assert_editable(&frame, input.expected_revision)?;
    if frame.stages.iter().any(|(_, t)| t == &title) {
        return Err(AppError::invalid(format!("阶段名称已存在：{title}")));
    }
    if frame.stages.len() >= 20 {
        return Err(AppError::invalid("单个流程最多 20 个阶段"));
    }

    let stage_id = format!("stage-{}", uuid::Uuid::new_v4().simple());
    let mut stages = frame.stages.clone();
    let insert_at = match input.position {
        Some(pos) if pos >= 0 && (pos as usize) <= stages.len() => pos as usize,
        None => stages.len(),
        _ => return Err(AppError::invalid("插入位置超出流程范围")),
    };
    stages.insert(insert_at, (stage_id.clone(), title.clone()));

    let now = timezone::now_timestamp();
    commit_change(
        &tx,
        &input.order_id,
        input.expected_revision,
        &stages,
        frame.current_stage_id.as_deref(),
        &format!("新增阶段「{title}」"),
        None,
        Some((&stage_id, &title)),
        input.request_id.as_deref(),
        &now,
    )?;

    let view = orders::load(&tx, &input.order_id)?;
    tx.commit()?;
    Ok(view)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameStageInput {
    pub order_id: String,
    pub expected_revision: i64,
    pub stage_id: String,
    pub title: String,
    pub request_id: Option<String>,
}

pub fn rename_stage(conn: &mut Connection, input: RenameStageInput) -> AppResult<OrderView> {
    let title = clean_stage_title(&input.title)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(rid) = input.request_id.as_deref() {
        if events::request_already_applied(&tx, &input.order_id, rid)? {
            let view = orders::load(&tx, &input.order_id)?;
            tx.commit()?;
            return Ok(view);
        }
    }

    let frame = load_frame(&tx, &input.order_id)?;
    assert_editable(&frame, input.expected_revision)?;

    let index = frame
        .stages
        .iter()
        .position(|(id, _)| id == &input.stage_id)
        .ok_or_else(|| AppError::not_found("阶段不存在"))?;
    let previous_title = frame.stages[index].1.clone();
    if previous_title == title {
        let view = orders::load(&tx, &input.order_id)?;
        tx.commit()?;
        return Ok(view);
    }
    if frame
        .stages
        .iter()
        .enumerate()
        .any(|(i, (_, t))| i != index && t == &title)
    {
        return Err(AppError::invalid(format!("阶段名称已存在：{title}")));
    }

    let mut stages = frame.stages.clone();
    stages[index].1 = title.clone();

    let now = timezone::now_timestamp();
    commit_change(
        &tx,
        &input.order_id,
        input.expected_revision,
        &stages,
        frame.current_stage_id.as_deref(),
        &format!("阶段「{previous_title}」重命名为「{title}」"),
        Some((&input.stage_id, &previous_title)),
        Some((&input.stage_id, &title)),
        input.request_id.as_deref(),
        &now,
    )?;

    let view = orders::load(&tx, &input.order_id)?;
    tx.commit()?;
    Ok(view)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveStageInput {
    pub order_id: String,
    pub expected_revision: i64,
    pub stage_id: String,
    /// 删除当前阶段时必须明确指定替代阶段。
    pub replacement_stage_id: Option<String>,
    pub request_id: Option<String>,
}

pub fn remove_stage(conn: &mut Connection, input: RemoveStageInput) -> AppResult<OrderView> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(rid) = input.request_id.as_deref() {
        if events::request_already_applied(&tx, &input.order_id, rid)? {
            let view = orders::load(&tx, &input.order_id)?;
            tx.commit()?;
            return Ok(view);
        }
    }

    let frame = load_frame(&tx, &input.order_id)?;
    assert_editable(&frame, input.expected_revision)?;

    if frame.stages.len() <= 1 {
        return Err(AppError::invalid("流程至少需要保留一个阶段，不能删除"));
    }
    let index = frame
        .stages
        .iter()
        .position(|(id, _)| id == &input.stage_id)
        .ok_or_else(|| AppError::not_found("阶段不存在"))?;
    let removed_title = frame.stages[index].1.clone();
    let is_current = Some(&input.stage_id) == frame.current_stage_id.as_ref();

    let mut stages = frame.stages.clone();
    stages.remove(index);

    let mut new_current = frame.current_stage_id.clone();
    if is_current {
        let replacement = input
            .replacement_stage_id
            .as_ref()
            .ok_or_else(|| AppError::invalid("删除当前阶段时必须指定替代阶段"))?;
        if replacement == &input.stage_id {
            return Err(AppError::invalid("替代阶段不能是被删除的阶段本身"));
        }
        if !stages.iter().any(|(id, _)| id == replacement) {
            return Err(AppError::invalid("替代阶段不属于该订单的流程"));
        }
        new_current = Some(replacement.clone());
    }

    let now = timezone::now_timestamp();
    commit_change(
        &tx,
        &input.order_id,
        input.expected_revision,
        &stages,
        new_current.as_deref(),
        &format!("删除阶段「{removed_title}」"),
        Some((&input.stage_id, &removed_title)),
        new_current
            .as_ref()
            .and_then(|id| stages.iter().find(|(sid, _)| sid == id))
            .map(|(id, t)| (id.as_str(), t.as_str())),
        input.request_id.as_deref(),
        &now,
    )?;

    let view = orders::load(&tx, &input.order_id)?;
    tx.commit()?;
    Ok(view)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderStagesInput {
    pub order_id: String,
    pub expected_revision: i64,
    /// 完整的阶段 ID 顺序，必须与当前阶段集合完全一致。
    pub ordered_stage_ids: Vec<String>,
    pub request_id: Option<String>,
}

pub fn reorder_stages(conn: &mut Connection, input: ReorderStagesInput) -> AppResult<OrderView> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some(rid) = input.request_id.as_deref() {
        if events::request_already_applied(&tx, &input.order_id, rid)? {
            let view = orders::load(&tx, &input.order_id)?;
            tx.commit()?;
            return Ok(view);
        }
    }

    let frame = load_frame(&tx, &input.order_id)?;
    assert_editable(&frame, input.expected_revision)?;

    if input.ordered_stage_ids.len() != frame.stages.len() {
        return Err(AppError::invalid("排序必须包含当前流程的全部阶段"));
    }
    let mut sorted_actual: Vec<String> = frame.stages.iter().map(|(id, _)| id.clone()).collect();
    let mut sorted_given = input.ordered_stage_ids.clone();
    sorted_actual.sort();
    sorted_given.sort();
    if sorted_actual != sorted_given {
        return Err(AppError::invalid("排序与实际阶段集合不一致"));
    }

    if frame.stages.iter().map(|(id, _)| id).eq(input.ordered_stage_ids.iter()) {
        let view = orders::load(&tx, &input.order_id)?;
        tx.commit()?;
        return Ok(view);
    }

    let reordered: Vec<(String, String)> = input
        .ordered_stage_ids
        .iter()
        .map(|id| {
            let title = frame
                .stages
                .iter()
                .find(|(sid, _)| sid == id)
                .map(|(_, t)| t.clone())
                .unwrap_or_default();
            (id.clone(), title)
        })
        .collect();
    ensure_unique_titles(&reordered)?;
    ensure_not_empty(&reordered)?;

    let now = timezone::now_timestamp();
    commit_change(
        &tx,
        &input.order_id,
        input.expected_revision,
        &reordered,
        frame.current_stage_id.as_deref(),
        "调整阶段顺序",
        None,
        None,
        input.request_id.as_deref(),
        &now,
    )?;

    let view = orders::load(&tx, &input.order_id)?;
    tx.commit()?;
    Ok(view)
}

/// 供测试：当前有效开工是否仍然可以撤销（用于验证重排不能绕过历史限制）。
pub fn undo_still_blocked(conn: &Connection, order_id: &str) -> AppResult<bool> {
    let facts = lifecycle::load_facts(conn, order_id)?;
    Ok(!lifecycle::capabilities(&facts).can_undo_start_work)
}
