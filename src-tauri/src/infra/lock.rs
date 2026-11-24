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

/// 稳定文件身份：Unix 用 `dev + ino`，Windows 用 `卷序号 + 文件索引`。
///
/// 只比较这两个值就足以发现「锁文件被删掉重建」「路径指向了另一个文件」——
/// 这是双写防护的唯一依据，所以两边都必须是真实取得的身份，不允许恒通过。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileId {
    pub volume: u64,
    pub index: u64,
}

pub struct DirLock {
    path: PathBuf,
    // 持有到 drop；进程死亡时内核自动释放。
    _file: File,
    /// 取得锁时的文件身份。用于发现"锁文件被人删掉重建"。
    identity: Option<FileId>,
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
            // 取锁时就没拿到身份：无法证明锁还在原地，宁可挡住写入也不放行。
            (None, _) => Err(AppError::busy(
                "无法确认数据目录锁的身份，已停止写入以避免双写",
            )),
            _ => Err(AppError::busy(
                "数据目录锁文件已被替换，已停止写入以避免双写",
            )),
        }
    }
}

/// 供测试与诊断读取：一个路径当前指向的文件身份。
pub fn file_id(path: &Path) -> Option<FileId> {
    file_identity(path)
}

#[cfg(unix)]
fn file_identity(path: &Path) -> Option<FileId> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).ok().map(|m| FileId {
        volume: m.dev(),
        index: m.ino(),
    })
}

#[cfg(windows)]
fn file_identity(path: &Path) -> Option<FileId> {
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    // 以「只读 + 不跟随重解析点」打开：拿到的必须是路径当前指向的那个文件。
    let file = std::fs::File::open(path).ok()?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let ok = unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) };
    if ok == 0 {
        return None;
    }
    Some(FileId {
        volume: info.dwVolumeSerialNumber as u64,
        index: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    })
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
