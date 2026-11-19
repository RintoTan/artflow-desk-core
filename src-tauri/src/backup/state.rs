//! 备份状态：最近一次成功备份时间与提醒周期。
//!
//! **放在数据根目录的 `state/backup.json`，不放业务库**：
//! 提醒是"这台机器上一次备份是什么时候"，属于本机环境状态；
//! 若写进业务库，恢复一份旧备份会把提醒基准一起倒回过去，反而误导用户。

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::store::generation::write_json_atomic;
use crate::store::paths::Layout;

const FILE: &str = "backup.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupState {
    /// 最近一次**成功**导出（或恢复前自动快照成功）的时间。
    pub last_success_at: Option<String>,
    pub last_path: Option<String>,
    /// 0 = 关闭提醒。周期由用户选择，不由程序默认决定。
    pub reminder_days: u32,
    pub last_error: Option<String>,
}

impl Default for BackupState {
    fn default() -> Self {
        Self {
            last_success_at: None,
            last_path: None,
            reminder_days: 0,
            last_error: None,
        }
    }
}

fn path(layout: &Layout) -> std::path::PathBuf {
    layout.state_dir().join(FILE)
}

pub fn load(layout: &Layout) -> BackupState {
    let file = path(layout);
    if !file.exists() {
        return BackupState::default();
    }
    std::fs::read_to_string(&file)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(layout: &Layout, state: &BackupState) -> AppResult<()> {
    write_json_atomic(&path(layout), state)
}

/// 距离上次成功备份的天数；从未备份过返回 None。
pub fn days_since_last(state: &BackupState, now: chrono::DateTime<chrono::Utc>) -> Option<i64> {
    let raw = state.last_success_at.as_ref()?;
    let last = chrono::DateTime::parse_from_rfc3339(raw).ok()?;
    Some((now - last.with_timezone(&chrono::Utc)).num_days())
}

/// 是否到期：没开提醒、从没备份过、或已超过周期。
pub fn reminder_due(state: &BackupState, now: chrono::DateTime<chrono::Utc>) -> bool {
    if state.reminder_days == 0 {
        return false;
    }
    match days_since_last(state, now) {
        None => true,
        Some(days) => days >= state.reminder_days as i64,
    }
}

pub fn record_success(layout: &Layout, at: &str, file: &Path) -> AppResult<()> {
    let mut state = load(layout);
    state.last_success_at = Some(at.to_string());
    state.last_path = Some(file.to_string_lossy().to_string());
    state.last_error = None;
    save(layout, &state)
}

pub fn record_error(layout: &Layout, message: &str) -> AppResult<()> {
    let mut state = load(layout);
    state.last_error = Some(message.to_string());
    save(layout, &state)
}
