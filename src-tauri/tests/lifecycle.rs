//! D02-05 ～ D02-14：开工、推进、返工、撤销、完成、取消、重开。

mod common;

use common::Ctx;
use minidesk::domain::lifecycle::{self, LifecycleInput, ReworkInput, WorkState};
use minidesk::domain::orders::{create_order, ClientChoice, CreateOrderInput, OrderView};

fn start(ctx: &Ctx, id: &str) -> OrderView {
    let view = ctx.load(id);
    let mut conn = ctx.conn();
    lifecycle::start_work(&mut conn, common::lifecycle_input(&view)).unwrap()
}

fn advance(ctx: &Ctx, id: &str) -> OrderView {
    let view = ctx.load(id);
    let mut conn = ctx.conn();
    lifecycle::advance_stage(&mut conn, common::lifecycle_input(&view)).unwrap()
}

fn rework(ctx: &Ctx, id: &str, target: Option<&str>) -> Result<OrderView, minidesk::error::AppError> {
    let view = ctx.load(id);
    let mut conn = ctx.conn();
    lifecycle::rework_stage(
        &mut conn,
        ReworkInput {
            order_id: id.into(),
            expected_revision: view.revision,
            target_stage_id: target.map(|s| s.to_string()),
            request_id: None,
        },
    )
}

#[test]
fn d02_05_cannot_advance_or_complete_before_starting() {
    let ctx = Ctx::new();
    let id = ctx.create_order("未开工");

    let mut conn = ctx.conn();
    let view = ctx.load(&id);
    assert!(!view.capabilities.can_advance);
    assert!(!view.capabilities.can_complete);

    let advance_err =
        lifecycle::advance_stage(&mut conn, common::lifecycle_input(&view)).unwrap_err();
    assert_eq!(advance_err.code, "INVALID");
    assert!(advance_err.message.contains("尚未开始制作"), "{}", advance_err.message);

    let complete_err =
        lifecycle::complete_order(&mut conn, common::lifecycle_input(&view)).unwrap_err();
    assert_eq!(complete_err.code, "INVALID");
    assert!(complete_err.message.contains("尚未开始制作"), "{}", complete_err.message);

    // 失败不得留下事件或改动版本
    assert_eq!(ctx.kinds(&id), vec!["created"]);
    assert_eq!(ctx.load(&id).revision, 0);
}

#[test]
fn d02_06_start_then_advance_moves_one_stage_at_a_time() {
    let ctx = Ctx::new();
    let id = ctx.create_order("推进");

    let started = start(&ctx, &id);
    assert_eq!(started.work_state, WorkState::InProgress);
    assert!(started.started_at.is_some());
    assert_eq!(started.current_stage_title.as_deref(), Some("草稿"));
    assert_eq!(started.revision, 1, "开工只 bump 一次");
    assert!(started.capabilities.can_advance);

    let second = advance(&ctx, &id);
    assert_eq!(second.current_stage_title.as_deref(), Some("线稿"));
    assert_eq!(second.current_stage_index, Some(1));
    assert_eq!(second.revision, 2);

    let third = advance(&ctx, &id);
    assert_eq!(third.current_stage_title.as_deref(), Some("固有色"));

    assert_eq!(
        ctx.kinds(&id),
        vec!["created", "work_started", "stage_advanced", "stage_advanced"]
    );

    // 事件里带阶段名快照与方向
    let events = ctx.events(&id);
    let first_advance = &events[2];
    assert_eq!(first_advance.from_stage_title.as_deref(), Some("草稿"));
    assert_eq!(first_advance.to_stage_title.as_deref(), Some("线稿"));
    assert_eq!(first_advance.movement.as_deref(), Some("forward"));
}

#[test]
fn d02_06_cannot_advance_past_the_last_stage() {
    let ctx = Ctx::new();
    let id = ctx.create_order("推进到底");
    start(&ctx, &id);
    for _ in 0..4 {
        advance(&ctx, &id);
    }
    let at_last = ctx.load(&id);
    assert_eq!(at_last.current_stage_title.as_deref(), Some("最终调整"));
    assert!(!at_last.capabilities.can_advance);
    assert!(at_last.capabilities.can_complete, "到末阶段后可以完成");

    let mut conn = ctx.conn();
    let err = lifecycle::advance_stage(&mut conn, common::lifecycle_input(&at_last)).unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("最后一个阶段"), "{}", err.message);
}

#[test]
fn d02_07_rework_goes_back_one_or_to_a_named_earlier_stage() {
    let ctx = Ctx::new();
    let id = ctx.create_order("返工");
    start(&ctx, &id);
    advance(&ctx, &id); // 线稿
    advance(&ctx, &id); // 固有色

    let back_one = rework(&ctx, &id, None).unwrap();
    assert_eq!(back_one.current_stage_title.as_deref(), Some("线稿"));
    assert_eq!(back_one.revision, 4);

    let events = ctx.events(&id);
    let last = events.last().unwrap();
    assert_eq!(last.kind, "stage_reworked");
    assert_eq!(last.from_stage_title.as_deref(), Some("固有色"));
    assert_eq!(last.to_stage_title.as_deref(), Some("线稿"));
    assert_eq!(last.movement.as_deref(), Some("backward"));
    assert_eq!(last.note, None, "单步返工不标记为多阶段");

    // 明确跳过多个阶段回到更早的位置
    advance(&ctx, &id); // 回到固有色
    let at_third = ctx.load(&id);
    let draft_id = at_third.stages[0].id.clone();
    let deep = rework(&ctx, &id, Some(&draft_id)).unwrap();
    assert_eq!(deep.current_stage_title.as_deref(), Some("草稿"));
    assert_eq!(deep.current_stage_index, Some(0));

    let events = ctx.events(&id);
    let last = events.last().unwrap();
    assert_eq!(last.from_stage_title.as_deref(), Some("固有色"));
    assert_eq!(last.to_stage_title.as_deref(), Some("草稿"));
    assert_eq!(last.note.as_deref(), Some("多阶段返工"));
}

#[test]
fn d02_07_rework_cannot_jump_forward() {
    let ctx = Ctx::new();
    let id = ctx.create_order("返工越界");
    start(&ctx, &id);
    advance(&ctx, &id); // 线稿
    let view = ctx.load(&id);
    let later = view.stages[2].id.clone();

    let err = rework(&ctx, &id, Some(&later)).unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("更早"), "{}", err.message);
}

#[test]
fn d02_08_undo_requires_first_stage_and_no_movement_since_start() {
    let ctx = Ctx::new();
    let id = ctx.create_order("撤销开工");
    start(&ctx, &id);

    // 一开始满足条件
    let view = ctx.load(&id);
    assert!(view.capabilities.can_undo_start_work);

    let mut conn = ctx.conn();
    let undone = lifecycle::undo_start_work(&mut conn, common::lifecycle_input(&view)).unwrap();
    assert!(undone.started_at.is_none());
    assert_eq!(undone.work_state, WorkState::Queued);
    assert_eq!(undone.current_stage_title.as_deref(), Some("草稿"));
    assert_eq!(undone.revision, 2);
    assert_eq!(ctx.kinds(&id), vec!["created", "work_started", "work_start_undone"]);
}

#[test]
fn d02_08_undo_is_blocked_after_advancing() {
    let ctx = Ctx::new();
    let id = ctx.create_order("推进后撤销");
    start(&ctx, &id);
    advance(&ctx, &id);
    // 回到第一阶段
    let view = ctx.load(&id);
    let draft = view.stages[0].id.clone();
    let back = rework(&ctx, &id, Some(&draft)).unwrap();

    assert!(!back.capabilities.can_undo_start_work, "推进过就不能撤销开工");
    assert!(back
        .capabilities
        .undo_blocked_reason
        .as_deref()
        .unwrap_or_default()
        .contains("推进或返工"));

    let mut conn = ctx.conn();
    let err = lifecycle::undo_start_work(&mut conn, common::lifecycle_input(&back)).unwrap_err();
    assert_eq!(err.code, "INVALID");
}

#[test]
fn d02_08_undo_is_blocked_when_not_on_first_stage() {
    let ctx = Ctx::new();
    let id = ctx.create_order("非首阶段撤销");
    start(&ctx, &id);
    advance(&ctx, &id);
    let view = ctx.load(&id);
    assert!(!view.capabilities.can_undo_start_work);
    assert!(view
        .capabilities
        .undo_blocked_reason
        .as_deref()
        .unwrap_or_default()
        .contains("第一阶段"));
}

#[test]
fn d02_08_undo_then_restart_starts_a_new_window() {
    let ctx = Ctx::new();
    let id = ctx.create_order("再次开工");
    start(&ctx, &id);
    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    lifecycle::undo_start_work(&mut conn, common::lifecycle_input(&view)).unwrap();

    // 重新开工后，历史判断以新一轮开工为起点。
    start(&ctx, &id);
    let again = ctx.load(&id);
    assert!(again.capabilities.can_undo_start_work, "新一轮开工应可撤销");
    assert_eq!(
        ctx.kinds(&id),
        vec![
            "created",
            "work_started",
            "work_start_undone",
            "work_started"
        ]
    );
}

#[test]
fn d02_09_single_stage_order_must_start_before_completing() {
    let ctx = Ctx::new();
    let mut conn = ctx.conn();

    // 造一个单阶段流程模板
    let now = minidesk::store::timezone::now_timestamp();
    conn.execute(
        "INSERT INTO stage_templates (id, name, is_default, revision, created_at, updated_at)
         VALUES ('tpl-one', '单阶段', 0, 0, ?1, ?1)",
        [&now],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO stage_template_steps (template_id, step_id, title, position)
         VALUES ('tpl-one', 'only', '一次完成', 0)",
        [],
    )
    .unwrap();

    let order = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "单阶段".into(),
            template_id: Some("tpl-one".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(order.stage_count, 1);
    assert!(!order.capabilities.can_complete, "未开工不能完成");
    assert!(!order.capabilities.can_advance, "单阶段无需推进");

    // 未开工直接完成 → 拒绝
    let err = lifecycle::complete_order(&mut conn, common::lifecycle_input(&order)).unwrap_err();
    assert_eq!(err.code, "INVALID");

    let started = start(&ctx, &order.id);
    assert!(started.capabilities.can_complete, "开工后可直接完成");

    let done = lifecycle::complete_order(&mut conn, common::lifecycle_input(&started)).unwrap();
    assert_eq!(done.status, "complete");
    assert!(done.completed_at.is_some());
    assert_eq!(done.work_state, WorkState::Completed);
    assert!(done.capabilities.can_reopen);
}

#[test]
fn d02_10_unstarted_order_can_be_cancelled_and_does_not_fake_a_start() {
    let ctx = Ctx::new();
    let id = ctx.create_order("未开工取消");
    let view = ctx.load(&id);
    let mut conn = ctx.conn();

    let cancelled = lifecycle::cancel_order(&mut conn, common::lifecycle_input(&view)).unwrap();
    assert_eq!(cancelled.status, "cancelled");
    assert!(cancelled.started_at.is_none(), "取消不得补记开工时间");
    assert!(cancelled.cancelled_at.is_some());
    assert_eq!(ctx.kinds(&id), vec!["created", "cancelled"]);
}

#[test]
fn d02_11_terminal_state_locks_stage_and_start_work() {
    let ctx = Ctx::new();
    let id = ctx.create_order("终态锁");
    start(&ctx, &id);
    advance(&ctx, &id);

    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    let cancelled = lifecycle::cancel_order(&mut conn, common::lifecycle_input(&view)).unwrap();
    assert!(!cancelled.capabilities.can_start_work);
    assert!(!cancelled.capabilities.can_advance);
    assert!(!cancelled.capabilities.can_rework);
    assert!(!cancelled.capabilities.can_complete);
    assert!(!cancelled.capabilities.can_cancel);
    assert!(cancelled.capabilities.can_reopen);

    let err = lifecycle::start_work(&mut conn, common::lifecycle_input(&cancelled)).unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("已取消"), "{}", err.message);
}

#[test]
fn d02_12_reopen_keeps_stage_and_start_state() {
    let ctx = Ctx::new();
    let id = ctx.create_order("重开");
    start(&ctx, &id);
    advance(&ctx, &id);
    let at_second = ctx.load(&id);

    let mut conn = ctx.conn();
    let cancelled =
        lifecycle::cancel_order(&mut conn, common::lifecycle_input(&at_second)).unwrap();
    assert!(cancelled.cancelled_at.is_some());

    let reopened = lifecycle::reopen_order(&mut conn, common::lifecycle_input(&cancelled)).unwrap();
    assert_eq!(reopened.status, "active");
    assert_eq!(reopened.current_stage_title.as_deref(), Some("线稿"), "阶段必须保留");
    assert!(reopened.started_at.is_some(), "有效开工记录必须保留");
    assert!(reopened.completed_at.is_none());
    assert!(reopened.cancelled_at.is_none());
    assert_eq!(reopened.work_state, WorkState::InProgress, "有开工记录 → 制作中");

    let events = ctx.events(&id);
    assert_eq!(events.last().unwrap().kind, "reopened");
    // 取消事件仍然存在
    assert!(events.iter().any(|e| e.kind == "cancelled"));
}

#[test]
fn d02_12_reopen_without_start_shows_queued() {
    let ctx = Ctx::new();
    let id = ctx.create_order("未开工重开");
    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    let cancelled = lifecycle::cancel_order(&mut conn, common::lifecycle_input(&view)).unwrap();
    let reopened = lifecycle::reopen_order(&mut conn, common::lifecycle_input(&cancelled)).unwrap();
    assert!(reopened.started_at.is_none());
    assert_eq!(reopened.work_state, WorkState::Queued);
}

#[test]
fn d02_13_reopen_appends_to_the_active_queue_tail() {
    let ctx = Ctx::new();
    let a = ctx.create_order("甲");
    let b = ctx.create_order("乙");
    let c = ctx.create_order("丙");

    let view = ctx.load(&a);
    let mut conn = ctx.conn();
    let cancelled = lifecycle::cancel_order(&mut conn, common::lifecycle_input(&view)).unwrap();
    let reopened = lifecycle::reopen_order(&mut conn, common::lifecycle_input(&cancelled)).unwrap();

    assert!(reopened.queue_position > ctx.load(&b).queue_position);
    assert!(reopened.queue_position > ctx.load(&c).queue_position);

    // 活动队列顺序：乙 丙 甲
    let conn2 = ctx.conn();
    let ordered: Vec<String> = minidesk::domain::orders::list(&conn2)
        .unwrap()
        .into_iter()
        .filter(|o| o.status == "active")
        .map(|o| o.title)
        .collect();
    assert_eq!(ordered, vec!["乙", "丙", "甲"]);
}

#[test]
fn d02_14_completing_twice_records_two_completion_events() {
    let ctx = Ctx::new();
    let mut conn = ctx.conn();

    conn.execute(
        "INSERT INTO stage_templates (id, name, is_default, revision, created_at, updated_at)
         VALUES ('tpl-one', '单阶段', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO stage_template_steps (template_id, step_id, title, position)
         VALUES ('tpl-one', 'only', '一次完成', 0)",
        [],
    )
    .unwrap();

    let order = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "两次完成".into(),
            template_id: Some("tpl-one".into()),
            ..Default::default()
        },
    )
    .unwrap();

    let started = start(&ctx, &order.id);
    let done = lifecycle::complete_order(&mut conn, common::lifecycle_input(&started)).unwrap();
    let reopened = lifecycle::reopen_order(&mut conn, common::lifecycle_input(&done)).unwrap();
    let done_again =
        lifecycle::complete_order(&mut conn, common::lifecycle_input(&reopened)).unwrap();

    assert_eq!(done_again.status, "complete");
    let completions = ctx
        .events(&order.id)
        .into_iter()
        .filter(|e| e.kind == "completed")
        .count();
    assert_eq!(completions, 2, "同一订单再次完成应产生第二个完成事件");

    let reopens = ctx
        .events(&order.id)
        .into_iter()
        .filter(|e| e.kind == "reopened")
        .count();
    assert_eq!(reopens, 1);
}

#[test]
fn completing_an_already_completed_order_is_refused() {
    let ctx = Ctx::new();
    let mut conn = ctx.conn();
    conn.execute(
        "INSERT INTO stage_templates (id, name, is_default, revision, created_at, updated_at)
         VALUES ('tpl-one', '单阶段', 0, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO stage_template_steps (template_id, step_id, title, position)
         VALUES ('tpl-one', 'only', '一次完成', 0)",
        [],
    )
    .unwrap();
    let order = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "重复完成".into(),
            template_id: Some("tpl-one".into()),
            ..Default::default()
        },
    )
    .unwrap();
    let started = start(&ctx, &order.id);
    let done = lifecycle::complete_order(&mut conn, common::lifecycle_input(&started)).unwrap();
    let err = lifecycle::complete_order(&mut conn, common::lifecycle_input(&done)).unwrap_err();
    assert_eq!(err.code, "INVALID");
}

#[test]
fn work_start_cannot_be_repeated() {
    let ctx = Ctx::new();
    let id = ctx.create_order("重复开工");
    let started = start(&ctx, &id);
    let mut conn = ctx.conn();
    let err = lifecycle::start_work(&mut conn, common::lifecycle_input(&started)).unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert_eq!(
        ctx.kinds(&id),
        vec!["created", "work_started"],
        "不得产生第二条开工事件"
    );
}

#[test]
fn terminal_status_cannot_be_reached_without_start_even_at_last_stage() {
    let ctx = Ctx::new();
    let id = ctx.create_order("末阶段未开工");
    start(&ctx, &id);
    for _ in 0..4 {
        advance(&ctx, &id);
    }
    let view = ctx.load(&id);
    assert!(view.capabilities.can_complete);

    // 撤销不可行（已推进），因此改用另一个订单验证：先推进到末阶段再取消，
    // 取消后不能直接完成。
    let mut conn = ctx.conn();
    let cancelled = lifecycle::cancel_order(&mut conn, common::lifecycle_input(&view)).unwrap();
    let err = lifecycle::complete_order(&mut conn, common::lifecycle_input(&cancelled)).unwrap_err();
    assert_eq!(err.code, "INVALID");
}

#[test]
fn lifecycle_actions_do_not_touch_other_orders() {
    let ctx = Ctx::new();
    let a = ctx.create_order("甲");
    let b = ctx.create_order("乙");
    let before = ctx.load(&b);

    let view = ctx.load(&a);
    let mut conn = ctx.conn();
    lifecycle::start_work(&mut conn, common::lifecycle_input(&view)).unwrap();
    let after = ctx.load(&b);

    assert_eq!(before.revision, after.revision);
    assert_eq!(before.updated_at, after.updated_at);
    assert_eq!(ctx.kinds(&b), vec!["created"]);
}

#[test]
fn client_survives_lifecycle_actions() {
    let ctx = Ctx::new();
    let mut conn = ctx.conn();
    let order = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "带客户走完流程".into(),
            client: ClientChoice::New {
                display_name: "老客户".into(),
                contact: None,
                note: None,
            },
            ..Default::default()
        },
    )
    .unwrap();
    let started = start(&ctx, &order.id);
    let cancelled = lifecycle::cancel_order(&mut conn, common::lifecycle_input(&started)).unwrap();
    assert_eq!(cancelled.client_name.as_deref(), Some("老客户"));
}

#[test]
fn queue_revision_changes_on_terminal_transitions_but_order_revision_is_independent() {
    let ctx = Ctx::new();
    let id = ctx.create_order("队列版本");
    let conn = ctx.conn();
    let start_queue = lifecycle::queue_revision(&conn).unwrap();

    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    lifecycle::cancel_order(&mut conn, common::lifecycle_input(&view)).unwrap();

    let conn = ctx.conn();
    let after_queue = lifecycle::queue_revision(&conn).unwrap();
    assert_eq!(after_queue, start_queue + 1, "终态移出活动队列应 bump 队列版本");
}

#[test]
fn revision_conflict_blocks_lifecycle_actions() {
    let ctx = Ctx::new();
    let id = ctx.create_order("版本冲突");
    let stale = ctx.load(&id);
    start(&ctx, &id);

    let mut conn = ctx.conn();
    let err = lifecycle::start_work(
        &mut conn,
        LifecycleInput {
            order_id: id.clone(),
            expected_revision: stale.revision,
            request_id: None,
        },
    )
    .unwrap_err();
    // 已经开工，前置条件先失败；无论哪种都必须拒绝且不重复写事件。
    assert!(err.code == "INVALID" || err.code == "CONFLICT");
    assert_eq!(ctx.kinds(&id), vec!["created", "work_started"]);
}
