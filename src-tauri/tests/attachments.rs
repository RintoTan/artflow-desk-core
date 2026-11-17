//! DEV-04 附件：导入校验、缩略图、移除清理、校验与修复、跨订单隔离。

mod common;

use std::path::{Path, PathBuf};

use common::Ctx;
use image::{DynamicImage, ImageFormat, RgbImage};
use minidesk::domain::attachments::{
    self, RepairInput, UpdateAttachmentMetaInput,
};

fn write_image(dir: &Path, name: &str, width: u32, height: u32, format: ImageFormat) -> PathBuf {
    let path = dir.join(name);
    let img = DynamicImage::ImageRgb8(RgbImage::from_fn(width, height, |x, y| {
        image::Rgb([(x % 256) as u8, (y % 256) as u8, 120])
    }));
    img.save_with_format(&path, format).expect("写入测试图片失败");
    path
}

fn import_one(ctx: &Ctx, order_id: &str, path: &Path) -> attachments::AttachmentView {
    let mut conn = ctx.conn();
    let outcomes = attachments::import(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        order_id,
        &[path.to_path_buf()],
        None,
    )
    .unwrap();
    assert_eq!(outcomes.len(), 1);
    let outcome = &outcomes[0];
    assert!(outcome.ok, "导入失败：{:?}", outcome.error);
    outcome.attachment.clone().unwrap()
}

fn list(ctx: &Ctx, order_id: &str) -> Vec<attachments::AttachmentView> {
    let conn = ctx.conn();
    attachments::list(
        &conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        order_id,
    )
    .unwrap()
}

#[test]
fn imports_png_with_original_thumbnail_and_hash() {
    let ctx = Ctx::new();
    let order = ctx.create_order("带图订单");
    let dir = tempfile::tempdir().unwrap();
    let source = write_image(dir.path(), "参考图.png", 900, 600, ImageFormat::Png);

    let view = import_one(&ctx, &order, &source);

    assert_eq!(view.original_name, "参考图.png");
    assert_eq!(view.mime_type, "image/png");
    assert_eq!(view.state, "ok");
    assert_eq!(view.width, Some(900));
    assert_eq!(view.height, Some(600));
    assert!(view.file_exists);
    assert!(view.thumb_exists, "应生成缩略图");

    // 原图是逐字节复制，哈希与源文件一致
    let source_hash = minidesk::media::import::file_sha256(&source).unwrap().unwrap();
    assert_eq!(view.sha256, source_hash);
    assert_eq!(
        std::fs::metadata(&view.original_path).unwrap().len() as i64,
        view.byte_size
    );

    // 缩略图是独立的 WebP 缓存
    let thumb = view.thumb_path.clone().unwrap();
    assert!(thumb.ends_with(".webp"));
    let thumb_bytes = std::fs::read(&thumb).unwrap();
    let decoded = image::load_from_memory(&thumb_bytes).unwrap();
    assert!(decoded.width().max(decoded.height()) <= 480);
}

#[test]
fn accepts_jpeg_and_webp() {
    let ctx = Ctx::new();
    let order = ctx.create_order("多格式");
    let dir = tempfile::tempdir().unwrap();

    for (name, format, mime) in [
        ("a.jpg", ImageFormat::Jpeg, "image/jpeg"),
        ("b.webp", ImageFormat::WebP, "image/webp"),
    ] {
        let source = write_image(dir.path(), name, 320, 200, format);
        let view = import_one(&ctx, &order, &source);
        assert_eq!(view.mime_type, mime, "{name}");
        assert_eq!(view.state, "ok");
    }
    assert_eq!(list(&ctx, &order).len(), 2);
}

#[test]
fn format_is_detected_from_bytes_not_from_extension() {
    let ctx = Ctx::new();
    let order = ctx.create_order("伪装扩展名");
    let dir = tempfile::tempdir().unwrap();
    // 内容是 PNG，文件名却是 .jpg
    let source = write_image(dir.path(), "其实是png.jpg", 200, 120, ImageFormat::Png);

    let view = import_one(&ctx, &order, &source);
    assert_eq!(view.mime_type, "image/png", "必须按内容判断格式");
    assert!(view.original_path.ends_with(".png"));
}

#[test]
fn rejects_corrupt_truncated_and_unsupported_files() {
    let ctx = Ctx::new();
    let order = ctx.create_order("坏文件");
    let dir = tempfile::tempdir().unwrap();
    let mut conn = ctx.conn();

    let truncated = dir.path().join("截断.png");
    let full = write_image(dir.path(), "完整.png", 400, 300, ImageFormat::Png);
    let bytes = std::fs::read(&full).unwrap();
    std::fs::write(&truncated, &bytes[..bytes.len() / 3]).unwrap();

    let text = dir.path().join("不是图片.png");
    std::fs::write(&text, b"hello world").unwrap();

    let gif = dir.path().join("动图.gif");
    std::fs::write(&gif, b"GIF89a\x01\x00\x01\x00\x00\x00\x00;").unwrap();

    let empty = dir.path().join("空.png");
    std::fs::write(&empty, b"").unwrap();

    for path in [&truncated, &text, &gif, &empty] {
        let outcomes = attachments::import(
            &mut conn,
            ctx.env.layout(),
            ctx.env.active_generation(),
            &order,
            &[path.clone()],
            None,
        )
        .unwrap();
        assert!(!outcomes[0].ok, "{} 应被拒绝", path.display());
        assert!(outcomes[0].error.is_some());
    }

    assert!(list(&ctx, &order).is_empty(), "拒绝的文件不得留下元数据");
}

#[test]
fn rejects_oversized_pixel_dimensions() {
    let ctx = Ctx::new();
    let order = ctx.create_order("超大尺寸");
    let dir = tempfile::tempdir().unwrap();
    // 单边超过 20000 像素（1 像素高，文件很小）
    let source = write_image(dir.path(), "超宽.png", 20_001, 1, ImageFormat::Png);

    let mut conn = ctx.conn();
    let outcomes = attachments::import(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        &order,
        &[source],
        None,
    )
    .unwrap();
    assert!(!outcomes[0].ok);
    let message = outcomes[0].error.clone().unwrap();
    assert!(message.contains("像素") || message.contains("尺寸"), "{message}");
}

#[test]
fn rejects_files_over_the_size_limit_without_reading_them() {
    let ctx = Ctx::new();
    let order = ctx.create_order("超大文件");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("huge.png");
    // 稀疏文件：只占磁盘元数据，读取前就会被大小检查拦下
    let file = std::fs::File::create(&path).unwrap();
    file.set_len(minidesk::media::MAX_ORIGINAL_BYTES + 1).unwrap();
    drop(file);

    let mut conn = ctx.conn();
    let outcomes = attachments::import(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        &order,
        &[path],
        None,
    )
    .unwrap();
    assert!(!outcomes[0].ok);
    assert!(outcomes[0].error.as_ref().unwrap().contains("100"));
}

#[test]
fn batch_import_reports_each_file_and_keeps_the_good_ones() {
    let ctx = Ctx::new();
    let order = ctx.create_order("批量导入");
    let dir = tempfile::tempdir().unwrap();
    let good = write_image(dir.path(), "好图.png", 200, 200, ImageFormat::Png);
    let bad = dir.path().join("坏图.png");
    std::fs::write(&bad, b"nope").unwrap();

    let mut conn = ctx.conn();
    let outcomes = attachments::import(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        &order,
        &[good, bad],
        Some("参考"),
    )
    .unwrap();

    assert_eq!(outcomes.len(), 2);
    assert!(outcomes[0].ok);
    assert!(!outcomes[1].ok);
    assert_eq!(list(&ctx, &order).len(), 1, "只保留成功的那一张");
    assert_eq!(list(&ctx, &order)[0].tag.as_deref(), Some("参考"));
}

#[test]
fn removing_an_attachment_deletes_files_and_records_cleanup() {
    let ctx = Ctx::new();
    let order = ctx.create_order("移除附件");
    let dir = tempfile::tempdir().unwrap();
    let source = write_image(dir.path(), "要删的.png", 300, 300, ImageFormat::Png);
    let view = import_one(&ctx, &order, &source);

    let mut conn = ctx.conn();
    attachments::remove(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        &view.id,
    )
    .unwrap();

    assert!(!Path::new(&view.original_path).exists(), "原图应被删除");
    if let Some(thumb) = &view.thumb_path {
        assert!(!Path::new(thumb).exists(), "缩略图应被删除");
    }
    assert!(list(&ctx, &order).is_empty());

    let done: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cleanup_tasks WHERE state = 'done'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(done >= 2, "原图与缩略图都应留下已完成的清理记录");
}

#[test]
fn removing_one_order_attachment_does_not_touch_another_order() {
    let ctx = Ctx::new();
    let a = ctx.create_order("订单甲");
    let b = ctx.create_order("订单乙");
    let dir = tempfile::tempdir().unwrap();

    let va = import_one(&ctx, &a, &write_image(dir.path(), "甲图.png", 200, 200, ImageFormat::Png));
    let vb = import_one(&ctx, &b, &write_image(dir.path(), "乙图.png", 200, 200, ImageFormat::Png));

    let mut conn = ctx.conn();
    attachments::remove(&mut conn, ctx.env.layout(), ctx.env.active_generation(), &va.id).unwrap();

    let remaining = list(&ctx, &b);
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, vb.id);
    assert!(Path::new(&vb.original_path).exists(), "另一张订单的原图不受影响");
}

#[test]
fn verify_detects_missing_and_corrupt_originals() {
    let ctx = Ctx::new();
    let order = ctx.create_order("校验附件");
    let dir = tempfile::tempdir().unwrap();

    let gone = import_one(&ctx, &order, &write_image(dir.path(), "会丢失.png", 120, 120, ImageFormat::Png));
    let broken = import_one(&ctx, &order, &write_image(dir.path(), "会损坏.png", 120, 120, ImageFormat::Png));
    let fine = import_one(&ctx, &order, &write_image(dir.path(), "正常.png", 120, 120, ImageFormat::Png));

    std::fs::remove_file(&gone.original_path).unwrap();
    std::fs::write(&broken.original_path, b"tampered").unwrap();

    let mut conn = ctx.conn();
    let report = attachments::verify(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        &order,
    )
    .unwrap();

    assert_eq!(report.ok, 1);
    assert_eq!(report.missing, 1);
    assert_eq!(report.corrupt, 1);

    let by_id = |id: &str| report.attachments.iter().find(|a| a.id == id).unwrap();
    assert_eq!(by_id(&gone.id).state, "missing");
    assert_eq!(by_id(&broken.id).state, "corrupt");
    assert_eq!(by_id(&fine.id).state, "ok");

    // 状态要落库，下次读取直接可见
    let stored = list(&ctx, &order);
    assert!(stored.iter().any(|a| a.state == "missing"));
}

#[test]
fn repair_restores_a_broken_original_in_place() {
    let ctx = Ctx::new();
    let order = ctx.create_order("修复附件");
    let dir = tempfile::tempdir().unwrap();
    let view = import_one(&ctx, &order, &write_image(dir.path(), "原图.png", 200, 150, ImageFormat::Png));

    std::fs::remove_file(&view.original_path).unwrap();
    let mut conn = ctx.conn();
    let report = attachments::verify(&mut conn, ctx.env.layout(), ctx.env.active_generation(), &order).unwrap();
    assert_eq!(report.missing, 1);

    let replacement = write_image(dir.path(), "替补.png", 640, 480, ImageFormat::Png);
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

    assert_eq!(repaired.id, view.id, "附件 ID 不变");
    assert_eq!(repaired.state, "ok");
    assert_eq!(repaired.width, Some(640));
    assert_eq!(repaired.height, Some(480));
    assert_ne!(repaired.sha256, view.sha256, "哈希应更新");
    assert!(Path::new(&repaired.original_path).is_file());
}

#[test]
fn rebuild_thumbs_regenerates_only_what_is_missing() {
    let ctx = Ctx::new();
    let order = ctx.create_order("重建缩略图");
    let dir = tempfile::tempdir().unwrap();
    let view = import_one(&ctx, &order, &write_image(dir.path(), "图.png", 600, 400, ImageFormat::Png));

    let thumb = view.thumb_path.clone().unwrap();
    std::fs::remove_file(&thumb).unwrap();

    let mut conn = ctx.conn();
    let first = attachments::rebuild_thumbs(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        &order,
    )
    .unwrap();
    assert_eq!((first.total, first.rebuilt, first.failed), (1, 1, 0));
    assert!(Path::new(&thumb).is_file(), "缩略图应被重建");

    let second = attachments::rebuild_thumbs(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        &order,
    )
    .unwrap();
    assert_eq!(second.rebuilt, 0, "已存在的缩略图应跳过");
    assert_eq!(second.skipped, 1);
}

#[test]
fn rebuild_reports_failure_but_keeps_the_original() {
    let ctx = Ctx::new();
    let order = ctx.create_order("缩略图失败");
    let dir = tempfile::tempdir().unwrap();
    let view = import_one(&ctx, &order, &write_image(dir.path(), "图.png", 300, 300, ImageFormat::Png));

    if let Some(thumb) = &view.thumb_path {
        let _ = std::fs::remove_file(thumb);
    }
    std::fs::write(&view.original_path, b"broken").unwrap();

    let mut conn = ctx.conn();
    let report = attachments::rebuild_thumbs(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        &order,
    )
    .unwrap();
    assert_eq!(report.failed, 1);
    assert!(!report.failures.is_empty());
    assert!(Path::new(&view.original_path).is_file(), "原图不得被删掉");

    let stored = list(&ctx, &order);
    assert_eq!(stored.len(), 1, "元数据必须保留");
}

#[test]
fn attachment_meta_can_be_edited_and_is_validated() {
    let ctx = Ctx::new();
    let order = ctx.create_order("图片备注");
    let dir = tempfile::tempdir().unwrap();
    let view = import_one(&ctx, &order, &write_image(dir.path(), "原文件名.png", 100, 100, ImageFormat::Png));

    let conn = ctx.conn();
    let updated = attachments::update_meta(
        &conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        UpdateAttachmentMetaInput {
            attachment_id: view.id.clone(),
            display_name: Some("  封面参考  ".into()),
            note: Some("客户指定配色".into()),
            tag: Some("配色".into()),
            role: None,
            gallery_visible: None,
        },
    )
    .unwrap();
    assert_eq!(updated.display_name.as_deref(), Some("封面参考"));
    assert_eq!(updated.note.as_deref(), Some("客户指定配色"));
    assert_eq!(updated.tag.as_deref(), Some("配色"));
    assert_eq!(updated.original_name, "原文件名.png", "原始文件名必须保留");

    let too_long = "字".repeat(121);
    let err = attachments::update_meta(
        &conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        UpdateAttachmentMetaInput {
            attachment_id: view.id.clone(),
            display_name: Some(too_long),
            note: None,
            tag: None,
            role: None,
            gallery_visible: None,
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "INVALID");
}

#[test]
fn stored_paths_are_portable_relative_and_inside_the_generation() {
    let ctx = Ctx::new();
    let order = ctx.create_order("路径检查");
    let dir = tempfile::tempdir().unwrap();
    let view = import_one(&ctx, &order, &write_image(dir.path(), "路径.png", 100, 100, ImageFormat::Png));

    let conn = ctx.conn();
    let rel: String = conn
        .query_row("SELECT rel_path FROM attachments WHERE id = ?1", [&view.id], |r| r.get(0))
        .unwrap();
    assert!(rel.starts_with("attachments/originals/"));
    assert!(!rel.contains(':') && !rel.contains('\\'));
    assert!(view.original_path.contains("generations"));
    assert!(view.original_path.contains("attachments/originals"));
}

#[test]
fn import_rejects_unknown_order() {
    let ctx = Ctx::new();
    let dir = tempfile::tempdir().unwrap();
    let source = write_image(dir.path(), "图.png", 50, 50, ImageFormat::Png);
    let mut conn = ctx.conn();
    let err = attachments::import(
        &mut conn,
        ctx.env.layout(),
        ctx.env.active_generation(),
        "ghost-order",
        &[source],
        None,
    )
    .unwrap_err();
    assert_eq!(err.code, "NOT_FOUND");
}
