//! 迁移链：空库初始化、隔离代际升级、失败回滚、高版本拒绝。
//!
//! v2 只存在于本测试文件，是**测试夹具**，不是已发布的正式 schema。

mod common;

use std::fs;

use minidesk::error::{AppError, AppResult};
use minidesk::store::environment::Environment;
use minidesk::store::generation;
use minidesk::store::migrations::{self, Migration};

fn apply_v2(tx: &rusqlite::Transaction<'_>) -> AppResult<()> {
    tx.execute_batch(
        "ALTER TABLE clients ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
         CREATE INDEX clients_archived_idx ON clients(archived);",
    )?;
    Ok(())
}

fn apply_v2_broken(tx: &rusqlite::Transaction<'_>) -> AppResult<()> {
    // 故意写坏：引用不存在的列，让整步迁移失败。
    tx.execute_batch("ALTER TABLE clients ADD COLUMN broken INTEGER NOT NULL DEFAULT 0;")?;
    tx.execute_batch("UPDATE clients SET no_such_column = 1;")?;
    Ok(())
}

fn fixture(apply_v2: fn(&rusqlite::Transaction<'_>) -> AppResult<()>) -> Vec<Migration> {
    let mut list = migrations::production();
    list.push(Migration {
        version: 2,
        name: "v2_test_only",
        apply: apply_v2,
    });
    list
}

#[test]
fn empty_database_initializes_to_v1() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);

    assert!(env.outcome().first_run, "首次启动应被识别为初始化");
    assert_eq!(env.outcome().schema_version, 1);
    assert!(env.db_path().exists());

    let conn = env.open_db().unwrap();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 1);

    let tables: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    for expected in [
        "orders",
        "order_stages",
        "order_events",
        "clients",
        "stage_templates",
        "stage_template_steps",
        "attachments",
        "cleanup_tasks",
        "themes",
        "app_settings",
        "schema_meta",
    ] {
        assert!(tables.iter().any(|t| t == expected), "缺少表 {expected}");
    }
}

#[test]
fn restart_reuses_the_same_generation() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let first = common::open(&root);
    let generation = first.active_generation().to_string();
    drop(first);

    let second = common::open(&root);
    assert!(!second.outcome().first_run, "第二次启动不是首次");
    assert_eq!(second.active_generation(), generation);
}

#[test]
fn upgrade_runs_in_an_isolated_generation_and_keeps_the_old_one() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");

    let env = common::open(&root);
    let original_generation = env.active_generation().to_string();
    {
        let mut conn = env.open_db().unwrap();
        common::insert_order(&mut conn, "AF-2026-0001", "升级前订单");
    }
    drop(env);

    let list = fixture(apply_v2);
    let upgraded =
        Environment::open_with(&root, &list, 2, Some(common::tz())).expect("升级应成功");

    assert_eq!(upgraded.outcome().upgraded_from, Some(1));
    assert_eq!(upgraded.outcome().schema_version, 2);
    assert_ne!(
        upgraded.active_generation(),
        original_generation,
        "升级必须发生在新的数据代际"
    );

    let conn = upgraded.open_db().unwrap();
    let has_column: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('clients') WHERE name = 'archived'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(has_column, 1, "新结构已生效");

    let orders: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    assert_eq!(orders, 1, "升级必须保留既有数据");

    let layout = upgraded.layout();
    assert!(
        layout.generation_db(&original_generation).exists(),
        "旧代际必须保留作为回退"
    );
    assert!(
        !layout.recovery_state().exists(),
        "升级成功后不应残留恢复状态"
    );
}

#[test]
fn failed_upgrade_keeps_old_generation_and_pointer() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");

    let env = common::open(&root);
    let original_generation = env.active_generation().to_string();
    {
        let mut conn = env.open_db().unwrap();
        common::insert_order(&mut conn, "AF-2026-0002", "升级会失败");
    }
    let before = generation::list_generations(env.layout()).unwrap();
    drop(env);

    let list = fixture(apply_v2_broken);
    let result = Environment::open_with(&root, &list, 2, Some(common::tz()));
    assert!(result.is_err(), "坏迁移必须返回错误");

    // 重新以 v1 打开：旧代际仍可用，数据仍在。
    let env = common::open(&root);
    assert_eq!(env.active_generation(), original_generation);
    let conn = env.open_db().unwrap();
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(version, 1, "失败后结构版本不得前进");
    let orders: i64 = conn.query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0)).unwrap();
    assert_eq!(orders, 1);

    // 失败的新代际目录必须被清理，不留下半成品。
    let after = generation::list_generations(env.layout()).unwrap();
    assert_eq!(before, after, "失败后不得残留新代际");
}

#[test]
fn database_newer_than_app_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");

    let env = common::open(&root);
    drop(env);

    // 手动把结构版本提到 99，模拟"更新版本的数据库"。
    let layout = minidesk::store::paths::Layout::new(&root);
    let active = generation::read_active(&layout).unwrap().unwrap();
    {
        let conn = rusqlite::Connection::open(layout.generation_db(&active.generation)).unwrap();
        conn.pragma_update(None, "user_version", 99i64).unwrap();
    }

    let err = match common::try_open(&root) {
        Ok(_) => panic!("高版本数据库必须被拒绝"),
        Err(e) => e,
    };
    assert_eq!(err.code, "SCHEMA");
    assert!(err.message.contains("99"), "{}", err.message);
}

#[test]
fn missing_v1_definition_is_detected() {
    let dir = tempfile::tempdir().unwrap();
    // 全新目录：初始化时必须能找到 v1 定义。
    let root = dir.path().join("fresh");

    let err = match Environment::open_with(&root, &[], 1, Some(common::tz())) {
        Ok(_) => panic!("缺失 v1 定义必须被拒绝"),
        Err(e) => e,
    };
    assert_eq!(err.code, "SCHEMA");
    assert!(err.message.contains("v1"), "{}", err.message);
}

#[test]
fn migration_steps_are_idempotent_across_restarts() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    for _ in 0..3 {
        let env = common::open(&root);
        let conn = env.open_db().unwrap();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 1);
        let templates: i64 = conn
            .query_row("SELECT COUNT(*) FROM stage_templates", [], |r| r.get(0))
            .unwrap();
        assert_eq!(templates, 1, "重复启动不得重复播种默认模板");
    }
}

#[test]
fn environment_marker_blocks_silent_rebuild() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let layout = env.layout().clone();
    drop(env);

    // 删掉活动指针：模拟"数据环境被动过"。
    fs::remove_file(layout.active_pointer()).unwrap();

    let err = common::try_open(&root).err().expect("必须拒绝");
    assert_eq!(err.code, "ENV");
    assert!(err.message.contains("活动指针"), "{}", err.message);
    assert!(
        !layout.active_pointer().exists(),
        "被拒绝时不得自动重建指针或空库"
    );
}

#[test]
fn missing_database_file_is_refused_not_recreated() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let db = env.db_path();
    drop(env);

    fs::remove_file(&db).unwrap();
    let err = match common::try_open(&root) {
        Ok(_) => panic!("必须拒绝"),
        Err(e) => e,
    };
    assert_eq!(err.code, "ENV");
    assert!(!db.exists(), "不得自动创建空数据库");
}

#[test]
fn app_error_codes_are_stable_strings() {
    // 前端按 code 分支，这些值是契约的一部分。
    assert_eq!(AppError::busy("x").code, "BUSY");
    assert_eq!(AppError::schema("x").code, "SCHEMA");
    assert_eq!(AppError::numbering("x").code, "NUMBERING");
}
