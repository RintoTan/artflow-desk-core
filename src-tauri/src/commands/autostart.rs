//! 登录时自动启动的读写入口。
//!
//! 状态一律从系统启动项里读回来，不落数据库：数据库里那句「已开启」
//! 一旦和真实系统状态不一致，用户就没有办法自己发现。

use crate::error::AppResult;
use crate::infra::autostart::{self, AutostartStatus};

#[tauri::command]
pub fn autostart_get() -> AppResult<AutostartStatus> {
    let exe = autostart::current_exe()?;
    Ok(autostart::status(&exe))
}

#[tauri::command]
pub fn autostart_set(enabled: bool) -> AppResult<AutostartStatus> {
    let exe = autostart::current_exe()?;
    autostart::set(&exe, enabled)
}
