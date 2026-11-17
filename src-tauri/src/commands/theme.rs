//! 主题设置：只存"用户选了什么"，不存"当前看起来是什么"。
//!
//! 关键区别：
//! - `mode = system` 必须原样保存，**不能**把观察到的深色/浅色写回去，
//!   否则用户下次启动就再也跟不上系统了；
//! - 强调色只接受 `#rrggbb`，空值表示回到主题自带色；
//! - 存储值损坏（未知模式、非法颜色）时**读出来是安全的默认值**，
//!   但不会去改写库里的原始值——用户可能只是升级/降级过版本。

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::infra::state::AppState;
use crate::store::{settings, timezone};

pub const MODES: [&str; 3] = ["arctic", "dark", "system"];
pub const DEFAULT_MODE: &str = "arctic";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeInfo {
    /// 已经过校验的模式；非法值回退为 arctic。
    pub mode: String,
    /// 已经过校验的强调色；非法值为 null。
    pub accent: Option<String>,
    /// 库里原始存储值，便于界面判断"配置损坏"。
    pub stored_mode: Option<String>,
}

pub fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn normalize_mode(raw: Option<&str>) -> String {
    match raw {
        Some(mode) if MODES.contains(&mode) => mode.to_string(),
        _ => DEFAULT_MODE.to_string(),
    }
}

fn normalize_accent(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|value| is_hex_color(value))
        .map(|value| value.to_ascii_lowercase())
}

fn read(conn: &rusqlite::Connection) -> AppResult<ThemeInfo> {
    let stored_mode = settings::get(conn, settings::KEY_THEME_MODE)?;
    let stored_accent = settings::get(conn, settings::KEY_THEME_ACCENT)?;
    Ok(ThemeInfo {
        mode: normalize_mode(stored_mode.as_deref()),
        accent: normalize_accent(stored_accent.as_deref()),
        stored_mode,
    })
}

#[tauri::command]
pub fn ui_theme_get(state: State<'_, AppState>) -> AppResult<ThemeInfo> {
    let conn = state.env.open_db()?;
    read(&conn)
}

#[tauri::command]
pub fn ui_theme_set(
    state: State<'_, AppState>,
    mode: String,
    accent: Option<String>,
) -> AppResult<ThemeInfo> {
    if !MODES.contains(&mode.as_str()) {
        return Err(AppError::invalid(format!(
            "主题模式只能是 {}，收到 {mode:?}",
            MODES.join(" / ")
        )));
    }
    let accent_value = match accent.as_deref().map(str::trim) {
        None | Some("") => String::new(),
        Some(value) if is_hex_color(value) => value.to_ascii_lowercase(),
        Some(value) => {
            return Err(AppError::invalid(format!(
                "强调色必须是 #rrggbb，收到 {value:?}"
            )))
        }
    };

    let conn = state.env.open_db()?;
    let now = timezone::now_timestamp();
    settings::set(&conn, settings::KEY_THEME_MODE, &mode, &now)?;
    settings::set(&conn, settings::KEY_THEME_ACCENT, &accent_value, &now)?;
    read(&conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_modes_survive() {
        assert_eq!(normalize_mode(Some("dark")), "dark");
        assert_eq!(normalize_mode(Some("system")), "system");
        assert_eq!(normalize_mode(Some("solarized")), DEFAULT_MODE);
        assert_eq!(normalize_mode(None), DEFAULT_MODE);
    }

    #[test]
    fn accent_must_be_hex() {
        assert_eq!(normalize_accent(Some("#1A2B3C")).as_deref(), Some("#1a2b3c"));
        assert_eq!(normalize_accent(Some("red")), None);
        assert_eq!(normalize_accent(Some("#12345")), None);
        assert_eq!(normalize_accent(Some("")), None);
    }
}
