//! 可见性守卫：只判状态，不改数据。
//!
//! 覆盖三种归属（不存在 / 有效 / 回收站）× 四个守卫，外加 `Scope` 分派与
//! `order_scope` 的返回值。全部在 tempfile 里跑。

mod common;

use minidesk::store::visibility::{
    order_scope, require_order, require_trashed_client, require_trashed_order,
    require_visible_client, require_visible_order, Scope,
};
use rusqlite::Connection;

fn trash_order(conn: &Connection, id: &str) {
    conn.execute(
        "UPDATE orders SET deleted_at = '2026-11-20T12:00:00+08:00', deleted_batch = 'b-1'
         WHERE id = ?1",
        [id],
    )
    .unwrap();
}

fn trash_client(conn: &Connection, id: &str) {
    conn.execute(
        "UPDATE clients SET deleted_at = '2026-11-20T12:00:00+08:00', deleted_batch = 'b-1'
         WHERE id = ?1",
        [id],
    )
    .unwrap();
}

fn insert_client(conn: &Connection, id: &str, name: &str) {
    conn.execute(
        "INSERT INTO clients (id, display_name, revision, created_at, updated_at)
         VALUES (?1, ?2, 0, '2026-11-20T10:00:00+08:00', '2026-11-20T10:00:00+08:00')",
        rusqlite::params![id, name],
    )
    .unwrap();
}

fn code_of(err: &minidesk::error::AppError) -> &str {
    &err.code
}

#[test]
fn visible_order_guard_accepts_live_and_rejects_trashed_and_missing() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let mut conn = env.open_db().unwrap();

    let live = common::insert_order(&mut conn, "AF-2026-0201", "有效订单");
    let gone = common::insert_order(&mut conn, "AF-2026-0202", "已删除订单");
    trash_order(&conn, &gone);

    require_visible_order(&conn, &live).expect("有效订单应通过");

    let err = require_visible_order(&conn, &gone).unwrap_err();
    assert_eq!(code_of(&err), "CONFLICT");
    assert!(
        err.message.contains("回收站"),
        "文案要指明去向：{}",
        err.message
    );

    let err = require_visible_order(&conn, "no-such-order").unwrap_err();
    assert_eq!(code_of(&err), "NOT_FOUND");
    assert!(err.message.contains("不存在"), "{}", err.message);
}

#[test]
fn trashed_order_guard_accepts_trashed_and_rejects_live() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let mut conn = env.open_db().unwrap();

    let live = common::insert_order(&mut conn, "AF-2026-0203", "还在业务侧");
    let gone = common::insert_order(&mut conn, "AF-2026-0204", "在回收站");
    trash_order(&conn, &gone);

    require_trashed_order(&conn, &gone).expect("回收站订单应通过");

    let err = require_trashed_order(&conn, &live).unwrap_err();
    assert_eq!(code_of(&err), "CONFLICT");
    assert!(
        err.message.contains("不在回收站"),
        "不能对活订单执行回收站操作：{}",
        err.message
    );

    let err = require_trashed_order(&conn, "no-such-order").unwrap_err();
    assert_eq!(code_of(&err), "NOT_FOUND");
}

#[test]
fn client_guards_split_live_and_trashed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let conn = env.open_db().unwrap();

    insert_client(&conn, "c-live", "有效客户");
    insert_client(&conn, "c-gone", "已删客户");
    trash_client(&conn, "c-gone");

    require_visible_client(&conn, "c-live").expect("有效客户应通过");
    require_trashed_client(&conn, "c-gone").expect("回收站客户应通过");

    let err = require_visible_client(&conn, "c-gone").unwrap_err();
    assert_eq!(code_of(&err), "CONFLICT");
    assert!(err.message.contains("回收站"), "{}", err.message);

    let err = require_trashed_client(&conn, "c-live").unwrap_err();
    assert_eq!(code_of(&err), "CONFLICT");

    let err = require_visible_client(&conn, "c-missing").unwrap_err();
    assert_eq!(code_of(&err), "NOT_FOUND");
    let err = require_trashed_client(&conn, "c-missing").unwrap_err();
    assert_eq!(code_of(&err), "NOT_FOUND");
}

#[test]
fn scope_dispatch_matches_named_guards() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let mut conn = env.open_db().unwrap();

    let live = common::insert_order(&mut conn, "AF-2026-0205", "有效");
    let gone = common::insert_order(&mut conn, "AF-2026-0206", "已删");
    trash_order(&conn, &gone);

    require_order(&conn, &live, Scope::Visible).expect("Visible 分支");
    require_order(&conn, &gone, Scope::Trashed).expect("Trashed 分支");

    assert_eq!(
        code_of(&require_order(&conn, &live, Scope::Trashed).unwrap_err()),
        "CONFLICT"
    );
    assert_eq!(
        code_of(&require_order(&conn, &gone, Scope::Visible).unwrap_err()),
        "CONFLICT"
    );

    assert_eq!(order_scope(&conn, &live).unwrap(), Scope::Visible);
    assert_eq!(order_scope(&conn, &gone).unwrap(), Scope::Trashed);
    assert_eq!(
        code_of(&order_scope(&conn, "no-such-order").unwrap_err()),
        "NOT_FOUND"
    );
}

#[test]
fn guards_are_read_only() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let mut conn = env.open_db().unwrap();

    let gone = common::insert_order(&mut conn, "AF-2026-0207", "守卫不应改数据");
    trash_order(&conn, &gone);

    let before: (Option<String>, Option<String>, i64) = conn
        .query_row(
            "SELECT deleted_at, deleted_batch, revision FROM orders WHERE id = ?1",
            [&gone],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();

    let _ = require_visible_order(&conn, &gone);
    let _ = require_trashed_order(&conn, &gone);
    let _ = order_scope(&conn, &gone);

    let after: (Option<String>, Option<String>, i64) = conn
        .query_row(
            "SELECT deleted_at, deleted_batch, revision FROM orders WHERE id = ?1",
            [&gone],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();

    assert_eq!(before, after, "守卫必须是只读的");
}
