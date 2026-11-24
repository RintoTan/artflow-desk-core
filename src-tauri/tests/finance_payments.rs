//! FIN-03：付款计划与实际收款。
//!
//! 这一批最容易被“看起来对”骗过去的地方有三处，测试都是围着它们写的：
//! - 建了 ¥300 定金计划 ≠ 收到 ¥300（计划与实际必须分开算）；
//! - 逾期、已收、待收、净到账全是读出来的，表里没有这些字段可以写错；
//! - 作废一笔收款会让已收齐的计划退回“部分收款”，历史记录仍然在。

mod common;

use common::Ctx;
use minidesk::domain::finance::{
    self, CreatePlatformInput, CreateRecordInput, PlanItemInput, SavePlanInput,
    UpdateRecordInput, VoidRecordInput,
};
use minidesk::domain::lifecycle;
use rusqlite::params;

fn order_with_amount(ctx: &Ctx, code: &str, cents: i64) -> String {
    let id = ctx.create_order(code);
    ctx.conn()
        .execute("UPDATE orders SET amount_cents = ?1 WHERE id = ?2", params![cents, id])
        .unwrap();
    id
}

fn platform(ctx: &Ctx, name: &str, rate: Option<&str>) -> String {
    let conn = ctx.conn();
    finance::create(
        &conn,
        &CreatePlatformInput {
            name: name.into(),
            fee_rate: rate.map(str::to_string),
        },
    )
    .unwrap()
    .id
}

fn today(ctx: &Ctx) -> String {
    let conn = ctx.conn();
    minidesk::store::timezone::local_today(minidesk::store::settings::working_timezone(&conn).unwrap())
        .format("%Y-%m-%d")
        .to_string()
}

fn plan(total: i64, mode: &str) -> Vec<PlanItemInput> {
    match mode {
        "full" => vec![item(None, "full", total, None)],
        "deposit_final" => vec![
            item(None, "deposit", total / 2, None),
            item(None, "final", total - total / 2, None),
        ],
        "installment" => vec![
            item(None, "installment", total / 3, None),
            item(None, "installment", total / 3, None),
            item(None, "installment", total - 2 * (total / 3), None),
        ],
        _ => panic!("未知模式"),
    }
}

fn item(id: Option<&str>, kind: &str, amount: i64, date: Option<&str>) -> PlanItemInput {
    PlanItemInput {
        id: id.map(str::to_string),
        kind: kind.into(),
        amount_cents: amount,
        expected_date: date.map(str::to_string),
    }
}

fn save(ctx: &Ctx, order: &str, items: Vec<PlanItemInput>, confirm: bool) -> minidesk::error::AppResult<finance::OrderFinanceView> {
    let mut conn = ctx.conn();
    finance::save_plan(
        &mut conn,
        &SavePlanInput {
            order_id: order.into(),
            items,
            confirm_detach: confirm,
        },
    )
}

#[allow(clippy::too_many_arguments)]
fn record(
    ctx: &Ctx,
    order: &str,
    schedule: Option<&str>,
    kind: &str,
    amount: i64,
    date: &str,
    platform_id: Option<&str>,
    fee: i64,
) -> minidesk::error::AppResult<finance::PaymentRecordView> {
    let mut conn = ctx.conn();
    finance::create_record(
        &mut conn,
        &CreateRecordInput {
            order_id: order.into(),
            schedule_id: schedule.map(str::to_string),
            kind: kind.into(),
            amount_cents: amount,
            received_on: date.into(),
            platform_id: platform_id.map(str::to_string),
            fee_cents: fee,
            method: Some("wechat".into()),
            note: None,
            request_id: None,
        },
    )
}

fn snapshot(ctx: &Ctx, order: &str) -> finance::OrderFinanceView {
    let conn = ctx.conn();
    finance::snapshot(&conn, order).unwrap()
}

// ============================================================ A. 迁移

#[test]
fn v11_upgrades_to_v12_with_the_kind_triggers() {
    let ctx = Ctx::new();
    let conn = ctx.conn();
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(version, 12);
    for trigger in [
        "payment_records_kind_match_insert",
        "payment_records_kind_match_update",
        "payment_schedules_kind_locked",
        "payment_records_same_order_insert",
        "payment_records_same_order_update",
        "payment_schedules_order_update",
    ] {
        let found: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name=?1",
                [trigger],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(found, 1, "缺少触发器 {trigger}");
    }
}

#[test]
fn v12_aborts_when_old_rows_already_mismatch() {
    // 造一个 v11 库（那时还没有类型约束），塞一条跨类型关联，再尝试升到 v12。
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    {
        let env = minidesk::store::environment::Environment::open_with(
            &root,
            &minidesk::store::migrations::production(),
            11,
            Some(common::tz()),
        )
        .unwrap();
        let mut conn = env.open_db().unwrap();
        let order = common::insert_order(&mut conn, "AF-2026-0901", "v11 订单");
        conn.execute(
            "INSERT INTO payment_schedules (id, order_id, kind, amount_cents, created_at)
             VALUES ('s1', ?1, 'deposit', 30000, 'x')",
            [&order],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payment_records
               (id, order_id, schedule_id, kind, amount_cents, received_on, fee_cents, created_at)
             VALUES ('r1', ?1, 's1', 'final', 30000, '2026-11-01', 0, 'x')",
            [&order],
        )
        .unwrap();

        let err = minidesk::store::migrations::migrate_to(
            &mut conn,
            &minidesk::store::migrations::production(),
            12,
        )
        .expect_err("跨类型历史数据必须让 v12 中止");
        assert!(err.message.contains("类型不一致"), "{err:?}");

        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 11, "中止后版本不能前进");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM payment_records", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "中止后不得改动任何数据");
    }
}

// ========================================================== B. 付款计划

#[test]
fn three_plan_modes_save() {
    let ctx = Ctx::new();
    for (code, total, mode) in [
        ("AF-2026-0902", 100_000, "full"),
        ("AF-2026-0903", 100_000, "deposit_final"),
        ("AF-2026-0904", 100_000, "installment"),
    ] {
        let order = order_with_amount(&ctx, code, total);
        let view = save(&ctx, &order, plan(total, mode), false).unwrap();
        assert_eq!(view.plan_total_cents, total, "{mode} 合计必须等于订单总额");
        assert!(view.plan_matches_order);
        assert_eq!(view.plan_items.len(), plan(total, mode).len());
    }
    let order = order_with_amount(&ctx, "AF-2026-0905", 100_000);
    assert_eq!(save(&ctx, &order, plan(100_000, "full"), false).unwrap().plan_mode, "full");
    let order = order_with_amount(&ctx, "AF-2026-0906", 100_000);
    assert_eq!(
        save(&ctx, &order, plan(100_000, "deposit_final"), false).unwrap().plan_mode,
        "deposit_final"
    );
    let order = order_with_amount(&ctx, "AF-2026-0907", 100_000);
    assert_eq!(
        save(&ctx, &order, plan(100_000, "installment"), false).unwrap().plan_mode,
        "installment"
    );
}

#[test]
fn plan_total_must_equal_the_order_amount() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0908", 100_000);

    let err = save(&ctx, &order, vec![item(None, "full", 90_000, None)], false).unwrap_err();
    assert!(err.message.contains("不一致"), "{err:?}");
    let err = save(&ctx, &order, vec![item(None, "full", 110_000, None)], false).unwrap_err();
    assert!(err.message.contains("不一致"), "{err:?}");
    // 一次都没写进去
    assert!(snapshot(&ctx, &order).plan_items.is_empty());
}

#[test]
fn a_plan_needs_a_known_positive_order_amount() {
    let ctx = Ctx::new();
    let empty = ctx.create_order("金额未知");
    let err = save(&ctx, &empty, vec![item(None, "full", 100, None)], false).unwrap_err();
    assert!(err.message.contains("订单金额未填写"), "{err:?}");

    let zero = order_with_amount(&ctx, "AF-2026-0909", 0);
    let err = save(&ctx, &zero, vec![item(None, "full", 100, None)], false).unwrap_err();
    assert!(err.message.contains("订单金额未填写"), "{err:?}");
}

#[test]
fn plan_structure_rejects_mixed_kinds() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0910", 100_000);
    let err = save(
        &ctx,
        &order,
        vec![
            item(None, "deposit", 30_000, None),
            item(None, "installment", 70_000, None),
        ],
        false,
    )
    .unwrap_err();
    assert!(err.message.contains("定金 + 尾款"), "{err:?}");

    let err = save(&ctx, &order, vec![item(None, "installment", 100_000, None)], false).unwrap_err();
    assert!(err.message.contains("至少两期"), "{err:?}");
}

#[test]
fn no_plan_is_a_valid_state_and_records_can_still_exist() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0911", 100_000);
    let view = snapshot(&ctx, &order);
    assert_eq!(view.plan_mode, "none");
    assert!(view.unrecorded, "既无计划也无流水 = 未记录收款信息");

    record(&ctx, &order, None, "full", 30_000, &today(&ctx), None, 0).unwrap();
    let view = snapshot(&ctx, &order);
    assert_eq!(view.gross_received_cents, 30_000, "独立流水也计入订单实收");
    assert!(view.has_records_without_plan);
    assert!(!view.unrecorded);
}

#[test]
fn expected_dates_are_optional_but_must_be_real() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0912", 100_000);
    let view = save(
        &ctx,
        &order,
        vec![
            item(None, "deposit", 50_000, Some("2026-12-10")),
            item(None, "final", 50_000, Some("2027-01-10")),
        ],
        false,
    )
    .unwrap();
    assert_eq!(view.plan_items[0].expected_date.as_deref(), Some("2026-12-10"));

    let err = save(
        &ctx,
        &order,
        vec![
            item(None, "deposit", 50_000, Some("2026-02-31")),
            item(None, "final", 50_000, None),
        ],
        true,
    )
    .unwrap_err();
    assert!(err.code == "INVALID");
}

#[test]
fn a_failed_plan_save_leaves_the_old_plan_untouched() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0913", 100_000);
    let view = save(&ctx, &order, plan(100_000, "deposit_final"), false).unwrap();
    let deposit_id = view.plan_items[0].id.clone();

    // 合计不等 → 拒绝
    let err = save(
        &ctx,
        &order,
        vec![
            item(Some(&deposit_id), "deposit", 50_000, None),
            item(None, "final", 40_000, None),
        ],
        true,
    )
    .unwrap_err();
    assert!(err.message.contains("不一致"));

    let after = snapshot(&ctx, &order);
    assert_eq!(after.plan_items.len(), 2, "失败的保存不能留下部分修改");
    assert_eq!(after.plan_total_cents, 100_000);
}

#[test]
fn clearing_or_removing_a_plan_with_payments_needs_confirmation() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0914", 100_000);
    let view = save(&ctx, &order, vec![item(None, "full", 100_000, None)], false).unwrap();
    let schedule_id = view.plan_items[0].id.clone();
    record(&ctx, &order, Some(&schedule_id), "full", 30_000, &today(&ctx), None, 0).unwrap();

    let err = save(&ctx, &order, vec![], false).unwrap_err();
    assert_eq!(err.code, "CONFLICT");
    assert!(err.message.contains("1 笔"), "{err:?}");

    let cleared = save(&ctx, &order, vec![], true).unwrap();
    assert!(cleared.plan_items.is_empty());
    assert_eq!(cleared.records.len(), 1, "解除关联不删除流水");
    assert_eq!(cleared.records[0].schedule_id, None);
    assert_eq!(cleared.gross_received_cents, 30_000);
}

// ====================================================== C. D1 类型一致

#[test]
fn record_kind_must_match_its_plan() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0915", 100_000);
    let view = save(&ctx, &order, plan(100_000, "deposit_final"), false).unwrap();
    let deposit = view.plan_items.iter().find(|i| i.kind == "deposit").unwrap();
    let final_plan = view.plan_items.iter().find(|i| i.kind == "final").unwrap();

    record(&ctx, &order, Some(&deposit.id), "deposit", 10_000, &today(&ctx), None, 0).unwrap();
    let err = record(
        &ctx,
        &order,
        Some(&final_plan.id),
        "deposit",
        10_000,
        &today(&ctx),
        None,
        0,
    )
    .unwrap_err();
    assert!(err.message.contains("类型不一致"), "{err:?}");

    // 数据库自己也不接受（绕过领域层直写）。
    let conn = ctx.conn();
    let err = conn
        .execute(
            "INSERT INTO payment_records
               (id, order_id, schedule_id, kind, amount_cents, received_on, fee_cents, created_at)
             VALUES ('raw', ?1, ?2, 'deposit', 100, '2026-11-01', 0, 'x')",
            params![order, final_plan.id],
        )
        .unwrap_err();
    assert!(err.to_string().contains("类型不一致"), "{err}");
}

#[test]
fn changing_kinds_after_the_fact_is_blocked() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0916", 100_000);
    let view = save(&ctx, &order, plan(100_000, "deposit_final"), false).unwrap();
    let deposit = view.plan_items.iter().find(|i| i.kind == "deposit").unwrap().id.clone();
    let rec = record(&ctx, &order, Some(&deposit), "deposit", 10_000, &today(&ctx), None, 0).unwrap();

    let mut conn = ctx.conn();
    // 改流水类型 → 与计划不一致
    let err = finance::update_record(
        &mut conn,
        &UpdateRecordInput {
            id: rec.id.clone(),
            schedule_id: Some(deposit.clone()),
            kind: "final".into(),
            amount_cents: 10_000,
            received_on: today(&ctx),
            platform_id: None,
            fee_cents: 0,
            method: None,
            note: None,
        },
    )
    .unwrap_err();
    assert!(err.message.contains("类型不一致"), "{err:?}");

    // 改计划类型 → 已有流水，锁住
    let err = save(
        &ctx,
        &order,
        vec![
            item(Some(&deposit), "full", 100_000, None),
        ],
        true,
    )
    .unwrap_err();
    assert!(err.message.contains("不能修改类型"), "{err:?}");
}

#[test]
fn a_voided_payment_still_pins_its_plan_kind() {
    // 作废只是不算钱，历史归属还在：计划类型仍不能被改。
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0917", 100_000);
    let view = save(&ctx, &order, plan(100_000, "deposit_final"), false).unwrap();
    let deposit = view.plan_items.iter().find(|i| i.kind == "deposit").unwrap().id.clone();
    let rec = record(&ctx, &order, Some(&deposit), "deposit", 10_000, &today(&ctx), None, 0).unwrap();
    let mut conn = ctx.conn();
    finance::void_record(
        &mut conn,
        &VoidRecordInput {
            id: rec.id,
            reason: "金额录错".into(),
        },
    )
    .unwrap();

    let err = conn
        .execute("UPDATE payment_schedules SET kind = 'full' WHERE id = ?1", [&deposit])
        .unwrap_err();
    assert!(err.to_string().contains("不能修改类型"), "{err}");
}

// ==================================================== D. 收款流水

#[test]
fn one_plan_accepts_several_payments() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0918", 100_000);
    let view = save(&ctx, &order, vec![item(None, "full", 100_000, None)], false).unwrap();
    let schedule = view.plan_items[0].id.clone();

    record(&ctx, &order, Some(&schedule), "full", 20_000, &today(&ctx), None, 0).unwrap();
    record(&ctx, &order, Some(&schedule), "full", 30_000, &today(&ctx), None, 0).unwrap();

    let view = snapshot(&ctx, &order);
    assert_eq!(view.records.len(), 2);
    assert_eq!(view.plan_items[0].received_cents, 50_000);
    assert_eq!(view.plan_items[0].outstanding_cents, 50_000);
    assert_eq!(view.plan_items[0].status, "partial");
}

#[test]
fn platform_snapshot_is_frozen_at_write_time() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0919", 100_000);
    let platform_id = platform(&ctx, "米画师", Some("5"));

    let rec = record(&ctx, &order, None, "full", 30_000, &today(&ctx), Some(&platform_id), 1_500).unwrap();
    assert_eq!(rec.platform_name.as_deref(), Some("米画师"));
    assert_eq!(rec.fee_rate_bp, Some(500));
    assert_eq!(rec.fee_cents, 1_500);
    assert_eq!(rec.net_cents, 28_500);

    // 平台改费率、改名：历史不动。
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

    let view = snapshot(&ctx, &order);
    assert_eq!(view.records[0].platform_name.as_deref(), Some("米画师"));
    assert_eq!(view.records[0].fee_rate_bp, Some(500));
    assert_eq!(view.records[0].fee_cents, 1_500);
}

#[test]
fn unknown_rate_stays_unknown_and_zero_is_explicit() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0920", 100_000);
    let unknown = platform(&ctx, "待确认", None);
    let zero = platform(&ctx, "免费渠道", Some("0"));

    let a = record(&ctx, &order, None, "full", 10_000, &today(&ctx), Some(&unknown), 0).unwrap();
    assert_eq!(a.fee_rate_bp, None, "没配费率就是不知道，不能变成 0");
    let b = record(&ctx, &order, None, "full", 10_000, &today(&ctx), Some(&zero), 0).unwrap();
    assert_eq!(b.fee_rate_bp, Some(0), "明确 0% 要存成 0");

    let no_platform = record(&ctx, &order, None, "full", 10_000, &today(&ctx), None, 0).unwrap();
    assert_eq!(no_platform.platform_id, None);
    assert_eq!(no_platform.platform_name, None);
    assert_eq!(no_platform.fee_rate_bp, None);
}

#[test]
fn archived_platforms_cannot_be_chosen_but_history_survives() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0921", 100_000);
    let platform_id = platform(&ctx, "旧平台", Some("3"));
    let rec = record(&ctx, &order, None, "full", 5_000, &today(&ctx), Some(&platform_id), 150).unwrap();

    let conn = ctx.conn();
    finance::archive(&conn, &platform_id).unwrap();
    let err = record(&ctx, &order, None, "full", 5_000, &today(&ctx), Some(&platform_id), 0).unwrap_err();
    assert!(err.message.contains("已归档"), "{err:?}");

    // 历史仍能读，删除平台也不影响它。
    finance::delete(&conn, &platform_id).unwrap();
    let view = snapshot(&ctx, &order);
    let found = view.records.iter().find(|r| r.id == rec.id).unwrap();
    assert_eq!(found.platform_id, None);
    assert_eq!(found.platform_name.as_deref(), Some("旧平台"));
    assert_eq!(found.fee_rate_bp, Some(300));
    assert_eq!(found.fee_cents, 150);
}

#[test]
fn fee_cannot_exceed_the_payment() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0922", 100_000);
    let err = record(&ctx, &order, None, "full", 1_000, &today(&ctx), None, 1_001).unwrap_err();
    assert!(err.message.contains("不能超过"), "{err:?}");
    let err = record(&ctx, &order, None, "full", 1_000, &today(&ctx), None, -1).unwrap_err();
    assert!(err.message.contains("不能为负"), "{err:?}");
}

#[test]
fn updating_a_payment_keeps_created_at_and_can_change_platform() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0923", 100_000);
    let first = platform(&ctx, "甲平台", Some("5"));
    let second = platform(&ctx, "乙平台", Some("2"));
    let rec = record(&ctx, &order, None, "full", 10_000, &today(&ctx), Some(&first), 500).unwrap();

    let mut conn = ctx.conn();
    let updated = finance::update_record(
        &mut conn,
        &UpdateRecordInput {
            id: rec.id.clone(),
            schedule_id: None,
            kind: "full".into(),
            amount_cents: 10_000,
            received_on: rec.received_on.clone(),
            platform_id: Some(second.clone()),
            fee_cents: 500,
            method: Some("alipay".into()),
            note: Some("换渠道".into()),
        },
    )
    .unwrap();
    assert_eq!(updated.created_at, rec.created_at, "编辑不改创建时间");
    assert_eq!(updated.platform_name.as_deref(), Some("乙平台"), "换平台要重新取快照");
    assert_eq!(updated.fee_rate_bp, Some(200));
    assert_eq!(updated.fee_cents, 500, "换平台不该偷偷改实际手续费");
    assert_eq!(updated.method.as_deref(), Some("alipay"));
}

#[test]
fn a_reduce_below_the_recorded_fee_is_refused() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0924", 100_000);
    let rec = record(&ctx, &order, None, "full", 10_000, &today(&ctx), None, 800).unwrap();
    let mut conn = ctx.conn();
    let err = finance::update_record(
        &mut conn,
        &UpdateRecordInput {
            id: rec.id,
            schedule_id: None,
            kind: "full".into(),
            amount_cents: 500,
            received_on: today(&ctx),
            platform_id: None,
            fee_cents: 800,
            method: None,
            note: None,
        },
    )
    .unwrap_err();
    assert!(err.message.contains("不能超过"), "{err:?}");
}

#[test]
fn the_same_request_id_does_not_record_twice() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0925", 100_000);
    let mut conn = ctx.conn();
    let mut payload = CreateRecordInput {
        order_id: order.clone(),
        schedule_id: None,
        kind: "full".into(),
        amount_cents: 10_000,
        received_on: today(&ctx),
        platform_id: None,
        fee_cents: 0,
        method: None,
        note: None,
        request_id: Some("req-1".into()),
    };
    let first = finance::create_record(&mut conn, &payload).unwrap();
    payload.amount_cents = 99_999; // 同 requestId 不同内容也不该再写一条
    let second = finance::create_record(&mut conn, &payload).unwrap();
    assert_eq!(first.id, second.id);
    let view = snapshot(&ctx, &order);
    assert_eq!(view.records.len(), 1);
    assert_eq!(view.gross_received_cents, 10_000);
}

// ========================================================== E. 日期

#[test]
fn received_dates_allow_the_past_but_not_the_future() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0926", 100_000);

    record(&ctx, &order, None, "full", 100, "2020-01-01", None, 0).expect("补录历史到账");
    record(&ctx, &order, None, "full", 100, &today(&ctx), None, 0).expect("当天可以");
    let err = record(&ctx, &order, None, "full", 100, "2099-01-01", None, 0).unwrap_err();
    assert!(err.message.contains("不能晚于今天"), "{err:?}");
}

#[test]
fn impossible_dates_are_rejected_at_the_domain_layer() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0927", 100_000);
    for bad in ["2026-02-31", "2026-13-01", "2026-02-29", "2026/01/01", "", "not-a-date"] {
        let err = record(&ctx, &order, None, "full", 100, bad, None, 0).unwrap_err();
        assert!(err.code == "INVALID", "{bad:?} 应被拒");
    }
    record(&ctx, &order, None, "full", 100, "2024-02-29", None, 0).expect("闰年 2 月 29 日合法");
}

// ======================================================= F. 派生状态

#[test]
fn plan_status_moves_from_unpaid_to_partial_to_settled() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0928", 100_000);
    let view = save(&ctx, &order, vec![item(None, "full", 100_000, None)], false).unwrap();
    let schedule = view.plan_items[0].id.clone();
    assert_eq!(snapshot(&ctx, &order).plan_items[0].status, "unpaid");

    record(&ctx, &order, Some(&schedule), "full", 40_000, &today(&ctx), None, 0).unwrap();
    assert_eq!(snapshot(&ctx, &order).plan_items[0].status, "partial");

    record(&ctx, &order, Some(&schedule), "full", 60_000, &today(&ctx), None, 0).unwrap();
    let view = snapshot(&ctx, &order);
    assert_eq!(view.plan_items[0].status, "settled");
    assert_eq!(view.remaining_cents, Some(0));
    assert_eq!(view.net_received_cents, 100_000);
}

#[test]
fn overdue_starts_the_day_after_and_respects_voided_payments() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0929", 100_000);
    // 昨天到期、只收到一部分 → 逾期
    let yesterday = (minidesk::store::timezone::local_today(
        minidesk::store::settings::working_timezone(&ctx.conn()).unwrap(),
    ) - chrono::Duration::days(1))
    .format("%Y-%m-%d")
    .to_string();
    let view = save(
        &ctx,
        &order,
        vec![item(None, "full", 100_000, Some(&yesterday))],
        false,
    )
    .unwrap();
    let schedule = view.plan_items[0].id.clone();
    assert_eq!(snapshot(&ctx, &order).plan_items[0].status, "overdue");

    let rec = record(&ctx, &order, Some(&schedule), "full", 40_000, &today(&ctx), None, 0).unwrap();
    let view = snapshot(&ctx, &order);
    assert_eq!(view.plan_items[0].status, "overdue", "部分收款但已过期，仍是逾期");
    assert_eq!(view.plan_items[0].received_cents, 40_000, "逾期也要显示已收");

    // 收齐就不再逾期
    record(&ctx, &order, Some(&schedule), "full", 60_000, &today(&ctx), None, 0).unwrap();
    assert_eq!(snapshot(&ctx, &order).plan_items[0].status, "settled");

    // 作废后回落
    let mut conn = ctx.conn();
    finance::void_record(&mut conn, &VoidRecordInput { id: rec.id, reason: "多记了一笔".into() })
        .unwrap();
    let view = snapshot(&ctx, &order);
    assert_eq!(view.plan_items[0].received_cents, 60_000);
    assert_eq!(view.plan_items[0].status, "overdue");
}

#[test]
fn a_due_today_is_not_overdue() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0930", 100_000);
    let view = save(&ctx, &order, vec![item(None, "full", 100_000, Some(&today(&ctx)))], false).unwrap();
    assert_eq!(snapshot(&ctx, &order).plan_items[0].status, "unpaid");
    let _ = view;
}

#[test]
fn paying_more_than_planned_is_recorded_not_refused() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0931", 100_000);
    let view = save(&ctx, &order, vec![item(None, "full", 100_000, None)], false).unwrap();
    let schedule = view.plan_items[0].id.clone();
    record(&ctx, &order, Some(&schedule), "full", 120_000, &today(&ctx), None, 0).unwrap();

    let view = snapshot(&ctx, &order);
    assert_eq!(view.plan_items[0].status, "settled", "超出计划视为已收齐");
    assert_eq!(view.plan_items[0].received_cents, 120_000);
    assert_eq!(view.over_received_cents, 20_000);
    assert_eq!(view.remaining_cents, Some(0));
}

#[test]
fn voided_payments_leave_every_total() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0932", 100_000);
    let rec = record(&ctx, &order, None, "full", 30_000, &today(&ctx), None, 1_000).unwrap();
    let mut conn = ctx.conn();
    finance::void_record(&mut conn, &VoidRecordInput { id: rec.id.clone(), reason: "录错金额".into() })
        .unwrap();

    let view = snapshot(&ctx, &order);
    assert_eq!(view.gross_received_cents, 0);
    assert_eq!(view.fee_total_cents, 0);
    assert_eq!(view.net_received_cents, 0);
    assert_eq!(view.remaining_cents, Some(100_000));
    assert_eq!(view.records.len(), 0);
    assert_eq!(view.voided_records.len(), 1, "作废记录要留档");
    assert_eq!(view.voided_records[0].void_reason.as_deref(), Some("录错金额"));
    assert_eq!(view.voided_records[0].amount_cents, 30_000, "作废不改原金额");
}

// ================================================= G. 完成与取消

#[test]
fn a_completed_order_still_accepts_payments() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0933", 100_000);
    {
        // 直接置为已完成：这条测的是「完成后还能不能记账」，不是完成流程本身。
        let conn = ctx.conn();
        conn.execute(
            "UPDATE orders SET status = 'complete', started_at = '2026-11-01T00:00:00.000Z',
                               completed_at = '2026-11-20T00:00:00.000Z'
              WHERE id = ?1",
            [&order],
        )
        .unwrap();
    }
    let rec = record(&ctx, &order, None, "full", 30_000, &today(&ctx), None, 0).unwrap();
    let view = snapshot(&ctx, &order);
    assert_eq!(view.gross_received_cents, 30_000);
    assert_eq!(view.remaining_cents, Some(70_000), "完成了也要继续显示待收");

    // 完成后仍可作废
    let mut conn = ctx.conn();
    finance::void_record(&mut conn, &VoidRecordInput { id: rec.id, reason: "客户退回".into() }).unwrap();

    // 订单状态没被财务操作带跑
    assert_eq!(ctx.load(&order).status, "complete");
}

#[test]
fn a_cancelled_order_is_closed_to_finance_until_restored() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0934", 100_000);
    let rec = record(&ctx, &order, None, "full", 30_000, &today(&ctx), None, 0).unwrap();
    {
        let mut conn = ctx.conn();
        lifecycle::cancel_order(&mut conn, common::lifecycle_input(&ctx.load(&order))).unwrap();
    }

    // 取消后仍然可以看：用户需要查阅自己的历史收款与退款。
    let conn = ctx.conn();
    let view = finance::snapshot(&conn, &order).unwrap();
    assert!(view.cancelled);
    assert_eq!(view.records.len(), 1, "历史收款保留可读");

    let err = record(&ctx, &order, None, "full", 100, &today(&ctx), None, 0).unwrap_err();
    assert!(err.message.contains("已取消"), "{err:?}");

    let mut conn = ctx.conn();
    let err = finance::void_record(&mut conn, &VoidRecordInput { id: rec.id.clone(), reason: "x".into() })
        .unwrap_err();
    assert!(err.message.contains("已取消"), "{err:?}");

    // 恢复订单后原数据重新可读
    let mut conn = ctx.conn();
    lifecycle::reopen_order(&mut conn, common::lifecycle_input(&ctx.load(&order))).unwrap();
    let view = snapshot(&ctx, &order);
    assert_eq!(view.records.len(), 1);
}

// ========================================================= H. 作废

#[test]
fn voiding_requires_a_reason_and_is_one_way() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0935", 100_000);
    let rec = record(&ctx, &order, None, "full", 10_000, &today(&ctx), None, 200).unwrap();
    let mut conn = ctx.conn();

    for reason in ["", "   ", "\u{3000}"] {
        let err = finance::void_record(&mut conn, &VoidRecordInput { id: rec.id.clone(), reason: reason.into() })
            .unwrap_err();
        assert!(err.message.contains("不能为空"), "{reason:?}");
    }

    let voided = finance::void_record(
        &mut conn,
        &VoidRecordInput {
            id: rec.id.clone(),
            reason: "  客户退款前先撤销  ".into(),
        },
    )
    .unwrap();
    assert!(voided.voided_at.is_some());
    assert_eq!(voided.void_reason.as_deref(), Some("客户退款前先撤销"));
    assert_eq!(voided.fee_cents, 200, "作废不动手续费");

    // 再作废 / 再编辑都不行
    let err = finance::void_record(&mut conn, &VoidRecordInput { id: rec.id.clone(), reason: "再来".into() })
        .unwrap_err();
    assert_eq!(err.code, "CONFLICT");
    let err = finance::update_record(
        &mut conn,
        &UpdateRecordInput {
            id: rec.id,
            schedule_id: None,
            kind: "full".into(),
            amount_cents: 20_000,
            received_on: today(&ctx),
            platform_id: None,
            fee_cents: 0,
            method: None,
            note: None,
        },
    )
    .unwrap_err();
    assert!(err.message.contains("作废"), "{err:?}");
}

// =================================================== I. 既有规则回归

#[test]
fn cross_order_links_still_refused_in_v12() {
    let ctx = Ctx::new();
    let first = order_with_amount(&ctx, "AF-2026-0936", 100_000);
    let second = order_with_amount(&ctx, "AF-2026-0937", 100_000);
    let view = save(&ctx, &second, vec![item(None, "full", 100_000, None)], false).unwrap();
    let schedule = view.plan_items[0].id.clone();

    let err = record(&ctx, &first, Some(&schedule), "full", 1_000, &today(&ctx), None, 0).unwrap_err();
    assert!(err.message.contains("不属于同一订单"), "{err:?}");
}

#[test]
fn deleting_a_plan_keeps_the_payment() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0938", 100_000);
    let view = save(&ctx, &order, vec![item(None, "full", 100_000, None)], false).unwrap();
    let schedule = view.plan_items[0].id.clone();
    let rec = record(&ctx, &order, Some(&schedule), "full", 25_000, &today(&ctx), None, 0).unwrap();

    let conn = ctx.conn();
    conn.execute("DELETE FROM payment_schedules WHERE id = ?1", [&schedule]).unwrap();
    let view = snapshot(&ctx, &order);
    let found = view.records.iter().find(|r| r.id == rec.id).unwrap();
    assert_eq!(found.schedule_id, None);
    assert_eq!(found.amount_cents, 25_000);
    assert_eq!(view.gross_received_cents, 25_000);
}

#[test]
fn fee_quotes_are_integer_and_unknown_rates_stay_unknown() {
    assert_eq!(finance::suggest_fee(100_000, Some(500)).unwrap(), Some(5_000));
    assert_eq!(finance::suggest_fee(100_000, Some(125)).unwrap(), Some(1_250));
    assert_eq!(finance::suggest_fee(100_000, Some(0)).unwrap(), Some(0));
    assert_eq!(finance::suggest_fee(100_000, None).unwrap(), None, "费率未知不给数字");
    assert_eq!(finance::suggest_fee(10_001, Some(500)).unwrap(), Some(500), "500.05 分四舍五入为 500");
    assert_eq!(finance::suggest_fee(10_100, Some(500)).unwrap(), Some(505), "505 分");
    assert_eq!(finance::suggest_fee(1, Some(10_000)).unwrap(), Some(1), "100% 等于全额");
}

// ------------------------------- FIN-04 补测：无流水的计划项切换

/// 切换计划模式时，旧计划项被删、新项被建，且不需要「解除关联」确认——
/// 因为没有流水会被牵连。这条之前只有实现说明，没有测试。
#[test]
fn switching_plan_mode_without_payments_needs_no_detach_confirmation() {
    let ctx = Ctx::new();
    let order = order_with_amount(&ctx, "AF-2026-0939", 100_000);
    let first = save(&ctx, &order, plan(100_000, "deposit_final"), false).unwrap();
    let old_ids: Vec<String> = first.plan_items.iter().map(|i| i.id.clone()).collect();

    // 不传 confirmDetach，也应该能直接换成三期
    let switched = save(&ctx, &order, plan(100_000, "installment"), false).unwrap();
    assert_eq!(switched.plan_mode, "installment");
    assert_eq!(switched.plan_items.len(), 3);
    for item in &switched.plan_items {
        assert!(
            !old_ids.contains(&item.id),
            "模式切换后旧计划项应当被替换，而不是被复用"
        );
    }
    // 旧行确实没了
    let conn = ctx.conn();
    for id in old_ids {
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM payment_schedules WHERE id = ?1", [&id], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "旧计划项 {id} 应被删除");
    }
}
