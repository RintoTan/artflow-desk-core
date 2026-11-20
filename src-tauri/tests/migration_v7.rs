//! schema v7：`order_events` 重建以支持 `stage_skipped`。
//!
//! 全部在 tempfile 里演练，不触碰任何真实库。覆盖：
//! - v3 / v5 / v6 三条升级路径都能到 v7；
//! - 旧事件、v6 改期六字段与三个索引完整保留；
//! - 外键 CASCADE 仍生效；
//! - 跳级事件必须有快照，其它类型不得写快照；
//! - 重复启动不重复迁移；
//! - 迁移中途失败整步回滚，旧库仍可读。

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

fn index_names(conn: &rusqlite::Connection) -> Vec<String> {
    let mut stmt = conn
        .prepare(
            "SELECT name FROM sqlite_master
             WHERE type = 'index' AND tbl_name = 'order_events' AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .unwrap();
    stmt.query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<Vec<String>, _>>()
        .unwrap()
}

/// 在给定版本上插入一条历史事件（只用各版本都有的列）。
fn insert_legacy_event(conn: &mut rusqlite::Connection, order_id: &str, kind: &str, at: &str) -> i64 {
    conn.execute(
        "INSERT INTO order_events (order_id, kind, from_stage_title, to_stage_title, occurred_at)
         VALUES (?1, ?2, '草稿', '线稿', ?3)",
        rusqlite::params![order_id, kind, at],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn apply_broken_v7(tx: &rusqlite::Transaction<'_>) -> AppResult<()> {
    tx.execute_batch("ALTER TABLE order_events ADD COLUMN broken_marker TEXT;")?;
    // 故意写坏：引用不存在的列，让整步迁移失败。
    tx.execute_batch("UPDATE order_events SET no_such_column = 1;")?;
    Ok(())
}

#[test]
fn v3_database_upgrades_all_the_way_to_v7_without_losing_events() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");

    // 1) v3：正式库历史上的版本。
    let (order_id, event_id) = {
        let env = open_at(&root, 3);
        assert_eq!(user_version(&env), 3);
        let mut conn = env.open_db().unwrap();
        let id = common::insert_order(&mut conn, "AF-2026-0001", "v3 老库");
        let eid = insert_legacy_event(&mut conn, &id, "created", "2026-11-01T10:00:00+08:00");
        (id, eid)
    };

    // 2) 打开同一目录 → v3 → v4 → v5 → v6 → v7 连续升级。
    let env = common::open(&root);
    assert_eq!(user_version(&env), migrations::APP_SCHEMA_VERSION);

    let conn = env.open_db().unwrap();
    let (id, kind, from_title): (i64, String, Option<String>) = conn
        .query_row(
            "SELECT id, kind, from_stage_title FROM order_events WHERE order_id = ?1",
            [&order_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(id, event_id, "事件主键不得变化");
    assert_eq!(kind, "created");
    assert_eq!(from_title.as_deref(), Some("草稿"));

    let (skipped, skip_reason): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT skipped_stages, skip_reason FROM order_events WHERE id = ?1",
            [event_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(skipped.is_none() && skip_reason.is_none(), "旧事件的新列必须为空");
}

#[test]
fn v5_database_upgrades_to_v7() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");

    let order_id = {
        let env = open_at(&root, 5);
        assert_eq!(user_version(&env), 5);
        let mut conn = env.open_db().unwrap();
        let id = common::insert_order(&mut conn, "AF-2026-0002", "v5 老库");
        insert_legacy_event(&mut conn, &id, "work_started", "2026-11-02T10:00:00+08:00");
        id
    };

    let env = common::open(&root);
    assert_eq!(user_version(&env), migrations::APP_SCHEMA_VERSION);
    let kinds: Vec<String> = {
        let conn = env.open_db().unwrap();
        let mut stmt = conn
            .prepare("SELECT kind FROM order_events WHERE order_id = ?1 ORDER BY id")
            .unwrap();
        stmt.query_map([&order_id], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    assert_eq!(kinds, vec!["work_started"]);
}

#[test]
fn v6_keeps_reschedule_fields_and_rebuilds_all_three_indexes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");

    let order_id = {
        let env = open_at(&root, 6);
        assert_eq!(user_version(&env), 6);
        let mut conn = env.open_db().unwrap();
        let id = common::insert_order(&mut conn, "AF-2026-0003", "v6 改期历史");
        minidesk::domain::events::append_reschedule(
            &conn,
            &id,
            Some("2026-12-01"),
            Some("2026-12-10"),
            Some("2026-12-03"),
            Some("2026-12-12"),
            Some("客户改期"),
            "calendar",
            "2026-11-20T09:00:00+08:00",
        )
        .unwrap();
        // 顺带给 request_id 部分唯一索引造一条数据，升级后必须仍然唯一。
        conn.execute(
            "INSERT INTO order_events (order_id, kind, request_id, occurred_at)
             VALUES (?1, 'created', 'req-legacy-1', '2026-11-20T08:00:00+08:00')",
            [&id],
        )
        .unwrap();
        id
    };

    let env = common::open(&root);
    assert_eq!(user_version(&env), migrations::APP_SCHEMA_VERSION);
    let conn = env.open_db().unwrap();

    let (os, od, ns, nd, reason, source): (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = conn
        .query_row(
            "SELECT old_start_date, old_delivery_date, new_start_date, new_delivery_date,
                    reason, change_source
             FROM order_events WHERE order_id = ?1 AND kind = 'rescheduled'",
            [&order_id],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(os.as_deref(), Some("2026-12-01"));
    assert_eq!(od.as_deref(), Some("2026-12-10"));
    assert_eq!(ns.as_deref(), Some("2026-12-03"));
    assert_eq!(nd.as_deref(), Some("2026-12-12"));
    assert_eq!(reason.as_deref(), Some("客户改期"));
    assert_eq!(source.as_deref(), Some("calendar"));

    let names = index_names(&conn);
    assert!(names.contains(&"order_events_order_idx".to_string()), "{names:?}");
    assert!(names.contains(&"order_events_kind_idx".to_string()), "{names:?}");
    assert!(
        names.contains(&"order_events_request_uniq".to_string()),
        "{names:?}"
    );

    // 部分唯一索引真的在拦截重复 request_id。
    let dup = conn.execute(
        "INSERT INTO order_events (order_id, kind, request_id, occurred_at)
         VALUES (?1, 'created', 'req-legacy-1', '2026-11-20T08:30:00+08:00')",
        [&order_id],
    );
    assert!(dup.is_err(), "重复 request_id 必须被唯一索引拒绝");
}

#[test]
fn v7_enforces_cascade_and_skip_snapshot_rules() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    assert_eq!(user_version(&env), migrations::APP_SCHEMA_VERSION);

    let mut conn = env.open_db().unwrap();
    let order_id = common::insert_order(&mut conn, "AF-2026-0004", "约束演练");

    // 没有快照的 stage_skipped 必须被 CHECK 拒绝。
    let missing = conn.execute(
        "INSERT INTO order_events (order_id, kind, occurred_at)
         VALUES (?1, 'stage_skipped', '2026-11-20T10:00:00+08:00')",
        [&order_id],
    );
    assert!(missing.is_err(), "跳级事件必须带快照");

    // 非法 JSON 也必须被拒绝。
    let bad_json = conn.execute(
        "INSERT INTO order_events (order_id, kind, skipped_stages, occurred_at)
         VALUES (?1, 'stage_skipped', 'not-json', '2026-11-20T10:00:00+08:00')",
        [&order_id],
    );
    assert!(bad_json.is_err(), "快照必须是合法 JSON");

    // 非跳级事件不得写快照。
    let polluted = conn.execute(
        "INSERT INTO order_events (order_id, kind, skipped_stages, occurred_at)
         VALUES (?1, 'created', '[{\"stage_id\":\"x\"}]', '2026-11-20T10:00:00+08:00')",
        [&order_id],
    );
    assert!(polluted.is_err(), "其它类型不得写跳级快照");

    // 未知事件类型仍然被拒绝。
    let unknown = conn.execute(
        "INSERT INTO order_events (order_id, kind, occurred_at)
         VALUES (?1, 'stage_teleported', '2026-11-20T10:00:00+08:00')",
        [&order_id],
    );
    assert!(unknown.is_err(), "未知事件类型必须被拒绝");

    // 合法跳级事件可以写入。
    conn.execute(
        "INSERT INTO order_events (order_id, kind, skipped_stages, skip_reason, occurred_at)
         VALUES (?1, 'stage_skipped',
                 '[{\"stage_id\":\"line\",\"title\":\"线稿\",\"position\":1}]',
                 '客户赶稿', '2026-11-20T10:00:00+08:00')",
        [&order_id],
    )
    .unwrap();

    // 外键 CASCADE：删订单，事件一起走。
    conn.execute("DELETE FROM orders WHERE id = ?1", [&order_id])
        .unwrap();
    let left: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM order_events WHERE order_id = ?1",
            [&order_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0, "外键 ON DELETE CASCADE 必须仍生效");
}

#[test]
fn reopening_a_v7_database_does_not_migrate_again() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");

    let (generation, rows) = {
        let env = common::open(&root);
        assert_eq!(user_version(&env), migrations::APP_SCHEMA_VERSION);
        let mut conn = env.open_db().unwrap();
        let id = common::insert_order(&mut conn, "AF-2026-0005", "重复启动");
        insert_legacy_event(&mut conn, &id, "created", "2026-11-20T10:00:00+08:00");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM order_events", [], |r| r.get(0))
            .unwrap();
        (env.active_generation().to_string(), rows)
    };

    let env = common::open(&root);
    assert_eq!(user_version(&env), migrations::APP_SCHEMA_VERSION);
    assert_eq!(
        env.active_generation(),
        generation,
        "已是最新版本时不得新建代际"
    );
    let conn = env.open_db().unwrap();
    let after: i64 = conn
        .query_row("SELECT COUNT(*) FROM order_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(after, rows, "重复启动不得复制或丢失事件");
}

#[test]
fn failed_v7_migration_rolls_back_whole_step() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");

    let rows = {
        let env = open_at(&root, 6);
        assert_eq!(user_version(&env), 6);
        let mut conn = env.open_db().unwrap();
        let id = common::insert_order(&mut conn, "AF-2026-0006", "迁移会失败");
        insert_legacy_event(&mut conn, &id, "created", "2026-11-20T10:00:00+08:00");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM order_events", [], |r| r.get(0))
            .unwrap();
        rows
    };

    let mut broken = migrations::production();
    for step in broken.iter_mut() {
        if step.version == 7 {
            step.apply = apply_broken_v7;
        }
    }
    let failed = Environment::open_with(&root, &broken, 7, Some(common::tz()));
    assert!(failed.is_err(), "坏迁移必须返回错误");

    // 旧代际仍然可读，版本停在 v6，事件一条不少。
    let env = Environment::open_with(
        &root,
        &migrations::production(),
        6,
        Some(common::tz()),
    )
    .expect("旧库必须仍能打开");
    let conn = env.open_db().unwrap();
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(version, 6, "失败后结构版本不得前进");
    assert_eq!(index_names(&conn).len(), 3, "失败后索引不变");
    let after: i64 = conn
        .query_row("SELECT COUNT(*) FROM order_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(after, rows);
    drop(conn);
    drop(env);

    // 换回正常迁移表仍可升级到最新版本。
    let env = common::open(&root);
    assert_eq!(user_version(&env), migrations::APP_SCHEMA_VERSION);
}
