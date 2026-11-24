//! FIN-01：财务三表（schema v10）。
//!
//! 这一批只验地基，不验业务：
//! - 迁移从 v9 升到 v10 时旧数据一个字节都不许动，而且**不生成任何历史流水**；
//! - 约束必须落在数据库层，不能只在将来的应用层兜底；
//! - 「未配置费率」与「明确 0%」必须可区分——这是本批最容易被静默做错的一条；
//! - 永久删除订单时，计划与流水不能留下孤儿。
//!
//! 用的是构造数据，证明的是「迁移链 + 约束 + 级联」，不证明真实用户库的历史形状。

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

fn user_version(env: &Environment) -> i64 {
    let conn = env.open_db().unwrap();
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap()
}

/// 表或视图都算「存在」——视图在 sqlite_master 里是 type='view'。
fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?1",
        [name],
        |r| r.get::<_, i64>(0),
    )
    .unwrap()
        == 1
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

/// 插一条平台。默认费率传 None 表示「未配置」。
fn platform(conn: &Connection, id: &str, name: &str, rate: Option<i64>) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO payment_platforms (id, name, fee_rate_bp, created_at, updated_at)
         VALUES (?1, ?2, ?3, '2026-11-24T00:00:00Z', '2026-11-24T00:00:00Z')",
        params![id, name, rate],
    )
}

fn schedule(conn: &Connection, id: &str, order_id: &str, kind: &str, amount: i64) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO payment_schedules (id, order_id, kind, amount_cents, created_at)
         VALUES (?1, ?2, ?3, ?4, '2026-11-24T00:00:00Z')",
        params![id, order_id, kind, amount],
    )
}

#[allow(clippy::too_many_arguments)]
fn record(
    conn: &Connection,
    id: &str,
    order_id: &str,
    schedule_id: Option<&str>,
    amount: i64,
    fee: i64,
    rate: Option<i64>,
) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO payment_records
           (id, order_id, schedule_id, kind, amount_cents, received_on,
            platform_id, platform_name, fee_rate_bp, fee_cents, created_at)
         VALUES (?1, ?2, ?3, 'deposit', ?4, '2026-11-24',
                 NULL, NULL, ?5, ?6, '2026-11-24T00:00:00Z')",
        params![id, order_id, schedule_id, amount, rate, fee],
    )
}

// ---------------------------------------------------------------- A. migration

#[test]
fn v9_database_upgrades_to_v10_without_touching_business_rows() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");

    let (order_id, client_id) = {
        let env = open_at(&root, 9);
        assert_eq!(user_version(&env), 9);
        let mut conn = env.open_db().unwrap();
        let order = common::insert_order(&mut conn, "AF-2026-0301", "v9 老库订单");
        // 金额走既有语义：一个已知、一个 NULL（NULL 不等于 0）。
        conn.execute(
            "UPDATE orders SET amount_cents = 123456 WHERE id = ?1",
            [&order],
        )
        .unwrap();
        common::insert_order(&mut conn, "AF-2026-0302", "金额未知的订单");
        let client = {
            let tx = conn.transaction().unwrap();
            tx.execute(
                "INSERT INTO clients (id, display_name, created_at, updated_at)
                 VALUES ('c-1', '老客户', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            tx.commit().unwrap();
            "c-1".to_string()
        };
        (order, client)
    };

    let env = common::open(&root);
    assert_eq!(user_version(&env), migrations::APP_SCHEMA_VERSION);
    let conn = env.open_db().unwrap();

    // 1) 旧数据原样保留，NULL 仍是 NULL。
    assert_eq!(
        conn.query_row(
            "SELECT amount_cents FROM orders WHERE code = 'AF-2026-0301'",
            [],
            |r| r.get::<_, Option<i64>>(0)
        )
        .unwrap(),
        Some(123456)
    );
    assert_eq!(
        conn.query_row(
            "SELECT amount_cents FROM orders WHERE code = 'AF-2026-0302'",
            [],
            |r| r.get::<_, Option<i64>>(0)
        )
        .unwrap(),
        None,
        "迁移不得把 NULL 金额补成 0"
    );
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders"), 2);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM clients WHERE id = 'c-1'"), 1);
    assert_eq!(client_id, "c-1");

    // 2) 三张表建好了，但一行历史数据都没有。
    for table in ["payment_platforms", "payment_schedules", "payment_records"] {
        assert!(table_exists(&conn, table), "缺少表 {table}");
        assert_eq!(count(&conn, &format!("SELECT COUNT(*) FROM {table}")), 0);
    }

    // 3) 原有三个视图不受影响（v8 只建了 orders_visible / orders_trashed / clients_visible）。
    for view in ["orders_visible", "orders_trashed", "clients_visible"] {
        assert!(table_exists(&conn, view), "缺少视图 {view}");
    }
    let visible: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders_visible WHERE id = ?1", [&order_id], |r| r.get(0))
        .unwrap();
    assert_eq!(visible, 1, "可见视图必须还能查到老订单");
}

#[test]
fn fresh_database_lands_on_v10() {
    let ctx = Ctx::new();
    assert_eq!(user_version(&ctx.env), 10);
    let conn = ctx.conn();
    for table in ["payment_platforms", "payment_schedules", "payment_records"] {
        assert!(table_exists(&conn, table), "新库缺少表 {table}");
    }
}

#[test]
fn a_failing_v10_step_rolls_back_and_leaves_no_half_built_tables() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    {
        let env = open_at(&root, 9);
        assert_eq!(user_version(&env), 9);
    }

    fn boom(tx: &rusqlite::Transaction<'_>) -> minidesk::error::AppResult<()> {
        tx.execute_batch("CREATE TABLE payment_platforms (id TEXT PRIMARY KEY);")?;
        Err(minidesk::error::AppError::schema("故意失败"))
    }

    let mut list = migrations::production();
    list.retain(|m| m.version <= 9);
    list.push(migrations::Migration {
        version: 10,
        name: "v10_finance_boom",
        apply: boom,
    });

    let env9 = open_at(&root, 9);
    let mut conn = env9.open_db().unwrap();
    assert!(migrations::migrate_to(&mut conn, &list, 10).is_err());

    // 版本号没前进，半成品表也不该留下。
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(version, 9);
    assert!(!table_exists(&conn, "payment_platforms"), "失败的迁移不能留下半成品表");
}

// ------------------------------------------------------- B. payment_platforms

#[test]
fn platform_accepts_unknown_and_explicit_zero_rate_as_different_values() {
    let ctx = Ctx::new();
    let conn = ctx.conn();

    platform(&conn, "p-unknown", "米画师", None).unwrap();
    platform(&conn, "p-zero", "画加", Some(0)).unwrap();
    platform(&conn, "p-rate", "私信", Some(500)).unwrap();

    assert_eq!(
        conn.query_row("SELECT fee_rate_bp FROM payment_platforms WHERE id = 'p-unknown'", [], |r| {
            r.get::<_, Option<i64>>(0)
        })
        .unwrap(),
        None,
        "未配置费率必须是 NULL，不能静默变成 0"
    );
    assert_eq!(
        conn.query_row("SELECT fee_rate_bp FROM payment_platforms WHERE id = 'p-zero'", [], |r| r
            .get::<_, Option<i64>>(0))
        .unwrap(),
        Some(0),
        "明确零费率必须是 0，与未配置区分"
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM payment_platforms WHERE fee_rate_bp IS NULL", [], |r| r
            .get::<_, i64>(0))
        .unwrap(),
        1
    );
}

#[test]
fn platform_rejects_bad_names_rates_and_flags() {
    let ctx = Ctx::new();
    let conn = ctx.conn();

    assert!(platform(&conn, "p-1", "", None).is_err(), "空名称必须拒绝");
    assert!(platform(&conn, "p-2", "   ", None).is_err(), "纯空格必须拒绝");
    assert!(platform(&conn, "p-3", &"字".repeat(41), None).is_err(), "超长名称必须拒绝");
    platform(&conn, "p-4", &"字".repeat(40), None).expect("40 字应允许");

    assert!(platform(&conn, "p-5", "费率负", Some(-1)).is_err());
    assert!(platform(&conn, "p-6", "费率超限", Some(10001)).is_err());
    platform(&conn, "p-7", "费率上限", Some(10000)).expect("10000bp = 100% 应允许");

    platform(&conn, "p-8", "重名", None).unwrap();
    assert!(platform(&conn, "p-9", "重名", None).is_err(), "名称唯一");

    assert!(conn
        .execute(
            "INSERT INTO payment_platforms (id, name, archived, created_at, updated_at)
             VALUES ('p-10', '坏标记', 2, 'x', 'x')",
            [],
        )
        .is_err());
}

#[test]
fn platform_name_uniqueness_is_exact_match_only() {
    let ctx = Ctx::new();
    let conn = ctx.conn();
    platform(&conn, "p-a", "Mihuashi", None).unwrap();
    // 不同大小写视为不同名称（默认二进制比较），不擅自折叠。
    platform(&conn, "p-b", "mihuashi", None).expect("大小写不同不应被唯一索引挡下");
    assert!(platform(&conn, "p-c", "Mihuashi", None).is_err());
}

// ------------------------------------------------------- C. payment_schedules

#[test]
fn schedule_accepts_four_kinds_and_optional_date() {
    let ctx = Ctx::new();
    let order = ctx.create_order("计划测试");
    let conn = ctx.conn();

    for (index, kind) in ["full", "deposit", "installment", "final"].iter().enumerate() {
        schedule(&conn, &format!("s-{index}"), &order, kind, 100).unwrap();
    }
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM payment_schedules"), 4);

    // 日期可空；有值时必须是 YYYY-MM-DD。
    conn.execute(
        "UPDATE payment_schedules SET expected_date = '2026-12-10' WHERE id = 's-0'",
        [],
    )
    .unwrap();
    assert!(conn
        .execute(
            "UPDATE payment_schedules SET expected_date = '2026/12/10' WHERE id = 's-1'",
            [],
        )
        .is_err());
}

#[test]
fn schedule_rejects_bad_kind_amount_and_orphan_order() {
    let ctx = Ctx::new();
    let order = ctx.create_order("计划约束");
    let conn = ctx.conn();

    assert!(schedule(&conn, "s-bad-kind", &order, "deposit_2", 100).is_err());
    assert!(schedule(&conn, "s-zero", &order, "deposit", 0).is_err());
    assert!(schedule(&conn, "s-negative", &order, "deposit", -1).is_err());
    assert!(
        schedule(&conn, "s-orphan", "不存在的订单", "deposit", 100).is_err(),
        "外键必须拦住不存在的订单"
    );
}

#[test]
fn deleting_an_order_cascades_schedules() {
    let ctx = Ctx::new();
    let order = ctx.create_order("级联");
    let conn = ctx.conn();
    schedule(&conn, "s-1", &order, "deposit", 100).unwrap();

    conn.execute("DELETE FROM orders WHERE id = ?1", [&order]).unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM payment_schedules"), 0);
}

// --------------------------------------------------------- D. payment_records

#[test]
fn record_accepts_all_kinds_and_methods() {
    let ctx = Ctx::new();
    let order = ctx.create_order("流水测试");
    let conn = ctx.conn();

    for (index, kind) in ["full", "deposit", "installment", "final"].iter().enumerate() {
        conn.execute(
            "INSERT INTO payment_records
               (id, order_id, kind, amount_cents, received_on, fee_cents, created_at)
             VALUES (?1, ?2, ?3, 100, '2026-11-24', 0, '2026-11-24T00:00:00Z')",
            params![format!("r-{index}"), order, kind],
        )
        .unwrap();
    }
    for (index, method) in ["wechat", "alipay", "bank", "cash", "other"].iter().enumerate() {
        conn.execute(
            "INSERT INTO payment_records
               (id, order_id, kind, amount_cents, received_on, method, fee_cents, created_at)
             VALUES (?1, ?2, 'deposit', 100, '2026-11-24', ?3, 0, '2026-11-24T00:00:00Z')",
            params![format!("m-{index}"), order, method],
        )
        .unwrap();
    }
    assert!(conn
        .execute(
            "INSERT INTO payment_records
               (id, order_id, kind, amount_cents, received_on, method, fee_cents, created_at)
             VALUES ('bad', ?1, 'deposit', 100, '2026-11-24', 'crypto', 0, 'x')",
            [&order],
        )
        .is_err());
}

#[test]
fn record_rejects_bad_amounts_and_fee_over_amount() {
    let ctx = Ctx::new();
    let order = ctx.create_order("金额约束");
    let conn = ctx.conn();

    assert!(record(&conn, "r-zero", &order, None, 0, 0, None).is_err());
    assert!(record(&conn, "r-neg", &order, None, -100, 0, None).is_err());
    assert!(record(&conn, "r-fee-neg", &order, None, 100, -1, None).is_err());
    assert!(
        record(&conn, "r-fee-over", &order, None, 100, 101, None).is_err(),
        "手续费不得超过该笔收款"
    );
    record(&conn, "r-equal", &order, None, 100, 100, None).expect("手续费等于金额应允许");
    assert!(record(&conn, "r-rate-bad", &order, None, 100, 0, Some(10001)).is_err());
    assert!(conn
        .execute(
            "INSERT INTO payment_records
               (id, order_id, kind, amount_cents, received_on, fee_cents, created_at)
             VALUES ('r-date', ?1, 'deposit', 100, '2026/11/24', 0, 'x')",
            [&order],
        )
        .is_err(),
        "到账日期必须是 YYYY-MM-DD"
    );
}

#[test]
fn record_keeps_unknown_rate_distinct_from_zero() {
    let ctx = Ctx::new();
    let order = ctx.create_order("费率快照");
    let conn = ctx.conn();

    record(&conn, "r-unknown", &order, None, 10_000, 500, None).unwrap();
    record(&conn, "r-zero", &order, None, 10_000, 0, Some(0)).unwrap();

    assert_eq!(
        conn.query_row("SELECT fee_rate_bp FROM payment_records WHERE id = 'r-unknown'", [], |r| r
            .get::<_, Option<i64>>(0))
        .unwrap(),
        None
    );
    assert_eq!(
        conn.query_row("SELECT fee_rate_bp FROM payment_records WHERE id = 'r-zero'", [], |r| r
            .get::<_, Option<i64>>(0))
        .unwrap(),
        Some(0)
    );
}

#[test]
fn record_fee_has_no_default_so_it_must_be_stated() {
    let ctx = Ctx::new();
    let order = ctx.create_order("手续费必须显式");
    let conn = ctx.conn();

    // 不写 fee_cents：必须被拒，而不是被 DEFAULT 0 兜成「零手续费」。
    let err = conn.execute(
        "INSERT INTO payment_records (id, order_id, kind, amount_cents, received_on, created_at)
         VALUES ('r-no-fee', ?1, 'deposit', 100, '2026-11-24', 'x')",
        [&order],
    );
    assert!(err.is_err(), "fee_cents 不得有默认值");
}

#[test]
fn duplicate_request_id_is_rejected_but_null_is_allowed_many_times() {
    let ctx = Ctx::new();
    let order = ctx.create_order("幂等");
    let conn = ctx.conn();

    let insert = |id: &str, request: Option<&str>| {
        conn.execute(
            "INSERT INTO payment_records
               (id, order_id, kind, amount_cents, received_on, fee_cents, request_id, created_at)
             VALUES (?1, ?2, 'deposit', 100, '2026-11-24', 0, ?3, 'x')",
            params![id, order, request],
        )
    };

    insert("r-1", Some("req-1")).unwrap();
    assert!(insert("r-2", Some("req-1")).is_err(), "重复 request_id 必须拒绝");
    insert("r-3", None).unwrap();
    insert("r-4", None).expect("多行 NULL 是允许的");
}

#[test]
fn deleting_platform_nullifies_link_but_keeps_name_snapshot() {
    let ctx = Ctx::new();
    let order = ctx.create_order("平台快照");
    let conn = ctx.conn();

    platform(&conn, "p-1", "米画师", Some(500)).unwrap();
    conn.execute(
        "INSERT INTO payment_records
           (id, order_id, kind, amount_cents, received_on, platform_id, platform_name,
            fee_rate_bp, fee_cents, created_at)
         VALUES ('r-1', ?1, 'deposit', 1000, '2026-11-24', 'p-1', '米画师', 500, 50, 'x')",
        [&order],
    )
    .unwrap();

    conn.execute("DELETE FROM payment_platforms WHERE id = 'p-1'", []).unwrap();

    let (platform_id, name, rate, fee): (Option<String>, Option<String>, Option<i64>, i64) = conn
        .query_row(
            "SELECT platform_id, platform_name, fee_rate_bp, fee_cents
             FROM payment_records WHERE id = 'r-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(platform_id, None, "平台删除后外键置空");
    assert_eq!(name.as_deref(), Some("米画师"), "名称快照必须保留");
    assert_eq!(rate, Some(500), "费率快照必须保留");
    assert_eq!(fee, 50, "实际手续费必须保留");
}

#[test]
fn deleting_schedule_keeps_the_real_payment() {
    let ctx = Ctx::new();
    let order = ctx.create_order("计划删除");
    let conn = ctx.conn();

    schedule(&conn, "s-1", &order, "deposit", 500).unwrap();
    record(&conn, "r-1", &order, Some("s-1"), 500, 0, None).unwrap();

    conn.execute("DELETE FROM payment_schedules WHERE id = 's-1'", []).unwrap();

    let (kept, schedule_id): (i64, Option<String>) = conn
        .query_row("SELECT COUNT(*), MAX(schedule_id) FROM payment_records WHERE id = 'r-1'", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(kept, 1, "计划删除不能带走真实收款");
    assert_eq!(schedule_id, None);
}

#[test]
fn permanent_delete_clears_schedules_and_records_without_touching_other_orders() {
    let ctx = Ctx::new();
    let doomed = ctx.create_order("将被永久删除");
    let keeper = ctx.create_order("必须留下");

    {
        let mut conn = ctx.conn();
        schedule(&conn, "s-doomed", &doomed, "deposit", 500).unwrap();
        record(&conn, "r-doomed", &doomed, Some("s-doomed"), 500, 0, None).unwrap();
        record(&conn, "r-keeper", &keeper, None, 700, 0, None).unwrap();

        // 走真实入口：先软删除，再永久删除。
        conn.execute(
            "UPDATE orders SET deleted_at = '2026-11-24T00:00:00Z',
                               deleted_batch = 'b-1' WHERE id = ?1",
            [&doomed],
        )
        .unwrap();
        let generation = ctx.env.active_generation().to_string();
        let layout = ctx.env.layout();
        minidesk::domain::trash::purge_order(&mut conn, &layout, &generation, &doomed).unwrap();
    }

    let conn = ctx.conn();
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM payment_records WHERE id = 'r-doomed'"),
        0,
        "永久删除后流水不得残留"
    );
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM payment_schedules"), 0);
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM payment_records WHERE id = 'r-keeper'"),
        1,
        "别的订单的流水不能被连坐"
    );
}

#[test]
fn foreign_key_and_integrity_checks_are_clean_after_writes() {
    let ctx = Ctx::new();
    let order = ctx.create_order("完整性");
    let conn = ctx.conn();

    platform(&conn, "p-1", "米画师", Some(500)).unwrap();
    schedule(&conn, "s-1", &order, "deposit", 500).unwrap();
    record(&conn, "r-1", &order, Some("s-1"), 500, 25, Some(500)).unwrap();

    let mut stmt = conn.prepare("PRAGMA foreign_key_check").unwrap();
    let violations = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap().count();
    assert_eq!(violations, 0, "外键必须无违规");

    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
    assert_eq!(integrity, "ok");
}
