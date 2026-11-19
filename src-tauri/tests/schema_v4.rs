//! schema v4：来源 / 附件角色与展示 / 客户标签，以及 v3 → v4 升级安全性。
//!
//! 本轮**不允许**对正式库执行迁移，因此全部在 tempfile 里用"v3 临时副本"演练。

mod common;

use std::path::Path;

use minidesk::error::AppResult;
use minidesk::store::environment::Environment;
use minidesk::store::migrations;

/// 只迁移到 v3 的环境，用来模拟"用户手上的正式库还是 v3"。
fn open_v3(root: &Path) -> Environment {
    let list = migrations::production();
    Environment::open_with(root, &list, 3, Some(common::tz())).expect("建 v3 环境失败")
}

fn user_version(env: &Environment) -> i64 {
    let conn = env.open_db().unwrap();
    conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
}

fn columns(env: &Environment, table: &str) -> Vec<String> {
    let conn = env.open_db().unwrap();
    let mut stmt = conn
        .prepare(&format!("SELECT name FROM pragma_table_info('{table}')"))
        .unwrap();
    stmt.query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

#[test]
fn v4_empty_database_has_all_new_structures() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    assert_eq!(user_version(&env), migrations::APP_SCHEMA_VERSION);
    assert!(columns(&env, "orders").contains(&"source".to_string()));
    assert!(columns(&env, "attachments").contains(&"role".to_string()));
    assert!(
        columns(&env, "attachments").contains(&"gallery_visible".to_string()),
        "附件必须有本地展示状态"
    );
    let conn = env.open_db().unwrap();
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'client_tag%'")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert!(tables.contains(&"client_tags".to_string()));
    assert!(tables.contains(&"client_tag_link".to_string()));
}

#[test]
fn v3_copy_upgrades_without_losing_data_or_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");

    // 在 v3 里造数据：1 客户 + 1 订单 + 1 附件 + 1 事件。
    let (order_id, client_id) = {
        let env = open_v3(&root);
        assert_eq!(user_version(&env), 3);
        let mut conn = env.open_db().unwrap();
        let now = minidesk::store::timezone::now_timestamp();
        // 订单与当前阶段之间有可延迟外键，必须在同一事务里提交。
        let tx = conn.transaction().unwrap();
        tx.execute(
            "INSERT INTO clients (id, display_name, contact, note, revision, created_at, updated_at)
             VALUES ('c1', '阿岚', 'wx', '备注', 0, ?1, ?1)",
            [&now],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO orders (id, code, title, client_id, amount_cents, status,
                                 current_stage_id, queue_position, revision, created_at, updated_at)
             VALUES ('o1', 'AF-2026-0001', '测试单', 'c1', NULL, 'active', 's1', 0, 0, ?1, ?1)",
            [&now],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO order_stages (order_id, stage_id, title, position)
             VALUES ('o1', 's1', '草稿', 0)",
            [],
        )
        .unwrap();
        tx.execute(
            "INSERT INTO attachments (id, order_id, original_name, rel_path, mime_type,
                                      byte_size, sha256, state, created_at)
             VALUES ('a1', 'o1', 'ref.png', 'attachments/ref.png', 'image/png', 10, 'x',
                     'ok', ?1)",
            [&now],
        )
        .unwrap();
        tx.commit().unwrap();
        ("o1".to_string(), "c1".to_string())
    };

    // 重新用当前程序打开 = 执行 v3 → v4。
    let env = common::open(&root);
    assert_eq!(user_version(&env), migrations::APP_SCHEMA_VERSION);
    let conn = env.open_db().unwrap();

    let (title, source, amount): (String, Option<String>, Option<i64>) = conn
        .query_row(
            "SELECT title, source, amount_cents FROM orders WHERE id = ?1",
            [&order_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(title, "测试单", "升级不得改动订单内容");
    assert_eq!(source, None, "旧订单来源必须是未设置，不能回填虚构值");
    assert_eq!(amount, None, "NULL 金额不能被升级写成 0");

    let (role, visible): (Option<String>, i64) = conn
        .query_row(
            "SELECT role, gallery_visible FROM attachments WHERE id = 'a1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(role, None, "旧附件必须保持未分类");
    assert_eq!(visible, 0, "旧附件绝不能自动进入展示");

    let clients: i64 = conn
        .query_row("SELECT COUNT(*) FROM clients", [], |r| r.get(0))
        .unwrap();
    let orders: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    assert_eq!((clients, orders), (1, 1));
    assert_eq!(client_id, "c1");

    let fk_problems: i64 = conn
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(fk_problems, 0, "升级后外键必须仍然有效");
}

#[test]
fn v3_copy_keeps_settings_and_highwater() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    {
        let env = open_v3(&root);
        let conn = env.open_db().unwrap();
        let now = minidesk::store::timezone::now_timestamp();
        minidesk::store::settings::set(
            &conn,
            minidesk::store::settings::KEY_THEME_MODE,
            "dark",
            &now,
        )
        .unwrap();
        minidesk::store::settings::set(
            &conn,
            minidesk::store::settings::KEY_ICON_VARIANT,
            "wave-a",
            &now,
        )
        .unwrap();
    }
    // 高水位在独立文件里，升级业务库不应触碰它。
    let hw_before = {
        let env = open_v3(&root);
        let hw = common::highwater(&env);
        let now = minidesk::store::timezone::now_timestamp();
        minidesk::domain::numbering::reserve(&hw, &now, common::tz()).unwrap()
    };

    let env = common::open(&root);
    let conn = env.open_db().unwrap();
    assert_eq!(
        minidesk::store::settings::get(&conn, minidesk::store::settings::KEY_THEME_MODE).unwrap(),
        Some("dark".to_string())
    );
    assert_eq!(
        minidesk::store::settings::get(&conn, minidesk::store::settings::KEY_ICON_VARIANT).unwrap(),
        Some("wave-a".to_string())
    );

    let hw = common::highwater(&env);
    let now = minidesk::store::timezone::now_timestamp();
    let next = minidesk::domain::numbering::reserve(&hw, &now, common::tz()).unwrap();
    assert!(
        next > hw_before,
        "编号必须继续递增且不复用：{hw_before} → {next}"
    );
}

#[test]
fn failed_v4_step_leaves_no_partial_schema() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    // 先到 v3。
    {
        let env = open_v3(&root);
        assert_eq!(user_version(&env), 3);
    }

    // 用"做到一半就报错"的 v4 替换正式 v4。
    fn broken(tx: &rusqlite::Transaction<'_>) -> AppResult<()> {
        tx.execute_batch("ALTER TABLE orders ADD COLUMN source TEXT;")?;
        tx.execute_batch("UPDATE orders SET no_such_column = 1;")?;
        Ok(())
    }
    let mut list = migrations::production();
    for step in list.iter_mut() {
        if step.version == 4 {
            step.apply = broken;
            step.name = "v4_broken_test_only";
        }
    }
    let err = Environment::open_with(&root, &list, 4, Some(common::tz()));
    // 注意：这里刻意只升到 4，验证"坏 v4 整步回滚"，与最高版本无关。
    assert!(err.is_err(), "坏迁移必须整体失败");

    // 重新用正式迁移表打开：应当能正常升到 v4，且没有半截列。
    let env = common::open(&root);
    assert_eq!(user_version(&env), migrations::APP_SCHEMA_VERSION);
    let cols = columns(&env, "orders");
    assert_eq!(
        cols.iter().filter(|c| *c == "source").count(),
        1,
        "source 列只应存在一次，说明坏迁移已整步回滚"
    );
}

#[test]
fn source_is_trimmed_limited_and_nullable() {
    use minidesk::domain::orders::{clean_source, CreateOrderInput};

    assert_eq!(clean_source(&None).unwrap(), None);
    assert_eq!(clean_source(&Some("   ".into())).unwrap(), None);
    assert_eq!(
        clean_source(&Some("  米画师 ".into())).unwrap(),
        Some("米画师".to_string())
    );
    assert!(
        clean_source(&Some("长".repeat(41))).is_err(),
        "超过 40 字必须拒绝"
    );
    assert_eq!(
        CreateOrderInput::default().source,
        None,
        "默认不填来源"
    );
}

#[test]
fn source_round_trips_through_create_and_update() {
    use minidesk::domain::orders::{create_order, CreateOrderInput, UpdateDetailsInput};

    let ctx = common::Ctx::new();
    let mut conn = ctx.conn();
    let view = create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: "带来源的订单".into(),
            source: Some("画加".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(view.source.as_deref(), Some("画加"));

    let updated = minidesk::domain::orders::update_details(
        &mut conn,
        UpdateDetailsInput {
            order_id: view.id.clone(),
            expected_revision: view.revision,
            title: view.title.clone(),
            client_id: None,
            commission_type: None,
            source: Some("  ".into()),
            amount_cents: None,
            planned_start_date: None,
            planned_delivery_date: None,
            note: None,
            change_source: None,
            reason: None,
        },
    )
    .unwrap();
    assert_eq!(updated.source, None, "空白来源归一为未设置");
}
