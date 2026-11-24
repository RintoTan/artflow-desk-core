//! FIN-01.1：v11 的约束补强。
//!
//! 这里验的不是「能不能写」，而是**不能写的东西会不会被数据库自己挡住**：
//! - `INTEGER` 是亲和性，不是约束；`STRICT` 才是；
//! - 两个外键各自有效，不代表它们指向同一张订单；
//! - `GLOB` 只认形状，`2026-02-31` 在 SQLite 里会被归一化成 3 月 3 日。
//!
//! 另外验一条**失败安全**：三张表非空时，v11 必须整步中止，且一行数据都不动。

mod common;

use std::path::Path;

use common::Ctx;
use minidesk::store::environment::Environment;
use minidesk::store::migrations;
use rusqlite::{params, Connection};

fn open_at(root: &Path, target: i64) -> Environment {
    Environment::open_with(root, &migrations::production(), target, Some(common::tz()))
        .expect("建环境失败")
}

fn user_version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

fn object_sql(conn: &Connection, name: &str) -> Option<String> {
    conn.query_row("SELECT sql FROM sqlite_master WHERE name = ?1", [name], |r| {
        r.get(0)
    })
    .ok()
}

fn platform(conn: &Connection, id: &str, name: &str, rate: Option<i64>) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO payment_platforms (id, name, fee_rate_bp, created_at, updated_at)
         VALUES (?1, ?2, ?3, '2026-11-01T00:00:00Z', '2026-11-10T00:00:00Z')",
        params![id, name, rate],
    )
}

fn schedule(conn: &Connection, id: &str, order_id: &str, amount: i64) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO payment_schedules (id, order_id, kind, amount_cents, created_at)
         VALUES (?1, ?2, 'deposit', ?3, '2026-11-01T00:00:00Z')",
        params![id, order_id, amount],
    )
}

fn record(conn: &Connection, id: &str, order_id: &str, schedule_id: Option<&str>) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO payment_records
           (id, order_id, schedule_id, kind, amount_cents, received_on, fee_cents, created_at)
         VALUES (?1, ?2, ?3, 'deposit', 100, '2026-11-24', 0, '2026-11-24T00:00:00Z')",
        params![id, order_id, schedule_id],
    )
}

// ------------------------------------------------------------ A. 升级与结构

#[test]
fn v10_upgrades_to_v11_and_rebuilds_with_strict_and_triggers() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    {
        let env = open_at(&root, 10);
        assert_eq!(user_version(&env.open_db().unwrap()), 10);
    }

    let env = common::open(&root);
    let conn = env.open_db().unwrap();
    assert_eq!(user_version(&conn), migrations::APP_SCHEMA_VERSION);

    for table in ["payment_platforms", "payment_schedules", "payment_records"] {
        let sql = object_sql(&conn, table).unwrap_or_else(|| panic!("缺少表 {table}"));
        assert!(sql.contains("STRICT"), "{table} 必须是 STRICT 表：{sql}");
        assert!(sql.contains("NOT NULL PRIMARY KEY"), "{table} 主键必须显式 NOT NULL：{sql}");
    }

    for trigger in [
        "payment_records_same_order_insert",
        "payment_records_same_order_update",
        "payment_schedules_order_update",
    ] {
        assert!(object_sql(&conn, trigger).is_some(), "缺少触发器 {trigger}");
    }
    for index in [
        "payment_platforms_name",
        "payment_schedules_order",
        "payment_records_order",
        "payment_records_schedule",
        "payment_records_received",
    ] {
        assert!(object_sql(&conn, index).is_some(), "缺少索引 {index}");
    }

    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
    assert_eq!(integrity, "ok");
}

#[test]
fn strict_tables_reject_real_numbers_and_null_keys() {
    let ctx = Ctx::new();
    let order = ctx.create_order("STRICT");
    let conn = ctx.conn();

    // INTEGER 列不再接受 REAL：亲和性会存成 1.5，STRICT 直接拒。
    assert!(conn
        .execute(
            "INSERT INTO payment_schedules (id, order_id, kind, amount_cents, created_at)
             VALUES ('s', ?1, 'deposit', 1.5, 'x')",
            [&order],
        )
        .is_err(), "金额必须是整数分");
    assert!(conn
        .execute(
            "INSERT INTO payment_platforms (id, name, fee_rate_bp, created_at, updated_at)
             VALUES ('p', '米画师', 5.5, 'x', 'x')",
            [],
        )
        .is_err(), "费率必须是整数基点");
    // 主键不能为 NULL（普通 rowid 表的历史行为，STRICT + NOT NULL 才拦住）。
    assert!(conn
        .execute(
            "INSERT INTO payment_platforms (id, name, created_at, updated_at)
             VALUES (NULL, '无 id', 'x', 'x')",
            [],
        )
        .is_err(), "主键不能为 NULL");
}

// ------------------------------------------------------ B. 空表断言（失败安全）

#[test]
fn migration_aborts_when_platforms_are_not_empty() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    {
        let env = open_at(&root, 10);
        let conn = env.open_db().unwrap();
        platform(&conn, "p-1", "米画师", Some(500)).unwrap();
    }
    assert_abort_keeps_v10(&root, "payment_platforms");
}

#[test]
fn migration_aborts_when_schedules_are_not_empty() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    {
        let env = open_at(&root, 10);
        let mut conn = env.open_db().unwrap();
        let order = common::insert_order(&mut conn, "AF-2026-0402", "v10 订单");
        schedule(&conn, "s-1", &order, 300).unwrap();
    }
    assert_abort_keeps_v10(&root, "payment_schedules");
}

#[test]
fn migration_aborts_when_records_are_not_empty() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    {
        let env = open_at(&root, 10);
        let mut conn = env.open_db().unwrap();
        let order = common::insert_order(&mut conn, "AF-2026-0403", "v10 订单");
        record(&conn, "r-1", &order, None).unwrap();
    }
    assert_abort_keeps_v10(&root, "payment_records");
}

/// 中止后：版本仍 v10、表还在、数据还在、完整性没坏。
fn assert_abort_keeps_v10(root: &Path, table: &str) {
    let env = open_at_root(root);
    let mut conn = env.open_db().unwrap();
    let rows_before = count(&conn, &format!("SELECT COUNT(*) FROM {table}"));

    let err = migrations::migrate_to(&mut conn, &migrations::production(), 11)
        .expect_err("非空表必须让 v11 中止");
    assert!(
        err.message.contains(table),
        "错误信息应指出是哪张表非空，实际：{}",
        err.message
    );

    assert_eq!(user_version(&conn), 10, "中止后版本必须停在 v10");
    assert_eq!(
        count(&conn, &format!("SELECT COUNT(*) FROM {table}")),
        rows_before,
        "中止后数据行必须原样保留"
    );
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
    assert_eq!(integrity, "ok");
    let fk = conn
        .prepare("PRAGMA foreign_key_check")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .count();
    assert_eq!(fk, 0);
}

fn open_at_root(root: &Path) -> Environment {
    Environment::open_with(root, &migrations::production(), 10, Some(common::tz()))
        .expect("重开 v10 环境失败")
}

// ---------------------------------------------------------- C. 跨订单关联

#[test]
fn cross_order_schedule_link_is_rejected_both_ways() {
    let ctx = Ctx::new();
    let first = ctx.create_order("订单一");
    let second = ctx.create_order("订单二");
    let conn = ctx.conn();

    schedule(&conn, "s-second", &second, 300).unwrap();

    // 1) 同订单：通过。
    record(&conn, "r-ok", &second, Some("s-second")).unwrap();
    // 2) 跨订单 INSERT：拒绝。
    let err = record(&conn, "r-bad", &first, Some("s-second")).unwrap_err();
    assert!(err.to_string().contains("不属于同一订单"), "{err}");
    // 3) 跨订单 UPDATE：拒绝。
    record(&conn, "r-own", &first, None).unwrap();
    let err = conn
        .execute("UPDATE payment_records SET schedule_id = 's-second' WHERE id = 'r-own'", [])
        .unwrap_err();
    assert!(err.to_string().contains("不属于同一订单"), "{err}");
    // 4) 改流水所属订单：拒绝。
    let err = conn
        .execute("UPDATE payment_records SET order_id = ?1 WHERE id = 'r-ok'", [&first])
        .unwrap_err();
    assert!(err.to_string().contains("不属于同一订单"), "{err}");
    // 5) 已挂流水的计划不能改挂到别的订单。
    let err = conn
        .execute("UPDATE payment_schedules SET order_id = ?1 WHERE id = 's-second'", [&first])
        .unwrap_err();
    assert!(err.to_string().contains("不能改挂到其他订单"), "{err}");
}

#[test]
fn deleting_a_schedule_keeps_the_payment_and_clears_only_the_link() {
    let ctx = Ctx::new();
    let order = ctx.create_order("删计划");
    let conn = ctx.conn();

    schedule(&conn, "s-1", &order, 300).unwrap();
    record(&conn, "r-1", &order, Some("s-1")).unwrap();
    conn.execute(
        "UPDATE payment_records SET amount_cents = 250, fee_cents = 5 WHERE id = 'r-1'",
        [],
    )
    .unwrap();

    conn.execute("DELETE FROM payment_schedules WHERE id = 's-1'", []).unwrap();

    let (schedule_id, order_id, amount, fee, received): (
        Option<String>,
        String,
        i64,
        i64,
        String,
    ) = conn
        .query_row(
            "SELECT schedule_id, order_id, amount_cents, fee_cents, received_on
             FROM payment_records WHERE id = 'r-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .unwrap();
    assert_eq!(schedule_id, None, "计划没了，关联置空");
    assert_eq!(order_id, order, "流水必须仍属于原订单");
    assert_eq!((amount, fee, received.as_str()), (250, 5, "2026-11-24"));
}

#[test]
fn a_schedule_without_payments_can_still_move_to_another_order() {
    let ctx = Ctx::new();
    let first = ctx.create_order("订单一");
    let second = ctx.create_order("订单二");
    let conn = ctx.conn();

    schedule(&conn, "s-free", &first, 300).unwrap();
    conn.execute("UPDATE payment_schedules SET order_id = ?1 WHERE id = 's-free'", [&second])
        .expect("没挂流水的计划可以改挂");
}

// ------------------------------------------------------------- D. 日期真实性

#[test]
fn dates_must_exist_not_just_look_right() {
    let ctx = Ctx::new();
    let order = ctx.create_order("日期");
    let conn = ctx.conn();

    // 形状对但日期不存在：SQLite 会把 2026-02-31 归一化成 3 月 3 日，靠回读比較抓住。
    assert!(conn
        .execute(
            "INSERT INTO payment_schedules (id, order_id, kind, amount_cents, expected_date, created_at)
             VALUES ('s-1', ?1, 'deposit', 100, '2026-02-31', 'x')",
            [&order],
        )
        .is_err(), "2 月 31 日必须拒绝");
    assert!(conn
        .execute(
            "INSERT INTO payment_schedules (id, order_id, kind, amount_cents, expected_date, created_at)
             VALUES ('s-2', ?1, 'deposit', 100, '2026-13-01', 'x')",
            [&order],
        )
        .is_err(), "13 月必须拒绝");
    assert!(conn
        .execute(
            "INSERT INTO payment_records
               (id, order_id, kind, amount_cents, received_on, fee_cents, created_at)
             VALUES ('r-1', ?1, 'deposit', 100, '2026-02-30', 0, 'x')",
            [&order],
        )
        .is_err(), "到账日期同样要真实存在");

    // 合法日期与 NULL 计划日期都要能进。
    schedule(&conn, "s-ok", &order, 100).unwrap();
    conn.execute("UPDATE payment_schedules SET expected_date = '2026-02-28' WHERE id = 's-ok'", [])
        .unwrap();
    conn.execute("UPDATE payment_schedules SET expected_date = NULL WHERE id = 's-ok'", [])
        .unwrap();
}

// --------------------------------------------------------- E. 平台名称与快照

#[test]
fn platform_names_must_be_trimmed_and_snapshots_are_required() {
    let ctx = Ctx::new();
    let order = ctx.create_order("平台");
    let conn = ctx.conn();

    assert!(platform(&conn, "p-1", " 米画师 ", Some(500)).is_err(), "首尾空格必须拒绝");
    assert!(platform(&conn, "p-2", "", None).is_err(), "空名称必须拒绝");
    platform(&conn, "p-3", "米画师", Some(500)).unwrap();

    // 关联了平台就必须有名称快照。
    assert!(conn
        .execute(
            "INSERT INTO payment_records
               (id, order_id, kind, amount_cents, received_on, platform_id, fee_cents, created_at)
             VALUES ('r-1', ?1, 'deposit', 100, '2026-11-24', 'p-3', 0, 'x')",
            [&order],
        )
        .is_err(), "有 platform_id 就必须写 platform_name");

    conn.execute(
        "INSERT INTO payment_records
           (id, order_id, kind, amount_cents, received_on, platform_id, platform_name,
            fee_rate_bp, fee_cents, created_at)
         VALUES ('r-2', ?1, 'deposit', 100, '2026-11-24', 'p-3', '米画师', 500, 5, 'x')",
        [&order],
    )
    .unwrap();

    // 删平台：id 置空，快照保留。
    conn.execute("DELETE FROM payment_platforms WHERE id = 'p-3'", []).unwrap();
    let (pid, name): (Option<String>, Option<String>) = conn
        .query_row("SELECT platform_id, platform_name FROM payment_records WHERE id = 'r-2'", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(pid, None);
    assert_eq!(name.as_deref(), Some("米画师"));
}

// ------------------------------------------------------------- F. 索引与计划

#[test]
fn query_plans_actually_use_the_new_indexes() {
    let ctx = Ctx::new();
    let conn = ctx.conn();

    let by_schedule: String = conn
        .query_row(
            "EXPLAIN QUERY PLAN
             SELECT SUM(amount_cents) FROM payment_records WHERE schedule_id = 'x'",
            [],
            |r| r.get(3),
        )
        .unwrap();
    assert!(
        by_schedule.contains("payment_records_schedule"),
        "按计划聚合应命中 payment_records_schedule：{by_schedule}"
    );

    let by_date: String = conn
        .query_row(
            "EXPLAIN QUERY PLAN
             SELECT SUM(amount_cents) FROM payment_records
              WHERE received_on >= '2026-11-01' AND received_on < '2026-12-01'",
            [],
            |r| r.get(3),
        )
        .unwrap();
    assert!(
        by_date.contains("payment_records_received"),
        "按到账月扫描应命中 payment_records_received：{by_date}"
    );
}
