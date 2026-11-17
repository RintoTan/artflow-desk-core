//! 跨进程数据环境独占锁。
//!
//! 使用操作系统级文件锁（`fs2` → `flock` / `LockFileEx`）：
//! 进程退出（含 abort）由内核释放，不需要清理逻辑，也不提供"删锁文件解锁"。
//! 锁文件位于数据根目录，不随 generation 更换。

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use fs2::FileExt;

use crate::error::{AppError, AppResult};

pub const LOCK_FILE_NAME: &str = ".write.lock";

pub struct DirLock {
    path: PathBuf,
    // 持有到 drop；进程死亡时内核自动释放。
    _file: File,
    /// 取得锁时的文件身份（unix: dev+ino）。用于发现"锁文件被人删掉重建"。
    identity: Option<(u64, u64)>,
}

impl DirLock {
    /// `root` 必须是已规范化的真实路径，否则符号链接别名会拿到不同的锁。
    pub fn acquire(root: &Path) -> AppResult<Self> {
        let path = root.join(LOCK_FILE_NAME);
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&path)
            .map_err(|e| AppError::io(format!("无法创建数据目录锁：{e}")))?;

        let identity = file_identity(&path);
        match file.try_lock_exclusive() {
            Ok(()) => Ok(Self {
                path,
                _file: file,
                identity,
            }),
            Err(_) => Err(AppError::busy(
                "另一个 ArtFlow Desk Core 进程正在使用这个数据目录",
            )),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 校验锁文件仍是当初锁住的那个文件。
    ///
    /// flock 只能保证"同一个文件对象"互斥；如果有人删掉锁文件再让第二个进程
    /// 新建一个，两边会各锁一个不同 inode。这个检查能发现这种情况并拒绝继续。
    pub fn verify(&self) -> AppResult<()> {
        let current = file_identity(&self.path);
        match (self.identity, current) {
            (Some(expected), Some(actual)) if expected == actual => Ok(()),
            (None, _) => Ok(()),
            _ => Err(AppError::busy(
                "数据目录锁文件已被替换，已停止写入以避免双写",
            )),
        }
    }
}

#[cfg(unix)]
fn file_identity(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|m| (m.dev(), m.ino()))
}

#[cfg(not(unix))]
fn file_identity(_path: &Path) -> Option<(u64, u64)> {
    // 非 unix 平台暂不做 inode 级校验；Windows 的文件锁语义由 DEV-09 单独验证。
    None
}

impl Drop for DirLock {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self._file);
    }
}

/// 规范化数据根目录；不存在时先创建。
/// 别名（符号链接、`..`）在这里被折叠成同一真实路径，保证同一目录只有一个锁对象。
pub fn canonical_root(root: &Path) -> AppResult<PathBuf> {
    if !root.exists() {
        std::fs::create_dir_all(root)
            .map_err(|e| AppError::io(format!("无法创建数据目录：{e}")))?;
    }
    std::fs::canonicalize(root).map_err(|e| AppError::io(format!("无法解析数据目录：{e}")))
}
