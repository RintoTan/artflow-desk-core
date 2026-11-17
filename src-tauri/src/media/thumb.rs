//! 缩略图生成。
//!
//! 缩略图是可重建的缓存：只读原图字节、不写原图，失败也只是没有缓存。

use std::io::Cursor;

use image::{DynamicImage, ImageFormat, ImageReader};

use crate::error::{AppError, AppResult};
use crate::media::{self, ImageKind};

/// 最长边缩到 `THUMB_EDGE` 以内并编码为 WebP。
pub fn render_webp(bytes: &[u8]) -> AppResult<Vec<u8>> {
    if bytes.is_empty() {
        return Err(AppError::invalid("原图为空，无法生成缩略图"));
    }

    let mut limits = image::Limits::default();
    limits.max_image_width = Some(media::MAX_IMAGE_EDGE);
    limits.max_image_height = Some(media::MAX_IMAGE_EDGE);
    limits.max_alloc = Some(media::MAX_IMAGE_PIXELS * 4 + 16 * 1024 * 1024);

    let format = image::guess_format(bytes).unwrap_or(ImageFormat::Png);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let decoded: DynamicImage = reader
        .decode()
        .map_err(|e| AppError::invalid(format!("缩略图生成失败，原图无法解码：{e}")))?;

    let width = decoded.width();
    let height = decoded.height();
    if width == 0 || height == 0 {
        return Err(AppError::invalid("原图尺寸无效"));
    }

    let scaled = if width.max(height) > media::THUMB_EDGE {
        // 用 Lanczos3 保边缘，稍慢但只有一次。
        decoded.resize(media::THUMB_EDGE, media::THUMB_EDGE, image::imageops::FilterType::Lanczos3)
    } else {
        decoded
    };

    let mut out = Cursor::new(Vec::new());
    scaled
        .write_to(&mut out, ImageFormat::WebP)
        .map_err(|e| AppError::invalid(format!("缩略图编码失败：{e}")))?;
    Ok(out.into_inner())
}

/// 缩略图最长边（供前端展示"可重建"说明）。
pub fn edge() -> u32 {
    media::THUMB_EDGE
}

pub fn extension_for(_kind: ImageKind) -> &'static str {
    "webp"
}
