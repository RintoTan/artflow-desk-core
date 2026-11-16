//! D02-01 / D02-02 / D02-04：建单、客户内联创建、金额 NULL 与 0。

mod common;

use minidesk::domain::orders::{create_order, ClientChoice, CreateOrderInput};
use minidesk::error::AppError;

fn base(title: &str) -> CreateOrderInput {
    CreateOrderInput {
        title: title.into(),
        ..Default::default()
    }
}

#[test]
fn d02_01_title_is_required_and_code_is_generated() {
    let ctx = common::Ctx::new();
    let mut conn = ctx.conn();

    let err = create_order(&mut conn, &ctx.hw, common::tz(), base("   ")).unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("标题"));

    let view = create_order(&mut conn, &ctx.hw, common::tz(), base("第一张委托")).unwrap();
    assert_eq!(view.code, "AF-2026-0001");
    assert_eq!(view.status, "active");
    assert_eq!(view.work_state, minidesk::domain::lifecycle::WorkState::Queued);
    assert!(view.started_at.is_none());
    assert_eq!(view.current_stage_title.as_deref(), Some("草稿"));
    assert_eq!(view.stage_count, 5);
    assert_eq!(view.queue_position, 0);
    assert_eq!(ctx.kinds(&view.id), vec!["created"]);

    // 阶段是订单自己的副本，与模板共用 ID 但属于本订单。
    let conn2 = ctx.conn();
    let count: i64 = conn2
        .query_row(
            "SELECT COUNT(*) FROM order_stages WHERE order_id = ?1",
            [&view.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 5);
}

#[test]
fn d02_01_second_order_appends_to_queue_tail() {
    let ctx = common::Ctx::new();
    let mut conn = ctx.conn();
    let a = create_order(&mut conn, &ctx.hw, common::tz(), base("甲")).unwrap();
    let b = create_order(&mut conn, &ctx.hw, common::tz(), base("乙")).unwrap();
    assert_eq!(a.queue_position, 0);
    assert_eq!(b.queue_position, 1);
    assert_eq!(a.code, "AF-2026-0001");
    assert_eq!(b.code, "AF-2026-0002");
}

#[test]
fn d02_02_inline_client_is_created_in_the_same_transaction() {
    let ctx = common::Ctx::new();
    let mut conn = ctx.conn();

    let view = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "带新客户的委托".into(),
            client: ClientChoice::New {
                display_name: "  小林  ".into(),
                contact: Some("wechat: lin".into()),
                note: None,
            },
            ..Default::default()
        },
    )
    .unwrap();

    assert_eq!(view.client_name.as_deref(), Some("小林"), "名称应被 trim");
    let client_id = view.client_id.expect("应有客户 ID");
    let conn2 = ctx.conn();
    let (name, contact): (String, Option<String>) = conn2
        .query_row(
            "SELECT display_name, contact FROM clients WHERE id = ?1",
            [&client_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(name, "小林");
    assert_eq!(contact.as_deref(), Some("wechat: lin"));
}

#[test]
fn d02_02_inline_client_rolls_back_when_order_fails() {
    let ctx = common::Ctx::new();
    let mut conn = ctx.conn();

    // 模板不存在 → 建单失败，新客户也不得残留。
    let err = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "会失败的委托".into(),
            client: ClientChoice::New {
                display_name: "不该出现的客户".into(),
                contact: None,
                note: None,
            },
            template_id: Some("no-such-template".into()),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "NOT_FOUND");

    let conn2 = ctx.conn();
    let clients: i64 = conn2
        .query_row("SELECT COUNT(*) FROM clients", [], |r| r.get(0))
        .unwrap();
    let orders: i64 = conn2
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    assert_eq!(clients, 0, "订单失败时新客户必须回滚");
    assert_eq!(orders, 0);
}

#[test]
fn d02_02_existing_client_can_be_selected_and_missing_one_is_rejected() {
    let ctx = common::Ctx::new();
    let mut conn = ctx.conn();

    let first = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "先建客户".into(),
            client: ClientChoice::New {
                display_name: "阿岚".into(),
                contact: None,
                note: None,
            },
            ..Default::default()
        },
    )
    .unwrap();
    let client_id = first.client_id.clone().unwrap();

    let second = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "复用客户".into(),
            client: ClientChoice::Existing {
                client_id: client_id.clone(),
            },
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(second.client_id.as_deref(), Some(client_id.as_str()));
    assert_eq!(second.client_name.as_deref(), Some("阿岚"));

    let missing = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "客户不存在".into(),
            client: ClientChoice::Existing {
                client_id: "ghost".into(),
            },
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(missing.code, "NOT_FOUND");
}

#[test]
fn d02_02_same_name_clients_are_not_merged() {
    let ctx = common::Ctx::new();
    let mut conn = ctx.conn();
    for title in ["单 A", "单 B"] {
        create_order(
            &mut conn,
            &ctx.hw,
            common::tz(),
            CreateOrderInput {
                title: title.into(),
                client: ClientChoice::New {
                    display_name: "同名画师".into(),
                    contact: None,
                    note: None,
                },
                ..Default::default()
            },
        )
        .unwrap();
    }
    let conn2 = ctx.conn();
    let count: i64 = conn2
        .query_row(
            "SELECT COUNT(*) FROM clients WHERE display_name = '同名画师'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 2, "同名客户必须各自独立");
}

#[test]
fn d02_04_null_amount_differs_from_zero() {
    let ctx = common::Ctx::new();
    let mut conn = ctx.conn();

    let unknown = create_order(&mut conn, &ctx.hw, common::tz(), base("未知金额")).unwrap();
    let zero = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "零元".into(),
            amount_cents: Some(0),
            ..Default::default()
        },
    )
    .unwrap();

    assert_eq!(unknown.amount_cents, None);
    assert_eq!(zero.amount_cents, Some(0));

    let negative = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "负金额".into(),
            amount_cents: Some(-1),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(negative.code, "INVALID");
}

#[test]
fn create_rejects_delivery_before_start_and_bad_dates() {
    let ctx = common::Ctx::new();
    let mut conn = ctx.conn();

    let bad_order = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "日期倒挂".into(),
            planned_start_date: Some("2026-05-10".into()),
            planned_delivery_date: Some("2026-05-01".into()),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(bad_order.code, "INVALID");

    let bad_format = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "日期格式错".into(),
            planned_start_date: Some("2026/05/10".into()),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(bad_format.code, "INVALID");
}

#[test]
fn create_is_idempotent_for_the_same_request_id() {
    let ctx = common::Ctx::new();
    let mut conn = ctx.conn();
    let input = CreateOrderInput {
        title: "重复提交".into(),
        request_id: Some("req-create-1".into()),
        ..Default::default()
    };
    let first = create_order(&mut conn, &ctx.hw, common::tz(), input.clone()).unwrap();
    let second = create_order(&mut conn, &ctx.hw, common::tz(), input).unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(first.code, second.code);

    let conn2 = ctx.conn();
    let count: i64 = conn2
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
    assert_eq!(ctx.events(&first.id).len(), 1, "只应有一条 created 事件");
}

#[test]
fn invalid_template_is_reported_not_silently_defaulted() {
    let ctx = common::Ctx::new();
    let mut conn = ctx.conn();
    let err: AppError = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "模板不存在".into(),
            template_id: Some("ghost-template".into()),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "NOT_FOUND");
}

#[test]
fn json_input_shape_matches_the_frontend_contract() {
    let none: CreateOrderInput =
        serde_json::from_str(r#"{"title":"无客户","client":{"mode":"none"}}"#).unwrap();
    assert!(matches!(none.client, ClientChoice::None));

    let existing: CreateOrderInput = serde_json::from_str(
        r#"{"title":"已有客户","client":{"mode":"existing","clientId":"c1"}}"#,
    )
    .unwrap();
    match existing.client {
        ClientChoice::Existing { client_id } => assert_eq!(client_id, "c1"),
        _ => panic!("应为已有客户"),
    }

    let fresh: CreateOrderInput = serde_json::from_str(
        r#"{"title":"新客户","client":{"mode":"new","displayName":"小林","contact":"tel"}}"#,
    )
    .unwrap();
    match fresh.client {
        ClientChoice::New { display_name, .. } => assert_eq!(display_name, "小林"),
        _ => panic!("应为新客户"),
    }

    // 省略 client 字段时默认不关联客户
    let omitted: CreateOrderInput = serde_json::from_str(r#"{"title":"省略客户"}"#).unwrap();
    assert!(matches!(omitted.client, ClientChoice::None));
}
