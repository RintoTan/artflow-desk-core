//! STAGE-SKIP：受控制作阶段跳级。
//!
//! 覆盖成功路径、全部拒绝路径（拒绝时必须零写入）、幂等、并发冲突，
//! 以及跳级后返工/推进/完成等既有语义不受影响。

mod common;

use common::Ctx;
use minidesk::domain::lifecycle::{self, LifecycleInput, ReworkInput, SkipInput, WorkState};
use minidesk::domain::orders::OrderView;

fn start(ctx: &Ctx, id: &str) -> OrderView {
    let view = ctx.load(id);
    let mut conn = ctx.conn();
    lifecycle::start_work(&mut conn, common::lifecycle_input(&view)).unwrap()
}

fn skip(ctx: &Ctx, id: &str, target: &str) -> Result<OrderView, minidesk::error::AppError> {
    let view = ctx.load(id);
    let mut conn = ctx.conn();
    lifecycle::skip_stage(
        &mut conn,
        SkipInput {
            order_id: id.into(),
            expected_revision: view.revision,
            target_stage_id: target.into(),
            reason: None,
            request_id: None,
        },
    )
}

fn skip_with_reason(
    ctx: &Ctx,
    id: &str,
    target: &str,
    reason: Option<&str>,
    request_id: Option<&str>,
) -> Result<OrderView, minidesk::error::AppError> {
    let view = ctx.load(id);
    let mut conn = ctx.conn();
    lifecycle::skip_stage(
        &mut conn,
        SkipInput {
            order_id: id.into(),
            expected_revision: view.revision,
            target_stage_id: target.into(),
            reason: reason.map(|s| s.to_string()),
            request_id: request_id.map(|s| s.to_string()),
        },
    )
}

fn stage_id(view: &OrderView, title: &str) -> String {
    view.stages
        .iter()
        .find(|s| s.title == title)
        .unwrap_or_else(|| panic!("模板里没有「{title}」"))
        .id
        .clone()
}

/// 拒绝时必须完全零写入：阶段、版本、事件条数都不变。
fn assert_untouched(ctx: &Ctx, id: &str, before: &OrderView, before_kinds: &[String]) {
    let after = ctx.load(id);
    assert_eq!(after.current_stage_id, before.current_stage_id);
    assert_eq!(after.revision, before.revision);
    assert_eq!(ctx.kinds(id), before_kinds.to_vec());
}

#[test]
fn skip_over_one_stage_succeeds_and_records_snapshot() {
    let ctx = Ctx::new();
    let id = ctx.create_order("跳一级");
    let started = start(&ctx, &id);
    let target = stage_id(&started, "固有色");

    let after = skip(&ctx, &id, &target).expect("跨一个阶段应允许");

    assert_eq!(after.current_stage_title.as_deref(), Some("固有色"));
    assert_eq!(after.revision, started.revision + 1, "revision 只加一次");
    assert_eq!(after.work_state, WorkState::InProgress, "跳级不是完成");
    assert_eq!(after.status, "active");

    let events = ctx.events(&id);
    let last = events.last().expect("应有跳级事件");
    assert_eq!(last.kind, "stage_skipped");
    assert_eq!(last.from_stage_title.as_deref(), Some("草稿"));
    assert_eq!(last.to_stage_title.as_deref(), Some("固有色"));
    assert_eq!(last.movement.as_deref(), Some("forward"));

    let snapshot: serde_json::Value =
        serde_json::from_str(last.skipped_stages.as_deref().expect("必须有快照")).unwrap();
    let items = snapshot.as_array().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["title"], "线稿");
    assert_eq!(items[0]["stage_id"], stage_id(&started, "线稿"));
    assert_eq!(items[0]["position"], 1);

    // 没有伪造的推进/完成事件。
    assert!(!ctx.kinds(&id).iter().any(|k| k == "stage_advanced"));
    assert!(!ctx.kinds(&id).iter().any(|k| k == "completed"));
}

#[test]
fn skip_over_multiple_stages_to_last_keeps_order_active() {
    let ctx = Ctx::new();
    let id = ctx.create_order("跳到底");
    let started = start(&ctx, &id);
    let last_stage = started.stages.last().unwrap().clone();

    let after = skip(&ctx, &id, &last_stage.id).expect("跳到最后一个阶段应允许");

    assert_eq!(after.current_stage_title.as_deref(), Some("最终调整"));
    assert_eq!(after.status, "active", "跳级不等于完成");
    assert_eq!(after.work_state, WorkState::InProgress);
    assert!(after.capabilities.can_complete, "到最后一个阶段后可以完成");
    assert!(!after.capabilities.can_skip, "最后一个阶段没有跳级目标");

    let last = ctx.events(&id).pop().unwrap();
    let snapshot: serde_json::Value =
        serde_json::from_str(last.skipped_stages.as_deref().unwrap()).unwrap();
    let titles: Vec<&str> = snapshot
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v["title"].as_str().unwrap())
        .collect();
    assert_eq!(titles, vec!["线稿", "固有色", "细化"]);
}

#[test]
fn skip_records_optional_reason_and_request_id() {
    let ctx = Ctx::new();
    let id = ctx.create_order("带原因");
    let started = start(&ctx, &id);
    let target = stage_id(&started, "细化");

    skip_with_reason(&ctx, &id, &target, Some("  客户只要成图  "), Some("req-skip-1")).unwrap();

    let last = ctx.events(&id).pop().unwrap();
    assert_eq!(last.skip_reason.as_deref(), Some("客户只要成图"), "原因两端空白应被清理");
    assert!(last.reason.is_none(), "不得占用改期原因列");
    assert!(last.note.is_none(), "不得占用事件备注列");
}

#[test]
fn skipping_to_next_stage_must_use_advance_not_skip() {
    let ctx = Ctx::new();
    let id = ctx.create_order("只差一步");
    let started = start(&ctx, &id);
    let next = stage_id(&started, "线稿");

    let err = skip(&ctx, &id, &next).unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("推进"), "{}", err.message);
    assert_untouched(&ctx, &id, &started, &["created".to_string(), "work_started".to_string()]);
}

#[test]
fn skipping_to_current_or_earlier_stage_is_rejected() {
    let ctx = Ctx::new();
    let id = ctx.create_order("目标非法");
    let started = start(&ctx, &id);
    let mut conn = ctx.conn();
    lifecycle::advance_stage(&mut conn, common::lifecycle_input(&started)).unwrap();
    let at_lineart = ctx.load(&id);

    let same = stage_id(&at_lineart, "线稿");
    let earlier = stage_id(&at_lineart, "草稿");

    let err = skip(&ctx, &id, &same).unwrap_err();
    assert_eq!(err.code, "INVALID");
    let err = skip(&ctx, &id, &earlier).unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("返工"), "{}", err.message);

    let kinds = ctx.kinds(&id);
    assert_eq!(kinds, vec!["created", "work_started", "stage_advanced"]);
    assert_eq!(ctx.load(&id).revision, at_lineart.revision);
}

#[test]
fn target_stage_always_resolves_against_this_orders_own_stages() {
    let ctx = Ctx::new();
    let id = ctx.create_order("本单");
    let other = ctx.create_order("另一单");
    let started = start(&ctx, &id);
    start(&ctx, &other);

    // 阶段 id 来自模板步骤，两张订单同名阶段的 id 相同；领域层只在本单自己的
    // `order_stages` 里解析，因此不会把另一张订单的阶段"借"过来。
    let shared = started.stages.last().unwrap().id.clone();
    let after = skip(&ctx, &id, &shared).expect("本单自己的阶段可以跳");
    assert_eq!(after.current_stage_title.as_deref(), Some("最终调整"));
    assert_eq!(
        ctx.load(&other).current_stage_title.as_deref(),
        Some("草稿"),
        "另一张订单的状态不得被牵连"
    );
}

#[test]
fn skipping_to_unknown_stage_is_rejected() {
    let ctx = Ctx::new();
    let id = ctx.create_order("不存在的阶段");
    let started = start(&ctx, &id);

    let err = skip(&ctx, &id, "no-such-stage").unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert_untouched(&ctx, &id, &started, &["created".to_string(), "work_started".to_string()]);
}

#[test]
fn skipping_before_start_or_after_terminal_state_is_rejected() {
    let ctx = Ctx::new();

    // 未开工
    let id = ctx.create_order("未开工");
    let view = ctx.load(&id);
    let target = stage_id(&view, "细化");
    let err = skip(&ctx, &id, &target).unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("尚未开始"), "{}", err.message);
    assert_untouched(&ctx, &id, &view, &["created".to_string()]);

    // 已完成
    let done = ctx.create_order("已完成");
    start(&ctx, &done);
    {
        let mut conn = ctx.conn();
        let view = ctx.load(&done);
        let target = stage_id(&view, "最终调整");
        lifecycle::skip_stage(
            &mut conn,
            SkipInput {
                order_id: done.clone(),
                expected_revision: view.revision,
                target_stage_id: target,
                reason: None,
                request_id: None,
            },
        )
        .unwrap();
        let at_last = ctx.load(&done);
        lifecycle::complete_order(&mut conn, common::lifecycle_input(&at_last)).unwrap();
    }
    let completed = ctx.load(&done);
    let kinds_before = ctx.kinds(&done);
    // 已完成后阶段都在最后一个阶段之后，这里用"重开前"的状态验证拒绝口径。
    let err = skip(&ctx, &done, &stage_id(&completed, "最终调整")).unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("已完成或已取消"), "{}", err.message);
    assert_untouched(&ctx, &done, &completed, &kinds_before);

    // 已取消
    let cancelled = ctx.create_order("已取消");
    start(&ctx, &cancelled);
    {
        let mut conn = ctx.conn();
        let view = ctx.load(&cancelled);
        lifecycle::cancel_order(&mut conn, common::lifecycle_input(&view)).unwrap();
    }
    let after_cancel = ctx.load(&cancelled);
    let kinds_before = ctx.kinds(&cancelled);
    let err = skip(&ctx, &cancelled, &stage_id(&after_cancel, "细化")).unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert_untouched(&ctx, &cancelled, &after_cancel, &kinds_before);
}

#[test]
fn stale_revision_conflicts_without_writing() {
    let ctx = Ctx::new();
    let id = ctx.create_order("版本冲突");
    let started = start(&ctx, &id);
    let target = stage_id(&started, "细化");

    let mut conn = ctx.conn();
    let err = lifecycle::skip_stage(
        &mut conn,
        SkipInput {
            order_id: id.clone(),
            expected_revision: started.revision + 5,
            target_stage_id: target,
            reason: None,
            request_id: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "CONFLICT");
    assert_untouched(&ctx, &id, &started, &["created".to_string(), "work_started".to_string()]);
}

#[test]
fn repeated_request_id_does_not_write_twice() {
    let ctx = Ctx::new();
    let id = ctx.create_order("幂等");
    let started = start(&ctx, &id);
    let target = stage_id(&started, "细化");

    let first = skip_with_reason(&ctx, &id, &target, None, Some("req-skip-idem")).unwrap();
    let kinds_after_first = ctx.kinds(&id);

    // 同 request_id 重放：即使 revision 已经过期，也必须短路返回当前订单。
    let mut conn = ctx.conn();
    let replay = lifecycle::skip_stage(
        &mut conn,
        SkipInput {
            order_id: id.clone(),
            expected_revision: started.revision,
            target_stage_id: target,
            reason: None,
            request_id: Some("req-skip-idem".into()),
        },
    )
    .expect("重放应成功返回");
    assert_eq!(replay.current_stage_id, first.current_stage_id);
    assert_eq!(ctx.kinds(&id), kinds_after_first, "不得重复写事件");
}

#[test]
fn skip_then_rework_still_works_and_history_is_kept() {
    let ctx = Ctx::new();
    let id = ctx.create_order("跳后返工");
    let started = start(&ctx, &id);
    let target = stage_id(&started, "细化");
    skip(&ctx, &id, &target).unwrap();

    let at_refine = ctx.load(&id);
    let lineart = stage_id(&at_refine, "线稿");
    let mut conn = ctx.conn();
    let reworked = lifecycle::rework_stage(
        &mut conn,
        ReworkInput {
            order_id: id.clone(),
            expected_revision: at_refine.revision,
            target_stage_id: Some(lineart),
            request_id: None,
        },
    )
    .unwrap();
    assert_eq!(reworked.current_stage_title.as_deref(), Some("线稿"));

    let kinds = ctx.kinds(&id);
    assert_eq!(kinds, vec!["created", "work_started", "stage_skipped", "stage_reworked"]);
    let skip_event = ctx
        .events(&id)
        .into_iter()
        .find(|e| e.kind == "stage_skipped")
        .unwrap();
    assert!(skip_event.skipped_stages.is_some(), "跳级历史不得被改写或清空");

    // 返工之后仍可继续推进。
    let at_lineart = ctx.load(&id);
    let advanced =
        lifecycle::advance_stage(&mut conn, common::lifecycle_input(&at_lineart)).unwrap();
    assert_eq!(advanced.current_stage_title.as_deref(), Some("固有色"));
}

#[test]
fn skip_does_not_touch_other_order_fields() {
    let ctx = Ctx::new();
    let id = ctx.create_order("字段隔离");
    let started = start(&ctx, &id);
    let before = ctx.load(&id);
    let target = stage_id(&started, "细化");
    let after = skip(&ctx, &id, &target).unwrap();

    assert_eq!(after.status, before.status);
    assert_eq!(after.started_at, before.started_at);
    assert_eq!(after.completed_at, before.completed_at);
    assert_eq!(after.cancelled_at, before.cancelled_at);
    assert_eq!(after.queue_position, before.queue_position);
    assert_eq!(after.work_state, before.work_state);
    assert_eq!(after.planned_start_date, before.planned_start_date);
    assert_eq!(after.planned_delivery_date, before.planned_delivery_date);
    assert_eq!(after.updated_at.is_empty(), false);
}

#[test]
fn undo_start_work_is_blocked_after_skip_even_if_reworked_back() {
    let ctx = Ctx::new();
    let id = ctx.create_order("跳级后撤销开工");
    let started = start(&ctx, &id);
    let target = stage_id(&started, "细化");
    skip(&ctx, &id, &target).unwrap();

    let at_refine = ctx.load(&id);
    let draft = stage_id(&at_refine, "草稿");
    let mut conn = ctx.conn();
    let back = lifecycle::rework_stage(
        &mut conn,
        ReworkInput {
            order_id: id.clone(),
            expected_revision: at_refine.revision,
            target_stage_id: Some(draft),
            request_id: None,
        },
    )
    .unwrap();

    // 回到第一阶段，但本次开工之后已经跳级过：撤销开工必须继续被拒绝。
    assert!(!back.capabilities.can_undo_start_work);
    let err = lifecycle::undo_start_work(&mut conn, common::lifecycle_input(&back)).unwrap_err();
    assert_eq!(err.code, "INVALID");
}

#[test]
fn skip_does_not_change_completion_stats() {
    let ctx = Ctx::new();
    let id = ctx.create_order("统计不受影响");
    let started = start(&ctx, &id);
    let target = stage_id(&started, "最终调整");
    skip(&ctx, &id, &target).unwrap();
    let at_last = ctx.load(&id);

    let mut conn = ctx.conn();
    lifecycle::complete_order(&mut conn, common::lifecycle_input(&at_last)).unwrap();

    let kinds = ctx.kinds(&id);
    assert_eq!(
        kinds.iter().filter(|k| k.as_str() == "completed").count(),
        1,
        "跳级不得额外产生 completed 事件"
    );
    assert_eq!(
        kinds.iter().filter(|k| k.as_str() == "stage_skipped").count(),
        1
    );
}

#[test]
fn lifecycle_input_type_is_still_the_advance_contract() {
    // 防止有人把 skip 做成 advance 的可选参数：两条命令的输入类型必须各自独立。
    let input = LifecycleInput {
        order_id: "x".into(),
        expected_revision: 0,
        request_id: None,
    };
    assert_eq!(input.expected_revision, 0);
}
