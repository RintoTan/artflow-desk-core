//! 附件路径与资源限制。

use std::path::Path;

use minidesk::media::{
    self, ensure_within, original_rel_path, safe_join, thumb_rel_path, validate_rel_path,
    ImageKind, MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS, MAX_ORIGINAL_BYTES, THUMB_EDGE,
};

#[test]
fn limits_match_the_frozen_spec() {
    assert_eq!(MAX_ORIGINAL_BYTES, 100 * 1024 * 1024, "单文件上限 100 MB");
    assert_eq!(THUMB_EDGE, 480, "缩略图最长边 480");
    assert!(MAX_IMAGE_PIXELS > 0 && MAX_IMAGE_EDGE > 0);
}

#[test]
fn portable_relative_paths_are_accepted() {
    for ok in [
        "attachments/originals/abc.png",
        "attachments/thumbs/abc.webp",
        "attachments/originals/a/b.png",
    ] {
        assert!(validate_rel_path(ok).is_ok(), "{ok} 应被接受");
    }
}

#[test]
fn dangerous_paths_are_rejected() {
    for bad in [
        "",
        "../escape.png",
        "attachments/../../etc/passwd",
        "/absolute/path.png",
        "C:/windows/system32.png",
        "C:\\windows\\system32.png",
        "attachments\\originals\\a.png",
        "attachments//double.png",
        "attachments/./a.png",
        "attachments/a.png ",
        "attachments/a.",
        "附件/中文.png",
    ] {
        assert!(validate_rel_path(bad).is_err(), "{bad:?} 必须被拒绝");
    }
}

#[test]
fn safe_join_stays_inside_the_base_directory() {
    let base = Path::new("/tmp/minidesk-base");
    let joined = safe_join(base, "attachments/originals/a.png").unwrap();
    assert!(joined.starts_with(base));
    assert!(safe_join(base, "../outside.png").is_err());
    assert!(safe_join(base, "/etc/passwd").is_err());
}

#[test]
fn ensure_within_rejects_paths_that_escape() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("gen");
    std::fs::create_dir_all(base.join("attachments")).unwrap();

    let inside = base.join("attachments/originals/a.png");
    std::fs::create_dir_all(inside.parent().unwrap()).unwrap();
    std::fs::write(&inside, b"x").unwrap();
    assert!(ensure_within(&base, &inside).is_ok());

    let outside = dir.path().join("elsewhere/a.png");
    std::fs::create_dir_all(outside.parent().unwrap()).unwrap();
    std::fs::write(&outside, b"x").unwrap();
    let err = ensure_within(&base, &outside).err().expect("越界必须被拒绝");
    assert_eq!(err.code, "DENIED");
}

#[test]
fn original_and_thumbnail_paths_are_separate() {
    let original = original_rel_path("att-1", "png");
    let thumb = thumb_rel_path("att-1");
    assert_eq!(original, "attachments/originals/att-1.png");
    assert_eq!(thumb, "attachments/thumbs/att-1.webp");
    assert_ne!(original, thumb);
    assert!(original.contains("/originals/"));
    assert!(thumb.contains("/thumbs/"));
}

#[test]
fn image_kinds_map_to_extension_and_mime() {
    assert_eq!(ImageKind::from_extension("PNG"), Some(ImageKind::Png));
    assert_eq!(ImageKind::from_extension("jpeg"), Some(ImageKind::Jpeg));
    assert_eq!(ImageKind::from_extension("webp"), Some(ImageKind::Webp));
    assert_eq!(ImageKind::from_extension("gif"), None);
    assert_eq!(ImageKind::Png.mime(), "image/png");
    assert_eq!(ImageKind::Jpeg.extension(), "jpg");
    assert_eq!(ImageKind::from_mime("image/webp"), Some(ImageKind::Webp));
    assert_eq!(ImageKind::from_mime("application/pdf"), None);
}

#[test]
fn dimension_limits_are_enforced() {
    assert!(media::check_dimensions(4000, 3000).is_ok());
    assert!(media::check_dimensions(0, 100).is_err());
    assert!(media::check_dimensions(MAX_IMAGE_EDGE + 1, 10).is_err());
    assert!(
        media::check_dimensions(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE).is_err(),
        "超大总像素必须被拒绝"
    );
    assert!(
        media::check_dimensions(8000, 8000).is_err(),
        "6400 万像素超过上限"
    );
}
