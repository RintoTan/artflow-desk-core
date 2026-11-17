//! 全局制作流程模板。
//!
//! 约束：每模板 1～20 个阶段、同一模板内不允许重名、阶段有稳定 ID、
//! 系统始终有且只有一个默认模板；删除默认模板前必须先另选默认。
//! 模板修改**不追溯**已有订单（订单创建时复制阶段，之后与模板无关）。

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::store::timezone;

pub const MAX_STEPS: usize = 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepView {
    pub step_id: String,
    pub title: String,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateView {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub revision: i64,
    pub steps: Vec<StepView>,
    pub step_count: i64,
    /// 有多少订单是复制自这个模板（仅作参考，不影响删除）。
    pub usage_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepInput {
    /// 保留原阶段 ID；新增步骤留空。
    pub step_id: Option<String>,
    pub title: String,
}

fn clean_template_name(raw: &str) -> AppResult<String> {
    let name = raw.trim();
    let count = name.chars().count();
    if count == 0 {
        return Err(AppError::invalid("模板名称不能为空"));
    }
    if count > 80 {
        return Err(AppError::invalid("模板名称不能超过 80 字"));
    }
    Ok(name.to_string())
}

fn clean_steps(steps: &[StepInput]) -> AppResult<Vec<(String, String)>> {
    if steps.is_empty() {
        return Err(AppError::invalid("模板至少需要 1 个阶段"));
    }
    if steps.len() > MAX_STEPS {
        return Err(AppError::invalid(format!("模板最多 {MAX_STEPS} 个阶段")));
    }
    let mut out: Vec<(String, String)> = Vec::with_capacity(steps.len());
    for step in steps {
        let title = step.title.trim();
        if title.is_empty() {
            return Err(AppError::invalid("阶段名称不能为空"));
        }
        if title.chars().count() > 80 {
            return Err(AppError::invalid("阶段名称不能超过 80 字"));
        }
        if out.iter().any(|(_, existing)| existing == title) {
            return Err(AppError::invalid(format!("同一模板内不允许重复阶段名：{title}")));
        }
        let step_id = match &step.step_id {
            Some(id) if !id.trim().is_empty() => id.trim().to_string(),
            _ => format!("step-{}", uuid::Uuid::new_v4().simple()),
        };
        out.push((step_id, title.to_string()));
    }
    Ok(out)
}

fn read_steps(conn: &Connection, template_id: &str) -> AppResult<Vec<StepView>> {
    let mut stmt = conn.prepare(
        "SELECT step_id, title, position FROM stage_template_steps
         WHERE template_id = ?1 ORDER BY position, step_id",
    )?;
    let rows = stmt
        .query_map([template_id], |r| {
            Ok(StepView {
                step_id: r.get(0)?,
                title: r.get(1)?,
                position: r.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn read_one(conn: &Connection, id: &str) -> AppResult<TemplateView> {
    let base = conn
        .query_row(
            "SELECT id, name, is_default, revision, created_at, updated_at
             FROM stage_templates WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("流程模板不存在"))?;

    let steps = read_steps(conn, id)?;
    let usage: i64 = conn.query_row(
        "SELECT COUNT(*) FROM orders WHERE stage_template_id = ?1",
        [id],
        |r| r.get(0),
    )?;

    Ok(TemplateView {
        id: base.0,
        name: base.1,
        is_default: base.2 == 1,
        revision: base.3,
        step_count: steps.len() as i64,
        steps,
        usage_count: usage,
        created_at: base.4,
        updated_at: base.5,
    })
}

pub fn list(conn: &Connection) -> AppResult<Vec<TemplateView>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM stage_templates ORDER BY is_default DESC, name, id",
    )?;
    let ids: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    ids.iter().map(|id| read_one(conn, id)).collect()
}

pub fn get(conn: &Connection, id: &str) -> AppResult<TemplateView> {
    read_one(conn, id)
}

fn write_steps(tx: &Connection, template_id: &str, steps: &[(String, String)]) -> AppResult<()> {
    tx.execute(
        "DELETE FROM stage_template_steps WHERE template_id = ?1",
        [template_id],
    )?;
    for (index, (step_id, title)) in steps.iter().enumerate() {
        tx.execute(
            "INSERT INTO stage_template_steps (template_id, step_id, title, position)
             VALUES (?1, ?2, ?3, ?4)",
            params![template_id, step_id, title, index as i64],
        )?;
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTemplateInput {
    pub name: String,
    pub steps: Vec<StepInput>,
    pub make_default: bool,
}

pub fn create(conn: &mut Connection, input: CreateTemplateInput) -> AppResult<TemplateView> {
    let name = clean_template_name(&input.name)?;
    let steps = clean_steps(&input.steps)?;
    let now = timezone::now_timestamp();
    let id = format!("tpl-{}", uuid::Uuid::new_v4().simple());

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if input.make_default {
        tx.execute("UPDATE stage_templates SET is_default = 0 WHERE is_default = 1", [])?;
    }
    tx.execute(
        "INSERT INTO stage_templates (id, name, is_default, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, ?4, ?4)",
        params![id, name, if input.make_default { 1 } else { 0 }, now],
    )?;
    write_steps(&tx, &id, &steps)?;
    let view = read_one(&tx, &id)?;
    tx.commit()?;
    Ok(view)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTemplateInput {
    pub template_id: String,
    pub expected_revision: i64,
    pub name: String,
    pub steps: Vec<StepInput>,
}

pub fn update(conn: &mut Connection, input: UpdateTemplateInput) -> AppResult<TemplateView> {
    let name = clean_template_name(&input.name)?;
    let steps = clean_steps(&input.steps)?;

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = tx
        .query_row(
            "SELECT name, revision FROM stage_templates WHERE id = ?1",
            [&input.template_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("流程模板不存在"))?;

    if current.1 != input.expected_revision {
        return Err(AppError::conflict(format!(
            "模板已被修改（当前版本 {}，你基于 {}）。请刷新后重试。",
            current.1, input.expected_revision
        )));
    }

    let changed = tx.execute(
        "UPDATE stage_templates SET name = ?1, revision = revision + 1, updated_at = ?2
         WHERE id = ?3 AND revision = ?4",
        params![name, timezone::now_timestamp(), input.template_id, input.expected_revision],
    )?;
    if changed != 1 {
        return Err(AppError::conflict("模板保存被并发修改阻断"));
    }
    write_steps(&tx, &input.template_id, &steps)?;

    let view = read_one(&tx, &input.template_id)?;
    tx.commit()?;
    Ok(view)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateTemplateInput {
    pub source_id: String,
    pub name: String,
}

pub fn duplicate(conn: &mut Connection, input: DuplicateTemplateInput) -> AppResult<TemplateView> {
    let name = clean_template_name(&input.name)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let steps = read_steps(&tx, &input.source_id)?;
    if steps.is_empty() {
        return Err(AppError::not_found("源模板不存在或没有阶段"));
    }
    let now = timezone::now_timestamp();
    let id = format!("tpl-{}", uuid::Uuid::new_v4().simple());
    tx.execute(
        "INSERT INTO stage_templates (id, name, is_default, revision, created_at, updated_at)
         VALUES (?1, ?2, 0, 0, ?3, ?3)",
        params![id, name, now],
    )?;
    let copied: Vec<(String, String)> = steps
        .iter()
        .map(|s| (format!("step-{}", uuid::Uuid::new_v4().simple()), s.title.clone()))
        .collect();
    write_steps(&tx, &id, &copied)?;
    let view = read_one(&tx, &id)?;
    tx.commit()?;
    Ok(view)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteTemplateInput {
    pub template_id: String,
    pub expected_revision: i64,
    /// 删除默认模板时必须指定新的默认模板。
    pub replacement_default_id: Option<String>,
}

pub fn remove(conn: &mut Connection, input: DeleteTemplateInput) -> AppResult<Vec<TemplateView>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = tx
        .query_row(
            "SELECT is_default, revision FROM stage_templates WHERE id = ?1",
            [&input.template_id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("流程模板不存在"))?;

    if current.1 != input.expected_revision {
        return Err(AppError::conflict("模板已被修改，请刷新后重试"));
    }

    let total: i64 = tx.query_row("SELECT COUNT(*) FROM stage_templates", [], |r| r.get(0))?;
    if total <= 1 {
        return Err(AppError::invalid("至少需要保留一个制作流程模板"));
    }

    if current.0 == 1 {
        let replacement = input
            .replacement_default_id
            .as_ref()
            .ok_or_else(|| AppError::invalid("删除默认模板前必须先指定新的默认模板"))?;
        if replacement == &input.template_id {
            return Err(AppError::invalid("新的默认模板不能是被删除的模板"));
        }
        let exists: Option<i64> = tx
            .query_row(
                "SELECT 1 FROM stage_templates WHERE id = ?1",
                [replacement],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_none() {
            return Err(AppError::not_found("指定的新默认模板不存在"));
        }
        tx.execute("UPDATE stage_templates SET is_default = 0 WHERE is_default = 1", [])?;
        tx.execute(
            "UPDATE stage_templates SET is_default = 1 WHERE id = ?1",
            [replacement],
        )?;
    }

    tx.execute(
        "DELETE FROM stage_templates WHERE id = ?1",
        [&input.template_id],
    )?;

    let views = list(&tx)?;
    tx.commit()?;
    Ok(views)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDefaultInput {
    pub template_id: String,
}

pub fn set_default(conn: &mut Connection, input: SetDefaultInput) -> AppResult<Vec<TemplateView>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let exists: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM stage_templates WHERE id = ?1",
            [&input.template_id],
            |r| r.get(0),
        )
        .optional()?;
    if exists.is_none() {
        return Err(AppError::not_found("流程模板不存在"));
    }
    tx.execute("UPDATE stage_templates SET is_default = 0 WHERE is_default = 1", [])?;
    tx.execute(
        "UPDATE stage_templates SET is_default = 1, revision = revision + 1 WHERE id = ?1",
        [&input.template_id],
    )?;
    let views = list(&tx)?;
    tx.commit()?;
    Ok(views)
}

/// 建单时读取模板阶段；也供 UI 预览。
pub fn template_steps(conn: &Connection, template_id: &str) -> AppResult<Vec<(String, String)>> {
    Ok(read_steps(conn, template_id)?
        .into_iter()
        .map(|s| (s.step_id, s.title))
        .collect())
}
