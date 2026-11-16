//! D02-15 / D02-16 与"重排不得绕过撤销开工限制"。

mod common;

use common::Ctx;
use minidesk::domain::lifecycle;
use minidesk::domain::workflow::{
    self, AddStageInput, RemoveStageInput, RenameStageInput, ReorderStagesInput,
};

fn add(ctx: &Ctx, order_id: &str, title: &str, position: Option<i64>) -> minidesk::domain::orders::OrderView {
    let view = ctx.load(order_id);
    let mut conn = ctx.conn();
    workflow::add_stage(
        &mut conn,
        AddStageInput {
            order_id: order_id.into(),
            expected_revision: view.revision,
            title: title.into(),
            position,
            request_id: None,
        },
    )
    .unwrap()
}

fn rename(ctx: &Ctx, order_id: &str, stage_id: &str, title: &str) -> minidesk::domain::orders::OrderView {
    let view = ctx.load(order_id);
    let mut conn = ctx.conn();
    workflow::rename_stage(
        &mut conn,
        RenameStageInput {
            order_id: order_id.into(),
            expected_revision: view.revision,
            stage_id: stage_id.into(),
            title: title.into(),
            request_id: None,
        },
    )
    .unwrap()
}

fn reorder(ctx: &Ctx, order_id: &str, ids: Vec<String>) -> Result<minidesk::domain::orders::OrderView, minidesk::error::AppError> {
    let view = ctx.load(order_id);
    let mut conn = ctx.conn();
    workflow::reorder_stages(
        &mut conn,
        ReorderStagesInput {
            order_id: order_id.into(),
            expected_revision: view.revision,
            ordered_stage_ids: ids,
            request_id: None,
        },
    )
}

#[test]
fn add_stage_appends_or_inserts() {
    let ctx = Ctx::new();
    let id = ctx.create_order("加阶段");

    let appended = add(&ctx, &id, "交付确认", None);
    assert_eq!(appended.stage_count, 6);
    assert_eq!(appended.stages.last().unwrap().title, "交付确认");
    assert_eq!(appended.revision, 1);

    let inserted = add(&ctx, &id, "草稿二", Some(1));
    assert_eq!(inserted.stages[1].title, "草稿二");
    assert_eq!(inserted.stages[0].title, "草稿");

    let events = ctx.events(&id);
    assert!(events.iter().any(|e| e.kind == "workflow_changed"));
    let last = events.last().unwrap();
    assert_eq!(last.kind, "workflow_changed");
    assert!(last.note.as_deref().unwrap_or("").contains("新增阶段"));
}

#[test]
fn duplicate_stage_name_is_rejected() {
    let ctx = Ctx::new();
    let id = ctx.create_order("重名");
    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    let err = workflow::add_stage(
        &mut conn,
        AddStageInput {
            order_id: id.clone(),
            expected_revision: view.revision,
            title: "线稿".into(),
            position: None,
            request_id: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("已存在"), "{}", err.message);
    assert_eq!(ctx.load(&id).stage_count, 5);
}

#[test]
fn d02_15_rename_keeps_historical_snapshots() {
    let ctx = Ctx::new();
    let id = ctx.create_order("改名");
    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    lifecycle::start_work(&mut conn, common::lifecycle_input(&view)).unwrap();

    let after_start = ctx.load(&id);
    lifecycle::advance_stage(&mut conn, common::lifecycle_input(&after_start)).unwrap();
    // 此时事件里记的是"线稿"
    let before_rename = ctx.events(&id);
    let advance_event = before_rename
        .iter()
        .find(|e| e.kind == "stage_advanced")
        .unwrap()
        .clone();
    assert_eq!(advance_event.to_stage_title.as_deref(), Some("线稿"));

    // 把线稿改名为勾线
    let current = ctx.load(&id);
    let lineart_id = current.stages[1].id.clone();
    let renamed = rename(&ctx, &id, &lineart_id, "勾线");
    assert_eq!(renamed.current_stage_title.as_deref(), Some("勾线"));

    let after = ctx.events(&id);
    let advance_after = after
        .iter()
        .find(|e| e.kind == "stage_advanced")
        .unwrap();
    assert_eq!(
        advance_after.to_stage_title.as_deref(),
        Some("线稿"),
        "历史必须保留当时的名称快照"
    );
    assert_eq!(advance_after.from_stage_title.as_deref(), Some("草稿"));

    // 重命名事件本身记录了新旧名称
    let rename_event = after.iter().find(|e| e.kind == "workflow_changed").unwrap();
    assert_eq!(rename_event.from_stage_title.as_deref(), Some("线稿"));
    assert_eq!(rename_event.to_stage_title.as_deref(), Some("勾线"));
}

#[test]
fn rename_to_existing_name_is_rejected() {
    let ctx = Ctx::new();
    let id = ctx.create_order("改名冲突");
    let view = ctx.load(&id);
    let second = view.stages[1].id.clone();
    let mut conn = ctx.conn();
    let err = workflow::rename_stage(
        &mut conn,
        RenameStageInput {
            order_id: id.clone(),
            expected_revision: view.revision,
            stage_id: second,
            title: "草稿".into(),
            request_id: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "INVALID");
}

#[test]
fn d02_16_removing_current_stage_requires_a_replacement() {
    let ctx = Ctx::new();
    let id = ctx.create_order("删除当前阶段");
    let view = ctx.load(&id);
    let current = view.stages[0].id.clone();
    let mut conn = ctx.conn();

    let err = workflow::remove_stage(
        &mut conn,
        RemoveStageInput {
            order_id: id.clone(),
            expected_revision: view.revision,
            stage_id: current.clone(),
            replacement_stage_id: None,
            request_id: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("替代阶段"), "{}", err.message);
    assert_eq!(ctx.load(&id).stage_count, 5);

    let replacement = view.stages[1].id.clone();
    let removed = workflow::remove_stage(
        &mut conn,
        RemoveStageInput {
            order_id: id.clone(),
            expected_revision: view.revision,
            stage_id: current,
            replacement_stage_id: Some(replacement.clone()),
            request_id: None,
        },
    )
    .unwrap();
    assert_eq!(removed.stage_count, 4);
    assert_eq!(removed.current_stage_id.as_deref(), Some(replacement.as_str()));
    assert_eq!(removed.current_stage_title.as_deref(), Some("线稿"));
}

#[test]
fn removing_a_non_current_stage_keeps_the_current_one() {
    let ctx = Ctx::new();
    let id = ctx.create_order("删除其它阶段");
    let view = ctx.load(&id);
    let current_before = view.current_stage_id.clone();
    let other = view.stages[3].id.clone();

    let mut conn = ctx.conn();
    let removed = workflow::remove_stage(
        &mut conn,
        RemoveStageInput {
            order_id: id.clone(),
            expected_revision: view.revision,
            stage_id: other,
            replacement_stage_id: None,
            request_id: None,
        },
    )
    .unwrap();
    assert_eq!(removed.current_stage_id, current_before);
    assert_eq!(removed.stage_count, 4);
}

#[test]
fn the_last_stage_cannot_be_removed() {
    let ctx = Ctx::new();
    let id = ctx.create_order("只剩一个");
    let mut view = ctx.load(&id);
    // 逐个删到只剩一个
    while view.stage_count > 1 {
        let victim = view
            .stages
            .iter()
            .find(|s| Some(&s.id) != view.current_stage_id.as_ref())
            .map(|s| s.id.clone())
            .unwrap();
        let mut conn = ctx.conn();
        view = workflow::remove_stage(
            &mut conn,
            RemoveStageInput {
                order_id: id.clone(),
                expected_revision: view.revision,
                stage_id: victim,
                replacement_stage_id: None,
                request_id: None,
            },
        )
        .unwrap();
    }
    assert_eq!(view.stage_count, 1);

    let victim = view.current_stage_id.clone().unwrap();
    let mut conn = ctx.conn();
    let err = workflow::remove_stage(
        &mut conn,
        RemoveStageInput {
            order_id: id.clone(),
            expected_revision: view.revision,
            stage_id: victim,
            replacement_stage_id: None,
            request_id: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("至少"), "{}", err.message);
}

#[test]
fn reorder_requires_the_complete_stage_set() {
    let ctx = Ctx::new();
    let id = ctx.create_order("排序");
    let view = ctx.load(&id);

    let partial: Vec<String> = view.stages[..3].iter().map(|s| s.id.clone()).collect();
    let err = reorder(&ctx, &id, partial).unwrap_err();
    assert_eq!(err.code, "INVALID");

    let mut wrong = view.stages.iter().map(|s| s.id.clone()).collect::<Vec<_>>();
    wrong[0] = "ghost".into();
    let err = reorder(&ctx, &id, wrong).unwrap_err();
    assert_eq!(err.code, "INVALID");
}

#[test]
fn reorder_rewrites_positions_and_keeps_the_current_stage_by_id() {
    let ctx = Ctx::new();
    let id = ctx.create_order("调序");
    let view = ctx.load(&id);
    let current = view.current_stage_id.clone().unwrap();
    let mut ids: Vec<String> = view.stages.iter().map(|s| s.id.clone()).collect();
    ids.reverse();

    let reordered = reorder(&ctx, &id, ids).unwrap();
    assert_eq!(reordered.current_stage_id.as_deref(), Some(current.as_str()));
    assert_eq!(reordered.stages[0].title, "最终调整");
    assert_eq!(reordered.current_stage_index, Some(4), "当前阶段随位置移动");
    assert_eq!(reordered.revision, 1);

    let conn = ctx.conn();
    let positions: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT position FROM order_stages WHERE order_id = ?1 ORDER BY position")
            .unwrap();
        stmt.query_map([&id], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(positions, vec![0, 1, 2, 3, 4], "位置必须连续");
}

#[test]
fn d02_08_reorder_cannot_bypass_the_undo_restriction() {
    let ctx = Ctx::new();
    let id = ctx.create_order("重排绕过");
    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    lifecycle::start_work(&mut conn, common::lifecycle_input(&view)).unwrap();

    let after_start = ctx.load(&id);
    lifecycle::advance_stage(&mut conn, common::lifecycle_input(&after_start)).unwrap();

    // 把当前阶段（线稿）排到第一位，制造"看起来在第一阶段"的状态
    let current = ctx.load(&id);
    let current_id = current.current_stage_id.clone().unwrap();
    let mut ids: Vec<String> = current.stages.iter().map(|s| s.id.clone()).collect();
    ids.retain(|id_| id_ != &current_id);
    ids.insert(0, current_id.clone());
    let moved = reorder(&ctx, &id, ids).unwrap();

    assert_eq!(moved.current_stage_index, Some(0), "当前阶段确实在第一位");
    assert!(
        !moved.capabilities.can_undo_start_work,
        "重排不得绕过「开工后已推进」的历史限制"
    );

    let err = lifecycle::undo_start_work(&mut conn, common::lifecycle_input(&moved)).unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert_eq!(
        ctx.kinds(&id),
        vec!["created", "work_started", "stage_advanced", "workflow_changed"]
    );
}

#[test]
fn workflow_edit_is_blocked_for_terminal_orders() {
    let ctx = Ctx::new();
    let id = ctx.create_order("终态改流程");
    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    let cancelled = lifecycle::cancel_order(&mut conn, common::lifecycle_input(&view)).unwrap();

    let err = workflow::add_stage(
        &mut conn,
        AddStageInput {
            order_id: id.clone(),
            expected_revision: cancelled.revision,
            title: "多余阶段".into(),
            position: None,
            request_id: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("已完成或已取消"), "{}", err.message);
}

#[test]
fn workflow_edit_requires_the_current_revision() {
    let ctx = Ctx::new();
    let id = ctx.create_order("流程版本");
    let stale = ctx.load(&id);
    add(&ctx, &id, "新阶段", None);

    let mut conn = ctx.conn();
    let err = workflow::add_stage(
        &mut conn,
        AddStageInput {
            order_id: id.clone(),
            expected_revision: stale.revision,
            title: "过期提交".into(),
            position: None,
            request_id: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "CONFLICT");
    assert_eq!(ctx.load(&id).stage_count, 6);
}

#[test]
fn removed_stage_disappears_from_stage_list() {
    let ctx = Ctx::new();
    let id = ctx.create_order("删阶段");
    let view = ctx.load(&id);
    let victim = view.stages[4].id.clone();
    let mut conn = ctx.conn();
    let after = workflow::remove_stage(
        &mut conn,
        RemoveStageInput {
            order_id: id.clone(),
            expected_revision: view.revision,
            stage_id: victim.clone(),
            replacement_stage_id: None,
            request_id: None,
        },
    )
    .unwrap();
    assert!(!after.stages.iter().any(|s| s.id == victim));
    assert_eq!(after.stage_count, 4);
}
