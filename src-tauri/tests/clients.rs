//! 客户档案：创建、编辑、改名反映到订单、关联订单历史、同名不合并。

mod common;

use common::Ctx;
use minidesk::domain::clients::{self, CreateClientInput, UpdateClientInput};
use minidesk::domain::orders::{create_order, ClientChoice, CreateOrderInput};

fn new_client(ctx: &Ctx, name: &str) -> clients::ClientView {
    let conn = ctx.conn();
    clients::create(
        &conn,
        CreateClientInput {
            display_name: name.into(),
            contact: Some("wechat: demo".into()),
            note: None,
        },
    )
    .unwrap()
}

#[test]
fn create_client_with_trimmed_name_and_optional_fields() {
    let ctx = Ctx::new();
    let conn = ctx.conn();
    let view = clients::create(
        &conn,
        CreateClientInput {
            display_name: "  阿岚  ".into(),
            contact: Some("   ".into()),
            note: Some("老客户".into()),
        },
    )
    .unwrap();
    assert_eq!(view.display_name, "阿岚");
    assert_eq!(view.contact, None, "空白联系方式应归一为 NULL");
    assert_eq!(view.note.as_deref(), Some("老客户"));
    assert_eq!(view.revision, 0);
    assert_eq!(view.order_count, 0);
}

#[test]
fn empty_name_is_rejected() {
    let ctx = Ctx::new();
    let conn = ctx.conn();
    let err = clients::create(
        &conn,
        CreateClientInput {
            display_name: "   ".into(),
            contact: None,
            note: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "INVALID");
}

#[test]
fn same_name_clients_stay_separate() {
    let ctx = Ctx::new();
    new_client(&ctx, "同名");
    new_client(&ctx, "同名");
    let conn = ctx.conn();
    let list = clients::list(&conn).unwrap();
    assert_eq!(list.len(), 2);
    assert_ne!(list[0].id, list[1].id);
}

#[test]
fn renaming_a_client_is_reflected_on_orders() {
    let ctx = Ctx::new();
    let mut conn = ctx.conn();
    let order = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "关联订单".into(),
            client: ClientChoice::New {
                display_name: "旧名字".into(),
                contact: None,
                note: None,
            },
            ..Default::default()
        },
    )
    .unwrap();
    let client_id = order.client_id.clone().unwrap();

    let updated = clients::update(
        &mut conn,
        UpdateClientInput {
            client_id: client_id.clone(),
            expected_revision: 0,
            display_name: "新名字".into(),
            contact: None,
            note: None,
        },
    )
    .unwrap();
    assert_eq!(updated.display_name, "新名字");
    assert_eq!(updated.revision, 1);
    assert_eq!(updated.order_count, 1);

    let reloaded = ctx.load(&order.id);
    assert_eq!(reloaded.client_name.as_deref(), Some("新名字"), "订单读取最新客户名称");
}

#[test]
fn client_update_uses_revision_and_no_op_save_does_not_bump() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "版本客户");
    let mut conn = ctx.conn();

    let first = clients::update(
        &mut conn,
        UpdateClientInput {
            client_id: client.id.clone(),
            expected_revision: 0,
            display_name: "版本客户".into(),
            contact: Some("wechat: demo".into()),
            note: None,
        },
    )
    .unwrap();
    assert_eq!(first.revision, 0, "内容未变不应 bump");

    let renamed = clients::update(
        &mut conn,
        UpdateClientInput {
            client_id: client.id.clone(),
            expected_revision: 0,
            display_name: "改过的名字".into(),
            contact: None,
            note: None,
        },
    )
    .unwrap();
    assert_eq!(renamed.revision, 1);

    let err = clients::update(
        &mut conn,
        UpdateClientInput {
            client_id: client.id.clone(),
            expected_revision: 0,
            display_name: "基于旧版本".into(),
            contact: None,
            note: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "CONFLICT");
    assert_eq!(
        clients::detail(&conn, &client.id).unwrap().client.display_name,
        "改过的名字"
    );
}

#[test]
fn client_detail_lists_orders_with_stage_names() {
    let ctx = Ctx::new();
    let mut conn = ctx.conn();
    let client = clients::create(
        &conn,
        CreateClientInput {
            display_name: "多单客户".into(),
            contact: None,
            note: None,
        },
    )
    .unwrap();

    for title in ["第一单", "第二单"] {
        create_order(
            &mut conn,
            &ctx.hw,
            common::tz(),
            CreateOrderInput {
                title: title.into(),
                client: ClientChoice::Existing {
                    client_id: client.id.clone(),
                },
                ..Default::default()
            },
        )
        .unwrap();
    }

    let detail = clients::detail(&conn, &client.id).unwrap();
    assert_eq!(detail.client.order_count, 2);
    assert_eq!(detail.orders.len(), 2);
    assert!(detail.orders.iter().all(|o| o.current_stage_title.as_deref() == Some("草稿")));
}

#[test]
fn counts_by_status_are_reported() {
    let ctx = Ctx::new();
    let mut conn = ctx.conn();
    let order = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "会被取消".into(),
            client: ClientChoice::New {
                display_name: "计数客户".into(),
                contact: None,
                note: None,
            },
            ..Default::default()
        },
    )
    .unwrap();
    let client_id = order.client_id.clone().unwrap();

    let view = ctx.load(&order.id);
    minidesk::domain::lifecycle::cancel_order(&mut conn, common::lifecycle_input(&view)).unwrap();

    let detail = clients::detail(&conn, &client_id).unwrap();
    assert_eq!(detail.client.order_count, 1);
    assert_eq!(detail.client.active_count, 0);
    assert_eq!(detail.client.completed_count, 0);
}

#[test]
fn missing_client_is_not_found() {
    let ctx = Ctx::new();
    let conn = ctx.conn();
    let err = clients::detail(&conn, "ghost").unwrap_err();
    assert_eq!(err.code, "NOT_FOUND");
}
