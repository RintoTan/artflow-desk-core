//! DEV-06D-3：改期历史（`rescheduled` 事件）与统一日期修改入口。
//!
//! 覆盖：同事务、同日期不写、建单不写、冲突/失败不写、清空记录、字段不丢、
//! 终态守卫、来源区分、不影响完成统计与生命周期历史。

mod common;

use minidesk::domain::events;
use minidesk::domain::lifecycle::{self, LifecycleInput};
use minidesk::domain::orders::{self, UpdateDetailsInput};

fn input(
    order_id: &str,
    revision: i64,
    title: &str,
    start: Option<&str>,
    delivery: Option<&str>,
) -> UpdateDetailsInput {
    UpdateDetailsInput {
        order_id: order_id.into(),
        expected_revision: revision,
        title: title.into(),
        client_id: None,
        commission_type: None,
        source: None,
        amount_cents: None,
        planned_start_date: start.map(|v| v.to_string()),
        planned_delivery_date: delivery.map(|v| v.to_string()),
        note: None,
        change_source: None,
        reason: None,
    }
}

#[test]
fn reschedule_writes_one_event_with_old_new_reason_and_source() {
    let ctx = common::Ctx::new();
    let id = ctx.create_order("改期记录");
    let view = ctx.load(&id);

    let mut conn = ctx.conn();
    let mut req = input(&id, view.revision, &view.title, Some("2026-12-01"), Some("2026-12-20"));
    req.change_source = Some("calendar".into());
    req.reason = Some("客户延期一周".into());
    let updated = orders::update_details(&mut conn, req).unwrap();
    assert_eq!(updated.planned_start_date.as_deref(), Some("2026-12-01"));

    let events = ctx.events(&id);
    assert_eq!(events.len(), 2, "created + rescheduled");
    let ev = &events[1];
    assert_eq!(ev.kind, events::RESCHEDULED);
    assert_eq!(ev.old_start_date, None);
    assert_eq!(ev.old_delivery_date, None);
    assert_eq!(ev.new_start_date.as_deref(), Some("2026-12-01"));
    assert_eq!(ev.new_delivery_date.as_deref(), Some("2026-12-20"));
    assert_eq!(ev.reason.as_deref(), Some("客户延期一周"));
    assert_eq!(ev.change_source.as_deref(), Some("calendar"));
    assert!(ev.from_status.is_none() && ev.to_status.is_none(), "改期不是状态变更");
}

#[test]
fn unchanged_dates_do_not_write_an_event() {
    let ctx = common::Ctx::new();
    let id = ctx.create_order("不改日期");
    let view = ctx.load(&id);

    let mut conn = ctx.conn();
    let updated = orders::update_details(
        &mut conn,
        input(&id, view.revision, "只改标题", Some("2026-12-01"), Some("2026-12-20")),
    )
    .unwrap();
    assert_eq!(updated.revision, 1);

    // 第二次提交完全相同的日期：不写事件
    let again = orders::update_details(
        &mut conn,
        input(&id, updated.revision, "只改标题", Some("2026-12-01"), Some("2026-12-20")),
    )
    .unwrap();
    assert_eq!(again.revision, 1, "内容一致不 bump revision");
    assert_eq!(ctx.kinds(&id), vec!["created", "rescheduled"]);
}

#[test]
fn creating_an_order_with_dates_does_not_write_a_reschedule() {
    let ctx = common::Ctx::new();
    let mut conn = ctx.conn();
    let view = orders::create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        orders::CreateOrderInput {
            title: "建单即排期".into(),
            planned_start_date: Some("2026-12-05".into()),
            planned_delivery_date: Some("2026-12-15".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(ctx.kinds(&view.id), vec!["created"], "建单不写改期事件");
}

#[test]
fn clearing_dates_is_recorded_as_a_reschedule() {
    let ctx = common::Ctx::new();
    let mut conn = ctx.conn();
    let view = orders::create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        orders::CreateOrderInput {
            title: "清空日期".into(),
            planned_start_date: Some("2026-12-05".into()),
            planned_delivery_date: Some("2026-12-15".into()),
            ..Default::default()
        },
    )
    .unwrap();

    let cleared = orders::update_details(&mut conn, input(&view.id, view.revision, &view.title, None, None)).unwrap();
    assert!(cleared.planned_start_date.is_none());
    assert!(cleared.planned_delivery_date.is_none());

    let events = ctx.events(&view.id);
    let last = events.last().unwrap();
    assert_eq!(last.kind, events::RESCHEDULED);
    assert_eq!(last.old_start_date.as_deref(), Some("2026-12-05"));
    assert_eq!(last.old_delivery_date.as_deref(), Some("2026-12-15"));
    assert!(last.new_start_date.is_none() && last.new_delivery_date.is_none());
}

#[test]
fn revision_conflict_writes_nothing_and_keeps_conflict_semantics() {
    let ctx = common::Ctx::new();
    let id = ctx.create_order("并发改期");
    let view = ctx.load(&id);

    let mut conn = ctx.conn();
    // 先用正确 revision 改一次
    let first = orders::update_details(
        &mut conn,
        input(&id, view.revision, &view.title, Some("2026-12-01"), Some("2026-12-10")),
    )
    .unwrap();
    let before = ctx.kinds(&id).len();

    // 再用过期 revision 改日期
    let err = orders::update_details(
        &mut conn,
        input(&id, view.revision, &view.title, Some("2026-12-02"), Some("2026-12-11")),
    )
    .unwrap_err();
    assert_eq!(err.code, "CONFLICT");
    assert_eq!(ctx.kinds(&id).len(), before, "冲突不写历史");
    assert_eq!(
        ctx.load(&id).planned_start_date.as_deref(),
        first.planned_start_date.as_deref(),
        "冲突不改日期"
    );
}

#[test]
fn invalid_date_range_writes_nothing() {
    let ctx = common::Ctx::new();
    let id = ctx.create_order("非法区间");
    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    let err = orders::update_details(
        &mut conn,
        input(&id, view.revision, &view.title, Some("2026-12-20"), Some("2026-12-10")),
    )
    .unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert_eq!(ctx.kinds(&id), vec!["created"]);
}

#[test]
fn other_fields_survive_a_date_only_change() {
    let ctx = common::Ctx::new();
    let id = ctx.create_order("字段保留");
    let view = ctx.load(&id);

    let mut conn = ctx.conn();
    let full = UpdateDetailsInput {
        order_id: id.clone(),
        expected_revision: view.revision,
        title: "完整资料".into(),
        client_id: None,
        commission_type: Some("半身立绘".into()),
        source: Some("画加".into()),
        amount_cents: Some(88_000),
        planned_start_date: Some("2026-12-01".into()),
        planned_delivery_date: Some("2026-12-08".into()),
        note: Some("两张草图".into()),
        change_source: None,
        reason: None,
    };
    let first = orders::update_details(&mut conn, full).unwrap();

    // 只改交付日的整单回填：其余字段必须原样保留
    let second = orders::update_details(
        &mut conn,
        UpdateDetailsInput {
            order_id: id.clone(),
            expected_revision: first.revision,
            title: first.title.clone(),
            client_id: first.client_id.clone(),
            commission_type: first.commission_type.clone(),
            source: first.source.clone(),
            amount_cents: first.amount_cents,
            planned_start_date: first.planned_start_date.clone(),
            planned_delivery_date: Some("2026-12-12".into()),
            note: first.note.clone(),
            change_source: Some("calendar".into()),
            reason: None,
        },
    )
    .unwrap();

    assert_eq!(second.title, "完整资料");
    assert_eq!(second.commission_type.as_deref(), Some("半身立绘"));
    assert_eq!(second.source.as_deref(), Some("画加"));
    assert_eq!(second.amount_cents, Some(88_000));
    assert_eq!(second.note.as_deref(), Some("两张草图"));
    assert_eq!(second.planned_start_date.as_deref(), Some("2026-12-01"));
    assert_eq!(second.planned_delivery_date.as_deref(), Some("2026-12-12"));
    assert_eq!(second.status, "active");
}

#[test]
fn terminal_orders_cannot_be_rescheduled_but_can_edit_other_fields() {
    let ctx = common::Ctx::new();
    let id = ctx.create_order("终态守卫");
    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    lifecycle::cancel_order(&mut conn, common::lifecycle_input(&view)).unwrap();
    let cancelled = ctx.load(&id);

    // 改日期 → 拒绝
    let err = orders::update_details(
        &mut conn,
        input(&id, cancelled.revision, &cancelled.title, Some("2026-12-01"), None),
    )
    .unwrap_err();
    assert_eq!(err.code, "INVALID", "{}", err.message);

    // 只改标题 → 允许，且不写改期事件
    let before = ctx.kinds(&id).len();
    let renamed = orders::update_details(
        &mut conn,
        input(&id, cancelled.revision, "取消后改标题", None, None),
    )
    .unwrap();
    assert_eq!(renamed.title, "取消后改标题");
    assert_eq!(ctx.kinds(&id).len(), before, "非日期编辑不写历史");
}

#[test]
fn reschedule_does_not_pollute_lifecycle_history_or_completion_count() {
    let ctx = common::Ctx::new();
    let id = ctx.create_order("生命周期");
    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    let started = lifecycle::start_work(&mut conn, common::lifecycle_input(&view)).unwrap();

    orders::update_details(
        &mut conn,
        input(&id, started.revision, &started.title, Some("2026-12-03"), Some("2026-12-09")),
    )
    .unwrap();

    let kinds = ctx.kinds(&id);
    assert_eq!(kinds, vec!["created", "work_started", "rescheduled"]);
    assert!(!kinds.iter().any(|k| k == "completed" || k == "cancelled"));

    let after = ctx.load(&id);
    assert_eq!(after.status, "active", "改期不改状态");
    assert!(after.started_at.is_some(), "改期不动开工记录");
    assert_eq!(after.work_state, minidesk::domain::lifecycle::WorkState::InProgress, "改期不动制作状态");
}

#[test]
fn unknown_change_source_is_rejected() {
    let ctx = common::Ctx::new();
    let id = ctx.create_order("来源校验");
    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    let mut req = input(&id, view.revision, &view.title, Some("2026-12-01"), None);
    req.change_source = Some("mobile".into());
    let err = orders::update_details(&mut conn, req).unwrap_err();
    assert_eq!(err.code, "INVALID");
}

#[test]
fn same_day_range_is_allowed() {
    let ctx = common::Ctx::new();
    let id = ctx.create_order("同日");
    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    let updated = orders::update_details(
        &mut conn,
        input(&id, view.revision, &view.title, Some("2026-12-09"), Some("2026-12-09")),
    )
    .unwrap();
    assert_eq!(updated.planned_start_date, updated.planned_delivery_date);
}

#[test]
fn request_id_idempotency_still_works_after_rebuild() {
    // v6 重建了 order_events，唯一索引必须仍然生效。
    let ctx = common::Ctx::new();
    let id = ctx.create_order("幂等键");
    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    let req = LifecycleInput {
        order_id: id.clone(),
        expected_revision: view.revision,
        request_id: Some("fixed-request-1".into()),
    };
    lifecycle::start_work(&mut conn, req.clone()).unwrap();
    lifecycle::start_work(&mut conn, req).unwrap(); // 重复提交不报错
    let kinds = ctx.kinds(&id);
    assert_eq!(kinds.iter().filter(|k| *k == "work_started").count(), 1);
}
