//! 应用偏好：工作时区 + 允许的界面偏好键。

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::infra::state::AppState;
use crate::store::settings;
use crate::store::timezone;

/// 允许前端读写的偏好键。新增键必须同时出现在这里，否则拒绝。
///
/// 注意：这里曾经漏掉 `orders_view_mode`，导致订单页一进入就报
/// 「不允许读取的偏好项」——读被拒、写也被拒。新增键时先加这里再加值域校验。
const ALLOWED_KEYS: &[&str] = &[settings::KEY_LIST_DENSITY, settings::KEY_ORDERS_VIEW_MODE];

/// 订单页视图模式的合法取值。与前端 `ViewMode` 一致。
const VIEW_MODES: &[&str] = &["cards", "board", "table"];

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
pub fn working_timezone_set(
    state: State<'_, AppState>,
    timezone_name: String,
) -> AppResult<TimezoneInfo> {
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

#[tauri::command]
pub fn preference_get(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
    if !ALLOWED_KEYS.contains(&key.as_str()) {
        return Err(AppError::denied(format!("不允许读取的偏好项：{key}")));
    }
    let conn = state.env.open_db()?;
    settings::get(&conn, &key)
}

#[tauri::command]
pub fn preference_set(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> AppResult<Option<String>> {
    if !ALLOWED_KEYS.contains(&key.as_str()) {
        return Err(AppError::denied(format!("不允许写入的偏好项：{key}")));
    }
    // 值域按白名单校验：不因为"键合法"就接受任意字符串。
    if key == settings::KEY_LIST_DENSITY && value != "comfortable" && value != "compact" {
        return Err(AppError::invalid("列表密度只能是 comfortable 或 compact"));
    }
    if key == settings::KEY_ORDERS_VIEW_MODE && !VIEW_MODES.contains(&value.as_str()) {
        return Err(AppError::invalid("订单视图只能是 cards、board 或 table"));
    }
    let conn = state.env.open_db()?;
    let now = timezone::now_timestamp();
    settings::set(&conn, &key, &value, &now)?;
    settings::get(&conn, &key)
}
