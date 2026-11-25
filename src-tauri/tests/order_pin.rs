//! ORDER-UX-01A：订单置顶。
//!
//! 三件事必须同时成立，缺一条置顶就会变成"看不见的账"：
//! 1. **有效判据**只有一个（`PIN_EFFECTIVE_SQL`），数量上限与展示分组都用它；
//! 2. **生命周期清理**覆盖每一条会让订单离开"活动且未归档"的路径；
//! 3. **队列边界**在后端拦住跨组拖拽，不依赖前端禁用把手。
//!
//! 第 2 条尤其容易漏：完成、取消、归档、进回收站、恢复——每一条都是独立的写入分支，
//! 所以下面每条路径都有单独断言，不用一个"综合生命周期"测试糊过去。

mod common;

use minidesk::domain::lifecycle;
use minidesk::domain::orders::{self, OrderView, MAX_PINNED};
use minidesk::domain::queue::{self, MoveInput};
use minidesk::domain::trash;
use minidesk::store::environment::Environment;
use minidesk::store::migrations;

fn db(env: &Environment) -> rusqlite::Connection {
    env.open_db().expect("打开数据库失败")
}

fn make_order(env: &Environment, code: &str, title: &str) -> String {
    let mut conn = db(env);
    common::insert_order(&mut conn, code, title)
}

fn view(env: &Environment, id: &str) -> OrderView {
    orders::load(&db(env), id).expect("读取订单失败")
}

/// 置顶字段的原始值：回收站里的订单读不到 `orders_visible`，只能查基表。
fn raw_pin(env: &Environment, id: &str) -> Option<String> {
    db(env)
        .query_row("SELECT pinned_at FROM orders WHERE id = ?1", [id], |r| {
            r.get(0)
        })
        .expect("读取 pinned_at 失败")
}

/// 明确排定队列位置，避免 `insert_order` 默认都为 0 时按编号碰运气。
fn place(env: &Environment, ids: &[&str]) {
    let conn = db(env);
    let owned: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
    queue::renumber(&conn, &owned).expect("写入队列位置失败");
}

fn queue_revision(env: &Environment) -> i64 {
    queue::revision(&db(env)).expect("读取队列版本失败")
}

fn start(env: &Environment, id: &str) {
    let v = view(env, id);
    let mut conn = db(env);
    lifecycle::start_work(&mut conn, common::lifecycle_input(&v)).expect("开工失败");
}

fn complete(env: &Environment, id: &str) {
    start(env, id);
    let v = view(env, id);
    assert!(v.capabilities.can_complete, "单阶段订单开工后应当可以直接完成");
    let mut conn = db(env);
    lifecycle::complete_order(&mut conn, common::lifecycle_input(&v)).expect("完成失败");
}

// ============================================================ 迁移

#[test]
fn v12_database_upgrades_to_v13_with_pinned_at_visible_in_both_views() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    {
        // 先停在 v12，模拟"上一个版本留下的库"。
        let _old = Environment::open_with(&root, &migrations::production(), 12, Some(common::tz()))
            .unwrap();
    }

    let env = common::open(&root);
    assert_eq!(env.outcome().schema_version, migrations::APP_SCHEMA_VERSION);
    assert_eq!(env.outcome().upgraded_from, Some(12));

    let conn = db(&env);
    let base = columns(&conn, "orders");
    assert!(base.contains(&"pinned_at".to_string()), "基表应当有 pinned_at");

    for name in ["orders_visible", "orders_trashed"] {
        let cols = columns(&conn, name);
        assert!(
            cols.contains(&"pinned_at".to_string()),
            "{name} 必须能读到 pinned_at（视图列冻结）"
        );
        assert_eq!(cols, base, "{name} 的列必须与基表完全一致");
    }
}

fn columns(conn: &rusqlite::Connection, table: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .unwrap();
    stmt.query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

#[test]
fn indexes_survive_the_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let conn = db(&env);
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='idx_orders_pinned'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "置顶部分索引应当存在");
}

// ============================================================ 基本行为

#[test]
fn new_orders_are_not_pinned() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let id = make_order(&env, "AF-2026-9001", "新单");
    assert!(view(&env, &id).pinned_at.is_none());
}

#[test]
fn pin_then_unpin_round_trips_without_touching_queue_or_revision() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let id = make_order(&env, "AF-2026-9002", "置顶单");
    let before = view(&env, &id);

    let mut conn = db(&env);
    let pinned = orders::pin(&mut conn, &id).expect("置顶应当成功");
    assert!(pinned.pinned_at.is_some());
    assert_eq!(pinned.queue_position, before.queue_position, "置顶不动队列位置");
    assert_eq!(pinned.revision, before.revision, "置顶不是内容修改，不该动 revision");

    let unpinned = orders::unpin(&mut conn, &id).expect("取消置顶应当成功");
    assert!(unpinned.pinned_at.is_none());
    assert_eq!(unpinned.queue_position, before.queue_position);
}

#[test]
fn pinning_twice_is_idempotent_and_keeps_the_original_timestamp() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let id = make_order(&env, "AF-2026-9003", "重复置顶");
    let mut conn = db(&env);

    let first = orders::pin(&mut conn, &id).unwrap().pinned_at;
    let second = orders::pin(&mut conn, &id).unwrap().pinned_at;
    assert_eq!(first, second, "已置顶时不该刷新时间，也不该消耗第二个名额");
}

#[test]
fn five_pins_succeed_and_the_sixth_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let ids: Vec<String> = (0..6)
        .map(|i| make_order(&env, &format!("AF-2026-91{i:02}"), &format!("第 {i} 单")))
        .collect();

    let mut conn = db(&env);
    for id in ids.iter().take(MAX_PINNED as usize) {
        orders::pin(&mut conn, id).expect("前五个应当成功");
    }
    assert_eq!(orders::pinned_count(&conn).unwrap(), MAX_PINNED);

    let err = orders::pin(&mut conn, &ids[5]).expect_err("第六个必须被拒绝");
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("最多只能置顶 5 个"), "{}", err.message);
    assert!(raw_pin(&env, &ids[5]).is_none(), "被拒绝的订单不该被写入");
    assert_eq!(orders::pinned_count(&conn).unwrap(), MAX_PINNED);
}

#[test]
fn only_active_unarchived_orders_can_be_pinned() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let done = make_order(&env, "AF-2026-9201", "已完成");
    complete(&env, &done);

    let mut conn = db(&env);
    let err = orders::pin(&mut conn, &done).expect_err("终态订单不能置顶");
    assert!(err.message.contains("进行中"), "{}", err.message);
}

/// 手工造一个「已完成却还挂着置顶」的旧行：它不该占名额。
///
/// 这条守的是判据本身，而不是清理语句——清理漏写时，界面与上限都必须还能算对。
#[test]
fn a_stale_pin_on_a_terminal_order_does_not_consume_a_slot() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let ids: Vec<String> = (0..5)
        .map(|i| make_order(&env, &format!("AF-2026-9F{i:02}"), &format!("单 {i}")))
        .collect();

    let mut conn = db(&env);
    for id in ids.iter().take(4) {
        orders::pin(&mut conn, id).unwrap();
    }
    complete(&env, &ids[4]);
    // 绕过清理，直接写一个历史遗留的置顶值。
    db(&env)
        .execute(
            "UPDATE orders SET pinned_at = '2026-11-01T00:00:00+08:00' WHERE id = ?1",
            [&ids[4]],
        )
        .unwrap();

    assert_eq!(orders::pinned_count(&db(&env)).unwrap(), 4, "终态订单不该占名额");

    // 名额还有第 5 个：再找一张新单，应当能置顶。
    let extra = make_order(&env, "AF-2026-9F99", "补位单");
    let mut conn = db(&env);
    orders::pin(&mut conn, &extra).expect("有效置顶只有 4 个，第五个应当成功");
}

// ============================================================ 生命周期清理

#[test]
fn completing_a_pinned_order_clears_the_pin_and_frees_the_slot() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let ids: Vec<String> = (0..6)
        .map(|i| make_order(&env, &format!("AF-2026-92{i:02}"), &format!("单 {i}")))
        .collect();

    let mut conn = db(&env);
    for id in ids.iter().take(5) {
        orders::pin(&mut conn, id).unwrap();
    }
    complete(&env, &ids[0]);
    assert!(view(&env, &ids[0]).pinned_at.is_none(), "完成必须解除置顶");
    assert_eq!(orders::pinned_count(&db(&env)).unwrap(), 4);

    // 名额确实回来了
    let mut conn = db(&env);
    orders::pin(&mut conn, &ids[5]).expect("完成一单后第六个应当能置顶");
}

#[test]
fn cancelling_a_pinned_order_clears_the_pin() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let id = make_order(&env, "AF-2026-9301", "要取消的单");

    let mut conn = db(&env);
    orders::pin(&mut conn, &id).unwrap();
    let v = view(&env, &id);
    lifecycle::cancel_order(&mut conn, common::lifecycle_input(&v)).expect("取消失败");

    assert!(raw_pin(&env, &id).is_none(), "取消必须解除置顶");
}

#[test]
fn archiving_clears_the_pin_and_unarchiving_does_not_bring_it_back() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let id = make_order(&env, "AF-2026-9401", "归档单");
    complete(&env, &id);

    // 归档要求已完成，而完成本身会清置顶——这里直接写一个"历史遗留"的置顶值，
    // 验证归档这条分支自己也会清。
    db(&env)
        .execute(
            "UPDATE orders SET pinned_at = '2026-11-01T00:00:00+08:00' WHERE id = ?1",
            [&id],
        )
        .unwrap();

    let mut conn = db(&env);
    orders::set_archived(&mut conn, &id, true).expect("归档失败");
    assert!(views_archived(&conn, &id).is_some());
    assert!(raw_pin(&env, &id).is_none(), "归档必须解除置顶");

    db(&env)
        .execute(
            "UPDATE orders SET pinned_at = '2026-11-01T00:00:00+08:00' WHERE id = ?1",
            [&id],
        )
        .unwrap();
    orders::set_archived(&mut conn, &id, false).expect("取消归档失败");
    assert!(raw_pin(&env, &id).is_none(), "取消归档不该恢复置顶");
}

fn views_archived(conn: &rusqlite::Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT archived_at FROM orders_visible WHERE id = ?1", [id], |r| {
        r.get(0)
    })
    .unwrap()
}

#[test]
fn moving_to_trash_clears_the_pin() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let id = make_order(&env, "AF-2026-9501", "进回收站");

    let mut conn = db(&env);
    orders::pin(&mut conn, &id).unwrap();
    trash::delete_order(&mut conn, &id).expect("删除失败");

    assert!(raw_pin(&env, &id).is_none(), "进回收站必须解除置顶");
}

#[test]
fn restoring_an_order_leaves_it_unpinned() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let id = make_order(&env, "AF-2026-9601", "恢复单");

    let mut conn = db(&env);
    orders::pin(&mut conn, &id).unwrap();
    trash::delete_order(&mut conn, &id).unwrap();
    trash::restore_order(&mut conn, &id).expect("恢复失败");

    assert!(view(&env, &id).pinned_at.is_none(), "恢复后保持未置顶");
}

#[test]
fn restoring_a_client_leaves_its_orders_unpinned() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let id = make_order(&env, "AF-2026-9701", "客户批次恢复");

    // 挂一个客户，才能走"按客户整批删除/恢复"这条分支。
    let client_id = {
        let conn = db(&env);
        conn.execute(
            "INSERT INTO clients (id, display_name, created_at, updated_at)
             VALUES ('c-pin', '客户甲', '2026-11-01T00:00:00+08:00', '2026-11-01T00:00:00+08:00')",
            [],
        )
        .unwrap();
        conn.execute("UPDATE orders SET client_id = 'c-pin' WHERE id = ?1", [&id])
            .unwrap();
        "c-pin".to_string()
    };

    let mut conn = db(&env);
    orders::pin(&mut conn, &id).unwrap();
    trash::delete_client(&mut conn, &client_id).expect("按客户删除失败");
    assert!(raw_pin(&env, &id).is_none(), "整批删除同样要解除置顶");

    trash::restore_client(&mut conn, &client_id).expect("按客户恢复失败");
    assert!(view(&env, &id).pinned_at.is_none(), "整批恢复后保持未置顶");
}

#[test]
fn reopening_does_not_resurrect_a_stale_pin() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let id = make_order(&env, "AF-2026-9801", "重开单");
    complete(&env, &id);

    // 手工造一个"完成却还挂着置顶"的旧数据，验证重开这条分支自己也会清。
    db(&env)
        .execute(
            "UPDATE orders SET pinned_at = '2026-11-01T00:00:00+08:00' WHERE id = ?1",
            [&id],
        )
        .unwrap();

    let mut conn = db(&env);
    let v = view(&env, &id);
    lifecycle::reopen_order(&mut conn, common::lifecycle_input(&v)).expect("重开失败");

    assert!(raw_pin(&env, &id).is_none(), "重开不恢复原置顶");
}

// ============================================================ 队列边界

#[test]
fn display_order_puts_pinned_orders_first_without_touching_positions() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let a = make_order(&env, "AF-2026-9A01", "甲");
    let b = make_order(&env, "AF-2026-9A02", "乙");
    let c = make_order(&env, "AF-2026-9A03", "丙");
    place(&env, &[&a, &b, &c]);

    let mut conn = db(&env);
    orders::pin(&mut conn, &c).unwrap();

    assert_eq!(queue::display_ids(&conn).unwrap(), vec![c.clone(), a.clone(), b.clone()]);
    // 位置本身没被改写
    assert_eq!(view(&env, &a).queue_position, 0);
    assert_eq!(view(&env, &b).queue_position, 1);
    assert_eq!(view(&env, &c).queue_position, 2);
}

#[test]
fn moving_a_pinned_order_into_the_normal_block_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let a = make_order(&env, "AF-2026-9B01", "甲");
    let b = make_order(&env, "AF-2026-9B02", "乙");
    let c = make_order(&env, "AF-2026-9B03", "丙");
    place(&env, &[&a, &b, &c]);
    orders::pin(&mut db(&env), &c).unwrap();

    let mut conn = db(&env);
    let err = queue::move_order(
        &mut conn,
        MoveInput {
            order_id: c.clone(),
            expected_queue_revision: queue_revision(&env),
            to_index: 2,
        },
    )
    .expect_err("置顶订单不能移到普通组");

    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("不能互相跨越"), "{}", err.message);
    // 拒绝时不能留下任何位置变更
    assert_eq!(view(&env, &a).queue_position, 0);
    assert_eq!(view(&env, &b).queue_position, 1);
    assert_eq!(view(&env, &c).queue_position, 2);
}

#[test]
fn moving_a_normal_order_into_the_pinned_block_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let a = make_order(&env, "AF-2026-9C01", "甲");
    let b = make_order(&env, "AF-2026-9C02", "乙");
    let c = make_order(&env, "AF-2026-9C03", "丙");
    place(&env, &[&a, &b, &c]);
    orders::pin(&mut db(&env), &c).unwrap();

    let mut conn = db(&env);
    let err = queue::move_order(
        &mut conn,
        MoveInput {
            order_id: a.clone(),
            expected_queue_revision: queue_revision(&env),
            to_index: 0,
        },
    )
    .expect_err("普通订单不能挤进置顶组");

    assert_eq!(err.code, "INVALID");
    assert_eq!(view(&env, &c).queue_position, 2, "置顶订单位置不该被动");
}

#[test]
fn moving_within_the_same_group_still_works() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let a = make_order(&env, "AF-2026-9D01", "甲");
    let b = make_order(&env, "AF-2026-9D02", "乙");
    let c = make_order(&env, "AF-2026-9D03", "丙");
    place(&env, &[&a, &b, &c]);
    orders::pin(&mut db(&env), &c).unwrap();

    // 展示顺序 [丙, 甲, 乙]；把甲往后挪一格 → [丙, 乙, 甲]
    let mut conn = db(&env);
    queue::move_order(
        &mut conn,
        MoveInput {
            order_id: a.clone(),
            expected_queue_revision: queue_revision(&env),
            to_index: 2,
        },
    )
    .expect("同组内移动应当允许");

    assert_eq!(
        queue::display_ids(&db(&env)).unwrap(),
        vec![c.clone(), b.clone(), a.clone()]
    );
}

#[test]
fn a_pinned_order_can_move_inside_the_pinned_block() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let a = make_order(&env, "AF-2026-9E01", "甲");
    let b = make_order(&env, "AF-2026-9E02", "乙");
    let c = make_order(&env, "AF-2026-9E03", "丙");
    place(&env, &[&a, &b, &c]);
    // 甲、丙都置顶：展示顺序 [甲, 丙, 乙]
    orders::pin(&mut db(&env), &a).unwrap();
    orders::pin(&mut db(&env), &c).unwrap();
    assert_eq!(
        queue::display_ids(&db(&env)).unwrap(),
        vec![a.clone(), c.clone(), b.clone()]
    );

    let mut conn = db(&env);
    queue::move_order(
        &mut conn,
        MoveInput {
            order_id: a.clone(),
            expected_queue_revision: queue_revision(&env),
            to_index: 1,
        },
    )
    .expect("置顶组内互换应当允许");

    assert_eq!(
        queue::display_ids(&db(&env)).unwrap(),
        vec![c.clone(), a.clone(), b.clone()]
    );
}
