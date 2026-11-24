//! FIN-05：财务统计口径。
//!
//! 这一批的测试几乎全在守同一件事：**钱按它真实发生的日期和方向归类**。
//! 到账归收款日、退款归退款日、手续费用当时记的数、取消单不进金额。
//! 任何一条错了，统计页都会给出一个「看起来合理但假」的数字。

mod common;

use common::Ctx;
use minidesk::domain::finance::{
    self, CreatePlatformInput, CreateRecordInput, PlanItemInput, RefundInput, SavePlanInput,
};
use minidesk::domain::finance_stats;
use minidesk::domain::stats::{self, StatsRange};
use rusqlite::params;

fn order(ctx: &Ctx, code: &str, amount: Option<i64>) -> String {
    let id = ctx.create_order(code);
    if let Some(cents) = amount {
        ctx.conn()
            .execute("UPDATE orders SET amount_cents = ?1 WHERE id = ?2", params![cents, id])
            .unwrap();
    }
    id
}

#[allow(clippy::too_many_arguments)]
fn pay(
    ctx: &Ctx,
    order: &str,
    amount: i64,
    fee: i64,
    date: &str,
    platform: Option<&str>,
    method: Option<&str>,
) -> String {
    let mut conn = ctx.conn();
    finance::create_record(
        &mut conn,
        &CreateRecordInput {
            order_id: order.into(),
            schedule_id: None,
            kind: "full".into(),
            amount_cents: amount,
            received_on: date.into(),
            platform_id: platform.map(str::to_string),
            fee_cents: fee,
            method: method.map(str::to_string),
            note: None,
            request_id: None,
        },
    )
    .unwrap()
    .id
}

fn refund(ctx: &Ctx, order: &str, amount: i64, date: &str) -> String {
    let mut conn = ctx.conn();
    finance::create_refund(
        &mut conn,
        &RefundInput {
            order_id: order.into(),
            payment_record_id: None,
            amount_cents: amount,
            refunded_on: date.into(),
            method: None,
            note: None,
            request_id: None,
        },
    )
    .unwrap()
    .id
}

fn report(ctx: &Ctx, range: StatsRange) -> finance_stats::FinanceStatsReport {
    let conn = ctx.conn();
    finance_stats::report(&conn, range).unwrap()
}

fn plan(ctx: &Ctx, order: &str, total: i64, date: Option<&str>) {
    let mut conn = ctx.conn();
    finance::save_plan(
        &mut conn,
        &SavePlanInput {
            order_id: order.into(),
            items: vec![PlanItemInput {
                id: None,
                kind: "full".into(),
                amount_cents: total,
                expected_date: date.map(str::to_string),
            }],
            confirm_detach: false,
        },
    )
    .unwrap();
}

/// 走真实的取消路径：只有这样才能产生 `cancelled` 事件，
/// 业务统计的取消次数才有意义。
fn cancel(ctx: &Ctx, order: &str) {
    let current = ctx.load(order);
    let mut conn = ctx.conn();
    minidesk::domain::lifecycle::cancel_order(
        &mut conn,
        minidesk::domain::lifecycle::LifecycleInput {
            order_id: order.into(),
            expected_revision: current.revision,
            request_id: Some(format!("cancel-{order}")),
        },
    )
    .unwrap();
}

// ============================================================ A. 汇总

#[test]
fn lifetime_totals_follow_the_money_not_the_order() {
    let ctx = Ctx::new();
    let o = order(&ctx, "AF-2026-2001", Some(100_000));
    pay(&ctx, &o, 30_000, 300, "2025-11-05", None, None);
    pay(&ctx, &o, 70_000, 700, "2025-12-05", None, None);
    refund(&ctx, &o, 20_000, "2026-01-05");

    let r = report(&ctx, StatsRange::All);
    assert_eq!(r.lifetime.gross_received_cents, 100_000);
    assert_eq!(r.lifetime.fee_total_cents, 1_000);
    assert_eq!(r.lifetime.net_received_cents, 99_000);
    assert_eq!(r.lifetime.refund_total_cents, 20_000);
    assert_eq!(r.lifetime.net_retained_cents, 79_000, "净留存要扣掉退款");
}

#[test]
fn voided_payments_and_refunds_drop_out() {
    let ctx = Ctx::new();
    let o = order(&ctx, "AF-2026-2002", Some(100_000));
    let keep = pay(&ctx, &o, 30_000, 300, "2025-11-05", None, None);
    let drop = pay(&ctx, &o, 50_000, 500, "2025-11-06", None, None);
    let mut conn = ctx.conn();
    finance::void_record(
        &mut conn,
        &finance::VoidRecordInput { id: drop, reason: "录错".into() },
    )
    .unwrap();

    let bad_refund = refund(&ctx, &o, 5_000, "2025-11-07");
    finance::void_refund(
        &mut conn,
        &finance::VoidRefundInput { id: bad_refund, reason: "退错".into() },
    )
    .unwrap();

    let r = report(&ctx, StatsRange::All);
    assert_eq!(r.lifetime.gross_received_cents, 30_000);
    assert_eq!(r.lifetime.fee_total_cents, 300);
    assert_eq!(r.lifetime.refund_total_cents, 0);
    let _ = keep;
}

#[test]
fn an_unmatched_refund_still_counts_as_money_out() {
    // 没关联原收款的退款也是真金白银流出，不能因为核验不了余额就漏掉。
    let ctx = Ctx::new();
    let o = order(&ctx, "AF-2026-2003", Some(100_000));
    refund(&ctx, &o, 15_000, "2025-11-05");
    let r = report(&ctx, StatsRange::All);
    assert_eq!(r.lifetime.refund_total_cents, 15_000);
    assert_eq!(r.lifetime.net_retained_cents, -15_000, "净留存允许为负");
}

// ==================================================== B. 取消单排除

#[test]
fn a_cancelled_order_contributes_no_money_but_still_counts_as_an_event() {
    let ctx = Ctx::new();
    let live = order(&ctx, "AF-2026-2004", Some(100_000));
    let dead = order(&ctx, "AF-2026-2005", Some(80_000));
    pay(&ctx, &live, 30_000, 300, "2025-11-05", None, None);
    pay(&ctx, &dead, 40_000, 400, "2025-11-06", None, None);
    refund(&ctx, &dead, 10_000, "2025-11-07");
    cancel(&ctx, &dead);

    let r = report(&ctx, StatsRange::All);
    assert_eq!(r.lifetime.gross_received_cents, 30_000, "取消单的到账不进金额");
    assert_eq!(r.lifetime.fee_total_cents, 300);
    assert_eq!(r.lifetime.refund_total_cents, 0, "取消单的退款也不进金额");
    assert_eq!(r.current.remaining_cents, 70_000, "取消单的待收不算");

    // 事件口径不受影响
    let conn = ctx.conn();
    let events = stats::report(&conn, StatsRange::All).unwrap();
    assert_eq!(events.totals.cancelled, 1);
    assert_eq!(events.totals.amount_cents, 100_000, "业务统计同样只算未取消单");
}

// ==================================================== C. 日期归属

#[test]
fn refunds_land_in_their_own_month_not_the_payment_month() {
    let ctx = Ctx::new();
    let o = order(&ctx, "AF-2026-2006", Some(100_000));
    pay(&ctx, &o, 100_000, 5_000, "2025-11-10", None, None);
    refund(&ctx, &o, 20_000, "2025-12-10");

    let r = report(&ctx, StatsRange::All);
    let nov = r.monthly.iter().find(|m| m.month == "2025-11").unwrap();
    let dec = r.monthly.iter().find(|m| m.month == "2025-12").unwrap();
    assert_eq!(nov.gross_received_cents, 100_000);
    assert_eq!(nov.net_received_cents, 95_000);
    assert_eq!(nov.refund_total_cents, 0, "12 月的退款不能回填到 11 月");
    assert_eq!(nov.net_retained_cents, 95_000);
    assert_eq!(dec.refund_total_cents, 20_000);
    assert_eq!(dec.net_retained_cents, -20_000, "只有退款的那个月可以是负数");
}

#[test]
fn annual_net_received_groups_by_receipt_year() {
    let ctx = Ctx::new();
    let o = order(&ctx, "AF-2026-2007", Some(100_000));
    pay(&ctx, &o, 10_000, 100, "2024-12-31", None, None);
    pay(&ctx, &o, 20_000, 200, "2025-01-01", None, None);

    let r = report(&ctx, StatsRange::All);
    let y2024 = r.annual.iter().find(|y| y.year == "2024").unwrap();
    let y2025 = r.annual.iter().find(|y| y.year == "2025").unwrap();
    assert_eq!(y2024.net_received_cents, 9_900);
    assert_eq!(y2025.net_received_cents, 19_800);
}

#[test]
fn expected_receipts_are_bucketed_by_plan_date() {
    let ctx = Ctx::new();
    let today = report(&ctx, StatsRange::All).to_month.clone();

    let overdue = order(&ctx, "AF-2026-2008", Some(50_000));
    plan(&ctx, &overdue, 50_000, Some("2020-01-01"));
    let future = order(&ctx, "AF-2026-2009", Some(60_000));
    let tz = minidesk::store::settings::working_timezone(&ctx.conn()).unwrap();
    let soon = (minidesk::store::timezone::local_today(tz) + chrono::Duration::days(40))
        .format("%Y-%m-%d")
        .to_string();
    plan(&ctx, &future, 60_000, Some(&soon));
    let unscheduled = order(&ctx, "AF-2026-2010", Some(70_000));
    plan(&ctx, &unscheduled, 70_000, None);

    let r = report(&ctx, StatsRange::All);
    assert_eq!(r.expected.overdue_cents, 50_000);
    assert_eq!(r.expected.unscheduled_cents, 70_000);
    assert!(
        r.expected.months.iter().any(|m| m.amount_cents == 60_000),
        "40 天后的计划应落进六个月窗口：{:?}",
        r.expected.months
    );
    let _ = today;
}

// ============================================================ D. 金额

#[test]
fn unknown_and_zero_amounts_are_told_apart() {
    let ctx = Ctx::new();
    let unknown = order(&ctx, "AF-2026-2011", None);
    let zero = order(&ctx, "AF-2026-2012", Some(0));
    pay(&ctx, &unknown, 10_000, 0, "2025-11-05", None, None);

    let r = report(&ctx, StatsRange::All);
    assert_eq!(r.current.unknown_amount_orders, 1, "只有 NULL 算未知");
    assert_eq!(r.current.remaining_cents, 0, "0 元订单不产生待收，NULL 也不当作欠款");
    assert_eq!(r.current.unrecorded_orders, 1, "0 元那张既无计划也无流水");
    let _ = zero;
}

#[test]
fn large_amounts_stay_exact() {
    let ctx = Ctx::new();
    let o = order(&ctx, "AF-2026-2013", Some(999_999_999));
    pay(&ctx, &o, 123_456_789, 1_234_567, "2025-11-05", None, None);
    let r = report(&ctx, StatsRange::All);
    assert_eq!(r.lifetime.gross_received_cents, 123_456_789);
    assert_eq!(r.lifetime.net_received_cents, 123_456_789 - 1_234_567);
}

#[test]
fn over_received_is_reported_separately_from_remaining() {
    let ctx = Ctx::new();
    let o = order(&ctx, "AF-2026-2014", Some(50_000));
    pay(&ctx, &o, 60_000, 0, "2025-11-05", None, None);
    let r = report(&ctx, StatsRange::All);
    assert_eq!(r.current.over_received_cents, 10_000);
    assert_eq!(r.current.remaining_cents, 0, "超额不能倒推出负待收");
}

// ============================================================ E. 计划

#[test]
fn a_refund_does_not_raise_the_amount_still_due() {
    let ctx = Ctx::new();
    let o = order(&ctx, "AF-2026-2015", Some(100_000));
    pay(&ctx, &o, 50_000, 0, "2025-11-05", None, None);
    refund(&ctx, &o, 20_000, "2025-11-06");
    let r = report(&ctx, StatsRange::All);
    assert_eq!(r.current.remaining_cents, 50_000, "退款不重新增加待收");
}

#[test]
fn plan_mismatch_and_no_plan_orders_are_counted() {
    let ctx = Ctx::new();
    let mismatch = order(&ctx, "AF-2026-2016", Some(100_000));
    // 先按 100% 建计划，再把订单金额改小 → 不匹配
    plan(&ctx, &mismatch, 100_000, None);
    ctx.conn()
        .execute("UPDATE orders SET amount_cents = 90_000 WHERE id = ?1", [&mismatch])
        .unwrap();
    let no_plan = order(&ctx, "AF-2026-2017", Some(30_000));

    let r = report(&ctx, StatsRange::All);
    assert_eq!(r.current.plan_mismatch_orders, 1);
    assert_eq!(r.expected.no_plan_orders, 1);
    let _ = no_plan;
}

#[test]
fn a_completed_order_keeps_its_outstanding_amount() {
    let ctx = Ctx::new();
    let o = order(&ctx, "AF-2026-2018", Some(100_000));
    pay(&ctx, &o, 30_000, 0, "2025-11-05", None, None);
    ctx.conn()
        .execute(
            "UPDATE orders SET status = 'complete', started_at = '2025-11-01T00:00:00.000Z',
                               completed_at = '2025-11-20T00:00:00.000Z' WHERE id = ?1",
            [&o],
        )
        .unwrap();
    let r = report(&ctx, StatsRange::All);
    assert_eq!(r.current.remaining_cents, 70_000, "完成 ≠ 收齐");
}

// ============================================================ F. 分组

#[test]
fn platform_stats_use_the_name_snapshot_even_after_a_rename() {
    let ctx = Ctx::new();
    let platform_id = {
        let conn = ctx.conn();
        finance::create(
            &conn,
            &CreatePlatformInput { name: "米画师".into(), fee_rate: Some("5".into()) },
        )
        .unwrap()
        .id
    };
    let o = order(&ctx, "AF-2026-2019", Some(100_000));
    pay(&ctx, &o, 30_000, 1_500, "2025-11-05", Some(&platform_id), Some("wechat"));

    {
        let conn = ctx.conn();
        finance::update(
            &conn,
            &finance::UpdatePlatformInput {
                id: platform_id.clone(),
                name: "米画师（新）".into(),
                fee_rate: Some("8".into()),
            },
        )
        .unwrap();
    }

    let r = report(&ctx, StatsRange::All);
    let row = r.by_platform.iter().find(|p| p.platform_name.as_deref() == Some("米画师")).unwrap();
    assert_eq!(row.gross_received_cents, 30_000);
    assert_eq!(row.fee_total_cents, 1_500, "不能按新费率重算历史手续费");
    assert!(!r.by_platform.iter().any(|p| p.platform_name.as_deref() == Some("米画师（新）")));
}

#[test]
fn platform_deletion_and_missing_values_still_show_up() {
    let ctx = Ctx::new();
    let platform_id = {
        let conn = ctx.conn();
        finance::create(
            &conn,
            &CreatePlatformInput { name: "画加".into(), fee_rate: None },
        )
        .unwrap()
        .id
    };
    let with_platform = order(&ctx, "AF-2026-2020", Some(100_000));
    pay(&ctx, &with_platform, 10_000, 0, "2025-11-05", Some(&platform_id), None);
    let without = order(&ctx, "AF-2026-2021", Some(100_000));
    pay(&ctx, &without, 5_000, 0, "2025-11-06", None, None);

    {
        let conn = ctx.conn();
        finance::delete(&conn, &platform_id).unwrap();
    }

    let r = report(&ctx, StatsRange::All);
    assert_eq!(
        r.by_platform.iter().find(|p| p.platform_name.as_deref() == Some("画加")).unwrap().gross_received_cents,
        10_000,
        "平台删了，历史仍按快照名字统计"
    );
    assert!(r.by_platform.iter().any(|p| p.platform_name.is_none()), "没有平台的流水不能丢");
    assert!(r.by_method.iter().any(|m| m.method.is_none()), "没有方式的流水不能丢");
}

#[test]
fn order_types_respect_free_text_and_uncategorised() {
    let ctx = Ctx::new();
    let a = order(&ctx, "AF-2026-2022", Some(50_000));
    let b = order(&ctx, "AF-2026-2023", Some(30_000));
    let c = order(&ctx, "AF-2026-2024", Some(20_000));
    let conn = ctx.conn();
    conn.execute("UPDATE orders SET commission_type = '插画' WHERE id = ?1", [&a]).unwrap();
    conn.execute("UPDATE orders SET commission_type = '插画' WHERE id = ?1", [&b]).unwrap();
    // c 保持未分类
    pay(&ctx, &a, 50_000, 0, "2025-11-05", None, None);

    let r = report(&ctx, StatsRange::All);
    let illu = r.by_order_type.iter().find(|t| t.order_type.as_deref() == Some("插画")).unwrap();
    assert_eq!(illu.orders, 2);
    assert_eq!(illu.order_amount_cents, 80_000, "订单金额是合同金额");
    assert_eq!(illu.gross_received_cents, 50_000, "到账单独统计");
    let none = r.by_order_type.iter().find(|t| t.order_type.is_none()).unwrap();
    assert_eq!(none.orders, 1);
    let _ = c;
}

#[test]
fn monthly_and_period_respect_the_requested_range() {
    let ctx = Ctx::new();
    let o = order(&ctx, "AF-2026-2025", Some(100_000));
    pay(&ctx, &o, 10_000, 0, "2025-11-05", None, None);
    pay(&ctx, &o, 20_000, 0, "2026-11-05", None, None);

    let all = report(&ctx, StatsRange::All);
    assert_eq!(all.period.gross_received_cents, 30_000);
    assert!(all.monthly.len() >= 2, "跨年也要各归各月");

    let this_month = report(&ctx, StatsRange::ThisMonth);
    assert_eq!(this_month.lifetime.gross_received_cents, 30_000, "累计不受范围影响");
    assert!(this_month.period.gross_received_cents <= 30_000);
}
