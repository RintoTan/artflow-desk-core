//! schema v9：订单归档字段。
//!
//! 这一版最容易出错的地方不是加列，而是**视图列冻结**：
//! v8 的 `orders_visible` 用 `SELECT *` 建过，只加列不重建视图，
//! 新列在视图里读不到，表现为「归档字段莫名其妙查不到」。
//! 所以这里的第一组断言就是「视图列 == 基表列」。

mod common;

use std::path::Path;

use minidesk::store::environment::Environment;
use minidesk::store::migrations;

fn open_at(root: &Path, target: i64) -> Environment {
    Environment::open_with(root, &migrations::production(), target, Some(common::tz()))
        .expect("建环境失败")
}

fn user_version(env: &Environment) -> i64 {
    let conn = env.open_db().unwrap();
    conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
}

fn column_names(conn: &rusqlite::Connection, object: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({object})"))
        .unwrap();
    stmt.query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

fn object_sql(conn: &rusqlite::Connection, name: &str) -> Option<String> {
    conn.query_row(
        "SELECT sql FROM sqlite_master WHERE name = ?1",
        [name],
        |r| r.get(0),
    )
    .ok()
}

#[test]
fn v8_upgrades_to_v9_and_keeps_every_row() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");

    let order_id = {
        let env = open_at(&root, 8);
        assert_eq!(user_version(&env), 8);
        let mut conn = env.open_db().unwrap();
        common::insert_order(&mut conn, "AF-2026-0201", "v8 老库订单")
    };

    let env = common::open(&root);
    // 老库必须一路升到程序当前支持的最高版本（v10 起不再写死 9）。
    assert_eq!(user_version(&env), migrations::APP_SCHEMA_VERSION);
    let conn = env.open_db().unwrap();

    // 1) 新列存在，老数据落在「未归档」侧。
    let cols = column_names(&conn, "orders");
    assert!(cols.contains(&"archived_at".to_string()), "{cols:?}");
    let archived: Option<String> = conn
        .query_row("SELECT archived_at FROM orders WHERE id = ?1", [&order_id], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(archived.is_none(), "老订单不能被当成已归档");

    // 2) 原有内容不变。
    let (code, title, status): (String, String, String) = conn
        .query_row(
            "SELECT code, title, status FROM orders WHERE id = ?1",
            [&order_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(code, "AF-2026-0201");
    assert_eq!(title, "v8 老库订单");
    assert_eq!(status, "active");

    // 3) 部分索引只覆盖已归档行。
    let sql = object_sql(&conn, "idx_orders_archived").expect("缺少归档索引");
    assert!(
        sql.to_uppercase().contains("WHERE ARCHIVED_AT IS NOT NULL"),
        "{sql}"
    );
}

#[test]
fn views_are_rebuilt_so_the_new_column_is_readable() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let conn = env.open_db().unwrap();

    for view in ["orders_visible", "orders_trashed"] {
        assert_eq!(
            column_names(&conn, view),
            column_names(&conn, "orders"),
            "{view} 的列必须与 orders 完全一致；加列后忘了重建视图就会在这里失败"
        );
    }

    // 能直接通过视图读到 archived_at，而不是只能读基表。
    let value: Option<String> = conn
        .query_row("SELECT archived_at FROM orders_visible LIMIT 1", [], |r| {
            r.get(0)
        })
        .ok()
        .flatten();
    assert!(value.is_none());
}

#[test]
fn archiving_does_not_move_the_row_out_of_the_visible_view() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let mut conn = env.open_db().unwrap();
    let id = common::insert_order(&mut conn, "AF-2026-0202", "归档不是删除");

    conn.execute(
        "UPDATE orders SET archived_at = '2026-11-23T10:00:00Z' WHERE id = ?1",
        [&id],
    )
    .unwrap();

    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM orders_visible", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1,
        "归档订单仍在可见集合里：客户、工作台、日历、统计都还要看见它"
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM orders_trashed", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0,
        "归档不等于进回收站"
    );
}

#[test]
fn migration_list_stays_contiguous() {
    let list = migrations::production();
    let versions: Vec<i64> = list.iter().map(|m| m.version).collect();
    // 版本号必须从 1 连续到程序支持的最高版本——升版时这条跟着走，不用手改数字。
    assert_eq!(versions, (1..=migrations::APP_SCHEMA_VERSION).collect::<Vec<_>>());
    assert_eq!(list.last().unwrap().name, "v12_payment_kind_match");
}
