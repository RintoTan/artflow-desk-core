//! 工作时区（FIX-08）：持久化、可校验、变更不改时间点、决定编号年份。

mod common;

use chrono_tz::Tz;
use minidesk::domain::numbering;
use minidesk::domain::orders::{create_order, CreateOrderInput};
use minidesk::store::{settings, timezone};

fn env_db() -> (tempfile::TempDir, minidesk::store::environment::Environment) {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    (dir, env)
}

#[test]
fn initial_timezone_is_persisted_and_valid() {
    let (_dir, env) = env_db();
    let conn = env.open_db().unwrap();
    let tz = settings::working_timezone(&conn).unwrap();
    assert_eq!(tz.name(), "Asia/Shanghai", "测试夹具固定该时区");
    assert!(!timezone::system_timezone().name().is_empty());
}

#[test]
fn invalid_iana_names_are_rejected() {
    for bad in ["", "Beijing", "Asia/Shangai", "UTC+8", "Mars/Olympus", "asia/shanghai"] {
        assert!(
            timezone::parse(bad).is_err(),
            "{bad:?} 不应被接受为 IANA 时区"
        );
    }
    assert!(timezone::parse("Asia/Shanghai").is_ok());
    assert!(timezone::parse("  Asia/Tokyo  ").is_ok(), "前后空白应被容忍");
}

#[test]
fn setting_timezone_persists_across_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    {
        let env = common::open(&root);
        let conn = env.open_db().unwrap();
        let now = timezone::now_timestamp();
        settings::set_working_timezone(&conn, "Europe/Berlin", &now).unwrap();
    }
    let env = common::open(&root);
    let conn = env.open_db().unwrap();
    assert_eq!(
        settings::working_timezone(&conn).unwrap().name(),
        "Europe/Berlin"
    );
}

#[test]
fn changing_timezone_does_not_alter_saved_timestamps() {
    let (_dir, env) = env_db();
    let hw = common::highwater(&env);
    let mut conn = env.open_db().unwrap();

    let order = create_order(
        &mut conn,
        &hw,
        common::tz(),
        CreateOrderInput { title: "跨时区".into(), ..Default::default() },
    )
    .unwrap();
    let created_at = order.created_at.clone();

    let now = timezone::now_timestamp();
    settings::set_working_timezone(&conn, "America/Los_Angeles", &now).unwrap();

    let reread: String = conn
        .query_row("SELECT created_at FROM orders WHERE id = ?1", [&order.id], |r| r.get(0))
        .unwrap();
    assert_eq!(reread, created_at, "改时区不得改写已保存的时间点");
}

#[test]
fn same_instant_maps_to_different_years_by_timezone() {
    // 2025-12-31T20:00:00Z：上海已是 2026-01-01，洛杉矶还是 2025-12-31。
    let instant = "2025-12-31T20:00:00.000Z";
    let shanghai = timezone::year_of(instant, Tz::Asia__Shanghai).unwrap();
    let los_angeles = timezone::year_of(instant, Tz::America__Los_Angeles).unwrap();
    assert_eq!(shanghai, 2026);
    assert_eq!(los_angeles, 2025);
}

#[test]
fn numbering_year_follows_working_timezone() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let hw = common::highwater(&env);
    let instant = "2025-12-31T20:00:00.000Z";

    let sh = numbering::reserve(&hw, instant, Tz::Asia__Shanghai).unwrap();
    let la = numbering::reserve(&hw, instant, Tz::America__Los_Angeles).unwrap();
    assert_eq!(sh, "AF-2026-0001");
    assert_eq!(la, "AF-2025-0001", "同一年份内各自独立计数");
}

#[test]
fn local_date_attributes_events_to_the_right_day() {
    let instant = "2026-03-01T17:30:00.000Z";
    let sh = timezone::local_date(instant, Tz::Asia__Shanghai).unwrap();
    let la = timezone::local_date(instant, Tz::America__Los_Angeles).unwrap();
    assert_eq!(sh.to_string(), "2026-03-02");
    assert_eq!(la.to_string(), "2026-03-01");
}

#[test]
fn calendar_dates_reject_timestamps() {
    assert!(timezone::parse_calendar_date("2026-03-01").is_ok());
    assert!(timezone::parse_calendar_date("2026-03-01T10:00:00Z").is_err());
    assert!(timezone::parse_calendar_date("2026/03/01").is_err());
    assert!(timezone::parse_calendar_date("2026-02-30").is_err());
}

#[test]
fn timestamps_are_utc_rfc3339_with_millis() {
    let now = timezone::now_timestamp();
    assert!(now.ends_with('Z'), "{now}");
    assert_eq!(now.len(), 24, "应为 YYYY-MM-DDTHH:MM:SS.mmmZ 形式：{now}");
    let parsed = chrono::DateTime::parse_from_rfc3339(&now).unwrap();
    assert_eq!(parsed.offset().local_minus_utc(), 0);
}
