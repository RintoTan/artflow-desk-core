//! 应用图标变体的持久化与回退（DEV-06B-ICON）。
//!
//! 全在 `tempfile` 里跑，不触碰真实数据目录。
//! 这里检查的是"存进去什么、重启读到什么、坏值怎么处理"，不是界面。

mod common;

use minidesk::commands::app_icon::{self, DEFAULT_VARIANT};
use minidesk::store::{settings, timezone};

fn env_db() -> (tempfile::TempDir, minidesk::store::environment::Environment) {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    (dir, env)
}

#[test]
fn missing_key_reads_as_orbit_without_writing_anything() {
    let (_dir, env) = env_db();
    let conn = env.open_db().unwrap();

    let info = app_icon::load(&conn).unwrap();
    assert_eq!(info.variant, DEFAULT_VARIANT);
    assert_eq!(info.default_variant, DEFAULT_VARIANT);
    assert_eq!(info.stored_variant, None);

    // 读不落库：键仍然不存在
    assert_eq!(settings::get(&conn, settings::KEY_ICON_VARIANT).unwrap(), None);
}

#[test]
fn chosen_variant_survives_reopen() {
    let (_dir, env) = env_db();
    let now = timezone::now_timestamp();

    {
        let conn = env.open_db().unwrap();
        let info = app_icon::store(&conn, "wave-a", &now).unwrap();
        assert_eq!(info.variant, "wave-a");
        assert_eq!(info.stored_variant.as_deref(), Some("wave-a"));
    }

    // 关掉连接再开一次 = 重启后读
    let conn = env.open_db().unwrap();
    let info = app_icon::load(&conn).unwrap();
    assert_eq!(info.variant, "wave-a");
}

#[test]
fn corrupt_stored_value_falls_back_without_rewriting() {
    let (_dir, env) = env_db();
    let conn = env.open_db().unwrap();
    let now = timezone::now_timestamp();
    settings::set(&conn, settings::KEY_ICON_VARIANT, "orbit-2024", &now).unwrap();

    let info = app_icon::load(&conn).unwrap();
    assert_eq!(info.variant, DEFAULT_VARIANT, "坏值必须回退");
    assert_eq!(
        info.stored_variant.as_deref(),
        Some("orbit-2024"),
        "原始值要保留给界面识别，不能悄悄改写"
    );
    assert_eq!(
        settings::get(&conn, settings::KEY_ICON_VARIANT).unwrap().as_deref(),
        Some("orbit-2024"),
        "读取不得修改库"
    );
}

#[test]
fn unknown_variant_is_rejected_and_nothing_is_written() {
    let (_dir, env) = env_db();
    let conn = env.open_db().unwrap();
    let now = timezone::now_timestamp();

    for bad in ["", "Orbit", "wave_a", "../etc/passwd"] {
        let err = app_icon::store(&conn, bad, &now).unwrap_err();
        assert_eq!(err.code, "INVALID", "{bad:?}");
        assert!(
            settings::get(&conn, settings::KEY_ICON_VARIANT).unwrap().is_none(),
            "{bad:?} 被拒绝后不能留下任何写入"
        );
    }
}

#[test]
fn icon_setting_does_not_disturb_theme_or_timezone() {
    let (_dir, env) = env_db();
    let conn = env.open_db().unwrap();
    let now = timezone::now_timestamp();

    settings::set(&conn, settings::KEY_THEME_MODE, "dark", &now).unwrap();
    settings::set(&conn, settings::KEY_THEME_ACCENT, "#1a2b3c", &now).unwrap();
    let tz_before = settings::get(&conn, settings::KEY_WORKING_TIMEZONE).unwrap();

    app_icon::store(&conn, "layers", &now).unwrap();

    assert_eq!(
        settings::get(&conn, settings::KEY_THEME_MODE).unwrap().as_deref(),
        Some("dark")
    );
    assert_eq!(
        settings::get(&conn, settings::KEY_THEME_ACCENT).unwrap().as_deref(),
        Some("#1a2b3c")
    );
    assert_eq!(
        settings::get(&conn, settings::KEY_WORKING_TIMEZONE).unwrap(),
        tz_before
    );
}

#[test]
fn schema_version_is_unchanged_by_icon_setting() {
    let (_dir, env) = env_db();
    let conn = env.open_db().unwrap();
    app_icon::store(&conn, "layers", &timezone::now_timestamp()).unwrap();

    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        version,
        minidesk::store::migrations::APP_SCHEMA_VERSION as i64,
        "图标偏好只写 app_settings，不动 schema"
    );
}
