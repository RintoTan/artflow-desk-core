//! DEV-05：工作台指标、到期边界、事件口径与金额归属。

mod common;

use chrono::NaiveDate;
use common::Ctx;
use minidesk::domain::dashboard;
use minidesk::domain::deadline::{classify, DeadlineState};
use minidesk::domain::lifecycle;
use minidesk::domain::orders;
use minidesk::domain::stats::{self, StatsRange};
use rusqlite::params;

fn date(raw: &str) -> NaiveDate {
    NaiveDate::parse_from_str(raw, "%Y-%m-%d").unwrap()
}

fn today() -> NaiveDate {
    minidesk::store::timezone::local_today(common::tz())
}

/// 建一张活动订单，可指定交付日期与金额。
fn make(ctx: &Ctx, title: &str, delivery: Option<&str>, amount: Option<i64>) -> String {
    let mut conn = ctx.conn();
    let view = minidesk::domain::orders::create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        minidesk::domain::orders::CreateOrderInput {
            title: title.into(),
            amount_cents: amount,
            planned_delivery_date: delivery.map(|s| s.to_string()),
            ..Default::default()
        },
    )
    .unwrap();
    view.id
}

fn start(ctx: &Ctx, id: &str) {
    let view = ctx.load(id);
    let mut conn = ctx.conn();
    lifecycle::start_work(&mut conn, common::lifecycle_input(&view)).unwrap();
}

fn metrics(ctx: &Ctx) -> dashboard::DashboardMetrics {
    let conn = ctx.conn();
    dashboard::metrics(&conn).unwrap()
}

// ---------------------------------------------------------------- 到期边界

#[test]
fn deadline_classification_is_mutually_exclusive() {
    let today = date("2026-11-17");
    assert_eq!(classify(None, today), DeadlineState::Unscheduled);
    assert_eq!(classify(Some(date("2026-11-16")), today), DeadlineState::Overdue);
    assert_eq!(classify(Some(today), today), DeadlineState::Today);
    assert_eq!(classify(Some(date("2026-11-18")), today), DeadlineState::DueSoon);
    assert_eq!(classify(Some(date("2026-11-20")), today), DeadlineState::DueSoon);
    assert_eq!(classify(Some(date("2026-11-21")), today), DeadlineState::Scheduled);
}

#[test]
fn deadline_boundaries_survive_month_and_year_ends() {
    // 跨月
    let end_of_month = date("2026-01-30");
    assert_eq!(
        classify(Some(date("2026-02-02")), end_of_month),
        DeadlineState::DueSoon
    );
    assert_eq!(
        classify(Some(date("2026-02-03")), end_of_month),
        DeadlineState::Scheduled
    );
    // 跨年（含闰日附近）
    let end_of_year = date("2026-12-31");
    assert_eq!(
        classify(Some(date("2027-01-03")), end_of_year),
        DeadlineState::DueSoon
    );
    assert_eq!(
        classify(Some(date("2027-01-04")), end_of_year),
        DeadlineState::Scheduled
    );
    // 闰年 2 月
    let leap = date("2028-02-28");
    assert_eq!(
        classify(Some(date("2028-03-02")), leap),
        DeadlineState::DueSoon
    );
}

#[test]
fn dashboard_counts_follow_the_same_classification() {
    let ctx = Ctx::new();
    let t = today();
    let yesterday = t.pred_opt().unwrap();
    let in_two = t.checked_add_days(chrono::Days::new(2)).unwrap();
    let far = t.checked_add_days(chrono::Days::new(30)).unwrap();

    make(&ctx, "逾期", Some(&yesterday.format("%Y-%m-%d").to_string()), None);
    make(&ctx, "今天", Some(&t.format("%Y-%m-%d").to_string()), None);
    make(&ctx, "两天后", Some(&in_two.format("%Y-%m-%d").to_string()), None);
    make(&ctx, "很远", Some(&far.format("%Y-%m-%d").to_string()), None);
    make(&ctx, "未排期", None, None);

    let m = metrics(&ctx);
    assert_eq!(m.active_total, 5);
    assert_eq!(m.overdue, 1);
    assert_eq!(m.due_today, 1);
    assert_eq!(m.due_soon, 1);
    assert_eq!(m.unscheduled, 1);
    // 四类互斥：1+1+1+1 <= 总数
    assert_eq!(m.overdue + m.due_today + m.due_soon + m.unscheduled, 4);
    assert_eq!(m.today, t.format("%Y-%m-%d").to_string());
}

#[test]
fn queued_and_in_progress_split_by_started_at() {
    let ctx = Ctx::new();
    let a = make(&ctx, "未开工甲", None, None);
    let _b = make(&ctx, "未开工乙", None, None);
    start(&ctx, &a);

    let m = metrics(&ctx);
    assert_eq!(m.active_total, 2);
    assert_eq!(m.in_progress, 1);
    assert_eq!(m.queued, 1);
    assert_eq!(m.queued + m.in_progress, m.active_total);
}

#[test]
fn terminal_orders_never_appear_in_active_reminders() {
    let ctx = Ctx::new();
    let t = today();
    let overdue_date = t.pred_opt().unwrap().format("%Y-%m-%d").to_string();
    let id = make(&ctx, "会被取消", Some(&overdue_date), None);
    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    lifecycle::cancel_order(&mut conn, common::lifecycle_input(&view)).unwrap();

    let m = metrics(&ctx);
    assert_eq!(m.active_total, 0);
    assert_eq!(m.overdue, 0);
    assert_eq!(m.unscheduled, 0);
}

#[test]
fn order_view_exposes_the_same_deadline_state() {
    let ctx = Ctx::new();
    let t = today();
    let soon = t.checked_add_days(chrono::Days::new(1)).unwrap();
    let id = make(&ctx, "明天到期", Some(&soon.format("%Y-%m-%d").to_string()), None);
    let view = ctx.load(&id);
    assert_eq!(view.deadline_state, DeadlineState::DueSoon);
}

// ---------------------------------------------------------------- 事件统计

fn insert_event(ctx: &Ctx, order_id: &str, kind: &str, occurred_at: &str) {
    let conn = ctx.conn();
    conn.execute(
        "INSERT INTO order_events (order_id, kind, occurred_at) VALUES (?1, ?2, ?3)",
        params![order_id, kind, occurred_at],
    )
    .unwrap();
}

#[test]
fn event_counts_follow_events_not_status() {
    let ctx = Ctx::new();
    let id = make(&ctx, "两次完成", None, Some(10_000));
    // 同一个月内完成两次（模拟完成→重开→再完成）
    insert_event(&ctx, &id, "completed", "2026-11-05T02:00:00.000Z");
    insert_event(&ctx, &id, "completed", "2026-11-09T02:00:00.000Z");

    let conn = ctx.conn();
    let report = stats::report(&conn, StatsRange::All).unwrap();
    let total_completed: i64 = report.months.iter().map(|b| b.completed).sum();
    // created 事件来自真实建单（本月），这里只断言"完成按事件次数"
    assert_eq!(total_completed, 2, "同一订单两次完成必须计两次");
    // 金额只算一次（按订单，不按事件）
    assert_eq!(report.totals.amount_cents, 10_000);
}

#[test]
fn reopen_does_not_erase_previous_completions() {
    let ctx = Ctx::new();
    let id = make(&ctx, "完成重开", None, None);
    insert_event(&ctx, &id, "completed", "2026-10-03T02:00:00.000Z");
    insert_event(&ctx, &id, "reopened", "2026-10-04T02:00:00.000Z");
    insert_event(&ctx, &id, "completed", "2026-10-20T02:00:00.000Z");

    let conn = ctx.conn();
    let report = stats::report(&conn, StatsRange::All).unwrap();
    let october = report.months.iter().find(|b| b.month == "2026-10").unwrap();
    assert_eq!(october.completed, 2);
}

#[test]
fn events_are_attributed_by_working_timezone_month() {
    // 2026-10-31T20:00:00Z 在上海是 11 月 1 日，在洛杉矶仍是 10 月 31 日
    let ctx = Ctx::new();
    let id = make(&ctx, "跨月事件", None, None);
    insert_event(&ctx, &id, "completed", "2026-10-31T20:00:00.000Z");

    let conn = ctx.conn();
    let shanghai = stats::report(&conn, StatsRange::All).unwrap();
    let nov = shanghai.months.iter().find(|b| b.month == "2026-11").unwrap();
    assert_eq!(nov.completed, 1, "上海时区应归入 11 月");

    let now = minidesk::store::timezone::now_timestamp();
    minidesk::store::settings::set_working_timezone(&conn, "America/Los_Angeles", &now).unwrap();
    let la = stats::report(&conn, StatsRange::All).unwrap();
    let oct = la.months.iter().find(|b| b.month == "2026-10").unwrap();
    assert_eq!(oct.completed, 1, "洛杉矶时区应归入 10 月");
}

#[test]
fn events_of_missing_orders_are_not_counted() {
    let ctx = Ctx::new();
    let id = make(&ctx, "会被删的订单", None, None);
    insert_event(&ctx, &id, "completed", "2026-09-10T02:00:00.000Z");

    // 直接删订单（模拟永久的、不可逆的移除；外键级联会带走事件）
    let conn = ctx.conn();
    conn.execute("DELETE FROM orders WHERE id = ?1", [&id]).unwrap();

    let report = stats::report(&conn, StatsRange::All).unwrap();
    let september = report.months.iter().find(|b| b.month == "2026-09");
    assert!(
        september.is_none() || september.unwrap().completed == 0,
        "失去订单关联的事件不得继续计入"
    );
}

#[test]
fn cancelled_orders_still_count_their_cancel_events() {
    let ctx = Ctx::new();
    let id = make(&ctx, "取消但存在", None, None);
    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    lifecycle::cancel_order(&mut conn, common::lifecycle_input(&view)).unwrap();

    let report = stats::report(&conn, StatsRange::All).unwrap();
    assert_eq!(report.totals.cancelled, 1, "取消不是删除，事件仍计数");
}

#[test]
fn ranges_include_the_current_month() {
    let ctx = Ctx::new();
    let conn = ctx.conn();
    let current = minidesk::store::timezone::local_today(common::tz())
        .format("%Y-%m")
        .to_string();

    for (range, expected) in [
        (StatsRange::ThisMonth, 1usize),
        (StatsRange::Last6, 6),
        (StatsRange::Last12, 12),
    ] {
        let report = stats::report(&conn, range).unwrap();
        assert_eq!(report.months.len(), expected, "{}", range.as_str());
        assert_eq!(report.months.last().unwrap().month, current, "必须包含当前月");
    }

    let all = stats::report(&conn, StatsRange::All).unwrap();
    assert!(all.months.iter().any(|b| b.month == current));
    assert!(all.months.len() >= 1);
}

// ---------------------------------------------------------------- 金额

#[test]
fn null_amount_is_not_zero_and_zero_is_known() {
    let ctx = Ctx::new();
    make(&ctx, "未知金额", None, None);
    make(&ctx, "零元", None, Some(0));
    make(&ctx, "一千二", None, Some(120_000));

    let conn = ctx.conn();
    let report = stats::report(&conn, StatsRange::ThisMonth).unwrap();
    assert_eq!(report.totals.unknown_orders, 1);
    assert_eq!(report.totals.known_orders, 2, "0 元订单属于已知金额");
    assert_eq!(report.totals.amount_cents, 120_000);
}

#[test]
fn amount_follows_creation_month_and_current_value() {
    let ctx = Ctx::new();
    let id = make(&ctx, "十月创建", None, Some(50_000));
    // 把它挪到 10 月创建
    {
        let conn = ctx.conn();
        conn.execute(
            "UPDATE orders SET created_at = '2026-10-05T02:00:00.000Z' WHERE id = ?1",
            [&id],
        )
        .unwrap();
    }

    let conn = ctx.conn();
    let before = stats::report(&conn, StatsRange::All).unwrap();
    let october = before.months.iter().find(|b| b.month == "2026-10").unwrap();
    assert_eq!(october.amount_cents, 50_000);

    // 改当前金额 → 10 月的汇总随之变化
    conn.execute("UPDATE orders SET amount_cents = 88_800 WHERE id = ?1", [&id])
        .unwrap();
    let after = stats::report(&conn, StatsRange::All).unwrap();
    let october = after.months.iter().find(|b| b.month == "2026-10").unwrap();
    assert_eq!(october.amount_cents, 88_800, "金额归属创建月份，取当前值");
}

#[test]
fn large_cents_sum_exactly_without_float_error() {
    let ctx = Ctx::new();
    make(&ctx, "大额甲", None, Some(999_999_999_99));
    make(&ctx, "大额乙", None, Some(1));
    let conn = ctx.conn();
    let report = stats::report(&conn, StatsRange::ThisMonth).unwrap();
    assert_eq!(report.totals.amount_cents, 999_999_999_99 + 1);
    assert_eq!(stats::cents_to_yuan(123_456), "1234.56");
    assert_eq!(stats::cents_to_yuan(0), "0.00");
}

#[test]
fn reports_do_not_touch_order_or_queue_versions() {
    let ctx = Ctx::new();
    let id = make(&ctx, "只读检查", None, Some(1000));
    let before = ctx.load(&id);
    let conn = ctx.conn();
    let queue_before = lifecycle::queue_revision(&conn).unwrap();

    let _ = dashboard::metrics(&conn).unwrap();
    let _ = stats::report(&conn, StatsRange::All).unwrap();
    let _ = dashboard::completed_events_in_month(&conn, "2026-11").unwrap();

    let after = ctx.load(&id);
    assert_eq!(after.revision, before.revision);
    assert_eq!(after.updated_at, before.updated_at);
    assert_eq!(lifecycle::queue_revision(&ctx.conn()).unwrap(), queue_before);
}

#[test]
fn completed_events_list_carries_order_identity() {
    let ctx = Ctx::new();
    let id = make(&ctx, "可下钻的完成", None, None);
    let view = ctx.load(&id);
    let mut conn = ctx.conn();
    lifecycle::start_work(&mut conn, common::lifecycle_input(&view)).unwrap();
    // 默认模板有 5 个阶段：先推进到最后一个阶段才能完成
    for _ in 0..4 {
        let current = ctx.load(&id);
        lifecycle::advance_stage(&mut conn, common::lifecycle_input(&current)).unwrap();
    }
    let at_last = ctx.load(&id);
    lifecycle::complete_order(&mut conn, common::lifecycle_input(&at_last)).unwrap();

    let month = minidesk::store::timezone::local_today(common::tz())
        .format("%Y-%m")
        .to_string();
    let rows = dashboard::completed_events_in_month(&conn, &month).unwrap();
    let row = rows.iter().find(|r| r.order_id == id).expect("本月完成事件");
    assert_eq!(row.code, view.code);
    assert_eq!(row.title, "可下钻的完成");
    assert!(!row.local_time.is_empty());
}

#[test]
fn order_list_and_dashboard_agree_on_risk() {
    let ctx = Ctx::new();
    let t = today();
    let overdue = t.pred_opt().unwrap().format("%Y-%m-%d").to_string();
    let id = make(&ctx, "列表与工作台一致", Some(&overdue), None);

    let conn = ctx.conn();
    let view = orders::load(&conn, &id).unwrap();
    assert_eq!(view.deadline_state, DeadlineState::Overdue);
    let m = dashboard::metrics(&conn).unwrap();
    assert_eq!(m.overdue, 1);
}

// ------------------------------------------------- C-1：取消单不计入金额

/// 取消是「这笔委托没做成」，不是「金额为 0」：金额口径必须整单排除。
/// 事件口径不受影响——取消次数本身要照常统计。
#[test]
fn cancelled_orders_are_excluded_from_every_amount_total() {
    let ctx = Ctx::new();
    let kept = make(&ctx, "保留", None, Some(10_000));
    let cancelled = make(&ctx, "取消", None, Some(28_850));
    let cancelled_unknown = make(&ctx, "取消且金额未知", None, None);

    let mut conn = ctx.conn();
    lifecycle::cancel_order(&mut conn, common::lifecycle_input(&ctx.load(&cancelled))).unwrap();
    lifecycle::cancel_order(&mut conn, common::lifecycle_input(&ctx.load(&cancelled_unknown)))
        .unwrap();

    let report = stats::report(&conn, StatsRange::All).unwrap();
    assert_eq!(report.totals.amount_cents, 10_000, "取消单金额不得计入合计");
    assert_eq!(report.totals.known_orders, 1, "取消单也不该算进「已知金额订单数」");
    assert_eq!(report.totals.unknown_orders, 0, "取消单的 NULL 金额同样不进未知计数");
    let total_cancelled: i64 = report.months.iter().map(|b| b.cancelled).sum();
    assert_eq!(total_cancelled, 2, "取消次数仍按事件统计");
    let total_created: i64 = report.months.iter().map(|b| b.created).sum();
    assert_eq!(total_created, 3, "订单数量不受影响");

    // 逐月：本月金额也只剩保留的那一张。
    let month = minidesk::store::timezone::local_today(common::tz())
        .format("%Y-%m")
        .to_string();
    let bucket = report.months.iter().find(|m| m.month == month).unwrap();
    assert_eq!(bucket.amount_cents, 10_000);
    assert_eq!(bucket.cancelled, 2);
    let _ = kept;
}
