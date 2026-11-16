//! 附件路径与资源限制。
//!
//! 原图与缩略图分离：缩略图是缓存，损坏可重建，绝不反向影响原图。
//! 所有落盘路径都必须是**代际目录内的相对路径**，禁止盘符与绝对路径。

use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, AppResult};

/// 单文件上限（D-00-16）。
pub const MAX_ORIGINAL_BYTES: u64 = 100 * 1024 * 1024;
/// 单边像素上限（FIX-11）。
pub const MAX_IMAGE_EDGE: u32 = 20_000;
/// 总像素上限（FIX-11），约 6000 万像素。
pub const MAX_IMAGE_PIXELS: u64 = 60_000_000;
/// 缩略图最长边。
pub const THUMB_EDGE: u32 = 480;

pub fn original_rel_path(attachment_id: &str, extension: &str) -> String {
    format!("attachments/originals/{attachment_id}.{extension}")
}

pub fn thumb_rel_path(attachment_id: &str) -> String {
    format!("attachments/thumbs/{attachment_id}.webp")
}

/// 校验一个可移植相对路径：只允许普通路径段，不含盘符、反斜杠、`.`/`..`。
pub fn validate_rel_path(rel: &str) -> AppResult<()> {
    if rel.trim().is_empty() {
        return Err(AppError::invalid("附件路径为空"));
    }
    if rel.contains('\\') {
        return Err(AppError::invalid("附件路径不允许包含反斜杠"));
    }
    if rel.contains('\0') {
        return Err(AppError::invalid("附件路径包含非法字符"));
    }
    if !rel.is_ascii() {
        return Err(AppError::invalid("附件存储路径必须是 ASCII 相对路径"));
    }
    if rel.starts_with('/') {
        return Err(AppError::invalid("附件路径不允许是绝对路径"));
    }
    if rel.len() >= 2 && rel.as_bytes()[1] == b':' {
        return Err(AppError::invalid("附件路径不允许包含盘符"));
    }
    for part in rel.split('/') {
        if part.is_empty() {
            return Err(AppError::invalid("附件路径包含空路径段"));
        }
        if part == "." || part == ".." {
            return Err(AppError::invalid("附件路径不允许包含相对跳转"));
        }
        if part.ends_with(' ') || part.ends_with('.') {
            return Err(AppError::invalid("附件路径不允许以空格或点结尾"));
        }
    }
    Ok(())
}

/// 把相对路径拼到基准目录，并确认结果没有逃出基准目录。
pub fn safe_join(base: &Path, rel: &str) -> AppResult<PathBuf> {
    validate_rel_path(rel)?;
    let mut out = base.to_path_buf();
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(part) => out.push(part),
            _ => return Err(AppError::invalid("附件路径包含非法路径段")),
        }
    }
    Ok(out)
}

/// 目录内文件是否仍然位于基准目录之内（防符号链接与别名跳出）。
pub fn ensure_within(base: &Path, candidate: &Path) -> AppResult<()> {
    let base = std::fs::canonicalize(base)
        .map_err(|e| AppError::io(format!("无法解析基准目录：{e}")))?;
    let parent = candidate
        .parent()
        .ok_or_else(|| AppError::invalid("目标路径没有父目录"))?;
    let resolved_parent = if parent.exists() {
        std::fs::canonicalize(parent)?
    } else {
        base.clone()
    };
    if !resolved_parent.starts_with(&base) {
        return Err(AppError::denied("目标路径超出数据目录，已拒绝"));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageKind {
    Png,
    Jpeg,
    Webp,
}

impl ImageKind {
    pub fn from_extension(ext: &str) -> Option<Self> {
        match ext.to_ascii_lowercase().as_str() {
            "png" => Some(Self::Png),
            "jpg" | "jpeg" => Some(Self::Jpeg),
            "webp" => Some(Self::Webp),
            _ => None,
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
        }
    }

    pub fn from_mime(mime: &str) -> Option<Self> {
        match mime {
            "image/png" => Some(Self::Png),
            "image/jpeg" => Some(Self::Jpeg),
            "image/webp" => Some(Self::Webp),
            _ => None,
        }
    }
}

/// 尺寸与像素限制检查（解码前先看头部，避免直接吃掉内存）。
pub fn check_dimensions(width: u32, height: u32) -> AppResult<()> {
    if width == 0 || height == 0 {
        return Err(AppError::invalid("图片尺寸无效"));
    }
    if width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE {
        return Err(AppError::invalid(format!(
            "图片单边不能超过 {MAX_IMAGE_EDGE} 像素"
        )));
    }
    if (width as u64) * (height as u64) > MAX_IMAGE_PIXELS {
        return Err(AppError::invalid(format!(
            "图片总像素不能超过 {} 万",
            MAX_IMAGE_PIXELS / 10_000
        )));
    }
    Ok(())
}
