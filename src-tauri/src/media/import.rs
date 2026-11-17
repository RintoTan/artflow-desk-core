//! 图片校验与解码。
//!
//! 只看字节内容，不信扩展名、不信客户端声明的 MIME：
//! 先按魔数猜格式，再用受限解码器确认能真正解开，最后检查尺寸与像素上限。

use std::path::Path;

use image::{ImageFormat, ImageReader};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};
use crate::media::{self, ImageKind};

#[derive(Debug, Clone)]
pub struct ValidatedImage {
    pub kind: ImageKind,
    pub width: u32,
    pub height: u32,
    pub bytes: Vec<u8>,
    pub sha256: String,
    pub original_name: String,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn kind_from_format(format: ImageFormat) -> Option<ImageKind> {
    match format {
        ImageFormat::Png => Some(ImageKind::Png),
        ImageFormat::Jpeg => Some(ImageKind::Jpeg),
        ImageFormat::WebP => Some(ImageKind::Webp),
        _ => None,
    }
}

/// 读取并校验一张原图。失败时给出可直接展示的中文原因。
pub fn read_and_validate(path: &Path) -> AppResult<ValidatedImage> {
    let metadata = std::fs::metadata(path)
        .map_err(|e| AppError::invalid(format!("无法读取文件：{e}")))?;
    if !metadata.is_file() {
        return Err(AppError::invalid("选择的不是普通文件"));
    }
    if metadata.len() == 0 {
        return Err(AppError::invalid("文件是空的"));
    }
    if metadata.len() > media::MAX_ORIGINAL_BYTES {
        return Err(AppError::invalid(format!(
            "单张图片不能超过 {} MB",
            media::MAX_ORIGINAL_BYTES / 1024 / 1024
        )));
    }

    let bytes = std::fs::read(path).map_err(|e| AppError::io(format!("读取文件失败：{e}")))?;

    let guessed = image::guess_format(&bytes)
        .map_err(|_| AppError::invalid("无法识别的图片格式（只支持 PNG / JPEG / WebP）"))?;
    let kind = kind_from_format(guessed)
        .ok_or_else(|| AppError::invalid("不支持的图片格式（只支持 PNG / JPEG / WebP）"))?;

    // 用受限解码器真正解开一次：能挡住截断、损坏、伪装扩展名的文件。
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(media::MAX_IMAGE_EDGE);
    limits.max_image_height = Some(media::MAX_IMAGE_EDGE);
    limits.max_alloc = Some(media::MAX_IMAGE_PIXELS * 4 + 16 * 1024 * 1024);

    // 先只读文件头拿尺寸：尺寸超限时给出准确提示，而不是丢一句"无法解码"。
    let header_reader = ImageReader::with_format(std::io::Cursor::new(&bytes), guessed);
    let (width, height) = header_reader
        .into_dimensions()
        .map_err(|e| AppError::invalid(format!("无法读取图片尺寸，文件可能已损坏：{e}")))?;
    media::check_dimensions(width, height)?;

    let mut reader = ImageReader::with_format(std::io::Cursor::new(&bytes), guessed);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|e| AppError::invalid(format!("图片无法解码，文件可能已损坏：{e}")))?;
    let (width, height) = (decoded.width(), decoded.height());

    let original_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "未命名图片".to_string());

    Ok(ValidatedImage {
        kind,
        width,
        height,
        sha256: sha256_hex(&bytes),
        bytes,
        original_name,
    })
}

/// 计算磁盘上文件的 SHA-256（用于校验原图是否被改动）。
pub fn file_sha256(path: &Path) -> AppResult<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|e| AppError::io(format!("读取文件失败：{e}")))?;
    Ok(Some(sha256_hex(&bytes)))
}
