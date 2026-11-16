//! 数据环境目录布局。
//!
//! ```text
//! {root}/
//!   environment.json          环境标记：区分"真正首次启动"与"数据丢失"
//!   .write.lock               跨进程独占锁（稳定位置，不随代际变化）
//!   state/
//!     active.json             活动代指针（原子替换）
//!     highwater.sqlite        年度编号高水位（独立于业务代际）
//!   generations/
//!     gen-<id>/
//!       database.sqlite       唯一正式业务库
//!       attachments/originals/
//!       attachments/thumbs/
//!   backups/                  本地备份产物
//!   recovery/state.json       未完成的恢复/升级事务
//! ```

use std::path::{Path, PathBuf};

pub const MARKER_FILE: &str = "environment.json";
pub const ACTIVE_POINTER: &str = "active.json";
pub const HIGHWATER_FILE: &str = "highwater.sqlite";

#[derive(Debug, Clone)]
pub struct Layout {
    root: PathBuf,
}

impl Layout {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn marker(&self) -> PathBuf {
        self.root.join(MARKER_FILE)
    }

    pub fn state_dir(&self) -> PathBuf {
        self.root.join("state")
    }

    pub fn active_pointer(&self) -> PathBuf {
        self.state_dir().join(ACTIVE_POINTER)
    }

    pub fn highwater_db(&self) -> PathBuf {
        self.state_dir().join(HIGHWATER_FILE)
    }

    pub fn generations_dir(&self) -> PathBuf {
        self.root.join("generations")
    }

    pub fn generation_dir(&self, id: &str) -> PathBuf {
        self.generations_dir().join(id)
    }

    pub fn generation_db(&self, id: &str) -> PathBuf {
        self.generation_dir(id).join("database.sqlite")
    }

    pub fn attachments_dir(&self, id: &str) -> PathBuf {
        self.generation_dir(id).join("attachments")
    }

    pub fn backups_dir(&self) -> PathBuf {
        self.root.join("backups")
    }

    pub fn recovery_dir(&self) -> PathBuf {
        self.root.join("recovery")
    }

    pub fn recovery_state(&self) -> PathBuf {
        self.recovery_dir().join("state.json")
    }
}
