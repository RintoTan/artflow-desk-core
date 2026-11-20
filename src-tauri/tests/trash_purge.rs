//! DEV-0.1.1-03C：永久删除与附件物理清理。
//!
//! 这一层的核心命题不是「能删」，而是**删完之后不留下无人知晓、无法重试的文件**：
//! - 路径必须在删行之前读出（否则 CASCADE 一带走就再也找不到文件）；
//! - 任务登记与删行在同一事务（否则行没了、任务没写，文件永久残留且无记录）；
//! - 文件删除只在提交之后（否则回滚会把文件变成孤儿）；
//! - 结果只按本次真实任务 ID 归因（否则会把别人的清理算成自己的成绩）；
//! - 失败必须留在可重试状态，且不能对用户谎称「全部清理完成」。

mod common;

use std::fs;
use std::path::PathBuf;

use common::Ctx;
use minidesk::domain::clients::{self, CreateClientInput};
use minidesk::domain::orders::{self, ClientChoice, CreateOrderInput};
use minidesk::domain::trash;

fn new_client(ctx: &Ctx, name: &str) -> String {
    let conn = ctx.conn();
    clients::create(
        &conn,
        CreateClientInput {
            display_name: name.into(),
            contact: None,
            note: None,
        },
    )
    .unwrap()
    .id
}

fn new_order(ctx: &Ctx, client_id: &str, title: &str) -> String {
    let mut conn = ctx.conn();
    orders::create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        CreateOrderInput {
            title: title.into(),
            client: ClientChoice::Existing {
                client_id: client_id.into(),
            },
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

/// 造一条附件记录，并把原图与缩略图真的写到磁盘上。
fn attach(ctx: &Ctx, order_id: &str, id: &str) -> (PathBuf, PathBuf) {
    let generation = ctx.env.active_generation().to_string();
    let base = ctx.env.layout().attachments_dir(&generation);
    let originals = base.join("originals");
    let thumbs = base.join("thumbs");
    fs::create_dir_all(&originals).unwrap();
    fs::create_dir_all(&thumbs).unwrap();

    let original = originals.join(format!("{id}.png"));
    let thumb = thumbs.join(format!("{id}.webp"));
    fs::write(&original, b"original").unwrap();
    fs::write(&thumb, b"thumb").unwrap();

    let conn = ctx.conn();
    conn.execute(
        "INSERT INTO attachments (id, order_id, original_name, rel_path, thumb_rel_path,
                                  mime_type, byte_size, sha256, state, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'image/png', 8, 'aa', 'ok',
                 '2026-11-20T00:00:00+08:00')",
        rusqlite::params![
            id,
            order_id,
            format!("{id}.png"),
            format!("attachments/originals/{id}.png"),
            format!("attachments/thumbs/{id}.webp")
        ],
    )
    .unwrap();
    (original, thumb)
}

fn count(conn: &rusqlite::Connection, sql: &str, arg: &str) -> i64 {
    conn.query_row(sql, [arg], |r| r.get(0)).unwrap()
}

fn task_state(conn: &rusqlite::Connection, rel_path: &str) -> Option<(String, String, i64)> {
    conn.query_row(
        "SELECT state, reason, attempts FROM cleanup_tasks WHERE rel_path = ?1
          ORDER BY created_at DESC LIMIT 1",
        [rel_path],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .ok()
}

fn purge(ctx: &Ctx, order_id: &str) -> minidesk::domain::trash::PurgeResult {
    let mut conn = ctx.conn();
    let layout = ctx.env.layout().clone();
    let generation = ctx.env.active_generation().to_string();
    trash::purge_order(&mut conn, &layout, &generation, order_id).unwrap()
}

#[test]
fn refuses_to_purge_a_live_order() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "活客户");
    let order = new_order(&ctx, &client, "活订单");

    let mut conn = ctx.conn();
    let layout = ctx.env.layout().clone();
    let generation = ctx.env.active_generation().to_string();
    let err = trash::purge_order(&mut conn, &layout, &generation, &order).unwrap_err();
    assert_eq!(err.code, "CONFLICT");
    assert!(err.message.contains("只能永久删除回收站"), "{}", err.message);
    assert_eq!(orders::list(&conn).unwrap().len(), 1, "有效订单必须留着");
}

#[test]
fn purge_order_removes_rows_and_files() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "客户");
    let order = new_order(&ctx, &client, "要删的");
    let other = new_order(&ctx, &client, "留着的");
    let (original, thumb) = attach(&ctx, &order, "a1");
    let (keep_original, _) = attach(&ctx, &other, "a2");

    let mut conn = ctx.conn();
    trash::delete_order(&mut conn, &order).unwrap();

    let result = purge(&ctx, &order);
    assert_eq!(result.orders_purged, 1);
    assert_eq!(result.attachments_removed, 1);
    assert_eq!(result.files_registered, 2, "原图 + 缩略图各一条任务");
    assert_eq!(result.cleanup.cleaned, 2);
    assert_eq!(result.cleanup.pending, 0);

    let conn = ctx.conn();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders WHERE id = ?1", &order), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM order_events WHERE order_id = ?1", &order), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM order_stages WHERE order_id = ?1", &order), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM attachments WHERE order_id = ?1", &order), 0);

    assert!(!original.exists(), "原图必须被删掉");
    assert!(!thumb.exists(), "缩略图必须被删掉");
    assert!(keep_original.exists(), "别的订单的附件不能被误删");

    // 任务记录保留为 done，便于排障。
    let state = task_state(&conn, "attachments/originals/a1.png").unwrap();
    assert_eq!(state.0, "done");
    assert_eq!(state.1, "purge");
}

#[test]
fn purge_group_clears_client_orders_and_tags_without_orphans() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "整组");
    let a = new_order(&ctx, &client, "A");
    let b = new_order(&ctx, &client, "B");
    let (a_original, _) = attach(&ctx, &a, "ga");
    let (b_original, _) = attach(&ctx, &b, "gb");

    let mut conn = ctx.conn();
    let tag = clients::create_tag(&conn, "常客").unwrap();
    clients::link_tag(&conn, &client, &tag.id).unwrap();
    trash::delete_client(&mut conn, &client).unwrap();

    let layout = ctx.env.layout().clone();
    let generation = ctx.env.active_generation().to_string();
    let result = trash::purge_client_group(&mut conn, &layout, &generation, &client).unwrap();
    assert_eq!(result.clients_purged, 1);
    assert_eq!(result.orders_purged, 2);
    assert_eq!(result.files_registered, 4);
    assert_eq!(result.cleanup.cleaned, 4);

    let conn = ctx.conn();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders WHERE client_id = ?1", &client), 0, "不得留下孤儿订单");
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM clients WHERE id = ?1", &client), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM client_tag_link WHERE client_id = ?1", &client), 0);
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM client_tags WHERE id = ?1", &tag.id),
        1,
        "标签本身不删"
    );
    assert!(!a_original.exists() && !b_original.exists());
}

#[test]
fn purge_group_aborts_on_batch_mismatch() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "异常批次");
    let a = new_order(&ctx, &client, "A");
    let b = new_order(&ctx, &client, "B");
    let (a_original, _) = attach(&ctx, &a, "ba");

    let mut conn = ctx.conn();
    trash::delete_client(&mut conn, &client).unwrap();
    conn.execute("UPDATE orders SET deleted_batch = 'legacy' WHERE id = ?1", [&b])
        .unwrap();

    let layout = ctx.env.layout().clone();
    let generation = ctx.env.active_generation().to_string();
    let err = trash::purge_client_group(&mut conn, &layout, &generation, &client).unwrap_err();
    assert_eq!(err.code, "INTEGRITY");

    let conn = ctx.conn();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders WHERE client_id = ?1", &client), 2, "整批回滚");
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM clients WHERE id = ?1", &client), 1);
    assert!(a_original.exists(), "回滚后文件仍在");
}

#[test]
fn purge_order_refuses_when_client_is_in_trash() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "组内");
    let order = new_order(&ctx, &client, "单");

    let mut conn = ctx.conn();
    trash::delete_client(&mut conn, &client).unwrap();

    let layout = ctx.env.layout().clone();
    let generation = ctx.env.active_generation().to_string();
    let err = trash::purge_order(&mut conn, &layout, &generation, &order).unwrap_err();
    assert_eq!(err.code, "CONFLICT");
    assert!(err.message.contains("整批永久删除"), "{}", err.message);
}

#[test]
fn task_registration_failure_rolls_back_the_whole_delete() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "触发器");
    let order = new_order(&ctx, &client, "会失败");
    let (original, thumb) = attach(&ctx, &order, "boom");

    let mut conn = ctx.conn();
    trash::delete_order(&mut conn, &order).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER fail_purge_task BEFORE INSERT ON cleanup_tasks
         WHEN NEW.rel_path LIKE '%boom%'
         BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    )
    .unwrap();

    let layout = ctx.env.layout().clone();
    let generation = ctx.env.active_generation().to_string();
    let err = trash::purge_order(&mut conn, &layout, &generation, &order).unwrap_err();
    assert!(err.message.contains("boom") || err.code != "OK", "应报错：{}", err.message);

    let conn = ctx.conn();
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM orders WHERE id = ?1", &order),
        1,
        "登记失败必须回滚删行"
    );
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM attachments WHERE order_id = ?1", &order), 1);
    let leftover: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cleanup_tasks WHERE rel_path LIKE '%boom%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(leftover, 0, "不得留下半条任务");
    // 关键时序证据：事务失败时文件仍然存在——说明文件删除发生在提交之后。
    assert!(original.exists() && thumb.exists(), "回滚时不得删文件");
}

#[test]
fn existing_pending_task_is_reused_and_promoted_to_purge() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "复用");
    let order = new_order(&ctx, &client, "单");
    let (original, _) = attach(&ctx, &order, "reuse");

    let mut conn = ctx.conn();
    trash::delete_order(&mut conn, &order).unwrap();

    let generation = ctx.env.active_generation().to_string();
    // 模拟「此前删除附件留下的 pending 任务」，id 与我们生成的不同。
    conn.execute(
        "INSERT INTO cleanup_tasks (id, generation, order_id, rel_path, reason, created_at)
         VALUES ('cl-legacy-0', ?1, ?2, 'attachments/originals/reuse.png',
                 'attachment_removed', '2026-11-19T00:00:00+08:00')",
        rusqlite::params![generation, order],
    )
    .unwrap();

    let result = purge(&ctx, &order);
    assert_eq!(result.cleanup.cleaned, 2, "复用任务也要算进本次结果");

    let conn = ctx.conn();
    let rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cleanup_tasks WHERE rel_path = 'attachments/originals/reuse.png'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rows, 1, "部分唯一索引不应产生重复行");
    let state = task_state(&conn, "attachments/originals/reuse.png").unwrap();
    assert_eq!(state.0, "done");
    assert_eq!(state.1, "purge", "复用任务必须被提升为 purge，才能进专属重试");
    assert!(!original.exists());
}

#[test]
fn result_attribution_ignores_other_cleanup_tasks() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "归因");
    let order = new_order(&ctx, &client, "单");
    let (original, _) = attach(&ctx, &order, "mine");

    // 别人的任务：路径是个目录，执行器会 refused → failed。
    let generation = ctx.env.active_generation().to_string();
    let base = ctx.env.layout().attachments_dir(&generation);
    let foreign_dir = base.join("originals").join("foreign");
    fs::create_dir_all(&foreign_dir).unwrap();

    let mut conn = ctx.conn();
    trash::delete_order(&mut conn, &order).unwrap();
    conn.execute(
        "INSERT INTO cleanup_tasks (id, generation, order_id, rel_path, reason, created_at)
         VALUES ('cl-foreign-0', ?1, NULL, 'attachments/originals/foreign',
                 'attachment_removed', '2026-11-19T00:00:00+08:00')",
        [&generation],
    )
    .unwrap();

    let result = purge(&ctx, &order);
    assert_eq!(result.cleanup.cleaned, 2, "自己的两个文件清理完成");
    assert_eq!(
        result.cleanup.pending, 0,
        "别人的失败任务不能算进本次结果"
    );
    assert!(!original.exists());

    // 但那条别人的任务确实失败了（全局视角），说明归因是分开的。
    let state = task_state(&ctx.conn(), "attachments/originals/foreign").unwrap();
    assert_eq!(state.0, "failed");
}

#[cfg(unix)]
#[test]
fn reports_pending_instead_of_claiming_success_when_file_cannot_be_removed() {
    use std::os::unix::fs::PermissionsExt;

    let ctx = Ctx::new();
    let client = new_client(&ctx, "只读");
    let order = new_order(&ctx, &client, "删不掉");
    let (original, thumb) = attach(&ctx, &order, "locked");

    let mut conn = ctx.conn();
    trash::delete_order(&mut conn, &order).unwrap();

    let originals_dir = original.parent().unwrap().to_path_buf();
    fs::set_permissions(&originals_dir, fs::Permissions::from_mode(0o555)).unwrap();

    let layout = ctx.env.layout().clone();
    let generation = ctx.env.active_generation().to_string();
    let result = trash::purge_order(&mut conn, &layout, &generation, &order).unwrap();

    fs::set_permissions(&originals_dir, fs::Permissions::from_mode(0o755)).unwrap();

    // 数据库删除成功、文件清理失败：两件事必须分开报告。
    assert_eq!(result.orders_purged, 1);
    assert_eq!(result.cleanup.cleaned, 1, "缩略图目录可写，应清理成功");
    assert_eq!(result.cleanup.pending, 1, "原图清理失败要如实计入");
    assert!(result
        .cleanup
        .pending_paths
        .iter()
        .any(|p| p.ends_with("locked.png")));

    let conn = ctx.conn();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders WHERE id = ?1", &order), 0);
    let state = task_state(&conn, "attachments/originals/locked.png").unwrap();
    assert_eq!(state.0, "failed");
    assert!(original.exists(), "文件确实还在");
    assert!(!thumb.exists());
}

#[test]
fn purging_twice_is_a_not_found_not_a_duplicate_side_effect() {
    let ctx = Ctx::new();
    let client = new_client(&ctx, "重复");
    let order = new_order(&ctx, &client, "单");
    let _ = attach(&ctx, &order, "dup");

    let mut conn = ctx.conn();
    trash::delete_order(&mut conn, &order).unwrap();
    purge(&ctx, &order);

    let before: i64 = ctx
        .conn()
        .query_row("SELECT COUNT(*) FROM cleanup_tasks", [], |r| r.get(0))
        .unwrap();

    let layout = ctx.env.layout().clone();
    let generation = ctx.env.active_generation().to_string();
    let err = trash::purge_order(&mut conn, &layout, &generation, &order).unwrap_err();
    assert_eq!(err.code, "NOT_FOUND");

    let after: i64 = ctx
        .conn()
        .query_row("SELECT COUNT(*) FROM cleanup_tasks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(before, after, "重复调用不得新增任务");
}

#[test]
fn stale_generation_task_is_skipped_and_file_kept() {
    let ctx = Ctx::new();
    let generation = ctx.env.active_generation().to_string();
    let base = ctx.env.layout().attachments_dir(&generation);
    let originals = base.join("originals");
    fs::create_dir_all(&originals).unwrap();
    let file = originals.join("stale.png");
    fs::write(&file, b"old").unwrap();

    let conn = ctx.conn();
    conn.execute(
        "INSERT INTO cleanup_tasks (id, generation, order_id, rel_path, reason, created_at)
         VALUES ('pg-stale-0', 'gen-old', NULL, 'attachments/originals/stale.png',
                 'purge', '2026-11-19T00:00:00+08:00')",
        [],
    )
    .unwrap();
    drop(conn);

    let mut conn = ctx.conn();
    let layout = ctx.env.layout().clone();
    minidesk::domain::attachments::run_cleanup(&mut conn, &layout, &generation).unwrap();

    assert!(file.exists(), "旧代际任务绝不能删当前代的文件");
    let state = task_state(&conn, "attachments/originals/stale.png").unwrap();
    assert_eq!(state.0, "pending", "旧代际任务被跳过，保持待处理");
}

#[test]
fn auto_retry_is_capped_but_manual_retry_is_not() {
    let ctx = Ctx::new();
    let generation = ctx.env.active_generation().to_string();
    let base = ctx.env.layout().attachments_dir(&generation);
    let originals = base.join("originals");
    fs::create_dir_all(&originals).unwrap();
    for name in ["r1.png", "r2.png", "r3.png"] {
        fs::write(originals.join(name), b"x").unwrap();
    }

    let conn = ctx.conn();
    for (id, rel, attempts) in [
        ("t1", "attachments/originals/r1.png", 1),
        ("t2", "attachments/originals/r2.png", 2),
        ("t3", "attachments/originals/r3.png", 3),
    ] {
        conn.execute(
            "INSERT INTO cleanup_tasks (id, generation, rel_path, reason, state, attempts, created_at)
             VALUES (?1, ?2, ?3, 'purge', 'failed', ?4, '2026-11-19T00:00:00+08:00')",
            rusqlite::params![id, generation, rel, attempts],
        )
        .unwrap();
    }
    drop(conn);

    let conn = ctx.conn();
    let queued = trash::reset_purge_failures(&conn, &generation, Some(3)).unwrap();
    assert_eq!(queued, 2, "attempts=3 已达总尝试上限，不再自动重试");

    // 计数不被清零：这是真实尝试次数，不是重新开始。
    let r1: (String, i64) = conn
        .query_row(
            "SELECT state, attempts FROM cleanup_tasks WHERE id = 't1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(r1, ("pending".to_string(), 1));
    let r3: (String, i64) = conn
        .query_row(
            "SELECT state, attempts FROM cleanup_tasks WHERE id = 't3'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(r3, ("failed".to_string(), 3));
    drop(conn);

    // 手动重试不受上限约束，且不清零计数。
    let mut conn = ctx.conn();
    let layout = ctx.env.layout().clone();
    for id in ["t1", "t3"] {
        conn.execute("UPDATE cleanup_tasks SET state = 'failed' WHERE id = ?1", [id])
            .unwrap();
        conn.execute("UPDATE cleanup_tasks SET attempts = 3 WHERE id = ?1", [id])
            .unwrap();
    }
    let status = trash::retry_purge_cleanup(&mut conn, &layout, &generation).unwrap();
    assert_eq!(status.failed, 0, "手动重试后应无失败任务");

    let done: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cleanup_tasks WHERE state = 'done' AND id IN ('t1','t3')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(done, 2);
    let attempts: i64 = conn
        .query_row(
            "SELECT attempts FROM cleanup_tasks WHERE id = 't3'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(attempts, 4, "手动重试是在真实计数上继续累加");
}

#[test]
fn retry_never_touches_attachment_removed_tasks() {
    let ctx = Ctx::new();
    let generation = ctx.env.active_generation().to_string();
    let base = ctx.env.layout().attachments_dir(&generation);
    let originals = base.join("originals");
    fs::create_dir_all(&originals).unwrap();
    fs::write(originals.join("ar.png"), b"x").unwrap();
    fs::write(originals.join("pg.png"), b"x").unwrap();

    let conn = ctx.conn();
    for (id, rel, reason) in [
        ("ar1", "attachments/originals/ar.png", "attachment_removed"),
        ("pg1", "attachments/originals/pg.png", "purge"),
    ] {
        conn.execute(
            "INSERT INTO cleanup_tasks (id, generation, rel_path, reason, state, attempts, created_at)
             VALUES (?1, ?2, ?3, ?4, 'failed', 1, '2026-11-19T00:00:00+08:00')",
            rusqlite::params![id, generation, rel, reason],
        )
        .unwrap();
    }
    drop(conn);

    let conn = ctx.conn();
    trash::reset_purge_failures(&conn, &generation, Some(3)).unwrap();
    let ar_state: String = conn
        .query_row("SELECT state FROM cleanup_tasks WHERE id = 'ar1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(ar_state, "failed", "自动重试不得动 attachment_removed");

    let status = trash::purge_cleanup_status(&conn, &generation).unwrap();
    assert_eq!(status.failed, 0, "状态只统计 purge，不混入其他 reason");

    let pg_state: String = conn
        .query_row("SELECT state FROM cleanup_tasks WHERE id = 'pg1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(pg_state, "pending");
}

#[test]
fn empty_trash_commits_successful_batches_and_reports_the_failed_one() {
    let ctx = Ctx::new();
    let group_a = new_client(&ctx, "甲组");
    let a1 = new_order(&ctx, &group_a, "A1");
    let (a_original, _) = attach(&ctx, &a1, "ea");

    let group_b = new_client(&ctx, "乙组");
    let b1 = new_order(&ctx, &group_b, "B1");
    let (b_original, _) = attach(&ctx, &b1, "failb");

    let solo_client = new_client(&ctx, "散客");
    let solo = new_order(&ctx, &solo_client, "单独一单");

    let mut conn = ctx.conn();
    trash::delete_client(&mut conn, &group_a).unwrap();
    trash::delete_client(&mut conn, &group_b).unwrap();
    trash::delete_order(&mut conn, &solo).unwrap();

    // 让乙组在登记清理任务时失败：模拟该批次出问题。
    conn.execute_batch(
        "CREATE TRIGGER fail_group_b BEFORE INSERT ON cleanup_tasks
         WHEN NEW.rel_path LIKE '%failb%'
         BEGIN SELECT RAISE(ABORT, 'injected'); END;",
    )
    .unwrap();

    let layout = ctx.env.layout().clone();
    let generation = ctx.env.active_generation().to_string();
    let result = trash::empty_trash(&mut conn, &layout, &generation).unwrap();

    assert_eq!(result.purged_batches, 2, "甲组与独立订单应完成");
    assert_eq!(result.failed_batches, 1, "乙组失败");
    let failed = result.batches.iter().find(|b| !b.ok).expect("要有失败批次");
    assert!(failed.label.contains("乙组"));
    assert!(failed.error.as_deref().unwrap_or("").contains("injected"));

    let conn = ctx.conn();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM clients WHERE id = ?1", &group_a), 0);
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders WHERE client_id = ?1", &group_a), 0);
    assert!(!a_original.exists());

    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM clients WHERE id = ?1", &group_b),
        1,
        "失败批次必须整批保留，不能半删"
    );
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders WHERE client_id = ?1", &group_b), 1);
    assert!(b_original.exists());

    assert_eq!(count(&conn, "SELECT COUNT(*) FROM orders WHERE id = ?1", &solo), 0);
    // 失败不影响已经完成的批次，也不阻止后续批次。
    assert_eq!(
        trash::snapshot(&ctx.conn()).unwrap().group_count,
        1,
        "回收站里只剩失败的那一组"
    );
}

#[test]
fn empty_trash_on_empty_recycle_bin_is_a_no_op() {
    let ctx = Ctx::new();
    let mut conn = ctx.conn();
    let layout = ctx.env.layout().clone();
    let generation = ctx.env.active_generation().to_string();
    let result = trash::empty_trash(&mut conn, &layout, &generation).unwrap();
    assert_eq!(result.purged_batches, 0);
    assert_eq!(result.failed_batches, 0);
    assert!(result.batches.is_empty());
}
