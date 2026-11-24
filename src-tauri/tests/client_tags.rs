//! 客户标签与动态统计：手工标签、使用中不可删、金额合计排除 NULL、终态计入。

mod common;

use common::Ctx;
use minidesk::domain::clients::{self, CreateClientInput, UpdateClientInput};
use minidesk::domain::lifecycle;
use minidesk::domain::orders::{create_order, ClientChoice, CreateOrderInput};

fn client(ctx: &Ctx, name: &str) -> String {
    let conn = ctx.conn();
    clients::create(
        &conn,
        CreateClientInput {
            display_name: name.into(),
            contact: None,
            note: None,
        },
    )
    .unwrap()
    .id
}

fn order_for(ctx: &Ctx, client_id: &str, title: &str, amount: Option<i64>) -> String {
    let mut conn = ctx.conn();
    create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: title.into(),
            client: ClientChoice::Existing {
                client_id: client_id.into(),
            },
            amount_cents: amount,
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

#[test]
fn tag_create_rejects_blank_and_duplicate_names() {
    let ctx = Ctx::new();
    let conn = ctx.conn();
    assert!(clients::create_tag(&conn, "   ").is_err(), "空名称必须拒绝");
    assert!(
        clients::create_tag(&conn, &"长".repeat(21)).is_err(),
        "超过 20 字必须拒绝"
    );
    let tag = clients::create_tag(&conn, " 长期客户 ").unwrap();
    assert_eq!(tag.name, "长期客户", "首尾空白应归一");
    let again = clients::create_tag(&conn, "长期客户");
    assert!(again.is_err(), "重名必须明确拒绝，不静默合并");
}

#[test]
fn tag_link_is_idempotent_and_unlink_is_reversible() {
    let ctx = Ctx::new();
    let conn = ctx.conn();
    let c = client(&ctx, "阿岚");
    let tag = clients::create_tag(&conn, "商业委托").unwrap();

    let after_first = clients::link_tag(&conn, &c, &tag.id).unwrap();
    assert_eq!(after_first.len(), 1);
    let after_second = clients::link_tag(&conn, &c, &tag.id).unwrap();
    assert_eq!(after_second.len(), 1, "重复挂载结果相同，不应出现两条");

    let all = clients::list_tags(&conn).unwrap();
    assert_eq!(all[0].client_count, 1);

    let after_unlink = clients::unlink_tag(&conn, &c, &tag.id).unwrap();
    assert!(after_unlink.is_empty());
    let after_unlink_again = clients::unlink_tag(&conn, &c, &tag.id).unwrap();
    assert!(after_unlink_again.is_empty(), "重复解除也算达成目标");
}

#[test]
fn tag_in_use_cannot_be_deleted() {
    let ctx = Ctx::new();
    let conn = ctx.conn();
    let c = client(&ctx, "阿岚");
    let tag = clients::create_tag(&conn, "需要提前确认草稿").unwrap();
    clients::link_tag(&conn, &c, &tag.id).unwrap();

    let err = clients::delete_tag(&conn, &tag.id).unwrap_err();
    assert!(
        err.message.contains("仍被 1 位客户使用"),
        "拒绝时必须说明用量，实际：{}",
        err.message
    );

    clients::unlink_tag(&conn, &c, &tag.id).unwrap();
    clients::delete_tag(&conn, &tag.id).unwrap();
    assert!(clients::list_tags(&conn).unwrap().is_empty());
}

#[test]
fn tag_link_rejects_unknown_ids() {
    let ctx = Ctx::new();
    let conn = ctx.conn();
    let c = client(&ctx, "阿岚");
    let tag = clients::create_tag(&conn, "标签").unwrap();
    assert!(clients::link_tag(&conn, "no-such-client", &tag.id).is_err());
    assert!(clients::link_tag(&conn, &c, "no-such-tag").is_err());
}

#[test]
fn client_stats_count_terminal_orders_and_skip_null_amounts() {
    let ctx = Ctx::new();
    let c = client(&ctx, "星河");

    let active = order_for(&ctx, &c, "进行中", Some(10_000));
    let done = order_for(&ctx, &c, "已完成但金额未知", None);
    let cancelled = order_for(&ctx, &c, "已取消", Some(5_000));

    // 完成一张、取消一张：两者都计入关联订单数，但取消单不计入金额（C-1）。
    let mut conn = ctx.conn();
    // 完成要求先开工并推进到最后一个阶段：领域规则不允许跳过这些条件。
    lifecycle::start_work(&mut conn, common::lifecycle_input(&ctx.load(&done))).unwrap();
    while !ctx.load(&done).capabilities.can_complete {
        lifecycle::advance_stage(&mut conn, common::lifecycle_input(&ctx.load(&done))).unwrap();
    }
    lifecycle::complete_order(&mut conn, common::lifecycle_input(&ctx.load(&done))).unwrap();
    lifecycle::cancel_order(&mut conn, common::lifecycle_input(&ctx.load(&cancelled))).unwrap();

    let view = clients::detail(&conn, &c).unwrap().client;
    assert_eq!(view.order_count, 3, "终态订单仍计入关联订单数");
    assert_eq!(view.completed_count, 1);
    assert_eq!(view.active_count, 1);
    assert_eq!(
        view.known_amount_cents, 10_000,
        "NULL 金额不计入，也不能当成 0 拉低合计；已取消订单的金额同样排除"
    );
    assert!(
        view.last_order_at.is_some(),
        "最近下单时间应取现存订单的最大创建时间"
    );
    assert!(!active.is_empty());
}

#[test]
fn client_update_conflict_and_notes_untouched_by_tags() {
    let ctx = Ctx::new();
    let c = client(&ctx, "月华");
    let conn0 = ctx.conn();
    let tag = clients::create_tag(&conn0, "长期客户").unwrap();
    clients::link_tag(&conn0, &c, &tag.id).unwrap();

    let before = clients::detail(&conn0, &c).unwrap().client;
    assert_eq!(before.tags.len(), 1);
    assert_eq!(
        before.revision, 0,
        "挂标签不应改动客户资料版本，避免已打开的表单被无谓判为冲突"
    );

    let mut conn = ctx.conn();
    let updated = clients::update(
        &mut conn,
        UpdateClientInput {
            client_id: c.clone(),
            expected_revision: 0,
            display_name: "月华（改名）".into(),
            contact: Some("wx: yuehua".into()),
            note: Some("沟通顺畅".into()),
        },
    )
    .unwrap();
    assert_eq!(updated.revision, 1);
    assert_eq!(updated.tags.len(), 1, "改名不影响标签关联");

    let stale = clients::update(
        &mut conn,
        UpdateClientInput {
            client_id: c.clone(),
            expected_revision: 0,
            display_name: "旧版本".into(),
            contact: None,
            note: None,
        },
    )
    .unwrap_err();
    assert!(stale.message.contains("已被修改"), "过期版本必须冲突");
}
