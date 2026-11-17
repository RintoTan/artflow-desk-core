//! v5：把「可展示 ⇒ 必须是成品」提升为数据库层约束。
//!
//! 背景：v4 的跨列 CHECK 表达式 `(g = 0 OR role = 'final')` 在 `g=1, role=NULL`
//! 时求值为 NULL，SQLite 把 NULL 当作"未违反"，非法组合能写进去。
//! 这里验证触发器在 **INSERT 与 UPDATE 两侧**都拦住，且对已存在的 v4 库升级后同样生效。

mod common;

use std::path::Path;

use minidesk::store::environment::Environment;
use minidesk::store::migrations;

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

/// 直接写一条附件行（绕过领域层），用来单独验证数据库约束。
fn insert_raw(conn: &rusqlite::Connection, order: &str, id: &str, role: Option<&str>, visible: i64) -> rusqlite::Result<usize> {
    let now = minidesk::store::timezone::now_timestamp();
    conn.execute(
        "INSERT INTO attachments (id, order_id, original_name, rel_path, mime_type,
                                  byte_size, sha256, state, created_at, role, gallery_visible)
         VALUES (?1, ?2, 'x.png', ?6, 'image/png', 1, 'x', 'ok', ?3, ?4, ?5)",
        rusqlite::params![id, order, now, role, visible, format!("attachments/{id}.png")],
    )
}

#[test]
fn insert_rejects_visible_without_final_role() {
    let ctx = common::Ctx::new();
    let order = ctx.create_order("测试单");
    let conn = ctx.conn();

    // NULL 角色 + 可展示：必须被触发器拒绝（这正是旧 CHECK 放过的组合）。
    let err = insert_raw(&conn, &order, "a-null", None, 1).unwrap_err();
    assert!(
        err.to_string().contains("gallery_visible"),
        "实际错误：{err}"
    );

    // 参考素材 + 可展示：同样拒绝。
    let err = insert_raw(&conn, &order, "a-ref", Some("reference"), 1).unwrap_err();
    assert!(err.to_string().contains("gallery_visible"), "实际错误：{err}");

    // 合法：成品 + 可展示。
    insert_raw(&conn, &order, "a-ok", Some("final"), 1).unwrap();
    // 合法：未分类 + 不可展示。
    insert_raw(&conn, &order, "a-hidden", None, 0).unwrap();
}

#[test]
fn update_cannot_publish_before_marking_final() {
    let ctx = common::Ctx::new();
    let order = ctx.create_order("测试单");
    let conn = ctx.conn();
    insert_raw(&conn, &order, "a1", None, 0).unwrap();

    // 先直接改可见性：必须被拒。
    let err = conn
        .execute("UPDATE attachments SET gallery_visible = 1 WHERE id = 'a1'", [])
        .unwrap_err();
    assert!(err.to_string().contains("gallery_visible"), "实际错误：{err}");

    // 只改 role 为 reference 再设可见：仍要拒。
    conn.execute("UPDATE attachments SET role = 'reference' WHERE id = 'a1'", [])
        .unwrap();
    assert!(conn
        .execute("UPDATE attachments SET gallery_visible = 1 WHERE id = 'a1'", [])
        .is_err());

    // 合法顺序：先标成品（同时允许可见），再一次更新即可。
    conn.execute(
        "UPDATE attachments SET role = 'final', gallery_visible = 1 WHERE id = 'a1'",
        [],
    )
    .unwrap();

    // 成品可以再隐藏。
    conn.execute("UPDATE attachments SET gallery_visible = 0 WHERE id = 'a1'", [])
        .unwrap();
}

#[test]
fn downgrading_role_while_visible_is_rejected() {
    let ctx = common::Ctx::new();
    let order = ctx.create_order("测试单");
    let conn = ctx.conn();
    insert_raw(&conn, &order, "a1", Some("final"), 1).unwrap();

    // 已经是可展示状态，却把角色退回未分类：必须拒绝，否则会出现
    // "可展示但不是成品"的脏状态。
    let err = conn
        .execute("UPDATE attachments SET role = NULL WHERE id = 'a1'", [])
        .unwrap_err();
    assert!(err.to_string().contains("gallery_visible"), "实际错误：{err}");
}

#[test]
fn existing_v4_database_gains_the_trigger_on_upgrade() {
    let dir = tempfile::tempdir().unwrap();
    let root: &Path = &dir.path().join("data");

    // 造一个货真价实的 v4 库（模拟已经迁移过的 QA 代际）。
    {
        let list = migrations::production();
        let env = Environment::open_with(root, &list, 4, Some(common::tz())).unwrap();
        assert_eq!(
            env.open_db()
                .unwrap()
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            4
        );
    }

    // 用当前程序打开 = v4 → v5。
    let env = common::open(root);
    let conn = env.open_db().unwrap();
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        migrations::APP_SCHEMA_VERSION
    );

    // 升级后结构没变、约束生效。
    assert!(columns(&env, "attachments").contains(&"gallery_visible".to_string()));
    let triggers: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'attachments_gallery_visible%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(triggers, 2, "INSERT 与 UPDATE 两个触发器都要在");
}
