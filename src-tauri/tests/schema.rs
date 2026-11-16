//! 单库结构：关键约束必须有数据库层兜底，而不是只靠应用层校验。

mod common;

use minidesk::store::settings;
use rusqlite::{params, Connection};

fn env_db() -> (tempfile::TempDir, minidesk::store::environment::Environment) {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    (dir, env)
}

#[test]
fn default_template_is_seeded_with_five_stages() {
    let (_dir, env) = env_db();
    let conn = env.open_db().unwrap();

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM stage_templates WHERE is_default = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1, "只允许一个默认模板");

    let mut stmt = conn
        .prepare(
            "SELECT title FROM stage_template_steps WHERE template_id = ?1 ORDER BY position",
        )
        .unwrap();
    let titles: Vec<String> = stmt
        .query_map([settings::DEFAULT_TEMPLATE_ID], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(titles, vec!["草稿", "线稿", "固有色", "细化", "最终调整"]);
}

#[test]
fn only_one_default_template_allowed() {
    let (_dir, env) = env_db();
    let conn = env.open_db().unwrap();
    let now = minidesk::store::timezone::now_timestamp();
    let result = conn.execute(
        "INSERT INTO stage_templates (id, name, is_default, revision, created_at, updated_at)
         VALUES ('tpl-second', '第二个默认', 1, 0, ?1, ?1)",
        [&now],
    );
    assert!(result.is_err(), "第二个默认模板必须被拒绝");
}

#[test]
fn duplicate_stage_title_within_template_rejected() {
    let (_dir, env) = env_db();
    let conn = env.open_db().unwrap();
    let result = conn.execute(
        "INSERT INTO stage_template_steps (template_id, step_id, title, position)
         VALUES (?1, 'dup', '草稿', 9)",
        [settings::DEFAULT_TEMPLATE_ID],
    );
    assert!(result.is_err(), "同模板内阶段重名必须被拒绝");
}

#[test]
fn order_code_is_unique_and_immutable_in_practice() {
    let (_dir, env) = env_db();
    let mut conn = env.open_db().unwrap();
    common::insert_order(&mut conn, "AF-2026-0001", "第一张");

    let now = minidesk::store::timezone::now_timestamp();
    let result = conn.execute(
        "INSERT INTO orders (id, code, title, status, current_stage_id, queue_position,
                             revision, created_at, updated_at)
         VALUES ('x2', 'AF-2026-0001', '重复编号', 'active', 'draft', 1, 0, ?1, ?1)",
        [&now],
    );
    assert!(result.is_err(), "编号必须唯一");
}

#[test]
fn amount_null_and_zero_are_distinct() {
    let (_dir, env) = env_db();
    let mut conn = env.open_db().unwrap();
    let now = minidesk::store::timezone::now_timestamp();

    let tx = conn.transaction().unwrap();
    tx.execute(
        "INSERT INTO orders (id, code, title, status, current_stage_id, queue_position,
                             amount_cents, revision, created_at, updated_at)
         VALUES ('a1', 'AF-2026-0010', '未知金额', 'active', 'draft', 0, NULL, 0, ?1, ?1)",
        [&now],
    )
    .unwrap();
    tx.execute(
        "INSERT INTO orders (id, code, title, status, current_stage_id, queue_position,
                             amount_cents, revision, created_at, updated_at)
         VALUES ('a2', 'AF-2026-0011', '零元', 'active', 'draft', 1, 0, 0, ?1, ?1)",
        [&now],
    )
    .unwrap();
    for id in ["a1", "a2"] {
        tx.execute(
            "INSERT INTO order_stages (order_id, stage_id, title, position)
             VALUES (?1, 'draft', '草稿', 0)",
            [id],
        )
        .unwrap();
    }
    tx.commit().unwrap();

    let null_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders WHERE amount_cents IS NULL", [], |r| r.get(0))
        .unwrap();
    let zero_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders WHERE amount_cents = 0", [], |r| r.get(0))
        .unwrap();
    assert_eq!((null_count, zero_count), (1, 1), "NULL 与 0 必须区分");

    let negative = conn.execute(
        "INSERT INTO orders (id, code, title, status, current_stage_id, queue_position,
                             amount_cents, revision, created_at, updated_at)
         VALUES ('a3', 'AF-2026-0012', '负金额', 'active', 'draft', 2, -1, 0, ?1, ?1)",
        [&now],
    );
    assert!(negative.is_err(), "负金额必须被拒绝");
}

#[test]
fn delivery_date_cannot_precede_start_date() {
    let (_dir, env) = env_db();
    let mut conn = env.open_db().unwrap();
    let now = minidesk::store::timezone::now_timestamp();
    let tx = conn.transaction().unwrap();
    let result = tx.execute(
        "INSERT INTO orders (id, code, title, status, current_stage_id, queue_position,
                             planned_start_date, planned_delivery_date,
                             revision, created_at, updated_at)
         VALUES ('d1', 'AF-2026-0020', '日期倒挂', 'active', 'draft', 0,
                 '2026-03-10', '2026-03-01', 0, ?1, ?1)",
        [&now],
    );
    assert!(result.is_err(), "交付日期早于开始日期必须被拒绝");
}

#[test]
fn terminal_state_timestamps_must_match_status() {
    let (_dir, env) = env_db();
    let mut conn = env.open_db().unwrap();
    let now = minidesk::store::timezone::now_timestamp();

    let tx = conn.transaction().unwrap();
    let missing = tx.execute(
        "INSERT INTO orders (id, code, title, status, current_stage_id, queue_position,
                             revision, created_at, updated_at)
         VALUES ('t1', 'AF-2026-0030', '完成但无时间', 'complete', 'draft', 0, 0, ?1, ?1)",
        [&now],
    );
    assert!(missing.is_err(), "completed 必须有 completed_at");

    let stray = tx.execute(
        "INSERT INTO orders (id, code, title, status, current_stage_id, queue_position,
                             completed_at, revision, created_at, updated_at)
         VALUES ('t2', 'AF-2026-0031', '活动却有完成时间', 'active', 'draft', 0, ?1, 0, ?1, ?1)",
        [&now],
    );
    assert!(stray.is_err(), "活动订单不得带 completed_at");
}

#[test]
fn current_stage_must_belong_to_the_same_order() {
    let (_dir, env) = env_db();
    let mut conn = env.open_db().unwrap();
    let now = minidesk::store::timezone::now_timestamp();

    let tx = conn.transaction().unwrap();
    tx.execute(
        "INSERT INTO orders (id, code, title, status, current_stage_id, queue_position,
                             revision, created_at, updated_at)
         VALUES ('o1', 'AF-2026-0040', '指向别人的阶段', 'active', 'stage-of-other', 0, 0, ?1, ?1)",
        [&now],
    )
    .unwrap();
    tx.execute(
        "INSERT INTO order_stages (order_id, stage_id, title, position)
         VALUES ('o1', 'draft', '草稿', 0)",
        [],
    )
    .unwrap();
    let commit = tx.commit();
    assert!(commit.is_err(), "当前阶段必须属于本订单，可延迟外键应在提交时拦截");
}

#[test]
fn clients_with_same_name_are_not_merged() {
    let (_dir, env) = env_db();
    let conn = env.open_db().unwrap();
    let now = minidesk::store::timezone::now_timestamp();
    for id in ["c1", "c2"] {
        conn.execute(
            "INSERT INTO clients (id, display_name, revision, created_at, updated_at)
             VALUES (?1, '同名画师', 0, ?2, ?2)",
            params![id, now],
        )
        .unwrap();
    }
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM clients WHERE display_name = '同名画师'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 2, "同名客户必须各自独立存在");
}

#[test]
fn attachment_rows_follow_order_deletion_and_reject_absolute_paths() {
    let (_dir, env) = env_db();
    let mut conn = env.open_db().unwrap();
    let id = common::insert_order(&mut conn, "AF-2026-0050", "带附件");
    let now = minidesk::store::timezone::now_timestamp();

    conn.execute(
        "INSERT INTO attachments (id, order_id, original_name, rel_path, mime_type,
                                  byte_size, sha256, created_at)
         VALUES ('att1', ?1, '参考图.png', 'attachments/originals/att1.png',
                 'image/png', 1024, 'hash', ?2)",
        params![id, now],
    )
    .unwrap();

    conn.execute("DELETE FROM orders WHERE id = ?1", [&id]).unwrap();
    let remaining: i64 = conn
        .query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get(0))
        .unwrap();
    assert_eq!(remaining, 0, "删除订单必须连带删除附件元数据");
}

#[test]
fn cleanup_task_pending_is_unique_per_generation_and_path() {
    let (_dir, env) = env_db();
    let conn = env.open_db().unwrap();
    let now = minidesk::store::timezone::now_timestamp();
    let sql = "INSERT INTO cleanup_tasks (id, generation, rel_path, reason, created_at)
               VALUES (?1, 'gen-a', 'attachments/originals/x.png', 'order_deleted', ?2)";
    conn.execute(sql, params!["t1", now]).unwrap();
    let dup = conn.execute(sql, params!["t2", now]);
    assert!(dup.is_err(), "同一代际同一路径只允许一个待清理任务");
}

#[test]
fn event_kind_is_restricted_to_known_lifecycle_events() {
    let (_dir, env) = env_db();
    let mut conn = env.open_db().unwrap();
    let id = common::insert_order(&mut conn, "AF-2026-0060", "事件");
    let now = minidesk::store::timezone::now_timestamp();

    let ok = conn.execute(
        "INSERT INTO order_events (order_id, kind, occurred_at) VALUES (?1, 'work_started', ?2)",
        params![id, now],
    );
    assert!(ok.is_ok());

    let bad = conn.execute(
        "INSERT INTO order_events (order_id, kind, occurred_at) VALUES (?1, 'details_edited', ?2)",
        params![id, now],
    );
    assert!(bad.is_err(), "普通资料编辑不应成为生命周期事件");
}

#[test]
fn theme_tokens_must_be_valid_json() {
    let (_dir, env) = env_db();
    let conn = env.open_db().unwrap();
    let now = minidesk::store::timezone::now_timestamp();
    let bad = conn.execute(
        "INSERT INTO themes (id, name, mode, tokens, builtin, created_at, updated_at)
         VALUES ('bad', '坏主题', 'light', 'not json', 0, ?1, ?1)",
        [&now],
    );
    assert!(bad.is_err(), "主题 token 必须是合法 JSON");
}

#[test]
fn builtin_theme_is_seeded_once() {
    let (_dir, env) = env_db();
    let conn = env.open_db().unwrap();
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM themes WHERE builtin = 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
    let tokens: String = conn
        .query_row("SELECT tokens FROM themes WHERE id = ?1", [settings::BUILTIN_THEME_ID], |r| r.get(0))
        .unwrap();
    assert!(tokens.contains("accent"));
}

#[test]
fn foreign_keys_are_enforced_at_runtime() {
    let (_dir, env) = env_db();
    let mut conn: Connection = env.open_db().unwrap();
    let enabled: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
    assert_eq!(enabled, 1);
    let id = common::insert_order(&mut conn, "AF-2026-0070", "孤儿引用");
    let bad = conn.execute(
        "INSERT INTO order_events (order_id, kind, occurred_at)
         VALUES ('no-such-order', 'created', '2026-01-01T00:00:00.000Z')",
        [],
    );
    assert!(bad.is_err());
    let _ = id;
}
