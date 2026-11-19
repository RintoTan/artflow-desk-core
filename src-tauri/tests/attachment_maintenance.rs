//! 附件维护：quarantine 盘点/清理与 `attachment_jobs` 清理边界。

mod common;

use std::fs;
use std::path::PathBuf;

use common::Ctx;
use minidesk::domain::maintenance::{self, PruneInput};
use minidesk::store::paths::Layout;

fn quarantine_dir(ctx: &Ctx) -> PathBuf {
    let generation = ctx.env.active_generation().to_string();
    ctx.env
        .layout()
        .generation_dir(&generation)
        .join("attachments/quarantine")
}

fn write_quarantine(ctx: &Ctx, name: &str, bytes: &[u8]) {
    let dir = quarantine_dir(ctx);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(name), bytes).unwrap();
}

#[test]
fn quarantine_report_separates_referenced_from_orphan() {
    let ctx = Ctx::new();
    write_quarantine(&ctx, "orphan-a.png", b"aaaa");
    write_quarantine(&ctx, "orphan-b.png", b"bbbbbb");

    // 造一条仍指向 quarantine 的作业：这类文件绝不能被当成孤儿。
    let conn = ctx.conn();
    conn.execute(
        "INSERT INTO attachment_jobs (id, attachment_id, generation, kind, rel_path, state, created_at, updated_at)
         VALUES ('job-keep', 'att-job-keep', ?1, 'import', 'attachments/quarantine/kept.png', 'failed',
                 '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z')",
        [ctx.env.active_generation()],
    )
    .unwrap();
    write_quarantine(&ctx, "kept.png", b"keep");

    let report = maintenance::quarantine_report(&ctx.env.open_db().unwrap(), ctx.env.layout(), ctx.env.active_generation())
        .unwrap();
    assert_eq!(report.items.len(), 3);
    assert_eq!(report.referenced_count, 1);
    assert_eq!(report.removable_count, 2);
    assert_eq!(report.total_bytes, 4 + 6 + 4);
    assert_eq!(report.removable_bytes, 10);
    assert!(report.items.iter().any(|i| i.name == "kept.png" && i.referenced));
}

#[test]
fn clearing_skips_referenced_and_unsafe_names() {
    let ctx = Ctx::new();
    write_quarantine(&ctx, "orphan.png", b"xxxx");

    let conn = ctx.conn();
    conn.execute(
        "INSERT INTO attachment_jobs (id, attachment_id, generation, kind, rel_path, state, created_at, updated_at)
         VALUES ('job-keep', 'att-job-keep', ?1, 'import', 'attachments/quarantine/kept.png', 'failed',
                 '2026-11-20T00:00:00Z', '2026-11-20T00:00:00Z')",
        [ctx.env.active_generation()],
    )
    .unwrap();
    write_quarantine(&ctx, "kept.png", b"keep");

    let cleared = maintenance::quarantine_clear(
        &ctx.env.open_db().unwrap(),
        ctx.env.layout(),
        ctx.env.active_generation(),
        &[
            "orphan.png".to_string(),
            "kept.png".to_string(),           // 有引用 → 跳过
            "../escape.txt".to_string(),      // 越界 → 跳过
            "/tmp/absolute.txt".to_string(),  // 绝对路径 → 跳过
        ],
    )
    .unwrap();

    assert_eq!(cleared.removed, 1);
    assert_eq!(cleared.skipped_referenced, 1);
    assert_eq!(cleared.skipped_unsafe, 2);
    assert_eq!(cleared.bytes_freed, 4);

    let dir = quarantine_dir(&ctx);
    assert!(!dir.join("orphan.png").exists());
    assert!(dir.join("kept.png").exists(), "有引用的文件必须保留");
}

#[test]
fn prune_never_touches_pending_or_open_jobs() {
    let ctx = Ctx::new();
    let mut conn = ctx.conn();
    let generation = ctx.env.active_generation().to_string();
    conn.execute(
        "INSERT INTO attachment_jobs (id, attachment_id, generation, kind, rel_path, state, created_at, updated_at)
         VALUES ('old-done', 'att-old-done', ?1, 'import', 'attachments/originals/x.png', 'done',
                 '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
                ('old-failed', 'att-old-failed', ?1, 'import', 'attachments/originals/y.png', 'failed',
                 '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
                ('old-pending', 'att-old-pending', ?1, 'import', 'attachments/originals/z.png', 'pending',
                 '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z'),
                ('new-done', 'att-new-done', ?1, 'import', 'attachments/originals/v.png', 'done',
                 '2026-11-19T00:00:00Z', '2026-11-19T00:00:00Z')",
        [&generation],
    )
    .unwrap();

    let dry = maintenance::jobs_prune(
        &mut conn,
        &PruneInput {
            older_than_days: 30,
            dry_run: true,
        },
    )
    .unwrap();
    assert_eq!(dry.matched, 2, "只有两条老的 done/failed 命中");
    assert_eq!(dry.removed, 0, "预览模式不删");
    assert_eq!(dry.kept_pending, 1, "pending 不计入清理");

    let real = maintenance::jobs_prune(
        &mut conn,
        &PruneInput {
            older_than_days: 30,
            dry_run: false,
        },
    )
    .unwrap();
    assert_eq!(real.removed, 2);

    let states: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT state FROM attachment_jobs ORDER BY id")
            .unwrap();
        stmt.query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    assert_eq!(states, vec!["done", "pending"]);
}

#[test]
fn jobs_report_counts_match_table() {
    let ctx = Ctx::new();
    let conn0 = ctx.conn();
    conn0
        .execute(
            "INSERT INTO attachment_jobs (id, attachment_id, generation, kind, rel_path, state, created_at, updated_at)
             VALUES ('a', 'att-a', ?1, 'import', 'x', 'done', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [ctx.env.active_generation()],
        )
        .unwrap();
    let report = maintenance::jobs_report(&conn0, 30).unwrap();
    assert_eq!(report.counts.total, 1);
    assert_eq!(report.counts.done, 1);
    assert_eq!(report.prunable, 1);
    assert_eq!(report.oldest_done_at.as_deref(), Some("2026-01-01T00:00:00Z"));
}

#[test]
fn quarantine_clear_on_missing_generation_dir_is_safe() {
    let ctx = Ctx::new();
    let layout = Layout::new(&std::env::temp_dir().join("artflow-no-such-root"));
    let cleared = maintenance::quarantine_clear(
        &ctx.env.open_db().unwrap(),
        &layout,
        "gen-missing",
        &["whatever.png".to_string()],
    )
    .unwrap();
    assert_eq!(cleared.removed, 0);
    assert_eq!(cleared.errors.len(), 1);
}
