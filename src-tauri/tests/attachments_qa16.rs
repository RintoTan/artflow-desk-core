//! UX-04：16 张多格式附件走真实导入链路。
//!
//! 覆盖：PNG / JPEG / WebP、正方 / 横向 / 纵向 / 超宽 / 高分辨率 / 透明底，
//! 断言原图字节一致（SHA-256）、缩略图可解码、删除互不影响、
//! 备份恢复后原图与缩略图仍成套。

mod common;

use std::fs;
use std::path::{Path, PathBuf};

use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use sha2::{Digest, Sha256};

use minidesk::domain::attachments;

fn hash(path: &Path) -> String {
    let bytes = fs::read(path).unwrap();
    let mut h = Sha256::new();
    h.update(&bytes);
    h.finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

/// 生成一张带渐变纹理的图；`alpha` 为 true 时四角透明。
fn make(width: u32, height: u32, alpha: bool) -> DynamicImage {
    let mut img = RgbaImage::new(width, height);
    for (x, y, px) in img.enumerate_pixels_mut() {
        let r = (x * 255 / width.max(1)) as u8;
        let g = (y * 255 / height.max(1)) as u8;
        let b = ((x + y) % 256) as u8;
        let a = if alpha && (x < width / 8 || y < height / 8) { 0 } else { 255 };
        *px = Rgba([r, g, b, a]);
    }
    DynamicImage::ImageRgba8(img)
}

fn write(dir: &Path, name: &str, img: &DynamicImage, fmt: ImageFormat) -> PathBuf {
    let path = dir.join(name);
    img.save_with_format(&path, fmt).unwrap();
    path
}

#[test]
fn sixteen_mixed_attachments_survive_import_delete_and_restore() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("src");
    fs::create_dir_all(&src).unwrap();

    // 16 张：格式 × 形状 × 特殊通道
    let specs: [(&str, u32, u32, ImageFormat, bool); 16] = [
        ("01-square.png", 600, 600, ImageFormat::Png, false),
        ("02-wide.png", 1200, 400, ImageFormat::Png, false),
        ("03-tall.png", 400, 1200, ImageFormat::Png, false),
        ("04-ultra.png", 2400, 300, ImageFormat::Png, false),
        ("05-huge.png", 3000, 2000, ImageFormat::Png, false),
        ("06-alpha.png", 512, 512, ImageFormat::Png, true),
        ("07-photo.jpg", 1024, 768, ImageFormat::Jpeg, false),
        ("08-photo-wide.jpg", 1600, 600, ImageFormat::Jpeg, false),
        ("09-mini.jpg", 64, 64, ImageFormat::Jpeg, false),
        ("10-webp.webp", 800, 800, ImageFormat::WebP, false),
        ("11-webp-wide.webp", 1400, 500, ImageFormat::WebP, false),
        ("12-thin.png", 200, 1600, ImageFormat::Png, false),
        ("13-flat.png", 900, 100, ImageFormat::Png, false),
        ("14-tall.jpg", 700, 1500, ImageFormat::Jpeg, false),
        ("15-alpha.webp", 1024, 1024, ImageFormat::WebP, true),
        ("16-tiny.png", 8, 8, ImageFormat::Png, false),
    ];

    let mut sources = Vec::new();
    for (name, w, h, fmt, alpha) in specs {
        let img = make(w, h, alpha);
        sources.push(write(&src, name, &img, fmt));
    }
    assert_eq!(sources.len(), 16);

    let ctx = common::Ctx::new();
    let order_id = ctx.create_order("附件验收单");
    let mut conn = ctx.conn();
    let generation = ctx.env.active_generation();
    let outcomes = attachments::import(
        &mut conn,
        ctx.env.layout(),
        &generation,
        &order_id,
        &sources,
        None,
    )
    .expect("导入失败");

    let ok: Vec<_> = outcomes.iter().filter(|o| o.ok).collect();
    assert_eq!(ok.len(), 16, "16 张应全部导入成功: {outcomes:?}");

    // 原图在盘、字节一致
    for outcome in &ok {
        let view = outcome.attachment.as_ref().unwrap();
        let path = ctx.env.layout().attachments_dir(&generation).join(&view.original_path);
        assert!(path.exists(), "原图缺失: {}", view.original_path);
        assert_eq!(hash(&path), view.sha256, "SHA-256 不一致: {}", view.original_path);
        assert!(view.byte_size > 0);
    }

    // 缩略图可解码
    for outcome in &ok {
        let view = outcome.attachment.as_ref().unwrap();
        let thumb_rel = view.thumb_path.as_ref().expect("缩略图未生成");
        let thumb_abs = ctx.env.layout().attachments_dir(&generation).join(thumb_rel);
        assert!(thumb_abs.exists(), "缩略图缺失: {thumb_rel}");
        let decoded = image::open(&thumb_abs).expect("缩略图无法解码");
        assert!(decoded.width() > 0 && decoded.height() > 0);
    }

    let listed = attachments::list(&conn, ctx.env.layout(), &generation, &order_id).unwrap();
    assert_eq!(listed.len(), 16, "列表应返回 16 条");

    // 删一张不影响其他
    let victim = listed[0].id.clone();
    let victim_path = listed[0].original_path.clone();
    attachments::remove(&mut conn, ctx.env.layout(), &generation, &victim).unwrap();
    let after = attachments::list(&conn, ctx.env.layout(), &generation, &order_id).unwrap();
    assert_eq!(after.len(), 15);
    assert!(after.iter().all(|a| a.id != victim));
    let remain_path = ctx.env.layout().attachments_dir(&generation).join(&after[0].original_path);
    assert!(remain_path.exists(), "删除一张时误删了其他文件");
    let _ = victim_path;

    // 备份 → 恢复：原图与缩略图都要成套
    let zip = dir.path().join("with-15.zip");
    let hw = common::highwater(&ctx.env);
    minidesk::backup::create::create(&ctx.env, &hw, &zip).expect("备份失败");

    let dst_root = dir.path().join("dst");
    let dst = common::open(&dst_root);
    let dst_hw = common::highwater(&dst);
    let restored =
        minidesk::backup::restore::restore(&dst, &dst_hw, &zip, &minidesk::store::migrations::production())
            .expect("恢复失败");
    drop(dst);
    let after_env = common::open(&dst_root);
    let gen2 = after_env.active_generation();
    let conn2 = after_env.open_db().unwrap();
    let restored_rows = attachments::list(&conn2, after_env.layout(), &gen2, &order_id).unwrap();
    assert_eq!(restored_rows.len(), 15, "恢复后附件数量不对");
    for row in &restored_rows {
        let p = after_env.layout().attachments_dir(&gen2).join(&row.original_path);
        assert!(p.exists(), "恢复后原图缺失: {}", row.original_path);
        assert_eq!(hash(&p), row.sha256, "恢复后原图字节变了");
        let t = row.thumb_path.as_ref().expect("恢复后缩略图缺失");
        assert!(after_env.layout().attachments_dir(&gen2).join(t).exists());
    }
    let _ = restored.summary.attachments;
}
