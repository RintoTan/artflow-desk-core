//! 备份包的读取与安全校验（DEV-01 只做**校验**，不做备份/恢复编排）。
//!
//! 关键点：`zip` 解析器按名称索引，**真实重复条目会被它悄悄合并成一个**，
//! 因此重复检测必须直接解析中央目录，不能依赖 `ZipArchive::len()`。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

pub const FORMAT_NAME: &str = "artflow-minidesk-backup";
pub const FORMAT_VERSION: u32 = 1;
pub const MANIFEST_NAME: &str = "manifest.json";
pub const DATABASE_NAME: &str = "database.sqlite";
const MAX_ENTRIES: usize = 20_000;
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YearWatermark {
    pub year: i32,
    pub last_allocated: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub format_version: u32,
    pub app_version: String,
    pub schema_version: i64,
    pub created_at: String,
    /// 工作时区随备份走，恢复后语义一致（FIX-08 / FIX-10）。
    pub working_timezone: String,
    /// 编号高水位随备份走，恢复时逐年取较大值（FIX-01）。
    pub number_high_water: Vec<YearWatermark>,
    pub files: Vec<ManifestFile>,
    pub total_files: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub manifest: Manifest,
    pub entries: usize,
    pub database_bytes: u64,
    pub attachment_files: usize,
}

/// 备份包内允许出现的路径形状。附件只允许 ASCII 相对路径。
pub fn reject_reason(name: &str) -> Option<&'static str> {
    if name.is_empty() {
        return Some("空路径");
    }
    if name.contains('\0') {
        return Some("包含空字符");
    }
    if name.contains('\\') {
        return Some("包含反斜杠");
    }
    if !name.is_ascii() {
        return Some("包含非 ASCII 字符");
    }
    if name.starts_with('/') {
        return Some("绝对路径");
    }
    if name.len() >= 2 && name.as_bytes()[1] == b':' {
        return Some("包含盘符");
    }
    if name.split('/').any(|p| p == "..") {
        return Some("路径穿越");
    }
    if name.split('/').any(|p| p == "." || p.is_empty()) {
        return Some("空路径段或相对跳转");
    }
    if name.split('/').any(|p| p.ends_with(' ') || p.ends_with('.')) {
        return Some("路径段以空格或点结尾");
    }
    if name.ends_with('/') {
        return Some("目录条目");
    }
    None
}

/// 直接读取 ZIP 中央目录，返回**全部**条目名（不做去重）。
pub fn central_directory_names(path: &Path) -> AppResult<Vec<String>> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    if len < 22 {
        return Err(AppError::zip("文件太小，不是有效的 ZIP"));
    }
    let tail_len = std::cmp::min(len, 66_000);
    file.seek(SeekFrom::Start(len - tail_len))?;
    let mut tail = vec![0u8; tail_len as usize];
    file.read_exact(&mut tail)?;

    let mut eocd = None;
    if tail.len() >= 22 {
        for i in (0..=tail.len() - 22).rev() {
            if tail[i] == 0x50 && tail[i + 1] == 0x4b && tail[i + 2] == 0x05 && tail[i + 3] == 0x06
            {
                eocd = Some(i);
                break;
            }
        }
    }
    let eocd = eocd.ok_or_else(|| AppError::zip("找不到 ZIP 目录结尾"))?;

    let cd_size = u32::from_le_bytes(tail[eocd + 12..eocd + 16].try_into().unwrap()) as u64;
    let cd_offset = u32::from_le_bytes(tail[eocd + 16..eocd + 20].try_into().unwrap()) as u64;
    let count = u16::from_le_bytes(tail[eocd + 10..eocd + 12].try_into().unwrap()) as u64;

    if cd_offset.saturating_add(cd_size) > len || cd_size > 256 * 1024 * 1024 {
        return Err(AppError::zip("中央目录位置或大小异常"));
    }

    file.seek(SeekFrom::Start(cd_offset))?;
    let mut cd = vec![0u8; cd_size as usize];
    file.read_exact(&mut cd)?;

    let mut names = Vec::new();
    let mut off = 0usize;
    while off + 46 <= cd.len() {
        if cd[off] != 0x50 || cd[off + 1] != 0x4b || cd[off + 2] != 0x01 || cd[off + 3] != 0x02 {
            break;
        }
        let name_len = u16::from_le_bytes(cd[off + 28..off + 30].try_into().unwrap()) as usize;
        let extra_len = u16::from_le_bytes(cd[off + 30..off + 32].try_into().unwrap()) as usize;
        let comment_len = u16::from_le_bytes(cd[off + 32..off + 34].try_into().unwrap()) as usize;
        let start = off + 46;
        if start + name_len > cd.len() {
            return Err(AppError::zip("中央目录条目被截断"));
        }
        names.push(String::from_utf8_lossy(&cd[start..start + name_len]).to_string());
        off = start + name_len + extra_len + comment_len;
    }

    if count != names.len() as u64 {
        return Err(AppError::zip("中央目录条目数与实际读取不一致，拒绝处理"));
    }
    Ok(names)
}

/// 完整校验：中央目录一致性 → 路径安全 → manifest → 逐文件 SHA-256。
pub fn inspect(path: &Path) -> AppResult<Inspection> {
    let names = central_directory_names(path)?;
    if names.len() > MAX_ENTRIES {
        return Err(AppError::zip(format!("条目数超过上限 {MAX_ENTRIES}")));
    }

    // 重复（含仅大小写不同）必须在中央目录层检测。
    let mut sorted = names.clone();
    sorted.sort();
    sorted.dedup();
    if sorted.len() != names.len() {
        return Err(AppError::zip("备份包包含重复路径"));
    }
    let mut lower: Vec<String> = names.iter().map(|n| n.to_ascii_lowercase()).collect();
    lower.sort();
    lower.dedup();
    if lower.len() != names.len() {
        return Err(AppError::zip("备份包包含仅大小写不同的冲突路径"));
    }

    for name in &names {
        if let Some(reason) = reject_reason(name) {
            return Err(AppError::zip(format!("备份包路径不安全（{reason}）：{name}")));
        }
    }

    let file = File::open(path)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| AppError::zip(format!("ZIP 解析失败：{e}")))?;
    if archive.len() != names.len() {
        return Err(AppError::zip(
            "ZIP 解析器隐藏了部分条目（疑似重复路径），拒绝处理",
        ));
    }

    let manifest: Manifest = {
        let mut entry = archive
            .by_name(MANIFEST_NAME)
            .map_err(|_| AppError::zip("备份包缺少 manifest.json"))?;
        if entry.size() > MAX_MANIFEST_BYTES {
            return Err(AppError::zip("manifest 过大"));
        }
        let mut raw = Vec::new();
        entry.read_to_end(&mut raw)?;
        serde_json::from_slice(&raw)
            .map_err(|e| AppError::zip(format!("manifest 格式不合法：{e}")))?
    };

    if manifest.format != FORMAT_NAME {
        return Err(AppError::zip("不是 ArtFlow Desk Core 的备份包"));
    }
    if manifest.format_version > FORMAT_VERSION {
        return Err(AppError::zip(format!(
            "备份格式版本 {} 高于本程序支持的 {FORMAT_VERSION}",
            manifest.format_version
        )));
    }
    if manifest.schema_version < 1 {
        return Err(AppError::zip("manifest 缺少有效的结构版本"));
    }
    if manifest.working_timezone.trim().is_empty() {
        return Err(AppError::zip("manifest 缺少工作时区"));
    }

    let mut actual: Vec<String> = names
        .iter()
        .filter(|n| n.as_str() != MANIFEST_NAME)
        .cloned()
        .collect();
    let mut declared: Vec<String> = manifest.files.iter().map(|f| f.path.clone()).collect();
    actual.sort();
    declared.sort();
    if actual != declared {
        return Err(AppError::zip("manifest 与实际条目不一致"));
    }

    let mut database_bytes = 0u64;
    let mut attachment_files = 0usize;
    for expected in &manifest.files {
        let mut entry = archive
            .by_name(&expected.path)
            .map_err(|_| AppError::zip(format!("清单中的文件不存在：{}", expected.path)))?;
        if entry.size() != expected.bytes {
            return Err(AppError::zip(format!("文件大小不符：{}", expected.path)));
        }
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 64 * 1024];
        let mut total = 0u64;
        loop {
            let read = entry.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            total += read as u64;
        }
        let digest: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if digest != expected.sha256.to_ascii_lowercase() {
            return Err(AppError::zip(format!("SHA-256 不匹配：{}", expected.path)));
        }
        if expected.path == DATABASE_NAME {
            database_bytes = total;
        } else if expected.path.starts_with("attachments/originals/") {
            attachment_files += 1;
        }
    }

    Ok(Inspection {
        entries: names.len(),
        database_bytes,
        attachment_files,
        manifest,
    })
}
