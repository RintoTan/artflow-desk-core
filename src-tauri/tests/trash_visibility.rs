//! Step 3 回归：Visible 类查询不得看见回收站数据。
//!
//! 这一组用例的价值在于**交叉验证**：客户卡片的「N 单」必须与客户详情列表
//! 条数一致，仪表盘与收入统计必须与订单列表一致。任何一处漏改
//! `orders_visible`，这类断言都会先红，而不是等用户发现「删了还在统计里」。
//!
//! 同时验证 A 类（备份摘要）**没有**被误改——它必须仍能看见回收站。

mod common;

use minidesk::backup::manifest;
use minidesk::domain::{clients, dashboard, export, orders, queue, stats};

fn trash(conn: &rusqlite::Connection, id: &str, batch: &str) {
    conn.execute(
        "UPDATE orders SET deleted_at = '2026-11-20T12:00:00+08:00', deleted_batch = ?2
         WHERE id = ?1",
        rusqlite::params![id, batch],
    )
    .unwrap();
}

fn set_amount(conn: &rusqlite::Connection, id: &str, cents: i64) {
    conn.execute(
        "UPDATE orders SET amount_cents = ?2 WHERE id = ?1",
        rusqlite::params![id, cents],
    )
    .unwrap();
}

struct Fixture {
    live_a: String,
    live_b: String,
    gone: String,
    client_id: String,
    client_gone: String,
}

fn seed(conn: &mut rusqlite::Connection) -> Fixture {
    conn.execute(
        "INSERT INTO clients (id, display_name, revision, created_at, updated_at)
         VALUES ('c-1', '客户一', 0, '2026-11-20T10:00:00+08:00', '2026-11-20T10:00:00+08:00')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO clients (id, display_name, revision, created_at, updated_at)
         VALUES ('c-gone', '被删客户', 0, '2026-11-20T10:00:00+08:00', '2026-11-20T10:00:00+08:00')",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE clients SET deleted_at = '2026-11-20T12:00:00+08:00', deleted_batch = 'c-batch'
         WHERE id = 'c-gone'",
        [],
    )
    .unwrap();

    let live_a = common::insert_order(conn, "AF-2026-0301", "有效 A");
    let live_b = common::insert_order(conn, "AF-2026-0302", "有效 B");
    let gone = common::insert_order(conn, "AF-2026-0303", "已删除 C");

    for id in [&live_a, &live_b, &gone] {
        conn.execute("UPDATE orders SET client_id = 'c-1' WHERE id = ?1", [id])
            .unwrap();
    }
    set_amount(conn, &live_a, 1_000);
    set_amount(conn, &live_b, 2_000);
    set_amount(conn, &gone, 9_000);
    trash(conn, &gone, "b-1");

    Fixture {
        live_a,
        live_b,
        gone,
        client_id: "c-1".into(),
        client_gone: "c-gone".into(),
    }
}

#[test]
fn order_list_hides_trashed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let mut conn = env.open_db().unwrap();
    let f = seed(&mut conn);

    let rows = orders::list(&conn).unwrap();
    assert_eq!(rows.len(), 2, "列表应只剩 2 单");
    let codes: Vec<&str> = rows.iter().map(|o| o.code.as_str()).collect();
    assert!(codes.contains(&"AF-2026-0301") && codes.contains(&"AF-2026-0302"));
    assert!(!codes.contains(&"AF-2026-0303"), "回收站订单不得出现");
    assert!(rows.iter().all(|o| o.id != f.gone));
    let _ = (&f.live_a, &f.live_b);
}

#[test]
fn client_card_count_matches_detail_list() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let mut conn = env.open_db().unwrap();
    let f = seed(&mut conn);

    let detail = clients::detail(&conn, &f.client_id).unwrap();
    assert_eq!(detail.orders.len(), 2, "客户详情只列有效订单");
    assert_eq!(
        detail.client.order_count, 2,
        "卡片数字必须与详情列表一致（子查询也要过滤）"
    );

    let listed = clients::list(&conn).unwrap();
    let card = listed
        .iter()
        .find(|c| c.id == f.client_id)
        .expect("客户应在列表里");
    assert_eq!(card.order_count, 2);

    assert!(
        !listed.iter().any(|c| c.id == f.client_gone),
        "回收站客户不得出现在客户列表"
    );
}

#[test]
fn dashboard_and_stats_exclude_trashed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let mut conn = env.open_db().unwrap();
    seed(&mut conn);

    let m = dashboard::metrics(&conn).unwrap();
    assert_eq!(m.active_total, 2, "仪表盘活动订单应排除回收站");

    let report = stats::report(&conn, stats::StatsRange::ThisMonth).unwrap();
    assert_eq!(
        report.totals.amount_cents, 3_000,
        "收入统计不得计入已删除订单的 9000 分"
    );
    assert_eq!(report.totals.known_orders, 2);
}

#[test]
fn csv_export_and_queue_exclude_trashed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let mut conn = env.open_db().unwrap();
    seed(&mut conn);

    let rows = export::collect_orders(&conn, &[], false).unwrap();
    assert_eq!(rows.len(), 2, "CSV 默认导出排除已删除");
    assert!(!rows.iter().any(|r| r.code == "AF-2026-0303"));

    let q = queue::list(&conn).unwrap();
    assert_eq!(q.len(), 2, "队列不得包含回收站订单");
    assert!(!q.iter().any(|e| e.code == "AF-2026-0303"));
}

#[test]
fn backup_summary_still_counts_trashed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let mut conn = env.open_db().unwrap();
    seed(&mut conn);

    let summary = manifest::summarize(&conn).unwrap();
    assert_eq!(
        summary.orders, 3,
        "A 类备份摘要必须包含回收站，否则恢复后数据不完整"
    );
    assert_eq!(summary.clients, 2, "客户同理");
}
