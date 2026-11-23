//! schema v8：回收站软删除字段 + 三个可见性视图。
//!
//! 全部在 tempfile 里演练，不触碰真实库。覆盖：
//! - v7 → v8 升级后数据一条不少、内容不变；
//! - 四个新列存在，两个部分索引的 WHERE 条件正确；
//! - 三个视图可查，且**视图列数与基表一致**（守住 `SELECT *` 列冻结）；
//! - 视图语义：visible 只含有效行、trashed 只含已删除行；
//! - 迁移表连续，v1–v7 的名字未被改写；
//! - 迁移失败时旧代际、活动指针与数据都不受影响；
//! - 重复启动不重复迁移。

mod common;

use std::path::Path;

use minidesk::error::AppResult;
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
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

fn count(conn: &rusqlite::Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

fn insert_client(conn: &rusqlite::Connection, id: &str, name: &str) {
    conn.execute(
        "INSERT INTO clients (id, display_name, revision, created_at, updated_at)
         VALUES (?1, ?2, 0, '2026-11-20T10:00:00+08:00', '2026-11-20T10:00:00+08:00')",
        rusqlite::params![id, name],
    )
    .unwrap();
}

fn apply_broken_v8(tx: &rusqlite::Transaction<'_>) -> AppResult<()> {
    tx.execute_batch("ALTER TABLE orders ADD COLUMN broken_marker TEXT;")?;
    // 故意引用不存在的列，让整步迁移失败。
    tx.execute_batch("UPDATE orders SET no_such_column = 1;")?;
    Ok(())
}

#[test]
fn v7_upgrades_to_v8_and_keeps_every_row() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");

    let order_id = {
        let env = open_at(&root, 7);
        assert_eq!(user_version(&env), 7);
        let mut conn = env.open_db().unwrap();
        let oid = common::insert_order(&mut conn, "AF-2026-0101", "v7 老库订单");
        insert_client(&conn, "c-legacy-1", "老客户");
        oid
    };

    // 显式停在 v8：这是 v8 的历史断言，后续版本由各自的迁移测试覆盖。
    let env = open_at(&root, 8);
    assert!(migrations::APP_SCHEMA_VERSION >= 8);
    assert_eq!(user_version(&env), 8);
    let conn = env.open_db().unwrap();

    // 1) 四个新列存在且默认 NULL。
    for table in ["orders", "clients"] {
        let cols = column_names(&conn, table);
        assert!(cols.contains(&"deleted_at".to_string()), "{table}: {cols:?}");
        assert!(
            cols.contains(&"deleted_batch".to_string()),
            "{table}: {cols:?}"
        );
    }
    let (at, batch): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT deleted_at, deleted_batch FROM orders WHERE id = ?1",
            [&order_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(at.is_none() && batch.is_none(), "老数据必须落在有效侧");

    // 2) 原有内容不变。
    let (code, title): (String, String) = conn
        .query_row(
            "SELECT code, title FROM orders WHERE id = ?1",
            [&order_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(code, "AF-2026-0101");
    assert_eq!(title, "v7 老库订单");
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM clients"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM order_stages"), 1);

    // 3) 两个部分索引，条件必须落在「已删除」侧。
    for idx in ["idx_orders_deleted", "idx_clients_deleted"] {
        let sql = object_sql(&conn, idx).unwrap_or_else(|| panic!("缺少索引 {idx}"));
        assert!(
            sql.to_uppercase().contains("WHERE DELETED_AT IS NOT NULL"),
            "{idx} 必须是部分索引：{sql}"
        );
    }

    // 4) 三个视图可查，且列数与基表一致（列冻结守卫）。
    for (view, base) in [
        ("orders_visible", "orders"),
        ("orders_trashed", "orders"),
        ("clients_visible", "clients"),
    ] {
        let view_cols = column_names(&conn, view);
        assert!(!view_cols.is_empty(), "视图 {view} 应存在且有列");
        let base_cols = column_names(&conn, base);
        assert_eq!(
            view_cols, base_cols,
            "{view} 的列必须与 {base} 完全一致；给 {base} 加列后记得重建视图"
        );
    }

    // 5) 未删除时，visible 与基表行数相同。
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders_visible"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders_trashed"), 0);
}

#[test]
fn views_split_visible_and_trashed_by_deleted_at() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let mut conn = env.open_db().unwrap();

    let kept = common::insert_order(&mut conn, "AF-2026-0102", "保留");
    let dropped = common::insert_order(&mut conn, "AF-2026-0103", "进回收站");
    insert_client(&conn, "c-live", "有效客户");
    insert_client(&conn, "c-gone", "已删客户");

    conn.execute(
        "UPDATE orders SET deleted_at = '2026-11-20T12:00:00+08:00', deleted_batch = 'b-1'
         WHERE id = ?1",
        [&dropped],
    )
    .unwrap();
    conn.execute(
        "UPDATE clients SET deleted_at = '2026-11-20T12:00:00+08:00', deleted_batch = 'b-1'
         WHERE id = 'c-gone'",
        [],
    )
    .unwrap();

    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 2);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders_visible"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders_trashed"), 1);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM clients"), 2);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM clients_visible"), 1);

    let visible_id: String = conn
        .query_row("SELECT id FROM orders_visible", [], |r| r.get(0))
        .unwrap();
    assert_eq!(visible_id, kept, "visible 必须只含未删除订单");
    let trashed_id: String = conn
        .query_row("SELECT id FROM orders_trashed", [], |r| r.get(0))
        .unwrap();
    assert_eq!(trashed_id, dropped);
}

#[test]
fn production_migration_list_is_contiguous_and_old_names_unchanged() {
    let list = migrations::production();
    let versions: Vec<i64> = list.iter().map(|m| m.version).collect();
    let latest = migrations::APP_SCHEMA_VERSION;
    assert_eq!(
        versions,
        (1..=latest).collect::<Vec<_>>(),
        "版本必须从 1 连续"
    );
    let names: Vec<&str> = list.iter().map(|m| m.name).collect();
    assert_eq!(
        &names[..7],
        &[
            "v1_initial",
            "v2_queue_and_events",
            "v3_attachment_jobs",
            "v4_source_and_gallery_and_tags",
            "v5_gallery_visibility_trigger",
            "v6_reschedule_events",
            "v7_stage_skipped_events",
        ],
        "v1–v7 的名字不得被改写"
    );
    assert_eq!(names[7], "v8_soft_delete_and_visibility_views");
}

#[test]
fn failed_v8_migration_leaves_old_generation_and_data_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");

    let (generation, order_id) = {
        let env = open_at(&root, 7);
        let mut conn = env.open_db().unwrap();
        let id = common::insert_order(&mut conn, "AF-2026-0104", "迁移会失败");
        (env.active_generation().to_string(), id)
    };

    let mut broken = migrations::production();
    for step in broken.iter_mut() {
        if step.version == 8 {
            step.apply = apply_broken_v8;
        }
    }
    let failed = Environment::open_with(&root, &broken, 8, Some(common::tz()));
    assert!(failed.is_err(), "坏迁移必须返回错误");

    // 旧代际仍停在 v7，指针未切换，数据完整，视图未被创建。
    let env = Environment::open_with(&root, &migrations::production(), 7, Some(common::tz()))
        .expect("旧库必须仍能打开");
    assert_eq!(user_version(&env), 7, "失败后结构版本不得前进");
    assert_eq!(env.active_generation(), generation, "活动指针不得切换");
    let conn = env.open_db().unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 1);
    let cols = column_names(&conn, "orders");
    assert!(!cols.contains(&"deleted_at".to_string()), "失败不该留下半截列");
    assert!(object_sql(&conn, "orders_visible").is_none(), "失败不该留下视图");
    drop(conn);
    drop(env);

    // 换回正常迁移表仍可升级到 v8。
    let env = open_at(&root, 8);
    assert_eq!(user_version(&env), 8);
    let conn = env.open_db().unwrap();
    let (code, deleted): (String, Option<String>) = conn
        .query_row(
            "SELECT code, deleted_at FROM orders WHERE id = ?1",
            [&order_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(code, "AF-2026-0104");
    assert!(deleted.is_none());
}

#[test]
fn reopening_a_v8_database_does_not_migrate_again() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");

    let generation = {
        let env = open_at(&root, 8);
        assert_eq!(user_version(&env), 8);
        let mut conn = env.open_db().unwrap();
        common::insert_order(&mut conn, "AF-2026-0105", "重复启动");
        env.active_generation().to_string()
    };

    let env = open_at(&root, 8);
    assert_eq!(user_version(&env), 8);
    assert_eq!(env.active_generation(), generation, "已是最新版本时不得新建代际");
    let conn = env.open_db().unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 1);
}
