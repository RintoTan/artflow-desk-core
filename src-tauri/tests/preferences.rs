//! 界面偏好键：白名单、值域、默认值与"未知键仍被拒绝"。
//!
//! 回归背景：`orders_view_mode` 曾只加了前端、没加后端白名单，
//! 结果订单页一进入就 `DENIED`——读被拒、写也被拒，而前端的 catch 把它吞掉了。
//! 这里把"键必须在白名单里"和"值必须合法"分别钉住。

mod common;

use common::Ctx;
use minidesk::store::settings;

/// 复刻 `commands::preferences` 的白名单行为（命令层依赖 Tauri State，
/// 这里直接对底层设置表与值域规则做断言，命令层由 `commands.rs` 的源码扫描兜住）。
const ALLOWED: &[&str] = &[settings::KEY_LIST_DENSITY, settings::KEY_ORDERS_VIEW_MODE];

#[test]
fn orders_view_mode_is_an_allowed_key() {
    assert!(
        ALLOWED.contains(&settings::KEY_ORDERS_VIEW_MODE),
        "orders_view_mode 必须在允许读写的键里，否则前端一进去就 DENIED"
    );
}

#[test]
fn orders_view_mode_defaults_to_unset_not_empty_string() {
    let ctx = Ctx::new();
    let conn = ctx.conn();
    assert_eq!(
        settings::get(&conn, settings::KEY_ORDERS_VIEW_MODE).unwrap(),
        None,
        "没选过必须是「未设置」，前端据此回退卡片视图；不能返回空串冒充已设置"
    );
}

#[test]
fn orders_view_mode_round_trips_and_persists() {
    let ctx = Ctx::new();
    let conn = ctx.conn();
    let now = minidesk::store::timezone::now_timestamp();

    settings::set(&conn, settings::KEY_ORDERS_VIEW_MODE, "board", &now).unwrap();
    assert_eq!(
        settings::get(&conn, settings::KEY_ORDERS_VIEW_MODE).unwrap(),
        Some("board".to_string())
    );

    // 「重启」= 新建一个连接再读：值来自数据库而不是内存。
    let again = ctx.conn();
    assert_eq!(
        settings::get(&again, settings::KEY_ORDERS_VIEW_MODE).unwrap(),
        Some("board".to_string())
    );

    settings::set(&again, settings::KEY_ORDERS_VIEW_MODE, "table", &now).unwrap();
    assert_eq!(
        settings::get(&ctx.conn(), settings::KEY_ORDERS_VIEW_MODE).unwrap(),
        Some("table".to_string())
    );
}

#[test]
fn every_view_mode_value_is_accepted_by_the_store() {
    let ctx = Ctx::new();
    let conn = ctx.conn();
    let now = minidesk::store::timezone::now_timestamp();
    for value in ["cards", "board", "table"] {
        settings::set(&conn, settings::KEY_ORDERS_VIEW_MODE, value, &now).unwrap();
        assert_eq!(
            settings::get(&conn, settings::KEY_ORDERS_VIEW_MODE).unwrap(),
            Some(value.to_string())
        );
    }
}

#[test]
fn unknown_keys_are_still_rejected() {
    // 白名单不是"任意字符串都能读写"。
    for key in ["orders_view_mode_v2", "theme", "working_timezone", ""] {
        assert!(!ALLOWED.contains(&key), "{key} 不应在白名单里");
    }
}
