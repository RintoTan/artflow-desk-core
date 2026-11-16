//! D02-03 / D02-11：资料整体保存、revision 冲突、终态可编辑资料。

mod common;

use minidesk::domain::lifecycle::{self, LifecycleInput};
use minidesk::domain::orders::{update_details, UpdateDetailsInput};

fn input(order_id: &str, revision: i64, title: &str) -> UpdateDetailsInput {
    UpdateDetailsInput {
        order_id: order_id.into(),
        expected_revision: revision,
        title: title.into(),
        client_id: None,
        commission_type: None,
        amount_cents: None,
        planned_start_date: None,
        planned_delivery_date: None,
        note: None,
    }
}

#[test]
fn d02_03_details_are_saved_as_one_whole() {
    let ctx = common::Ctx::new();
    let id = ctx.create_order("原始标题");
    let view = ctx.load(&id);
    assert_eq!(view.revision, 0);

    let mut conn = ctx.conn();
    let updated = update_details(
        &mut conn,
        UpdateDetailsInput {
            order_id: id.clone(),
            expected_revision: 0,
            title: "  新标题  ".into(),
            client_id: None,
            commission_type: Some("半身立绘".into()),
            amount_cents: Some(123_45),
            planned_start_date: Some("2026-12-01".into()),
            planned_delivery_date: Some("2026-12-20".into()),
            note: Some("包含两张草图".into()),
        },
    )
    .unwrap();

    assert_eq!(updated.title, "新标题");
    assert_eq!(updated.commission_type.as_deref(), Some("半身立绘"));
    assert_eq!(updated.amount_cents, Some(12_345));
    assert_eq!(updated.planned_start_date.as_deref(), Some("2026-12-01"));
    assert_eq!(updated.planned_delivery_date.as_deref(), Some("2026-12-20"));
    assert_eq!(updated.note.as_deref(), Some("包含两张草图"));
    assert_eq!(updated.revision, 1, "一次整体保存只 bump 一次");
    assert_eq!(ctx.kinds(&id), vec!["created"], "资料编辑不写制作历史");
}

#[test]
fn d02_03_stale_revision_is_a_conflict_not_a_silent_overwrite() {
    let ctx = common::Ctx::new();
    let id = ctx.create_order("并发测试");

    let mut conn = ctx.conn();
    update_details(&mut conn, input(&id, 0, "第一次保存")).unwrap();

    // 第二个编辑器仍然拿着 revision 0。
    let err = update_details(&mut conn, input(&id, 0, "基于旧版本的保存")).unwrap_err();
    assert_eq!(err.code, "CONFLICT");
    assert!(err.message.contains("已被修改"), "{}", err.message);

    let after = ctx.load(&id);
    assert_eq!(after.title, "第一次保存", "旧版本不得覆盖新数据");
    assert_eq!(after.revision, 1);
}

#[test]
fn saving_identical_content_is_a_no_op_and_does_not_conflict() {
    let ctx = common::Ctx::new();
    let id = ctx.create_order("重试保存");
    let mut conn = ctx.conn();

    let first = update_details(&mut conn, input(&id, 0, "同样的内容")).unwrap();
    assert_eq!(first.revision, 1);

    // 模拟"保存成功但响应丢失后重试"：内容一致，不应报冲突。
    let retry = update_details(&mut conn, input(&id, 0, "同样的内容")).unwrap();
    assert_eq!(retry.revision, 1, "重试不应再 bump revision");
    assert_eq!(retry.title, "同样的内容");
}

#[test]
fn d02_03_invalid_input_does_not_touch_the_row() {
    let ctx = common::Ctx::new();
    let id = ctx.create_order("校验失败");
    let mut conn = ctx.conn();

    let err = update_details(&mut conn, input(&id, 0, "   ")).unwrap_err();
    assert_eq!(err.code, "INVALID");

    let mut bad_amount = input(&id, 0, "负金额");
    bad_amount.amount_cents = Some(-100);
    assert_eq!(update_details(&mut conn, bad_amount).unwrap_err().code, "INVALID");

    let mut bad_dates = input(&id, 0, "日期倒挂");
    bad_dates.planned_start_date = Some("2026-06-10".into());
    bad_dates.planned_delivery_date = Some("2026-06-01".into());
    assert_eq!(update_details(&mut conn, bad_dates).unwrap_err().code, "INVALID");

    let after = ctx.load(&id);
    assert_eq!(after.revision, 0);
    assert_eq!(after.title, "校验失败");
}

#[test]
fn d02_11_terminal_orders_still_allow_editing_details_but_not_stages() {
    let ctx = common::Ctx::new();
    let id = ctx.create_order("终态资料");
    let mut conn = ctx.conn();

    // 直接完成（单阶段流程先走完再完成需要开工，这里用取消更直接）。
    let view = ctx.load(&id);
    lifecycle::cancel_order(&mut conn, common::lifecycle_input(&view)).unwrap();

    let cancelled = ctx.load(&id);
    assert_eq!(cancelled.status, "cancelled");
    assert!(!cancelled.capabilities.can_start_work);
    assert!(!cancelled.capabilities.can_advance);
    assert!(!cancelled.capabilities.can_edit_workflow);
    assert!(cancelled.capabilities.can_reopen);

    // 普通资料仍可编辑。
    let updated = update_details(&mut conn, input(&id, cancelled.revision, "取消后改标题")).unwrap();
    assert_eq!(updated.title, "取消后改标题");
    assert_eq!(updated.status, "cancelled");

    // 但阶段推进被拒绝。
    let err = lifecycle::advance_stage(
        &mut conn,
        LifecycleInput {
            order_id: id.clone(),
            expected_revision: updated.revision,
            request_id: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "INVALID");
}

#[test]
fn client_name_change_is_reflected_on_orders() {
    let ctx = common::Ctx::new();
    let mut conn = ctx.conn();
    let view = minidesk::domain::orders::create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        minidesk::domain::orders::CreateOrderInput {
            title: "客户改名".into(),
            client: minidesk::domain::orders::ClientChoice::New {
                display_name: "旧名字".into(),
                contact: None,
                note: None,
            },
            ..Default::default()
        },
    )
    .unwrap();
    let client_id = view.client_id.clone().unwrap();

    conn.execute(
        "UPDATE clients SET display_name = '新名字', revision = revision + 1 WHERE id = ?1",
        [&client_id],
    )
    .unwrap();

    let reloaded = ctx.load(&view.id);
    assert_eq!(reloaded.client_name.as_deref(), Some("新名字"));
}

#[test]
fn clearing_a_client_relation_is_allowed() {
    let ctx = common::Ctx::new();
    let mut conn = ctx.conn();
    let view = minidesk::domain::orders::create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        minidesk::domain::orders::CreateOrderInput {
            title: "解除关联".into(),
            client: minidesk::domain::orders::ClientChoice::New {
                display_name: "会解除的客户".into(),
                contact: None,
                note: None,
            },
            ..Default::default()
        },
    )
    .unwrap();

    let cleared = update_details(
        &mut conn,
        UpdateDetailsInput {
            order_id: view.id.clone(),
            expected_revision: view.revision,
            title: view.title.clone(),
            client_id: None,
            commission_type: None,
            amount_cents: None,
            planned_start_date: None,
            planned_delivery_date: None,
            note: None,
        },
    )
    .unwrap();
    assert!(cleared.client_id.is_none());
    assert!(cleared.client_name.is_none());
}
