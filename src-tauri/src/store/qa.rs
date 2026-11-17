//! QA 沙箱：独立数据根目录的解析与守卫。
//!
//! 只解决一件事——让「测试数据」和「正式数据」在启动阶段就不可能混在一起：
//!
//! 1. **双钥匙**：`AF_MINIDESK_QA=1` 与 `AF_MINIDESK_QA_ROOT=<绝对路径>` 必须同时给出，
//!    只给一个直接拒绝启动。避免"以为开了 QA，其实还在正式目录"。
//! 2. **标记文件**：QA 根目录里必须有 `.qa-root` 且内容匹配。没有标记的目录（包括正式
//!    数据目录）不会被当成 QA 环境，`qa_seed` 之外的任何写入都无法让它变成 QA。
//! 3. **互相包含检查**：QA 根与正式数据目录在任一方向互相包含都拒绝。
//! 4. **反向守卫**：正式启动时若发现正式数据目录里出现 QA 标记，也拒绝启动，
//!    防止测试数据被当成正式台账使用。
//!
//! 这些判定只依赖路径与环境变量，不读数据库，因此在打开任何数据之前就能生效。

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

pub const QA_ROOT_ENV: &str = "AF_MINIDESK_QA_ROOT";
pub const QA_FLAG_ENV: &str = "AF_MINIDESK_QA";
pub const QA_MARKER_FILE: &str = ".qa-root";
pub const QA_MARKER_BODY: &str = "artflow-minidesk-qa";

/// 尽量取真实路径；不存在的路径保留原样，交给后续存在性检查报错。
pub fn normalize(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn contains(parent: &Path, child: &Path) -> bool {
    child.starts_with(parent)
}

/// 解析启动时应该使用的数据根。
///
/// - 返回 `Ok(None)`：正常模式，使用正式数据目录。
/// - 返回 `Ok(Some(path))`：QA 模式，使用该目录。
/// - 返回 `Err`：配置不合法，调用方必须**中止启动**而不是回退到正式目录。
pub fn resolve_root(
    production_root: &Path,
    qa_root: Option<&OsStr>,
    qa_flag: Option<&OsStr>,
) -> AppResult<Option<PathBuf>> {
    match (qa_root, qa_flag) {
        (None, None) => {
            let production = normalize(production_root);
            if production.join(QA_MARKER_FILE).exists() {
                return Err(AppError::env(format!(
                    "正式数据目录里出现了 QA 标记（{}），拒绝启动：\
                     这通常意味着测试数据被写进了正式目录。\
                     请先确认数据来源，再手动删除该标记后重新启动。",
                    QA_MARKER_FILE
                )));
            }
            Ok(None)
        }
        (Some(_), None) => Err(AppError::env(format!(
            "只设置了 {QA_ROOT_ENV}。QA 模式必须同时设置 {QA_FLAG_ENV}=1，否则拒绝启动。"
        ))),
        (None, Some(_)) => Err(AppError::env(format!(
            "只设置了 {QA_FLAG_ENV}。QA 模式必须同时给出 {QA_ROOT_ENV}=<绝对路径>，\
             不会默认使用正式数据目录。"
        ))),
        (Some(raw), Some(flag)) => {
            if flag != "1" {
                return Err(AppError::env(format!(
                    "{QA_FLAG_ENV} 只接受 1，收到 {:?}",
                    flag.to_string_lossy()
                )));
            }
            let candidate = PathBuf::from(raw);
            if !candidate.is_absolute() {
                return Err(AppError::env(format!(
                    "{QA_ROOT_ENV} 必须是绝对路径，收到 {:?}",
                    candidate.display().to_string()
                )));
            }
            verify_marker(&candidate)?;

            let production = normalize(production_root);
            let qa = normalize(&candidate);
            if qa == production || contains(&production, &qa) || contains(&qa, &production) {
                return Err(AppError::env(format!(
                    "QA 根目录不能与正式数据目录互相包含：qa={} production={}",
                    qa.display(),
                    production.display()
                )));
            }
            Ok(Some(qa))
        }
    }
}

/// 校验一个目录确实是 QA 根（存在且带正确标记）。
pub fn verify_marker(dir: &Path) -> AppResult<()> {
    if !dir.is_dir() {
        return Err(AppError::env(format!(
            "QA 根目录不存在：{}。请先运行 qa_seed 初始化。",
            dir.display()
        )));
    }
    let marker = dir.join(QA_MARKER_FILE);
    match fs::read_to_string(&marker) {
        Ok(body) if body.trim() == QA_MARKER_BODY => Ok(()),
        Ok(_) => Err(AppError::env(format!(
            "QA 标记内容不正确：{}。不做任何改动，请先检查该目录是什么。",
            marker.display()
        ))),
        Err(_) => Err(AppError::env(format!(
            "缺少 QA 标记 {}（{}）。没有标记的目录不会被当作 QA 环境，\
             以免把正式数据目录当成测试环境。",
            QA_MARKER_FILE,
            dir.display()
        ))),
    }
}

/// 写入 QA 标记。只由 `qa_seed` 在用户显式初始化时调用。
pub fn write_marker(dir: &Path) -> AppResult<()> {
    fs::create_dir_all(dir)?;
    fs::write(dir.join(QA_MARKER_FILE), format!("{QA_MARKER_BODY}\n"))?;
    Ok(())
}

pub fn has_marker(dir: &Path) -> bool {
    dir.join(QA_MARKER_FILE).is_file()
}
