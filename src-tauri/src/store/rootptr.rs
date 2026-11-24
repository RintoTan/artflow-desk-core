//! 自定义数据根的稳定指针（`DATA-LIFECYCLE §7`）。
//!
//! 指针文件**不在数据根里**：数据根会被迁移、会被换盘，而应用必须永远能找到
//! "当前该用哪个根"。所以它固定在应用数据目录下：
//!
//! - 正式版：`app_data_dir/root.json`
//! - QA：`app_data_dir/.root-pointers/{scenario}/root.json`（各场景互不覆盖）
//!
//! 指针损坏、目标不可用都必须**硬失败**。静默回落默认根会让用户对着一个空库
//! 以为数据丢了，这比不启动更糟。

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub const POINTER_FILE: &str = "root.json";
pub const POINTER_DIR: &str = ".root-pointers";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RootPointer {
    /// 绝对路径；解析时不做任何环境变量展开。
    pub data_root: String,
    /// RFC3339
    pub updated_at: String,
}

/// 指针位置：正式在应用数据目录根部，QA 按场景分目录。
pub fn pointer_path(app_data_dir: &Path, scenario: Option<&str>) -> PathBuf {
    match scenario {
        Some(name) => app_data_dir.join(POINTER_DIR).join(name).join(POINTER_FILE),
        None => app_data_dir.join(POINTER_FILE),
    }
}

/// 读取指针。文件不存在 = 用默认根；存在但读不懂 = 硬失败。
pub fn read(path: &Path) -> AppResult<Option<RootPointer>> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(AppError::env(format!(
                "无法读取数据位置指针 {}：{e}",
                path.display()
            )))
        }
    };
    let pointer: RootPointer = serde_json::from_str(&raw).map_err(|e| {
        AppError::env(format!(
            "数据位置指针已损坏（{}）：{e}。请修复或删除该文件后再启动。",
            path.display()
        ))
    })?;
    if pointer.data_root.trim().is_empty() {
        return Err(AppError::env(format!(
            "数据位置指针缺少 dataRoot：{}",
            path.display()
        )));
    }
    Ok(Some(pointer))
}

/// 原子写：临时文件 → fsync → rename → fsync 目录。
/// 半截写入的指针会让应用下次启动时找不到数据，所以这一步不能省。
pub fn write_atomic(path: &Path, pointer: &RootPointer) -> AppResult<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::env("指针文件路径缺少父目录"))?;
    fs::create_dir_all(dir)?;

    let body = serde_json::to_string_pretty(pointer)
        .map_err(|e| AppError::env(format!("无法序列化数据位置指针：{e}")))?;
    let tmp = dir.join(format!(".{POINTER_FILE}.tmp-{}", std::process::id()));

    {
        let mut file = File::create(&tmp)
            .map_err(|e| AppError::io(format!("无法写入临时指针文件：{e}")))?;
        file.write_all(body.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }

    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        AppError::io(format!("无法替换数据位置指针：{e}"))
    })?;

    // rename 本身原子，但目录项要落盘才算真的换了。
    if let Ok(dir_handle) = File::open(dir) {
        let _ = dir_handle.sync_all();
    }
    Ok(())
}

/// 切回默认位置：删掉指针而不是写一个指向默认根的指针，
/// 这样"没有自定义位置"只有一个表达方式。
pub fn clear(path: &Path) -> AppResult<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::io(format!("无法删除数据位置指针：{e}"))),
    }
}

/// 目标根上是否已经有别的数据环境。
pub fn has_environment(root: &Path) -> bool {
    root.join("environment.json").exists()
}

fn canonical_or_self(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// 迁移目标的前置校验：不含空间检查（那需要完整载荷，由迁移层负责）。
pub fn check_target(source_root: &Path, target: &Path) -> AppResult<()> {
    if !target.is_absolute() {
        return Err(AppError::invalid("数据位置必须是绝对路径"));
    }

    let source = canonical_or_self(source_root);
    let target_canon = canonical_or_self(target);

    if source == target_canon {
        return Err(AppError::invalid("目标目录就是当前数据目录"));
    }
    if target_canon.starts_with(&source) {
        return Err(AppError::invalid(
            "目标目录位于当前数据目录内部，会造成递归复制",
        ));
    }
    if source.starts_with(&target_canon) {
        return Err(AppError::invalid(
            "目标目录是当前数据目录的上级目录，会覆盖现有数据",
        ));
    }

    if target.exists() && !target.is_dir() {
        return Err(AppError::invalid("目标位置已存在同名文件，不是目录"));
    }
    if has_environment(&target_canon) {
        return Err(AppError::conflict(
            "目标目录中已经存在一个数据环境，不会覆盖或合并",
        ));
    }

    // 可写性用真实写入探测：只读挂载点用 metadata 看不出来。
    fs::create_dir_all(&target_canon)
        .map_err(|e| AppError::io(format!("无法创建目标目录：{e}")))?;
    let probe = target_canon.join(format!(".write-probe-{}", std::process::id()));
    match File::create(&probe) {
        Ok(mut file) => {
            let _ = file.write_all(b"probe");
            let _ = fs::remove_file(&probe);
        }
        Err(e) => {
            return Err(AppError::io(format!(
                "目标位置不可写：{}（{e}）",
                target_canon.display()
            )))
        }
    }

    Ok(())
}

/// 目标盘剩余空间（字节）。
pub fn available_space(path: &Path) -> Option<u64> {
    fs2::available_space(path).ok()
}

/// 启动时的自定义根校验：存在、是目录、有环境标记。
/// 这里不创建任何东西——创建会把"盘没挂上"变成"悄悄新建了一个空根"。
pub fn validate_existing_root(target: &Path) -> AppResult<()> {
    if !target.exists() {
        return Err(AppError::env(format!(
            "自定义数据位置不可用：{} 不存在。可能是外接盘未连接。",
            target.display()
        )));
    }
    if !target.is_dir() {
        return Err(AppError::env(format!(
            "自定义数据位置不是目录：{}",
            target.display()
        )));
    }
    if !has_environment(target) {
        return Err(AppError::env(format!(
            "自定义数据位置缺少环境标记（{}），不是 ArtFlow Desk Core 的数据目录。",
            target.join("environment.json").display()
        )));
    }
    Ok(())
}
