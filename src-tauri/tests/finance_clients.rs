//! FIN-06：客户维度财务汇总 + 三个 CSV 出口。
//!
//! 重点守三件容易出的事：
//! 1. **不能重复累加**：一个客户两个订单、每个订单两笔收款，JOIN 写法会把订单金额放大；
//! 2. **同名客户不能合并**：聚合身份只能是 `clients.id`；
//! 3. **CSV 不能破坏原有列**：订单 CSV 的前 9 列必须原样。

mod common;

use common::Ctx;
use minidesk::domain::finance::{
    self, CreateRecordInput, RefundInput, VoidRecordInput,
};
use minidesk::domain::finance_clients;
use minidesk::domain::finance_stats;
use minidesk::domain::stats::StatsRange;
use rusqlite::params;

fn client(ctx: &Ctx, name: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    ctx.conn()
        .execute(
            "INSERT INTO clients (id, display_name, created_at, updated_at)
             VALUES (?1, ?2, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
            params![id, name],
        )
        .unwrap();
    id
}

fn order_for(ctx: &Ctx, code: &str, client_id: &str, amount: Option<i64>) -> String {
    let id = ctx.create_order(code);
    ctx.conn()
        .execute(
            "UPDATE orders SET client_id = ?1, amount_cents = ?2 WHERE id = ?3",
            params![client_id, amount, id],
        )
        .unwrap();
    id
}

fn pay(ctx: &Ctx, order: &str, amount: i64, fee: i64, date: &str) -> String {
    let mut conn = ctx.conn();
    finance::create_record(
        &mut conn,
        &CreateRecordInput {
            order_id: order.into(),
            schedule_id: None,
            kind: "full".into(),
            amount_cents: amount,
            received_on: date.into(),
            platform_id: None,
            fee_cents: fee,
            method: Some("wechat".into()),
            note: Some("内部备注不应该出现在导出里".into()),
            request_id: None,
        },
    )
    .unwrap()
    .id
}

fn refund(ctx: &Ctx, order: &str, amount: i64, date: &str) {
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
    .unwrap();
}

fn summary(ctx: &Ctx, client_id: &str) -> finance_clients::ClientFinance {
    let conn = ctx.conn();
    finance_clients::summary(&conn, client_id).unwrap()
}

// ==================================================== A. 客户汇总

#[test]
fn a_client_with_several_orders_is_not_double_counted() {
    let ctx = Ctx::new();
    let c = client(&ctx, "小明");
    let first = order_for(&ctx, "AF-2026-3001", &c, Some(100_000));
    let second = order_for(&ctx, "AF-2026-3002", &c, Some(50_000));
    pay(&ctx, &first, 30_000, 300, "2025-11-01");
    pay(&ctx, &first, 20_000, 200, "2025-11-02");
    pay(&ctx, &second, 50_000, 500, "2025-11-03");
    refund(&ctx, &first, 10_000, "2025-11-04");

    let s = summary(&ctx, &c);
    assert_eq!(s.orders, 2);
    assert_eq!(s.order_amount_cents, 150_000, "订单金额只算一次");
    assert_eq!(s.gross_received_cents, 100_000);
    assert_eq!(s.fee_total_cents, 1_000);
    assert_eq!(s.net_received_cents, 99_000);
    assert_eq!(s.refund_total_cents, 10_000);
    assert_eq!(s.net_retained_cents, 89_000);
    // 第一单 10 万 - 5 万 = 5 万；第二单收满 → 0
    assert_eq!(s.remaining_cents, 50_000, "待收要逐单计算再汇总");
    assert_eq!(s.over_received_cents, 0);
}

#[test]
fn over_received_on_one_order_does_not_cancel_under_payment_on_another() {
    let ctx = Ctx::new();
    let c = client(&ctx, "小红");
    let short = order_for(&ctx, "AF-2026-3003", &c, Some(100_000));
    let over = order_for(&ctx, "AF-2026-3004", &c, Some(20_000));
    pay(&ctx, &short, 40_000, 0, "2025-11-01");
    pay(&ctx, &over, 30_000, 0, "2025-11-02");

    let s = summary(&ctx, &c);
    assert_eq!(s.remaining_cents, 60_000, "少收的那单不能被人多收的那单抵掉");
    assert_eq!(s.over_received_cents, 10_000);
}

#[test]
fn clients_with_the_same_name_stay_separate() {
    let ctx = Ctx::new();
    let a = client(&ctx, "小明");
    let b = client(&ctx, "小明");
    let first = order_for(&ctx, "AF-2026-3005", &a, Some(30_000));
    let second = order_for(&ctx, "AF-2026-3006", &b, Some(70_000));
    pay(&ctx, &first, 30_000, 0, "2025-11-01");
    pay(&ctx, &second, 10_000, 0, "2025-11-02");

    let all = finance_clients::all(&ctx.conn()).unwrap();
    let row_a = all.iter().find(|r| r.client_id == a).unwrap();
    let row_b = all.iter().find(|r| r.client_id == b).unwrap();
    assert_eq!(row_a.order_amount_cents, 30_000);
    assert_eq!(row_b.order_amount_cents, 70_000);
    assert_eq!(row_a.gross_received_cents, 30_000);
    assert_eq!(row_b.gross_received_cents, 10_000);
}

#[test]
fn renamed_clients_keep_their_history_and_cancelled_orders_drop_out() {
    let ctx = Ctx::new();
    let c = client(&ctx, "旧名字");
    let live = order_for(&ctx, "AF-2026-3007", &c, Some(50_000));
    let dead = order_for(&ctx, "AF-2026-3008", &c, Some(80_000));
    pay(&ctx, &live, 20_000, 0, "2025-11-01");
    pay(&ctx, &dead, 30_000, 0, "2025-11-02");
    {
        let mut conn = ctx.conn();
        minidesk::domain::lifecycle::cancel_order(
            &mut conn,
            minidesk::domain::lifecycle::LifecycleInput {
                order_id: dead.clone(),
                expected_revision: ctx.load(&dead).revision,
                request_id: None,
            },
        )
        .unwrap();
        conn.execute("UPDATE clients SET display_name = '新名字' WHERE id = ?1", [&c])
            .unwrap();
    }

    let s = summary(&ctx, &c);
    assert_eq!(s.display_name, "新名字");
    assert_eq!(s.orders, 1, "取消单不进入客户财务");
    assert_eq!(s.order_amount_cents, 50_000);
    assert_eq!(s.gross_received_cents, 20_000);
    assert_eq!(s.remaining_cents, 30_000);
}

#[test]
fn null_amounts_are_counted_not_zeroed_and_unrecorded_is_flagged() {
    let ctx = Ctx::new();
    let c = client(&ctx, "小刚");
    let unknown = order_for(&ctx, "AF-2026-3009", &c, None);
    let zero = order_for(&ctx, "AF-2026-3010", &c, Some(0));
    pay(&ctx, &unknown, 5_000, 0, "2025-11-01");

    let s = summary(&ctx, &c);
    assert_eq!(s.orders, 2);
    assert_eq!(s.unknown_amount_orders, 1);
    assert_eq!(s.order_amount_cents, 0, "NULL 不参与金额合计，0 元正常计入");
    assert_eq!(s.unrecorded_orders, 1, "0 元那张既无计划也无流水");
    assert_eq!(s.remaining_cents, 0);
    let _ = zero;
}

#[test]
fn a_refund_never_raises_what_is_still_owed() {
    let ctx = Ctx::new();
    let c = client(&ctx, "小兰");
    let o = order_for(&ctx, "AF-2026-3011", &c, Some(100_000));
    pay(&ctx, &o, 40_000, 0, "2025-11-01");
    refund(&ctx, &o, 15_000, "2025-11-02");
    let s = summary(&ctx, &c);
    assert_eq!(s.remaining_cents, 60_000);
    assert_eq!(s.net_retained_cents, 25_000);
}

#[test]
fn voided_payments_and_refunds_are_left_out() {
    let ctx = Ctx::new();
    let c = client(&ctx, "小竹");
    let o = order_for(&ctx, "AF-2026-3012", &c, Some(100_000));
    let keep = pay(&ctx, &o, 10_000, 100, "2025-11-01");
    let drop = pay(&ctx, &o, 20_000, 200, "2025-11-02");
    let mut conn = ctx.conn();
    finance::void_record(
        &mut conn,
        &VoidRecordInput { id: drop, reason: "录错".into() },
    )
    .unwrap();
    let s = summary(&ctx, &c);
    assert_eq!(s.gross_received_cents, 10_000);
    assert_eq!(s.fee_total_cents, 100);
    let _ = keep;
}

// ==================================================== B. 一致性

#[test]
fn detail_stats_and_csv_report_the_same_numbers() {
    let ctx = Ctx::new();
    let c = client(&ctx, "客户甲");
    let o = order_for(&ctx, "AF-2026-3013", &c, Some(120_000));
    pay(&ctx, &o, 50_000, 500, "2025-11-01");
    refund(&ctx, &o, 8_000, "2025-11-02");

    let detail = summary(&ctx, &c);
    let report = finance_stats::report(&ctx.conn(), StatsRange::All).unwrap();
    let from_stats = report.by_client.iter().find(|r| r.client_id == c).unwrap();
    assert_eq!(&detail, from_stats, "客户详情与统计页必须是同一组数");

    let csv = String::from_utf8(
        minidesk::domain::export::finance_stats_csv(&ctx.conn(), StatsRange::All).unwrap(),
    )
    .unwrap();
    assert!(csv.contains("客户甲"));
    assert!(csv.contains("1200.00"), "累计委托金额");
    assert!(csv.contains("500.00"), "实际到账");
    assert!(csv.contains("700.00"), "待收款");
}

// ==================================================== C. 财务统计 CSV

#[test]
fn finance_stats_csv_has_bom_sections_and_skips_cancelled_money() {
    let ctx = Ctx::new();
    let c = client(&ctx, "客户乙");
    let live = order_for(&ctx, "AF-2026-3014", &c, Some(100_000));
    let dead = order_for(&ctx, "AF-2026-3015", &c, Some(90_000));
    pay(&ctx, &live, 25_000, 250, "2025-11-01");
    pay(&ctx, &dead, 40_000, 400, "2025-11-02");
    {
        let mut conn = ctx.conn();
        minidesk::domain::lifecycle::cancel_order(
            &mut conn,
            minidesk::domain::lifecycle::LifecycleInput {
                order_id: dead.clone(),
                expected_revision: ctx.load(&dead).revision,
                request_id: None,
            },
        )
        .unwrap();
    }

    let bytes = minidesk::domain::export::finance_stats_csv(&ctx.conn(), StatsRange::All).unwrap();
    assert!(bytes.starts_with(&[0xEF, 0xBB, 0xBF]), "必须带 UTF-8 BOM");
    let csv = String::from_utf8(bytes).unwrap();
    assert!(csv.contains("\r\n"), "CRLF 行尾");
    for section in ["A. 累计财务", "B. 当前财务状态", "D. 月度现金流", "G4. 按客户"] {
        assert!(csv.contains(section), "缺少分区 {section}");
    }
    assert!(csv.contains("250.00"), "取消单的到账不计入");
    assert!(!csv.contains("400.00"), "取消单的手续费不能出现");
    assert!(csv.contains("未记录收款信息订单数"));
}

// ==================================================== D. 收款流水 CSV

#[test]
fn payments_csv_keeps_voided_rows_and_never_leaks_notes() {
    let ctx = Ctx::new();
    let c = client(&ctx, "客户丙");
    let o = order_for(&ctx, "AF-2026-3016", &c, Some(100_000));
    let keep = pay(&ctx, &o, 10_000, 100, "2025-11-01");
    let gone = pay(&ctx, &o, 20_000, 200, "2025-11-02");
    {
        let mut conn = ctx.conn();
        finance::void_record(
            &mut conn,
            &VoidRecordInput { id: gone, reason: "金额录错".into() },
        )
        .unwrap();
    }

    let csv = String::from_utf8(minidesk::domain::export::payments_csv(&ctx.conn()).unwrap()).unwrap();
    assert!(csv.contains("有效"));
    assert!(csv.contains("已作废"), "作废行必须保留并标记");
    assert!(csv.contains("金额录错"), "作废原因要能追溯");
    assert!(csv.contains("未记录平台"), "没有平台时明确写出来");
    assert!(
        !csv.contains("内部备注不应该出现在导出里"),
        "收款备注不导出"
    );
    let _ = (keep, c);
}

// ==================================================== E. 订单 CSV

#[test]
fn orders_csv_keeps_its_original_columns_and_appends_finance_at_the_end() {
    let ctx = Ctx::new();
    let c = client(&ctx, "客户丁");
    let o = order_for(&ctx, "AF-2026-3017", &c, Some(100_000));
    pay(&ctx, &o, 30_000, 300, "2025-11-01");

    let rows = minidesk::domain::export::collect_orders(&ctx.conn(), &[], false).unwrap();
    let csv = String::from_utf8(
        minidesk::domain::export::orders_csv(&ctx.conn(), &rows, "全部订单").unwrap(),
    )
    .unwrap();

    let header = csv
        .lines()
        .find(|line| line.starts_with("订单编号"))
        .expect("缺少表头");
    let columns: Vec<&str> = header.trim_end().split(',').collect();
    assert_eq!(
        &columns[..9],
        &[
            "订单编号",
            "标题",
            "客户",
            "状态",
            "创建时间",
            "计划交付日期",
            "当前阶段",
            "金额（元）",
            "金额是否未知",
        ],
        "原有 9 列必须一字不动、顺序不变"
    );
    assert_eq!(columns[9], "付款计划模式");
    assert_eq!(columns.len(), 22, "9 + 13 个财务列");
    assert!(csv.contains("已有收款记录"));
    assert!(csv.contains("未设置付款计划"));
}

#[test]
fn a_cancelled_order_exports_with_empty_money_and_a_reason() {
    let ctx = Ctx::new();
    let c = client(&ctx, "客户戊");
    let o = order_for(&ctx, "AF-2026-3018", &c, Some(100_000));
    pay(&ctx, &o, 30_000, 300, "2025-11-01");
    {
        let mut conn = ctx.conn();
        minidesk::domain::lifecycle::cancel_order(
            &mut conn,
            minidesk::domain::lifecycle::LifecycleInput {
                order_id: o.clone(),
                expected_revision: ctx.load(&o).revision,
                request_id: None,
            },
        )
        .unwrap();
    }
    let rows = minidesk::domain::export::collect_orders(&ctx.conn(), &[], false).unwrap();
    let csv = String::from_utf8(
        minidesk::domain::export::orders_csv(&ctx.conn(), &rows, "全部订单").unwrap(),
    )
    .unwrap();
    let row = csv
        .lines()
        .find(|line| line.split(',').nth(1) == Some("AF-2026-3018"))
        .expect("缺少数据行");
    let cols: Vec<&str> = row.trim_end().split(',').collect();
    assert_eq!(cols[20], "已取消，金额统计排除");
    assert_eq!(cols[13], "", "取消单的实际到账留空");
    assert_eq!(cols[17], "", "取消单的净留存留空");
}

#[test]
fn unrecorded_orders_do_not_export_a_pending_amount() {
    let ctx = Ctx::new();
    let c = client(&ctx, "客户己");
    order_for(&ctx, "AF-2026-3019", &c, Some(100_000));
    let rows = minidesk::domain::export::collect_orders(&ctx.conn(), &[], false).unwrap();
    let csv = String::from_utf8(
        minidesk::domain::export::orders_csv(&ctx.conn(), &rows, "全部订单").unwrap(),
    )
    .unwrap();
    // 第一列是订单编号（程序生成），测试标题在第二列。
    let row = csv
        .lines()
        .find(|line| line.split(',').nth(1) == Some("AF-2026-3019"))
        .expect("缺少数据行");
    let cols: Vec<&str> = row.trim_end().split(',').collect();
    assert_eq!(cols[20], "未记录收款信息");
    assert_eq!(cols[18], "", "没记录收款时待收列必须留空，不能写成全额");
    assert_eq!(cols[7], "1000.00", "订单合同金额仍然照实导出");
}
