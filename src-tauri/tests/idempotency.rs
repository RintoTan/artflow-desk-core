//! D02-17 / D02-18：事务失败不留孤立事件；重复请求不产生重复事件。

mod common;

use common::Ctx;
use minidesk::domain::lifecycle::{self, LifecycleInput, ReworkInput};

fn with_request(view: &minidesk::domain::orders::OrderView, request_id: &str) -> LifecycleInput {
    LifecycleInput {
        order_id: view.id.clone(),
        expected_revision: view.revision,
        request_id: Some(request_id.into()),
    }
}

#[test]
fn d02_18_duplicate_start_request_writes_one_event() {
    let ctx = Ctx::new();
    let id = ctx.create_order("重复开工请求");
    let view = ctx.load(&id);
    let mut conn = ctx.conn();

    let first = lifecycle::start_work(&mut conn, with_request(&view, "req-start-1")).unwrap();
    assert!(first.started_at.is_some());

    // 同一个 request_id 再发一次：直接返回，不再写事件、不再 bump 版本。
    let second = lifecycle::start_work(&mut conn, with_request(&view, "req-start-1")).unwrap();
    assert_eq!(second.revision, first.revision);
    assert_eq!(second.started_at, first.started_at);

    assert_eq!(ctx.kinds(&id), vec!["created", "work_started"]);
}

#[test]
fn d02_18_duplicate_advance_request_writes_one_event() {
    let ctx = Ctx::new();
    let id = ctx.create_order("重复推进请求");
    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    let started = lifecycle::start_work(&mut conn, common::lifecycle_input(&view)).unwrap();

    let first = lifecycle::advance_stage(&mut conn, with_request(&started, "req-adv-1")).unwrap();
    let second = lifecycle::advance_stage(&mut conn, with_request(&started, "req-adv-1")).unwrap();

    assert_eq!(first.current_stage_title, second.current_stage_title);
    assert_eq!(first.revision, second.revision);
    assert_eq!(
        ctx.kinds(&id),
        vec!["created", "work_started", "stage_advanced"]
    );
}

#[test]
fn d02_18_duplicate_complete_and_reopen_requests_are_idempotent() {
    let ctx = Ctx::new();
    let _root_id = ctx.create_order("重复终态请求");
    let mut conn = ctx.conn();

    // 单阶段模板，便于直接完成
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
    let order = minidesk::domain::orders::create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        minidesk::domain::orders::CreateOrderInput {
            title: "单阶段重复请求".into(),
            template_id: Some("tpl-one".into()),
            ..Default::default()
        },
    )
    .unwrap();

    let started = lifecycle::start_work(&mut conn, common::lifecycle_input(&order)).unwrap();
    let done = lifecycle::complete_order(&mut conn, with_request(&started, "req-done-1")).unwrap();
    let done_again =
        lifecycle::complete_order(&mut conn, with_request(&started, "req-done-1")).unwrap();
    assert_eq!(done.revision, done_again.revision);

    let reopened = lifecycle::reopen_order(&mut conn, with_request(&done, "req-open-1")).unwrap();
    let reopened_again =
        lifecycle::reopen_order(&mut conn, with_request(&done, "req-open-1")).unwrap();
    assert_eq!(reopened.revision, reopened_again.revision);

    let kinds = ctx.kinds(&order.id);
    assert_eq!(kinds.iter().filter(|k| *k == "completed").count(), 1);
    assert_eq!(kinds.iter().filter(|k| *k == "reopened").count(), 1);
}

#[test]
fn d02_17_failed_transaction_leaves_no_orphan_event() {
    let ctx = Ctx::new();
    let id = ctx.create_order("注入失败");
    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    let started = lifecycle::start_work(&mut conn, common::lifecycle_input(&view)).unwrap();

    let before_events = ctx.events(&id).len();
    let before_revision = started.revision;
    let before_stage = started.current_stage_id.clone();

    // 用触发器让 UPDATE 在事务中途失败，验证事件不会单独留下。
    conn.execute_batch(
        "CREATE TRIGGER inject_fail BEFORE UPDATE ON orders
         BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
    )
    .unwrap();

    let err = lifecycle::advance_stage(&mut conn, common::lifecycle_input(&started)).unwrap_err();
    assert_eq!(err.code, "DB");

    conn.execute_batch("DROP TRIGGER inject_fail").unwrap();

    let after = ctx.load(&id);
    assert_eq!(after.current_stage_id, before_stage, "阶段不得改变");
    assert_eq!(after.revision, before_revision, "版本不得前进");
    assert_eq!(ctx.events(&id).len(), before_events, "不得留下孤立事件");
    assert_eq!(ctx.kinds(&id), vec!["created", "work_started"]);
}

#[test]
fn d02_17_failed_workflow_edit_leaves_the_flow_intact() {
    let ctx = Ctx::new();
    let id = ctx.create_order("流程注入失败");
    let view = ctx.load(&id);
    let mut conn = ctx.conn();

    conn.execute_batch(
        "CREATE TRIGGER inject_fail2 BEFORE UPDATE ON orders
         BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
    )
    .unwrap();

    let err = minidesk::domain::workflow::add_stage(
        &mut conn,
        minidesk::domain::workflow::AddStageInput {
            order_id: id.clone(),
            expected_revision: view.revision,
            title: "不该出现".into(),
            position: None,
            request_id: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "DB");
    conn.execute_batch("DROP TRIGGER inject_fail2").unwrap();

    let after = ctx.load(&id);
    assert_eq!(after.stage_count, 5, "流程结构必须回滚");
    assert_eq!(after.revision, 0);
    assert!(!after.stages.iter().any(|s| s.title == "不该出现"));
    assert_eq!(ctx.kinds(&id), vec!["created"]);
}

#[test]
fn d02_17_failed_rework_keeps_stage_and_events() {
    let ctx = Ctx::new();
    let id = ctx.create_order("返工注入失败");
    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    let started = lifecycle::start_work(&mut conn, common::lifecycle_input(&view)).unwrap();
    let advanced = lifecycle::advance_stage(&mut conn, common::lifecycle_input(&started)).unwrap();

    let before = ctx.events(&id).len();
    conn.execute_batch(
        "CREATE TRIGGER inject_fail3 BEFORE UPDATE ON orders
         BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
    )
    .unwrap();

    let err = lifecycle::rework_stage(
        &mut conn,
        ReworkInput {
            order_id: id.clone(),
            expected_revision: advanced.revision,
            target_stage_id: None,
            request_id: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "DB");
    conn.execute_batch("DROP TRIGGER inject_fail3").unwrap();

    assert_eq!(ctx.events(&id).len(), before);
    assert_eq!(ctx.load(&id).current_stage_id, advanced.current_stage_id);
}

#[test]
fn two_editors_with_the_same_revision_only_one_wins() {
    let ctx = Ctx::new();
    let _id = ctx.create_order("双编辑器");
    let view = ctx.load(&_id);

    let mut conn_a = ctx.conn();
    let mut conn_b = ctx.conn();

    let first = lifecycle::start_work(&mut conn_a, common::lifecycle_input(&view));
    let second = lifecycle::start_work(&mut conn_b, common::lifecycle_input(&view));

    let wins = [first.is_ok(), second.is_ok()].iter().filter(|ok| **ok).count();
    assert_eq!(wins, 1, "同一 revision 只能有一个成功");
    assert_eq!(ctx.kinds(&_id), vec!["created", "work_started"]);
}

#[test]
fn request_id_is_scoped_per_order() {
    let ctx = Ctx::new();
    let a = ctx.create_order("甲");
    let b = ctx.create_order("乙");
    let view_a = ctx.load(&a);
    let view_b = ctx.load(&b);
    let mut conn = ctx.conn();

    lifecycle::start_work(&mut conn, with_request(&view_a, "same-key")).unwrap();
    // 另一个订单用同一个键是合法的新操作。
    lifecycle::start_work(&mut conn, with_request(&view_b, "same-key")).unwrap();

    assert!(ctx.load(&a).started_at.is_some());
    assert!(ctx.load(&b).started_at.is_some());
}
