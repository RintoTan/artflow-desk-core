//! schema v6：`order_events` 重建以支持 `rescheduled`，且必须完整保留既有历史。
//!
//! 全部在 tempfile 里演练，不触碰任何真实库。

mod common;

use std::path::Path;

use minidesk::store::environment::Environment;
use minidesk::store::migrations;

/// 只迁移到 v5 的环境，模拟"用户手上的库还是 v5"。
fn open_v5(root: &Path) -> Environment {
    let list = migrations::production();
    Environment::open_with(root, &list, 5, Some(common::tz())).expect("建 v5 环境失败")
}

fn user_version(env: &Environment) -> i64 {
    let conn = env.open_db().unwrap();
    conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap()
}

#[test]
fn v6_preserves_existing_events_and_accepts_rescheduled() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");

    // 1) 在 v5 上造一张订单 + 生命周期事件
    let order_id = {
        let env = open_v5(&root);
        assert_eq!(user_version(&env), 5);
        let mut conn = env.open_db().unwrap();
        let view = minidesk::domain::orders::create_order(
            &mut conn,
            &common::highwater(&env),
            common::tz(),
            minidesk::domain::orders::CreateOrderInput {
                title: "v6 迁移演练".into(),
                planned_start_date: Some("2026-12-01".into()),
                planned_delivery_date: Some("2026-12-10".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let started = minidesk::domain::lifecycle::start_work(
            &mut conn,
            common::lifecycle_input(&view),
        )
        .unwrap();
        assert_eq!(started.work_state, minidesk::domain::lifecycle::WorkState::InProgress);
        view.id
    };

    // 2) 打开同一目录 → 触发 v5 → v6
    let env = common::open(&root);
    assert_eq!(user_version(&env), 6);
    assert_eq!(migrations::APP_SCHEMA_VERSION, 6);

    let conn = env.open_db().unwrap();
    let kinds: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT kind FROM order_events WHERE order_id = ?1 ORDER BY id")
            .unwrap();
        stmt.query_map([&order_id], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    assert_eq!(kinds, vec!["created", "work_started"], "原有事件一条不少");

    // 3) 新列可写、旧事件为 NULL
    let (os, nd, src): (Option<String>, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT old_start_date, new_delivery_date, change_source FROM order_events WHERE kind = 'created'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert!(os.is_none() && nd.is_none() && src.is_none());

    // 4) rescheduled 现在能写入
    drop(conn);
    let mut conn = env.open_db().unwrap();
    let view = minidesk::domain::orders::load(&conn, &order_id).unwrap();
    let mut req = minidesk::domain::orders::UpdateDetailsInput {
        order_id: order_id.clone(),
        expected_revision: view.revision,
        title: view.title.clone(),
        client_id: view.client_id.clone(),
        commission_type: view.commission_type.clone(),
        source: view.source.clone(),
        amount_cents: view.amount_cents,
        planned_start_date: view.planned_start_date.clone(),
        planned_delivery_date: Some("2026-12-18".into()),
        note: view.note.clone(),
        change_source: Some("calendar".into()),
        reason: None,
    };
    minidesk::domain::orders::update_details(&mut conn, req.clone()).unwrap();
    req.expected_revision += 1;
    req.planned_delivery_date = Some("2026-12-19".into());
    minidesk::domain::orders::update_details(&mut conn, req).unwrap();

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM order_events WHERE order_id = ?1 AND kind = 'rescheduled'",
            [&order_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);

    // 5) 重复打开不会重复迁移
    drop(conn);
    drop(env);
    let env2 = common::open(&root);
    assert_eq!(user_version(&env2), 6);
}

#[test]
fn v6_rebuild_keeps_indexes_and_foreign_key() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let conn = env.open_db().unwrap();

    let indexes: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='order_events'")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    for expected in ["order_events_order_idx", "order_events_kind_idx", "order_events_request_uniq"] {
        assert!(indexes.iter().any(|n| n == expected), "缺少索引 {expected}：{indexes:?}");
    }

    let fk: Vec<(i64, String, String)> = {
        let mut stmt = conn
            .prepare("PRAGMA foreign_key_list(order_events)")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    assert!(
        fk.iter().any(|(_, table, from)| table == "orders" && from == "order_id"),
        "外键丢失：{fk:?}"
    );

    // 级联删除仍然生效
    let id = {
        let mut conn2 = env.open_db().unwrap();
        let view = minidesk::domain::orders::create_order(
            &mut conn2,
            &common::highwater(&env),
            common::tz(),
            minidesk::domain::orders::CreateOrderInput {
                title: "级联删除".into(),
                ..Default::default()
            },
        )
        .unwrap();
        view.id
    };
    conn.execute("DELETE FROM orders WHERE id = ?1", [&id]).unwrap();
    let left: i64 = conn
        .query_row("SELECT COUNT(*) FROM order_events WHERE order_id = ?1", [&id], |r| r.get(0))
        .unwrap();
    assert_eq!(left, 0, "删除订单应级联删除事件");
}

#[test]
fn v6_rejects_unknown_event_kind_at_database_level() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let mut conn = env.open_db().unwrap();
    let view = minidesk::domain::orders::create_order(
        &mut conn,
        &common::highwater(&env),
        common::tz(),
        minidesk::domain::orders::CreateOrderInput {
            title: "约束".into(),
            ..Default::default()
        },
    )
    .unwrap();
    let err = conn
        .execute(
            "INSERT INTO order_events (order_id, kind, occurred_at) VALUES (?1, 'rescheduled_v2', '2026-12-01T00:00:00Z')",
            [&view.id],
        )
        .unwrap_err();
    assert!(err.to_string().contains("CHECK"), "应被 CHECK 拒绝：{err}");
}
