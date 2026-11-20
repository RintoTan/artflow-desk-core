//! DEV-0.1.1-03B：删除、恢复与回收站读模型。
//!
//! 重点不是「能删能恢复」，而是**客户与订单的关系在删除/恢复之后仍然完整**：
//! - 删客户时，早先单独删除的订单也要并入本次批次（否则永久删除客户会产生孤儿）；
//! - 早先删除的订单保留自己的删除时间；
//! - 恢复客户时它一定回来；
//! - 批次不一致时中止，不静默扩大范围。

mod common;

use common::Ctx;
use minidesk::domain::clients::{self, CreateClientInput};
use minidesk::domain::lifecycle;
use minidesk::domain::orders::{self, ClientChoice, CreateOrderInput};
use minidesk::domain::trash;

fn new_client(ctx: &Ctx, name: &str) -> String {
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

fn new_order(ctx: &Ctx, client_id: &str, title: &str) -> String {
    let mut conn = ctx.conn();
    orders::create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: title.into(),
            client: ClientChoice::Existing {
                client_id: client_id.into(),
            },
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

fn batch_of_order(conn: &rusqlite::Connection, id: &str) -> (Option<String>, Option<String>) {
    conn.query_row(
        "SELECT deleted_at, deleted_batch FROM orders WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

fn batch_of_client(conn: &rusqlite::Connection, id: &str) -> (Option<String>, Option<String>) {
    conn.query_row(
        "SELECT deleted_at, deleted_batch FROM clients WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

fn count(conn: &rusqlite::Connection, sql: &str, arg: &str) -> i64 {
    conn.query_row(sql, [arg], |r| r.get(0)).unwrap()
}

#[test]
fn delete_order_hides_it_from_business_but_shows_in_trash() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "甲");
    let order = new_order(&ctx, &client, "独立删除");
    let mut conn = ctx.conn();

    assert_eq!(orders::list(&conn).unwrap().len(), 1);
    let deleted = trash::delete_order(&mut conn, &order).unwrap();
    assert_eq!(deleted.order_id, order);

    assert!(orders::list(&conn).unwrap().is_empty(), "业务列表不再显示");
    assert_eq!(
        orders::load(&conn, &order).unwrap_err().code,
        "NOT_FOUND",
        "详情读的是视图"
    );

    let snap = trash::snapshot(&conn).unwrap();
    assert_eq!(snap.group_count, 0);
    assert_eq!(snap.loose_order_count, 1);
    assert_eq!(snap.total_order_count, 1);
    assert_eq!(snap.loose_orders[0].id, order);
    assert_eq!(
        snap.loose_orders[0].original_client_name.as_deref(),
        Some("甲"),
        "独立订单要能显示原客户"
    );

    let (deleted_at, batch) = batch_of_order(&conn, &order);
    assert!(deleted_at.is_some());
    assert!(batch.is_some(), "单笔删除也要有自己的批次");
}

#[test]
fn delete_client_batches_every_order_including_previously_trashed() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "Alice");
    let a = new_order(&ctx, &client, "A");
    let b = new_order(&ctx, &client, "B");
    let c = new_order(&ctx, &client, "C");
    let mut conn = ctx.conn();

    // 第 1 步：单独删除 A。
    trash::delete_order(&mut conn, &a).unwrap();
    let (a_time_before, a_batch_before) = batch_of_order(&conn, &a);
    assert!(a_time_before.is_some());
    assert_ne!(a_batch_before, None);

    // 第 2 步：删除客户 Alice。
    let impact = trash::client_delete_impact(&conn, &client).unwrap();
    assert_eq!(impact.order_count, 3);
    assert_eq!(impact.already_trashed, 1, "确认框要说明有 1 单已在回收站");

    let deleted = trash::delete_client(&mut conn, &client).unwrap();
    assert_eq!(deleted.orders_trashed, 2);
    assert_eq!(deleted.orders_already_trashed, 1);

    // 三单同批，且与客户批次一致。
    let (_, client_batch) = batch_of_client(&conn, &client);
    let client_batch = client_batch.expect("客户应有批次");
    for id in [&a, &b, &c] {
        let (_, batch) = batch_of_order(&conn, id);
        assert_eq!(batch.as_deref(), Some(client_batch.as_str()), "订单必须并入客户批次");
    }

    // A 保留原删除时间，B/C 用本次时间。
    let (a_time_after, _) = batch_of_order(&conn, &a);
    assert_eq!(a_time_after, a_time_before, "早先删除的订单不得被改写删除时间");
    let (b_time, _) = batch_of_order(&conn, &b);
    assert_eq!(b_time.as_deref(), Some(deleted.deleted_at.as_str()));

    // 分类：三单都在客户组里，独立订单段为空。
    let snap = trash::snapshot(&conn).unwrap();
    assert_eq!(snap.group_count, 1);
    assert_eq!(snap.loose_order_count, 0);
    assert_eq!(snap.total_order_count, 3);
    assert_eq!(snap.groups[0].orders.len(), 3);
    assert_eq!(snap.groups[0].client_name, "Alice");
}

#[test]
fn restore_client_brings_back_earlier_deleted_order() {
    // 本用例**只有两个订单**，用来单独验证「早先单独删除的那单也会回来」。
    // 三单（A 早删 + B + C）的完整计数在下一个用例里。
    let ctx = Ctx::new();
    let client = new_client(&ctx, "Bob");
    let a = new_order(&ctx, &client, "A");
    let b = new_order(&ctx, &client, "B");
    let mut conn = ctx.conn();

    trash::delete_order(&mut conn, &a).unwrap();
    trash::delete_client(&mut conn, &client).unwrap();

    let restored = trash::restore_client(&mut conn, &client).unwrap();
    assert_eq!(restored.orders_restored, 2, "A 与 B 一起回来");
    assert_eq!(restored.clients_restored, 1);

    let listed = orders::list(&conn).unwrap();
    assert_eq!(listed.len(), 2, "两单都回到业务列表");
    assert!(listed.iter().any(|o| o.id == a));
    assert_eq!(clients::list(&conn).unwrap().len(), 1);

    for id in [&a, &b] {
        let (deleted_at, batch) = batch_of_order(&conn, id);
        assert!(deleted_at.is_none() && batch.is_none(), "恢复后不再带删除标记");
    }
    let (client_deleted, client_batch) = batch_of_client(&conn, &client);
    assert!(client_deleted.is_none() && client_batch.is_none());

    assert!(trash::snapshot(&conn).unwrap().groups.is_empty());
}

#[test]
fn restore_client_restores_all_three_when_one_was_trashed_first() {
    // 验收关注点：A 早先单独删除 → 删客户时被并入本批次 → 恢复必须 3 单全回来，
    // 且 `orders_restored` 必须把这单算进去（它确实被 UPDATE 改到了）。
    let ctx = Ctx::new();
    let client = new_client(&ctx, "Henry");
    let a = new_order(&ctx, &client, "A");
    let b = new_order(&ctx, &client, "B");
    let c = new_order(&ctx, &client, "C");
    let mut conn = ctx.conn();

    trash::delete_order(&mut conn, &a).unwrap();
    trash::delete_client(&mut conn, &client).unwrap();

    // 恢复前：三单同批，A 的时间更早。
    let (a_time, _) = batch_of_order(&conn, &a);
    assert!(a_time.is_some());

    let restored = trash::restore_client(&mut conn, &client).unwrap();
    assert_eq!(restored.clients_restored, 1, "客户恢复计数");
    assert_eq!(
        restored.orders_restored, 3,
        "A（早先单独删除）、B、C 三单都要计入"
    );

    // 验收三问，逐条对数据库取证。
    for (label, id) in [("A", &a), ("B", &b), ("C", &c)] {
        let (deleted_at, batch) = batch_of_order(&conn, id);
        assert!(deleted_at.is_none(), "{label} 的 deleted_at 必须为 NULL");
        assert!(batch.is_none(), "{label} 的 deleted_batch 必须为 NULL");
    }
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM orders WHERE client_id = ?1 AND deleted_at IS NOT NULL",
            &client
        ),
        0,
        "不得有订单仍留在回收站"
    );
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM orders WHERE client_id = ?1 AND deleted_batch IS NOT NULL",
            &client
        ),
        0,
        "不得有订单仍带删除批次"
    );

    // 业务面：三单可见，客户可见，回收站空。
    assert_eq!(orders::list(&conn).unwrap().len(), 3);
    assert_eq!(clients::list(&conn).unwrap().len(), 1);
    let snap = trash::snapshot(&conn).unwrap();
    assert_eq!(snap.group_count, 0);
    assert_eq!(snap.total_order_count, 0);
}

#[test]
fn restore_client_aborts_when_a_stray_order_is_outside_the_batch() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "Carol");
    let a = new_order(&ctx, &client, "A");
    let b = new_order(&ctx, &client, "B");
    let mut conn = ctx.conn();

    trash::delete_client(&mut conn, &client).unwrap();

    // 人为制造批次不一致：把 B 挪到另一个批次（模拟历史/异常数据）。
    conn.execute(
        "UPDATE orders SET deleted_batch = 'legacy-batch' WHERE id = ?1",
        [&b],
    )
    .unwrap();

    let err = trash::restore_client(&mut conn, &client).unwrap_err();
    assert_eq!(err.code, "INTEGRITY", "批次不一致必须中止，而不是扩大范围");
    assert!(err.message.contains("不在本批次内"), "{}", err.message);

    // 什么都没动：客户与两单仍在回收站。
    assert!(batch_of_client(&conn, &client).0.is_some());
    assert!(batch_of_order(&conn, &a).0.is_some());
    assert!(batch_of_order(&conn, &b).0.is_some());
    assert!(orders::list(&conn).unwrap().is_empty());
}

#[test]
fn restore_order_rejected_while_client_in_trash() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "Dave");
    let order = new_order(&ctx, &client, "A");
    let mut conn = ctx.conn();

    trash::delete_client(&mut conn, &client).unwrap();

    let err = trash::restore_order(&mut conn, &order).unwrap_err();
    assert_eq!(err.code, "CONFLICT");
    assert!(err.message.contains("请先恢复所属客户"), "{}", err.message);
    assert!(batch_of_order(&conn, &order).0.is_some(), "被拒后仍是已删除");
}

#[test]
fn restore_is_idempotent() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "Eve");
    let order = new_order(&ctx, &client, "A");
    let mut conn = ctx.conn();

    trash::delete_order(&mut conn, &order).unwrap();
    let first = trash::restore_order(&mut conn, &order).unwrap();
    assert_eq!(first.orders_restored, 1);
    let second = trash::restore_order(&mut conn, &order).unwrap();
    assert_eq!(second.orders_restored, 0, "重复恢复是幂等的");

    trash::delete_client(&mut conn, &client).unwrap();
    assert_eq!(trash::restore_client(&mut conn, &client).unwrap().clients_restored, 1);
    let again = trash::restore_client(&mut conn, &client).unwrap();
    assert_eq!(again.clients_restored, 0);
    assert_eq!(again.orders_restored, 0);
}

#[test]
fn history_stages_tags_and_attachments_survive_delete_and_restore() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "Frank");
    let order = new_order(&ctx, &client, "带历史");
    let mut conn = ctx.conn();

    // 开工产生历史事件；打标签；挂一条附件记录。
    let view = orders::load(&conn, &order).unwrap();
    lifecycle::start_work(&mut conn, common::lifecycle_input(&view)).unwrap();
    let tag = clients::create_tag(&conn, "常客").unwrap();
    clients::link_tag(&conn, &client, &tag.id).unwrap();
    conn.execute(
        "INSERT INTO attachments (id, order_id, original_name, rel_path, thumb_rel_path,
                                  mime_type, byte_size, sha256, state, created_at)
         VALUES ('a-1', ?1, 'x.png', 'attachments/originals/x.png',
                 'attachments/thumbs/x.webp', 'image/png', 10, 'aa', 'ok',
                 '2026-11-20T00:00:00+08:00')",
        [&order],
    )
    .unwrap();

    let events_before = count(&conn, "SELECT COUNT(*) FROM order_events WHERE order_id = ?1", &order);
    let stages_before = count(&conn, "SELECT COUNT(*) FROM order_stages WHERE order_id = ?1", &order);
    assert!(events_before >= 2 && stages_before >= 1);

    trash::delete_client(&mut conn, &client).unwrap();

    // 删除期间：历史与附件照旧，只是业务面看不到。
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM order_events WHERE order_id = ?1", &order), events_before);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM order_stages WHERE order_id = ?1", &order), stages_before);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM attachments WHERE order_id = ?1", &order), 1);
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM client_tag_link WHERE client_id = ?1", &client),
        1,
        "回收站期间标签关联保留"
    );

    trash::restore_client(&mut conn, &client).unwrap();

    assert_eq!(count(&conn, "SELECT COUNT(*) FROM order_events WHERE order_id = ?1", &order), events_before);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM order_stages WHERE order_id = ?1", &order), stages_before);
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM client_tag_link WHERE client_id = ?1", &client),
        1,
        "恢复后标签天然复原"
    );
    let tags = clients::tags_of(&conn, &client).unwrap();
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0].name, "常客");
    assert!(
        conn.query_row("SELECT COUNT(*) FROM client_tags", [], |r| r.get::<_, i64>(0)).unwrap() >= 1,
        "标签本身不因客户删除而消失"
    );
}

#[test]
fn trashed_order_cannot_be_deleted_again() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "Gina");
    let order = new_order(&ctx, &client, "A");
    let mut conn = ctx.conn();

    trash::delete_order(&mut conn, &order).unwrap();
    let err = trash::delete_order(&mut conn, &order).unwrap_err();
    assert_eq!(err.code, "CONFLICT", "可见性守卫先拦下");
    assert!(err.message.contains("回收站"), "{}", err.message);

    // 客户本身仍有效，因此删客户是合法的：已删除的那单会被并入客户组。
    let deleted = trash::delete_client(&mut conn, &client).unwrap();
    assert_eq!(deleted.orders_trashed, 0, "没有新的订单需要删除");
    assert_eq!(deleted.orders_already_trashed, 1, "已删除的订单被并入本批");
    let (_, client_batch) = batch_of_client(&conn, &client);
    let (_, order_batch) = batch_of_order(&conn, &order);
    assert_eq!(order_batch, client_batch, "批次必须与客户一致");
}

#[test]
fn snapshot_counts_are_three_separate_metrics() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "有组");
    let _a = new_order(&ctx, &client, "组内 1");
    let _b = new_order(&ctx, &client, "组内 2");

    let other = new_client(&ctx, "另一个人");
    let loose = new_order(&ctx, &other, "独立");
    let mut conn = ctx.conn();

    trash::delete_client(&mut conn, &client).unwrap();
    trash::delete_order(&mut conn, &loose).unwrap();

    let snap = trash::snapshot(&conn).unwrap();
    assert_eq!(snap.group_count, 1);
    assert_eq!(snap.loose_order_count, 1);
    assert_eq!(snap.total_order_count, 3, "总数含组内订单");

    let listed = snap.groups.iter().map(|g| g.orders.len()).sum::<usize>() + snap.loose_orders.len();
    assert_eq!(listed as i64, snap.total_order_count, "页头与列表同源");
}

#[test]
fn snapshot_work_state_follows_lifecycle_rule() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "状态");
    let queued = new_order(&ctx, &client, "排队");
    let running = new_order(&ctx, &client, "制作");

    {
        let mut conn = ctx.conn();
        let view = orders::load(&conn, &running).unwrap();
        lifecycle::start_work(&mut conn, common::lifecycle_input(&view)).unwrap();
    }

    let mut conn = ctx.conn();
    trash::delete_client(&mut conn, &client).unwrap();

    // 已完成/已取消：直接用 SQL 造终态（本用例只验证展示口径）。
    // 终态有 CHECK 约束：(status='complete') = (completed_at IS NOT NULL)。
    conn.execute(
        "UPDATE orders SET status = 'complete', completed_at = '2026-11-20T00:00:00+08:00'
          WHERE id = ?1",
        [&queued],
    )
    .unwrap();

    let snap = trash::snapshot(&conn).unwrap();
    let states: Vec<(String, String)> = snap.groups[0]
        .orders
        .iter()
        .map(|o| (o.title.clone(), format!("{:?}", o.work_state)))
        .collect();

    let find = |title: &str| {
        states
            .iter()
            .find(|(t, _)| t == title)
            .map(|(_, s)| s.clone())
            .unwrap()
    };
    assert_eq!(find("制作"), "InProgress");
    assert_eq!(find("排队"), "Completed", "status 覆盖 started_at");
}

#[test]
fn snapshot_does_not_use_per_row_queries() {
    // `rusqlite` 未启用 `trace` feature，无法直接统计语句数；改为对实现做结构性断言：
    // snapshot 只能有两条 `prepare`，且不得调用按行的 `load_facts` / `orders::load`。
    let source = include_str!("../src/domain/trash.rs");
    let start = source.find("pub fn snapshot").expect("snapshot 必须存在");
    let end = source
        .find("pub fn client_delete_impact")
        .expect("client_delete_impact 必须紧随其后");
    let body = &source[start..end];

    assert_eq!(
        body.matches(".prepare(").count(),
        2,
        "回收站读取应只有两条查询（客户组 / 独立订单）"
    );
    assert!(
        !body.contains("load_facts(") && !body.contains("orders::load("),
        "不得对每一行单独查生命周期事实（N+1）"
    );
}

#[test]
fn deleting_client_without_orders_still_works() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "空客户");
    let mut conn = ctx.conn();

    let impact = trash::client_delete_impact(&conn, &client).unwrap();
    assert_eq!(impact.order_count, 0);
    let deleted = trash::delete_client(&mut conn, &client).unwrap();
    assert_eq!(deleted.orders_trashed, 0);

    let snap = trash::snapshot(&conn).unwrap();
    assert_eq!(snap.group_count, 1, "没有订单的客户也要出现在回收站");
    assert_eq!(snap.groups[0].orders.len(), 0);
    assert_eq!(snap.total_order_count, 0);
}
