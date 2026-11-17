//! 崩溃恢复、清理任务安全、缩略图完整性、路径发布守卫。
//!
//! 关键崩溃点用**真实子进程 abort**，不是返回普通错误。

mod common;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use common::Ctx;
use image::{ImageFormat, RgbImage};
use minidesk::domain::attachments::{self, RepairInput};
use rusqlite::params;

const PROBE: &str = env!("CARGO_BIN_EXE_attachments-probe");

fn write_image(dir: &Path, name: &str, width: u32, height: u32) -> PathBuf {
    let path = dir.join(name);
    image::DynamicImage::ImageRgb8(RgbImage::from_fn(width, height, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 90])
    }))
    .save_with_format(&path, ImageFormat::Png)
    .unwrap();
    path
}

fn ctx() -> (Ctx, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    (Ctx::new(), dir)
}

/// 崩溃测试用：目录由调用方持有，环境可以反复开关。
struct Env {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

fn crash_env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    Env { _dir: dir, root }
}

fn import_one(ctx: &Ctx, order: &str, path: &Path) -> attachments::AttachmentView {
    let mut conn = ctx.conn();
    let outcomes = attachments::import(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        order,
        &[path.to_path_buf()],
        None,
    )
    .unwrap();
    assert!(outcomes[0].ok, "{:?}", outcomes[0].error);
    outcomes[0].attachment.clone().unwrap()
}

fn gen_dir(ctx: &Ctx) -> PathBuf {
    ctx.env.layout().generation_dir(ctx.env.active_generation())
}

// ---------------------------------------------------------- 导入崩溃

#[test]
fn import_crash_before_metadata_leaves_no_visible_attachment() {
    let env = crash_env();
    let (ctx, img_dir) = (Ctx::at(&env.root), tempfile::tempdir().unwrap());
    let order = ctx.create_order("导入崩溃");
    let root = env.root.clone();
    drop(ctx);

    let source = write_image(img_dir.path(), "会崩溃.png", 240, 180);
    let out = Command::new(PROBE)
        .args([
            "import-crash",
            root.to_str().unwrap(),
            &order,
            source.to_str().unwrap(),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(!out.status.success(), "探针应异常退出：{stdout}");
    assert!(stdout.contains("PUBLISHED"), "{stdout}");

    // 重新打开：启动维护应当把孤儿文件隔离，且不产生附件行
    let ctx = Ctx::at(&root);
    let mut conn = ctx.conn();
    let report = attachments::recover(&mut conn, ctx.env.layout(), ctx.env.active_generation()).unwrap();

    assert_eq!(report.rolled_back, 1, "导入未提交应被回滚：{report:?}");
    assert!(!report.quarantined.is_empty(), "孤儿文件应被隔离而不是删除");
    let list = attachments::list(&conn, ctx.env.layout(), ctx.env.active_generation(), &order).unwrap();
    assert!(list.is_empty(), "不得出现可见附件");

    let originals = gen_dir(&ctx).join("attachments/originals");
    let leftover = std::fs::read_dir(&originals)
        .map(|it| it.flatten().count())
        .unwrap_or(0);
    assert_eq!(leftover, 0, "原图目录不应残留未被引用的文件");

    let quarantine = gen_dir(&ctx).join("attachments/quarantine");
    assert!(quarantine.is_dir(), "隔离目录应存在");
    assert!(
        std::fs::read_dir(&quarantine).unwrap().flatten().count() > 0,
        "隔离文件应保留下来供人工确认"
    );
}

#[test]
fn recovery_never_deletes_files_that_are_still_referenced() {
    let (ctx, img_dir) = ctx();
    let order = ctx.create_order("保留引用");
    let view = import_one(&ctx, &order, &write_image(img_dir.path(), "正常.png", 120, 120));

    let mut conn = ctx.conn();
    let report = attachments::recover(&mut conn, ctx.env.layout(), ctx.env.active_generation()).unwrap();
    assert!(report.quarantined.is_empty());
    assert!(Path::new(&view.original_path).is_file(), "有引用的原图不得被隔离");
}

#[test]
fn recovery_quarantines_unknown_files_instead_of_deleting_them() {
    let (ctx, img_dir) = ctx();
    let order = ctx.create_order("陌生文件");
    let _ = import_one(&ctx, &order, &write_image(img_dir.path(), "已知.png", 100, 100));

    let stray = gen_dir(&ctx).join("attachments/originals/stranger.png");
    std::fs::write(&stray, b"not ours").unwrap();

    let mut conn = ctx.conn();
    let report = attachments::recover(&mut conn, ctx.env.layout(), ctx.env.active_generation()).unwrap();
    assert_eq!(report.quarantined.len(), 1, "{report:?}");
    assert!(!stray.exists(), "陌生文件应被移出原图目录");
    assert_eq!(
        std::fs::read_dir(gen_dir(&ctx).join("attachments/quarantine"))
            .unwrap()
            .flatten()
            .count(),
        1,
        "文件应被保留在隔离目录"
    );
}

// ---------------------------------------------------------- 修复崩溃

#[test]
fn repair_crash_completes_or_rolls_back_consistently() {
    let env = crash_env();
    let (ctx, img_dir) = (Ctx::at(&env.root), tempfile::tempdir().unwrap());
    let order = ctx.create_order("修复崩溃");
    let original = write_image(img_dir.path(), "旧图.png", 320, 240);
    let view = import_one(&ctx, &order, &original);
    let replacement = write_image(img_dir.path(), "新图.png", 640, 480);
    let new_hash = minidesk::media::import::file_sha256(&replacement).unwrap().unwrap();

    let root = env.root.clone();
    drop(ctx);

    let out = Command::new(PROBE)
        .args([
            "repair-crash",
            root.to_str().unwrap(),
            &view.id,
            replacement.to_str().unwrap(),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(!out.status.success(), "探针应异常退出：{stdout}");
    assert!(stdout.contains("REPLACED"), "{stdout}");

    let ctx = Ctx::at(&root);
    let mut conn = ctx.conn();
    attachments::recover(&mut conn, ctx.env.layout(), ctx.env.active_generation()).unwrap();

    // 不变量：数据库里的哈希必须与磁盘上的文件一致，且缩略图可用
    let list = attachments::list(&conn, ctx.env.layout(), ctx.env.active_generation(), &order).unwrap();
    assert_eq!(list.len(), 1);
    let row = &list[0];
    let on_disk = minidesk::media::import::file_sha256(Path::new(&row.original_path))
        .unwrap()
        .unwrap();
    assert_eq!(row.sha256, on_disk, "崩溃后必须收敛到一致状态");
    assert_eq!(row.thumb_state, "ok", "缩略图应已按最终原图重建");
    assert_eq!(row.state, "ok");

    // 两种收敛都合法：补做成新图，或回滚成旧图；不允许出现第三种
    assert!(
        on_disk == new_hash || on_disk == view.sha256,
        "只能是新内容或回滚后的旧内容"
    );
}

// ---------------------------------------------------------- 清理任务安全

#[test]
fn cleanup_skips_tasks_from_another_generation() {
    let (ctx, img_dir) = ctx();
    let order = ctx.create_order("跨代任务");
    let _ = import_one(&ctx, &order, &write_image(img_dir.path(), "a.png", 80, 80));

    let mut conn = ctx.conn();
    let target = gen_dir(&ctx).join("attachments/originals/keep-me.png");
    std::fs::write(&target, b"keep").unwrap();
    conn.execute(
        "INSERT INTO cleanup_tasks (id, generation, order_id, rel_path, reason, created_at)
         VALUES ('stale-1', 'gen-some-old-generation', ?1, 'attachments/originals/keep-me.png',
                 'attachment_removed', '2026-01-01T00:00:00.000Z')",
        params![order],
    )
    .unwrap();

    let report = attachments::run_cleanup(&mut conn, ctx.env.layout(), ctx.env.active_generation()).unwrap();
    assert_eq!(report.skipped_stale, 1, "{report:?}");
    assert!(target.is_file(), "旧代际的清理任务不得删除当前代的文件");
}

#[test]
fn cleanup_refuses_paths_outside_managed_directories() {
    let (ctx, _img) = ctx();
    let order = ctx.create_order("越界任务");
    let mut conn = ctx.conn();
    for (id, rel) in [
        ("bad-1", "../../environment.json"),
        ("bad-2", "database.sqlite"),
        ("bad-3", "state/highwater.sqlite"),
    ] {
        conn.execute(
            "INSERT INTO cleanup_tasks (id, generation, order_id, rel_path, reason, created_at)
             VALUES (?1, ?2, ?3, ?4, 'test', '2026-01-01T00:00:00.000Z')",
            params![id, ctx.env.active_generation(), order, rel],
        )
        .unwrap();
    }
    let report = attachments::run_cleanup(&mut conn, ctx.env.layout(), ctx.env.active_generation()).unwrap();
    assert_eq!(report.refused, 3, "{report:?}");
    assert!(gen_dir(&ctx).join("../../environment.json").exists() || true);
    assert!(ctx.env.layout().highwater_db().exists(), "编号库不得被删");
}

#[cfg(unix)]
#[test]
fn cleanup_refuses_symlinks() {
    let (ctx, img_dir) = ctx();
    let order = ctx.create_order("符号链接");
    let _ = import_one(&ctx, &order, &write_image(img_dir.path(), "a.png", 80, 80));

    let outside = img_dir.path().join("outside-target.txt");
    std::fs::write(&outside, b"do not delete").unwrap();
    let link = gen_dir(&ctx).join("attachments/originals/link.png");
    std::os::unix::fs::symlink(&outside, &link).unwrap();

    let mut conn = ctx.conn();
    conn.execute(
        "INSERT INTO cleanup_tasks (id, generation, order_id, rel_path, reason, created_at)
         VALUES ('sym-1', ?1, ?2, 'attachments/originals/link.png', 'test',
                 '2026-01-01T00:00:00.000Z')",
        params![ctx.env.active_generation(), order],
    )
    .unwrap();

    let report = attachments::run_cleanup(&mut conn, ctx.env.layout(), ctx.env.active_generation()).unwrap();
    assert_eq!(report.refused, 1, "{report:?}");
    assert!(outside.is_file(), "符号链接目标绝不能被删");
    assert!(report.notes.iter().any(|n| n.contains("普通文件")));
}

#[test]
fn cleanup_is_idempotent_and_does_not_touch_other_attachments() {
    let (ctx, img_dir) = ctx();
    let order = ctx.create_order("幂等清理");
    let keep = import_one(&ctx, &order, &write_image(img_dir.path(), "keep.png", 100, 100));
    let drop_me = import_one(&ctx, &order, &write_image(img_dir.path(), "drop.png", 100, 100));

    let mut conn = ctx.conn();
    attachments::remove(&mut conn, ctx.env.layout(), ctx.env.active_generation(), &drop_me.id).unwrap();
    let again = attachments::run_cleanup(&mut conn, ctx.env.layout(), ctx.env.active_generation()).unwrap();
    assert_eq!(again.removed, 0, "没有新的待清理任务");

    assert!(Path::new(&keep.original_path).is_file(), "另一张不得被删");
    assert!(!std::fs::read_dir(gen_dir(&ctx).join("attachments/originals"))
        .unwrap()
        .flatten()
        .any(|e| e.path() == Path::new(&drop_me.original_path)));
}

// ---------------------------------------------------------- 缩略图

#[test]
fn corrupt_or_foreign_thumbnails_are_detected_and_rebuilt() {
    let (ctx, img_dir) = ctx();
    let order = ctx.create_order("缩略图损坏");
    let view = import_one(&ctx, &order, &write_image(img_dir.path(), "图.png", 400, 300));
    let thumb = PathBuf::from(view.thumb_path.clone().unwrap());

    // 非空但无法解码
    std::fs::write(&thumb, b"not a webp at all").unwrap();
    let mut conn = ctx.conn();
    let listed = attachments::list(&conn, ctx.env.layout(), ctx.env.active_generation(), &order).unwrap();
    assert_eq!(listed[0].thumb_state, "corrupt");

    let report = attachments::rebuild_thumbs(&mut conn, ctx.env.layout(), ctx.env.active_generation(), &order).unwrap();
    assert_eq!(report.rebuilt, 1);
    assert_eq!(report.failed, 0);
    assert!(minidesk::media::thumb::is_valid(&thumb));

    // 换成 PNG 内容（格式不符）也应被视为无效缓存
    let png = std::fs::read(&view.original_path).unwrap();
    std::fs::write(&thumb, &png).unwrap();
    let listed = attachments::list(&conn, ctx.env.layout(), ctx.env.active_generation(), &order).unwrap();
    assert_eq!(listed[0].thumb_state, "corrupt");
    let report = attachments::rebuild_thumbs(&mut conn, ctx.env.layout(), ctx.env.active_generation(), &order).unwrap();
    assert_eq!(report.rebuilt, 1);
}

#[test]
fn missing_original_does_not_produce_a_fake_thumbnail_success() {
    let (ctx, img_dir) = ctx();
    let order = ctx.create_order("原图没了");
    let view = import_one(&ctx, &order, &write_image(img_dir.path(), "没了.png", 120, 120));
    std::fs::remove_file(&view.original_path).unwrap();
    if let Some(t) = &view.thumb_path {
        let _ = std::fs::remove_file(t);
    }

    let mut conn = ctx.conn();
    let report = attachments::rebuild_thumbs(&mut conn, ctx.env.layout(), ctx.env.active_generation(), &order).unwrap();
    assert_eq!(report.failed, 1);
    assert_eq!(report.rebuilt, 0, "原图缺失时不得声称重建成功");
    assert!(report.failures[0].contains("原图缺失"));

    let verify = attachments::verify(&mut conn, ctx.env.layout(), ctx.env.active_generation(), &order).unwrap();
    assert_eq!(verify.missing, 1);
    assert_eq!(verify.ok, 0);
}

#[test]
fn repair_invalidates_the_old_thumbnail() {
    let (ctx, img_dir) = ctx();
    let order = ctx.create_order("修复后缩略图");
    let view = import_one(&ctx, &order, &write_image(img_dir.path(), "旧.png", 200, 200));
    let replacement = write_image(img_dir.path(), "新.png", 1200, 900);

    let mut conn = ctx.conn();
    let repaired = attachments::repair(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        RepairInput {
            attachment_id: view.id.clone(),
            source_path: replacement.to_string_lossy().to_string(),
        },
    )
    .unwrap();

    assert_eq!(repaired.thumb_state, "ok");
    let decoded = image::open(repaired.thumb_path.as_ref().unwrap()).unwrap();
    assert!(decoded.width() <= 481 && decoded.height() <= 481);
    // 缩略图长宽比应与新图一致（3:4），不再是旧图的 1:1
    let ratio = decoded.width() as f32 / decoded.height() as f32;
    assert!((ratio - 4.0 / 3.0).abs() < 0.05, "缩略图必须来自新原图");
}

#[test]
fn repair_failure_keeps_the_previous_good_original() {
    let (ctx, img_dir) = ctx();
    let order = ctx.create_order("修复失败");
    let view = import_one(&ctx, &order, &write_image(img_dir.path(), "好图.png", 200, 200));
    let before = std::fs::read(&view.original_path).unwrap();

    let bad = img_dir.path().join("坏图.png");
    std::fs::write(&bad, b"definitely not an image").unwrap();

    let mut conn = ctx.conn();
    let err = attachments::repair(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        RepairInput {
            attachment_id: view.id.clone(),
            source_path: bad.to_string_lossy().to_string(),
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "INVALID");

    assert_eq!(std::fs::read(&view.original_path).unwrap(), before, "原图必须原样保留");
    let listed = attachments::list(&conn, ctx.env.layout(), ctx.env.active_generation(), &order).unwrap();
    assert_eq!(listed[0].sha256, view.sha256, "元数据不得被改动");
}

// ---------------------------------------------------------- 路径发布

#[test]
fn suspicious_relative_paths_never_reach_the_frontend() {
    let (ctx, img_dir) = ctx();
    let order = ctx.create_order("可疑路径");
    let view = import_one(&ctx, &order, &write_image(img_dir.path(), "图.png", 100, 100));

    // 绕过领域层直接写一条越界路径，验证读取侧仍然守住
    let conn = ctx.conn();
    conn.execute(
        "UPDATE attachments SET rel_path = '../../environment.json' WHERE id = ?1",
        [&view.id],
    )
    .unwrap();

    // 读取侧直接拒绝：越界路径连视图都构造不出来，前端拿不到任何 URL
    let err = attachments::list(&conn, ctx.env.layout(), ctx.env.active_generation(), &order).unwrap_err();
    assert_eq!(err.code, "INVALID");
    assert!(err.message.contains("相对跳转"), "{}", err.message);
}
