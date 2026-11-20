//! DEV-05：CSV 格式、转义、防公式注入、隐私与写盘失败路径。

mod common;

use common::Ctx;
use minidesk::domain::export::{self, Cell};
use minidesk::domain::orders::{create_order, ClientChoice, CreateOrderInput};
use minidesk::domain::stats::StatsRange;

fn text_of(bytes: &[u8]) -> String {
    String::from_utf8(bytes.to_vec()).unwrap()
}

fn make_order(ctx: &Ctx, title: &str, amount: Option<i64>, client: Option<&str>) -> String {
    let mut conn = ctx.conn();
    let choice = match client {
        Some(name) => ClientChoice::New {
            display_name: name.into(),
            contact: Some("CONTACT-SECRET-42".into()),
            note: Some("NOTE-SECRET-42".into()),
        },
        None => ClientChoice::None,
    };
    create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: title.into(),
            amount_cents: amount,
            client: choice,
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

#[test]
fn csv_starts_with_bom_and_uses_crlf() {
    let ctx = Ctx::new();
    make_order(&ctx, "中文标题", Some(1000), None);
    let conn = ctx.conn();
    let bytes = export::summary_csv(&conn, StatsRange::ThisMonth).unwrap();

    assert!(bytes.starts_with(&[0xEF, 0xBB, 0xBF]), "必须带 UTF-8 BOM");
    let body = text_of(&bytes);
    assert!(body.contains("\r\n"), "必须使用 CRLF");
    assert!(!body.contains("\n\n"), "不应出现裸 LF 空行");
    assert!(body.contains("统计范围"));
    assert!(body.contains("工作时时区"));
}

#[test]
fn commas_quotes_and_newlines_are_escaped() {
    let ctx = Ctx::new();
    make_order(&ctx, "含,逗号", None, None);
    make_order(&ctx, "含\"引号\"", None, None);
    make_order(&ctx, "含\n换行", None, None);

    let conn = ctx.conn();
    let rows = export::collect_orders(&conn, &[], false).unwrap();
    let body = text_of(&export::orders_csv(&conn, &rows, "全部订单").unwrap());

    assert!(body.contains("\"含,逗号\""), "逗号单元格必须加引号");
    assert!(body.contains("\"含\"\"引号\"\"\""), "双引号必须成对转义");
    assert!(body.contains("\"含\n换行\""), "换行必须保留在带引号的单元格内");
}

#[test]
fn formula_prefixes_are_neutralised_in_text_cells() {
    for payload in ["=cmd|' /C calc'!A0", "+1+1", "-2+3", "@SUM(A1)", "\t=1"] {
        let cell = export::cell_to_string(&Cell::Text(payload.into()));
        assert!(
            cell.starts_with("'") || cell.starts_with("\"'"),
            "{payload:?} 应被加上防注入前缀，实际 {cell:?}"
        );
    }
    // 前导空白后出现公式前缀也要拦住
    let sneaky = export::cell_to_string(&Cell::Text("   =1+1".into()));
    assert!(sneaky.starts_with("'") || sneaky.starts_with("\"'"));

    // 普通文本不受影响
    assert_eq!(export::cell_to_string(&Cell::Text("草稿".into())), "草稿");
    assert_eq!(
        export::cell_to_string(&Cell::Text("AF-2026-0001".into())),
        "AF-2026-0001"
    );
}

#[test]
fn numeric_cells_keep_their_type_semantics() {
    // 数字与金额不加任何前缀，避免被当成文本
    assert_eq!(export::cell_to_string(&Cell::Integer(-5)), "-5");
    assert_eq!(export::cell_to_string(&Cell::Integer(0)), "0");
    assert_eq!(export::cell_to_string(&Cell::Money(123_456)), "1234.56");
    assert_eq!(export::cell_to_string(&Cell::Money(0)), "0.00");
    assert_eq!(export::cell_to_string(&Cell::Empty), "");
}

#[test]
fn order_details_never_include_private_fields() {
    let ctx = Ctx::new();
    make_order(&ctx, "隐私检查", Some(5000), Some("客户甲"));
    let conn = ctx.conn();
    let rows = export::collect_orders(&conn, &[], false).unwrap();
    let body = text_of(&export::orders_csv(&conn, &rows, "全部订单").unwrap());

    assert!(body.contains("客户甲"), "客户展示名可以导出");
    assert!(!body.contains("CONTACT-SECRET-42"), "联系方式绝不能出现");
    assert!(!body.contains("NOTE-SECRET-42"), "客户备注绝不能出现");
    assert!(!body.contains("/Users/"), "不得出现文件系统路径");
    assert!(!body.contains("attachments/originals"), "不得出现附件路径");
    assert!(body.contains("金额是否未知"));
}

#[test]
fn summary_carries_the_statistical_basis() {
    let ctx = Ctx::new();
    make_order(&ctx, "口径说明", Some(100), None);
    let conn = ctx.conn();
    let body = text_of(&export::summary_csv(&conn, StatsRange::ThisMonth).unwrap());

    assert!(body.contains("按 completed 生命周期事件次数"));
    assert!(body.contains("按订单创建月份归属"));
    assert!(body.contains("已知金额合计（元）"));
    assert!(body.contains("未知金额订单数"));
}

#[test]
fn filtered_and_all_scopes_differ() {
    let ctx = Ctx::new();
    let a = make_order(&ctx, "甲", None, None);
    make_order(&ctx, "乙", None, None);
    let conn = ctx.conn();

    let all = export::collect_orders(&conn, &[], false).unwrap();
    assert_eq!(all.len(), 2);

    let only_a = export::collect_orders(&conn, &[a], false).unwrap();
    assert_eq!(only_a.len(), 1);
    assert_eq!(only_a[0].title, "甲");
}

#[test]
fn write_file_produces_the_expected_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("报表.csv");
    let payload = format!("{}{}", export::BOM, "a,b\r\n1,2\r\n");

    let result = export::write_file(&target, payload.as_bytes(), 1).unwrap();
    assert_eq!(result.rows, 1);
    assert_eq!(std::fs::read(&target).unwrap(), payload.as_bytes());
    // 不留下临时文件
    let leftovers = std::fs::read_dir(dir.path())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains("minidesk-export"))
        .count();
    assert_eq!(leftovers, 0);
}

#[test]
fn write_failures_are_reported_and_leave_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("不存在的目录").join("x.csv");
    let err = export::write_file(&missing, b"x", 0).unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(!missing.exists());

    let err = export::write_file(std::path::Path::new(""), b"x", 0).unwrap_err();
    assert_eq!(err.code, "INVALID");

    // 目标是目录时拒绝覆盖
    let as_dir = dir.path().join("这是个目录");
    std::fs::create_dir(&as_dir).unwrap();
    let err = export::write_file(&as_dir, b"x", 0).unwrap_err();
    assert_eq!(err.code, "INVALID");
}

#[test]
fn export_does_not_touch_the_database() {
    let ctx = Ctx::new();
    let id = make_order(&ctx, "导出只读", Some(777), None);
    let before = ctx.load(&id);
    let queue_before = minidesk::domain::lifecycle::queue_revision(&ctx.conn()).unwrap();

    let dir = tempfile::tempdir().unwrap();
    {
        let conn = ctx.conn();
        let summary = export::summary_csv(&conn, StatsRange::All).unwrap();
        export::write_file(&dir.path().join("s.csv"), &summary, 0).unwrap();
        let rows = export::collect_orders(&conn, &[], false).unwrap();
        let details = export::orders_csv(&conn, &rows, "全部订单").unwrap();
        export::write_file(&dir.path().join("o.csv"), &details, rows.len() as i64).unwrap();
    }

    let after = ctx.load(&id);
    assert_eq!(after.revision, before.revision);
    assert_eq!(after.updated_at, before.updated_at);
    assert_eq!(
        minidesk::domain::lifecycle::queue_revision(&ctx.conn()).unwrap(),
        queue_before
    );
}

#[test]
fn unknown_amount_is_marked_not_zeroed() {
    let ctx = Ctx::new();
    make_order(&ctx, "未知金额", None, None);
    let conn = ctx.conn();
    let rows = export::collect_orders(&conn, &[], false).unwrap();
    let body = text_of(&export::orders_csv(&conn, &rows, "全部订单").unwrap());

    // 金额列为空、未知列为「是」
    let line = body
        .lines()
        .find(|l| l.contains("未知金额"))
        .expect("应有一行");
    assert!(line.ends_with(",是"), "未知金额必须显式标记：{line}");
    assert!(!line.contains(",0.00"), "不得把 NULL 写成 0.00：{line}");
}
