//! 应用图标变体：只存"用户选了哪一套"，不存图像本身。
//!
//! 与主题模块同一套约定：
//! - 稳定标识是 `orbit` / `layers` / `wave-a`，**不是**展示名，改名不影响已保存的值；
//! - 库里值损坏或键缺失时，读出来是 `orbit`，但不去改写库里的原始值；
//! - 写入只接受三个已知标识，其它一律拒绝，避免前端拼错时静默落库一个死值。

use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::infra::state::AppState;
use crate::store::{settings, timezone};

/// 顺序即界面的展示顺序。
pub const VARIANTS: [&str; 3] = ["orbit", "layers", "wave-a"];
pub const DEFAULT_VARIANT: &str = "orbit";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IconInfo {
    /// 已经过校验的变体；非法值回退为 orbit。
    pub variant: String,
    /// 库里原始存储值，便于界面识别"配置损坏"。
    pub stored_variant: Option<String>,
    /// 让界面不必再硬编码一份默认值。
    pub default_variant: String,
}

pub fn is_variant(value: &str) -> bool {
    VARIANTS.contains(&value)
}

pub fn normalize_variant(raw: Option<&str>) -> String {
    match raw.map(str::trim) {
        Some(value) if is_variant(value) => value.to_string(),
        _ => DEFAULT_VARIANT.to_string(),
    }
}

pub fn load(conn: &Connection) -> AppResult<IconInfo> {
    let stored_variant = settings::get(conn, settings::KEY_ICON_VARIANT)?;
    Ok(IconInfo {
        variant: normalize_variant(stored_variant.as_deref()),
        stored_variant,
        default_variant: DEFAULT_VARIANT.to_string(),
    })
}

pub fn store(conn: &Connection, variant: &str, now: &str) -> AppResult<IconInfo> {
    if !is_variant(variant) {
        return Err(AppError::invalid(format!(
            "应用图标只能是 {}，收到 {variant:?}",
            VARIANTS.join(" / ")
        )));
    }
    settings::set(conn, settings::KEY_ICON_VARIANT, variant, now)?;
    load(conn)
}

#[tauri::command]
pub fn ui_icon_get(state: State<'_, AppState>) -> AppResult<IconInfo> {
    let conn = state.env.open_db()?;
    load(&conn)
}

#[tauri::command]
pub fn ui_icon_set(state: State<'_, AppState>, variant: String) -> AppResult<IconInfo> {
    let conn = state.env.open_db()?;
    let now = timezone::now_timestamp();
    store(&conn, variant.trim(), &now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_variants_survive() {
        assert_eq!(normalize_variant(Some("orbit")), "orbit");
        assert_eq!(normalize_variant(Some("layers")), "layers");
        assert_eq!(normalize_variant(Some("wave-a")), "wave-a");
        assert_eq!(normalize_variant(Some(" wave-a ")), "wave-a");
    }

    #[test]
    fn unknown_or_missing_values_fall_back_to_orbit() {
        for bad in ["", "Wave A", "wave_a", "ORBIT", "custom.png"] {
            assert_eq!(normalize_variant(Some(bad)), DEFAULT_VARIANT, "{bad:?}");
        }
        assert_eq!(normalize_variant(None), DEFAULT_VARIANT);
    }

    #[test]
    fn default_variant_is_orbit() {
        // 前端 DEFAULT_ICON_VARIANT 也钉在 "orbit"，两边改动必须同步
        assert_eq!(DEFAULT_VARIANT, "orbit");
        assert_eq!(VARIANTS[0], "orbit");
    }
}
