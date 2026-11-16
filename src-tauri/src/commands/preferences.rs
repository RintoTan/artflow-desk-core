//! 应用偏好（DEV-01 只落地工作时区，其余键随 DEV-06 增加）。

use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::infra::state::AppState;
use crate::store::settings;
use crate::store::timezone;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimezoneInfo {
    pub working_timezone: String,
    pub system_timezone: String,
    pub same_as_system: bool,
}

#[tauri::command]
pub fn working_timezone_get(state: State<'_, AppState>) -> AppResult<TimezoneInfo> {
    let conn = state.env.open_db()?;
    let tz = settings::working_timezone(&conn)?;
    let system = timezone::system_timezone();
    Ok(TimezoneInfo {
        working_timezone: tz.name().to_string(),
        system_timezone: system.name().to_string(),
        same_as_system: tz == system,
    })
}

/// 修改工作时区：只影响展示、提醒与统计月份归属，不修改已保存的时间点。
#[tauri::command]
pub fn working_timezone_set(state: State<'_, AppState>, timezone_name: String) -> AppResult<TimezoneInfo> {
    let conn = state.env.open_db()?;
    let now = timezone::now_timestamp();
    let tz = settings::set_working_timezone(&conn, &timezone_name, &now)?;
    let system = timezone::system_timezone();
    Ok(TimezoneInfo {
        working_timezone: tz.name().to_string(),
        system_timezone: system.name().to_string(),
        same_as_system: tz == system,
    })
}
