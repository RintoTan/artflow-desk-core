//! FIN-07.1：启动时的必需表检查。
//!
//! v12 曾经在提交之后扩充过退款表，于是「user_version 写着 12、`refund_records`
//! 却没有」这种库是可能存在的。版本号对得上、`integrity_check` 也 ok，但第一次用到
//! 退款就会炸——那不是用户能理解的失败，所以要在启动时就说清楚。
//!
//! 这里同时钉住反向边界：v9 / v11 的正常升级不能被这条检查拦住。`resume` 会在
//! **迁移之前**先 `validate` 一次，如果检查不看 `user_version`，正常升级会被全灭。

mod common;

use std::path::Path;

use minidesk::store::environment::Environment;
use minidesk::store::migrations;
use rusqlite::Connection;

fn open_at(root: &Path, version: i64) -> Environment {
    Environment::open_with(
        root,
        &migrations::production(),
        version,
        Some(common::tz()),
    )
    .expect("打开数据环境失败")
}

fn seed_order(env: &Environment, code: &str) -> String {
    let mut conn = env.open_db().unwrap();
    common::insert_order(&mut conn, code, "订单")
}

/// 在真实库里删掉一张表，模拟「版本号到了、结构没到」。
fn drop_table(root: &Path, table: &str) {
    let env = common::open(root);
    {
        let conn = env.open_db().unwrap();
        // 外键开着时删父表会先跑一次隐式删除；这里只是为了造结构，不关心约束。
        conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        conn.execute_batch(&format!("DROP TABLE {table};")).unwrap();
    }
    drop(env);
}

fn table_exists(root: &Path, table: &str) -> bool {
    let conn = Connection::open(root.join(format!(
        "generations/{}/database.sqlite",
        active_generation(root)
    )))
    .unwrap();
    let found: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |r| r.get(0),
        )
        .unwrap();
    found > 0
}

fn active_generation(root: &Path) -> String {
    let text = std::fs::read_to_string(root.join("state/active.json")).unwrap();
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    value["generation"].as_str().unwrap().to_string()
}

/// `Environment` 没实现 `Debug`，`unwrap_err` 用不了；这里把「应拒绝却成功」变成一句话说清。
fn open_error(root: &Path) -> minidesk::error::AppError {
    match common::try_open(root) {
        Ok(_) => panic!("应当拒绝启动，却成功打开了：{}", root.display()),
        Err(e) => e,
    }
}

fn generation_count(root: &Path) -> usize {
    std::fs::read_dir(root.join("generations")).unwrap().count()
}

#[test]
fn complete_v12_database_opens() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = open_at(&root, migrations::APP_SCHEMA_VERSION);
    seed_order(&env, "AF-2026-6001");
    drop(env);

    let reopened = common::open(&root);
    assert_eq!(reopened.outcome().schema_version, migrations::APP_SCHEMA_VERSION);
    assert!(reopened.outcome().upgraded_from.is_none(), "v12 不该再升级");
}

#[test]
fn v12_missing_refund_records_is_refused_at_startup() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    {
        let env = open_at(&root, migrations::APP_SCHEMA_VERSION);
        seed_order(&env, "AF-2026-6010");
    }
    drop_table(&root, "refund_records");

    let err = open_error(&root);
    assert_eq!(err.code, "SCHEMA", "{}", err.message);
    assert!(err.message.contains("refund_records"), "{}", err.message);
    assert!(
        err.message.contains(&format!("v{}", migrations::APP_SCHEMA_VERSION)),
        "错误要说清当前版本：{}",
        err.message
    );
    assert!(err.message.contains("无法继续启动"), "{}", err.message);
}

#[test]
fn v12_missing_payment_platforms_is_refused_at_startup() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    {
        let env = open_at(&root, migrations::APP_SCHEMA_VERSION);
        seed_order(&env, "AF-2026-6020");
    }
    drop_table(&root, "payment_platforms");

    let err = open_error(&root);
    assert!(err.message.contains("payment_platforms"), "{}", err.message);
}

#[test]
fn v12_missing_payment_schedules_is_refused_at_startup() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    {
        let env = open_at(&root, migrations::APP_SCHEMA_VERSION);
        seed_order(&env, "AF-2026-6030");
    }
    drop_table(&root, "payment_schedules");

    let err = open_error(&root);
    assert!(err.message.contains("payment_schedules"), "{}", err.message);
}

#[test]
fn v12_missing_payment_records_is_refused_at_startup() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    {
        let env = open_at(&root, migrations::APP_SCHEMA_VERSION);
        seed_order(&env, "AF-2026-6040");
    }
    drop_table(&root, "payment_records");

    let err = open_error(&root);
    assert!(err.message.contains("payment_records"), "{}", err.message);
}

/// 拒绝启动不等于动过数据：表不能被自动补上，库不能被改写，代际不能变多。
#[test]
fn structure_error_does_not_repair_anything() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    {
        let env = open_at(&root, migrations::APP_SCHEMA_VERSION);
        seed_order(&env, "AF-2026-6050");
    }
    drop_table(&root, "refund_records");

    let generations_before = generation_count(&root);
    let _ = open_error(&root);

    assert!(!table_exists(&root, "refund_records"), "不得自动建表");
    assert_eq!(
        generation_count(&root),
        generations_before,
        "拒绝启动不该产生新代际"
    );

    let conn = Connection::open(root.join(format!(
        "generations/{}/database.sqlite",
        active_generation(&root)
    )))
    .unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, migrations::APP_SCHEMA_VERSION, "版本号不该被改写");
    let orders: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    assert_eq!(orders, 1, "现有数据不该被动过");
}

// ------------------------------------------------ 反向边界：正常升级不能被拦

#[test]
fn v9_upgrades_to_v12_and_opens() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    {
        let env = open_at(&root, 9);
        seed_order(&env, "AF-2026-6060");
        let conn = env.open_db().unwrap();
        let platforms: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = 'payment_platforms'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(platforms, 0, "v9 本来就没有财务表");
    }

    let upgraded = common::open(&root);
    assert_eq!(upgraded.outcome().upgraded_from, Some(9));
    assert_eq!(upgraded.outcome().schema_version, migrations::APP_SCHEMA_VERSION);

    let conn = upgraded.open_db().unwrap();
    for table in [
        "payment_platforms",
        "payment_schedules",
        "payment_records",
        "refund_records",
    ] {
        let found: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(found, 1, "升级后必须补出 {table}");
    }
    let orders: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    assert_eq!(orders, 1, "升级不得丢订单");
}

#[test]
fn v11_upgrades_to_v12_and_keeps_finance_data() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    {
        let env = open_at(&root, 11);
        let order_id = seed_order(&env, "AF-2026-6070");
        let conn = env.open_db().unwrap();
        conn.execute(
            "INSERT INTO payment_platforms
               (id, name, fee_rate_bp, archived, sort_position, created_at, updated_at)
             VALUES ('p1','米画师',500,0,0,'2026-09-01T09:00:00+08:00','2026-09-01T09:00:00+08:00')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO payment_records
               (id, order_id, schedule_id, kind, amount_cents, received_on, platform_id,
                platform_name, fee_rate_bp, fee_cents, method, note, voided_at, void_reason,
                request_id, created_at)
             VALUES ('r1', ?1, NULL, 'full', 50000, '2026-11-01', 'p1',
                     '米画师', 500, 250, 'wechat', NULL, NULL, NULL, NULL,
                     '2026-11-01T09:00:00+08:00')",
            [&order_id],
        )
        .unwrap();
    }

    let upgraded = common::open(&root);
    assert_eq!(upgraded.outcome().upgraded_from, Some(11));

    let conn = upgraded.open_db().unwrap();
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM payment_platforms", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1,
        "平台配置必须保留"
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM payment_records", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1,
        "收款流水必须保留"
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM refund_records", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0,
        "退款表是新建的空表"
    );
    let fee: i64 = conn
        .query_row("SELECT fee_cents FROM payment_records WHERE id = 'r1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(fee, 250, "手续费快照不得被迁移改动");
}
