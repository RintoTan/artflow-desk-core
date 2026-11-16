//! 应用设置与首次默认数据。

use chrono_tz::Tz;
use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{AppError, AppResult};
use crate::store::migrations::v1;
use crate::store::timezone;

pub const KEY_WORKING_TIMEZONE: &str = "working_timezone";
pub const KEY_LIST_DENSITY: &str = "list_density";
pub const KEY_STARTUP_PAGE: &str = "startup_page";
pub const KEY_ACTIVE_LIGHT_THEME: &str = "active_light_theme";
pub const KEY_ACTIVE_DARK_THEME: &str = "active_dark_theme";
pub const KEY_DEFAULTS_SEEDED: &str = "defaults_seeded";
pub const KEY_SCHEMA_VERSION: &str = "schema_version";

/// 内置模板：草稿 → 线稿 → 固有色 → 细化 → 最终调整（D-00-14）。
pub const DEFAULT_TEMPLATE_ID: &str = "tpl-default";
pub const DEFAULT_TEMPLATE_NAME: &str = "通用制作流程";
pub const DEFAULT_STEPS: &[(&str, &str)] = &[
    ("draft", "草稿"),
    ("lineart", "线稿"),
    ("base-color", "固有色"),
    ("refine", "细化"),
    ("final-adjust", "最终调整"),
];

pub const BUILTIN_THEME_ID: &str = "theme-arctic-blue";
pub const BUILTIN_THEME_LIGHT: &str = r##"{
  "bg": "#F5F8FC", "surface": "#FFFFFF", "surfaceAlt": "#EDF3FA",
  "border": "#D3E0EE", "text": "#16283C", "textMuted": "#5A7189",
  "accent": "#2C6FB5", "accentContrast": "#FFFFFF", "danger": "#B4402F"
}"##;
pub const BUILTIN_THEME_DARK: &str = r##"{
  "bg": "#0E1621", "surface": "#16222F", "surfaceAlt": "#1D2C3C",
  "border": "#2A3B4D", "text": "#E7EFF7", "textMuted": "#93A8BC",
  "accent": "#5FA8E0", "accentContrast": "#0B1420", "danger": "#E2795F"
}"##;

pub fn get(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM app_settings WHERE key = ?1", [key], |r| {
            r.get::<_, String>(0)
        })
        .optional()?)
}

pub fn set(conn: &Connection, key: &str, value: &str, now: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now],
    )?;
    Ok(())
}

pub fn working_timezone(conn: &Connection) -> AppResult<Tz> {
    let raw = get(conn, KEY_WORKING_TIMEZONE)?
        .ok_or_else(|| AppError::timezone("尚未设置工作时区"))?;
    timezone::parse(&raw)
}

pub fn set_working_timezone(conn: &Connection, tz: &str, now: &str) -> AppResult<Tz> {
    let parsed = timezone::parse(tz)?;
    set(conn, KEY_WORKING_TIMEZONE, &parsed.name(), now)?;
    Ok(parsed)
}

/// 首次启动写入默认数据。只执行一次（由 `defaults_seeded` 标记控制），
/// 后续启动不会覆盖用户已有的模板、主题或设置。
pub fn seed_defaults_once(conn: &mut Connection, tz: Tz, now: &str) -> AppResult<bool> {
    if get(conn, KEY_DEFAULTS_SEEDED)?.as_deref() == Some("1") {
        return Ok(false);
    }
    let tx = conn.transaction()?;

    tx.execute(
        "INSERT OR IGNORE INTO stage_templates (id, name, is_default, revision, created_at, updated_at)
         VALUES (?1, ?2, 1, 0, ?3, ?3)",
        params![DEFAULT_TEMPLATE_ID, DEFAULT_TEMPLATE_NAME, now],
    )?;
    for (index, (step_id, title)) in DEFAULT_STEPS.iter().enumerate() {
        tx.execute(
            "INSERT OR IGNORE INTO stage_template_steps (template_id, step_id, title, position)
             VALUES (?1, ?2, ?3, ?4)",
            params![DEFAULT_TEMPLATE_ID, step_id, title, index as i64],
        )?;
    }

    tx.execute(
        "INSERT OR IGNORE INTO themes (id, name, mode, tokens, builtin, created_at, updated_at)
         VALUES (?1, ?2, 'light', ?3, 1, ?4, ?4)",
        params![BUILTIN_THEME_ID, "Arctic Blue 浅色", BUILTIN_THEME_LIGHT, now],
    )?;

    for (key, value) in [
        (KEY_WORKING_TIMEZONE, tz.name()),
        (KEY_LIST_DENSITY, "comfortable"),
        (KEY_STARTUP_PAGE, "dashboard"),
        (KEY_ACTIVE_LIGHT_THEME, BUILTIN_THEME_ID),
        (KEY_DEFAULTS_SEEDED, "1"),
    ] {
        tx.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO NOTHING",
            params![key, value, now],
        )?;
    }

    tx.execute(
        "INSERT INTO schema_meta (key, value) VALUES ('initialized_at', ?1)
         ON CONFLICT(key) DO NOTHING",
        params![now],
    )?;
    tx.execute(
        "INSERT INTO schema_meta (key, value) VALUES ('schema_baseline', 'v1')
         ON CONFLICT(key) DO NOTHING",
        [],
    )?;
    let _ = v1::SQL; // schema 由迁移链建立，这里只填默认数据
    tx.commit()?;
    Ok(true)
}
