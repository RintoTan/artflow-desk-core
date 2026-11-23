//! UX-03：订单归档。
//!
//! 归档是**收纳**：只把订单从「订单信息」的普通列表里收起来，
//! 不改变业务状态、不写事件、不影响客户/工作台/日历/统计，也不进回收站。
//!
//! 这里守的是四件事：
//! 1. 只有已完成订单能归档；
//! 2. 归档不动 status / revision / 阶段 / 排期 / 事件；
//! 3. 取消归档回到取消前的样子；
//! 4. 归档后进入回收站再恢复，归档标记仍然在（两套状态互不吞并）。

mod common;

use common::Ctx;
use minidesk::domain::lifecycle;
use minidesk::domain::orders;
use minidesk::domain::trash;

fn started(ctx: &Ctx, id: &str) {
    let view = ctx.load(id);
    let mut conn = ctx.conn();
    lifecycle::start_work(&mut conn, common::lifecycle_input(&view)).unwrap();
}

fn completed(ctx: &Ctx, id: &str) {
    // 完成要求已在最后一个阶段：先一路推进到末阶段。
    loop {
        let view = ctx.load(id);
        if view.capabilities.can_complete {
            break;
        }
        assert!(view.capabilities.can_advance, "既不能推进也不能完成");
        let mut conn = ctx.conn();
        lifecycle::advance_stage(&mut conn, common::lifecycle_input(&view)).unwrap();
    }
    let view = ctx.load(id);
    let mut conn = ctx.conn();
    lifecycle::complete_order(&mut conn, common::lifecycle_input(&view)).unwrap();
}

fn archived_at(conn: &rusqlite::Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT archived_at FROM orders WHERE id = ?1", [id], |r| {
        r.get(0)
    })
    .unwrap()
}

#[test]
fn only_completed_orders_can_be_archived() {
    let ctx = Ctx::new();
    let active = ctx.create_order("进行中");
    let mut conn = ctx.conn();

    let err = orders::set_archived(&mut conn, &active, true).unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("已完成"), "{}", err.message);
    assert!(archived_at(&conn, &active).is_none());
}

#[test]
fn archiving_keeps_every_business_field() {
    let ctx = Ctx::new();
    let id = ctx.create_order("已交付");
    started(&ctx, &id);
    completed(&ctx, &id);

    let before = ctx.load(&id);
    assert!(before.completed_at.is_some());
    assert_eq!(before.status, "complete");
    let events_before = ctx.kinds(&id);

    let mut conn = ctx.conn();
    let after = orders::set_archived(&mut conn, &id, true).unwrap();

    assert!(after.archived_at.is_some(), "归档时间被写入");
    assert_eq!(after.status, before.status, "业务状态不变");
    assert_eq!(after.revision, before.revision, "归档不算一次编辑");
    assert_eq!(after.completed_at, before.completed_at);
    assert_eq!(after.current_stage_id, before.current_stage_id);
    assert_eq!(after.planned_delivery_date, before.planned_delivery_date);
    assert_eq!(after.amount_cents, before.amount_cents);
    assert_eq!(ctx.kinds(&id), events_before, "归档不写事件");
}

#[test]
fn unarchive_clears_the_marker_and_keeps_the_order() {
    let ctx = Ctx::new();
    let id = ctx.create_order("取消归档");
    started(&ctx, &id);
    completed(&ctx, &id);

    let mut conn = ctx.conn();
    orders::set_archived(&mut conn, &id, true).unwrap();
    let back = orders::set_archived(&mut conn, &id, false).unwrap();

    assert!(back.archived_at.is_none());
    assert_eq!(back.status, "complete");
    assert_eq!(archived_at(&ctx.conn(), &id), None);
}

#[test]
fn archiving_twice_is_idempotent() {
    let ctx = Ctx::new();
    let id = ctx.create_order("重复归档");
    started(&ctx, &id);
    completed(&ctx, &id);

    let mut conn = ctx.conn();
    let first = orders::set_archived(&mut conn, &id, true).unwrap();
    let second = orders::set_archived(&mut conn, &id, true).unwrap();
    assert_eq!(first.archived_at, second.archived_at, "重复归档不刷新时间");
}

#[test]
fn archived_order_survives_trash_and_restore() {
    let ctx = Ctx::new();
    let id = ctx.create_order("归档后删除");
    started(&ctx, &id);
    completed(&ctx, &id);

    let mut conn = ctx.conn();
    orders::set_archived(&mut conn, &id, true).unwrap();
    trash::delete_order(&mut conn, &id).unwrap();

    let trashed = archived_at(&conn, &id);
    assert!(trashed.is_some(), "进回收站不动归档标记");

    trash::restore_order(&mut conn, &id).unwrap();
    assert!(archived_at(&conn, &id).is_some(), "恢复后仍在归档空间");
    assert_eq!(orders::load(&conn, &id).unwrap().status, "complete");
}

#[test]
fn archived_orders_stay_visible_to_other_readers() {
    let ctx = Ctx::new();
    let id = ctx.create_order("归档仍可见");
    started(&ctx, &id);
    completed(&ctx, &id);

    let mut conn = ctx.conn();
    orders::set_archived(&mut conn, &id, true).unwrap();

    // 列表接口返回全部可见订单（含归档）：普通列表的切分在界面层做，
    // 其余模块（客户详情、工作台、日历、统计）读同一条记录，不受影响。
    let all = orders::list(&conn).unwrap();
    assert!(all.iter().any(|o| o.id == id), "归档订单仍在可见集合里");
    assert!(all
        .iter()
        .find(|o| o.id == id)
        .unwrap()
        .archived_at
        .is_some());
}
