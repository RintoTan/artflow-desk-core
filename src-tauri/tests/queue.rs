//! 活动队列：插入位置、上移/下移、重排与 queue_revision 冲突保护。

mod common;

use common::Ctx;
use minidesk::domain::lifecycle;
use minidesk::domain::orders::{create_order, CreateOrderInput};
use minidesk::domain::queue::{self, MoveInput};

fn order(ctx: &Ctx, title: &str) -> String {
    ctx.create_order(title)
}

fn titles(ctx: &Ctx) -> Vec<String> {
    let conn = ctx.conn();
    queue::list(&conn)
        .unwrap()
        .into_iter()
        .map(|e| e.title)
        .collect()
}

fn positions(ctx: &Ctx) -> Vec<i64> {
    let conn = ctx.conn();
    queue::list(&conn)
        .unwrap()
        .into_iter()
        .map(|e| e.queue_position)
        .collect()
}

#[test]
fn new_orders_append_to_the_tail_in_creation_order() {
    let ctx = Ctx::new();
    order(&ctx, "甲");
    order(&ctx, "乙");
    order(&ctx, "丙");
    assert_eq!(titles(&ctx), vec!["甲", "乙", "丙"]);
    assert_eq!(positions(&ctx), vec![0, 1, 2]);
}

#[test]
fn move_to_index_reorders_and_keeps_positions_contiguous() {
    let ctx = Ctx::new();
    let a = order(&ctx, "甲");
    order(&ctx, "乙");
    order(&ctx, "丙");
    let rev = queue::revision(&ctx.conn()).unwrap();

    let mut conn = ctx.conn();
    let snap = queue::move_order(
        &mut conn,
        MoveInput {
            order_id: a,
            expected_queue_revision: rev,
            to_index: 2,
        },
    )
    .unwrap();

    assert_eq!(
        snap.entries.iter().map(|e| e.title.as_str()).collect::<Vec<_>>(),
        vec!["乙", "丙", "甲"]
    );
    assert_eq!(
        snap.entries.iter().map(|e| e.queue_position).collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    assert_eq!(snap.revision, rev + 1);
}

#[test]
fn move_up_and_down_shift_by_one() {
    let ctx = Ctx::new();
    let a = order(&ctx, "甲");
    order(&ctx, "乙");
    order(&ctx, "丙");
    let rev = queue::revision(&ctx.conn()).unwrap();

    let mut conn = ctx.conn();
    queue::shift(&mut conn, &a, rev, 1).unwrap();
    assert_eq!(titles(&ctx), vec!["乙", "甲", "丙"]);

    let rev2 = queue::revision(&ctx.conn()).unwrap();
    queue::shift(&mut conn, &a, rev2, -1).unwrap();
    assert_eq!(titles(&ctx), vec!["甲", "乙", "丙"]);
}

#[test]
fn moving_out_of_range_clamps_instead_of_failing() {
    let ctx = Ctx::new();
    let a = order(&ctx, "甲");
    order(&ctx, "乙");
    let rev = queue::revision(&ctx.conn()).unwrap();

    let mut conn = ctx.conn();
    queue::move_order(
        &mut conn,
        MoveInput {
            order_id: a.clone(),
            expected_queue_revision: rev,
            to_index: 99,
        },
    )
    .unwrap();
    assert_eq!(titles(&ctx), vec!["乙", "甲"]);

    let rev2 = queue::revision(&ctx.conn()).unwrap();
    queue::move_order(
        &mut conn,
        MoveInput {
            order_id: a,
            expected_queue_revision: rev2,
            to_index: -5,
        },
    )
    .unwrap();
    assert_eq!(titles(&ctx), vec!["甲", "乙"]);
}

#[test]
fn stale_queue_revision_is_a_conflict() {
    let ctx = Ctx::new();
    let a = order(&ctx, "甲");
    order(&ctx, "乙");
    order(&ctx, "丙");
    let stale = queue::revision(&ctx.conn()).unwrap();

    let mut conn = ctx.conn();
    // 另一个人先动了顺序
    queue::move_order(
        &mut conn,
        MoveInput {
            order_id: a.clone(),
            expected_queue_revision: stale,
            to_index: 2,
        },
    )
    .unwrap();

    let err = queue::move_order(
        &mut conn,
        MoveInput {
            order_id: a,
            expected_queue_revision: stale,
            to_index: 0,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "CONFLICT");
    // 冲突时不得改动顺序
    assert_eq!(titles(&ctx), vec!["乙", "丙", "甲"]);
}

#[test]
fn reordering_never_bumps_order_revision() {
    let ctx = Ctx::new();
    let a = order(&ctx, "甲");
    let b = order(&ctx, "乙");
    let before_a = ctx.load(&a);
    let before_b = ctx.load(&b);
    let rev = queue::revision(&ctx.conn()).unwrap();

    let mut conn = ctx.conn();
    queue::move_order(
        &mut conn,
        MoveInput {
            order_id: a.clone(),
            expected_queue_revision: rev,
            to_index: 1,
        },
    )
    .unwrap();

    assert_eq!(ctx.load(&a).revision, before_a.revision, "排序不 bump 订单版本");
    assert_eq!(ctx.load(&b).revision, before_b.revision);
    assert_eq!(ctx.load(&a).queue_position, 1);
    assert_eq!(ctx.load(&b).queue_position, 0);
}

#[test]
fn terminal_orders_leave_the_queue() {
    let ctx = Ctx::new();
    let a = order(&ctx, "甲");
    order(&ctx, "乙");
    let view = ctx.load(&a);
    let mut conn = ctx.conn();
    lifecycle::cancel_order(&mut conn, common::lifecycle_input(&view)).unwrap();

    assert_eq!(titles(&ctx), vec!["乙"]);

    let err = queue::move_order(
        &mut conn,
        MoveInput {
            order_id: a,
            expected_queue_revision: queue::revision(&ctx.conn()).unwrap(),
            to_index: 0,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "INVALID");
}

#[test]
fn single_entry_queue_is_a_no_op() {
    let ctx = Ctx::new();
    let a = order(&ctx, "只有一个");
    let rev = queue::revision(&ctx.conn()).unwrap();
    let mut conn = ctx.conn();
    let snap = queue::move_order(
        &mut conn,
        MoveInput {
            order_id: a,
            expected_queue_revision: rev,
            to_index: 5,
        },
    )
    .unwrap();
    assert_eq!(snap.entries.len(), 1);
    assert_eq!(snap.revision, rev, "无变化不应 bump 队列版本");
}

#[test]
fn create_can_insert_at_a_chosen_position() {
    let ctx = Ctx::new();
    order(&ctx, "甲");
    order(&ctx, "乙");
    let rev = queue::revision(&ctx.conn()).unwrap();

    let mut conn = ctx.conn();
    create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "插队".into(),
            queue_insert_position: Some(1),
            expected_queue_revision: Some(rev),
            ..Default::default()
        },
    )
    .unwrap();

    assert_eq!(titles(&ctx), vec!["甲", "插队", "乙"]);
    assert_eq!(positions(&ctx), vec![0, 1, 2]);
}

#[test]
fn create_with_stale_queue_revision_is_refused() {
    let ctx = Ctx::new();
    let a = order(&ctx, "甲");
    order(&ctx, "乙");
    let stale = queue::revision(&ctx.conn()).unwrap();

    let mut conn = ctx.conn();
    queue::move_order(
        &mut conn,
        MoveInput {
            order_id: a,
            expected_queue_revision: stale,
            to_index: 1,
        },
    )
    .unwrap();

    let err = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "基于旧顺序插入".into(),
            queue_insert_position: Some(0),
            expected_queue_revision: Some(stale),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "CONFLICT");

    let count: i64 = {
        let conn = ctx.conn();
        conn.query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0)).unwrap()
    };
    assert_eq!(count, 2, "冲突时不得建单");
}

#[test]
fn reopen_places_the_order_at_the_tail_and_bumps_queue_revision() {
    let ctx = Ctx::new();
    let a = order(&ctx, "甲");
    order(&ctx, "乙");
    let before = queue::revision(&ctx.conn()).unwrap();

    let view = ctx.load(&a);
    let mut conn = ctx.conn();
    let cancelled = lifecycle::cancel_order(&mut conn, common::lifecycle_input(&view)).unwrap();
    let reopened = lifecycle::reopen_order(&mut conn, common::lifecycle_input(&cancelled)).unwrap();

    assert_eq!(titles(&ctx), vec!["乙", "甲"]);
    assert_eq!(reopened.queue_position, 1);
    assert!(queue::revision(&ctx.conn()).unwrap() > before);
}
