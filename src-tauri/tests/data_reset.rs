//! DEV-0.1.1-04：数据重置。
//!
//! 覆盖 §6 的产品规则与三条硬约束（编号不动、快照不被清理、失败不切指针）。
//! 全部使用临时目录，不触碰 QA 数据。

mod common;

use std::fs;
use std::path::{Path, PathBuf};

use common::Ctx;
use minidesk::domain::reset::{self, ResetInput};
use minidesk::store::environment::open_connection;
use minidesk::store::migrations;
use minidesk::store::settings;

fn input(set: &[&str]) -> ResetInput {
    ResetInput {
        business: set.contains(&"business"),
        settings: set.contains(&"settings"),
        backups: set.contains(&"backups"),
        reminder: set.contains(&"reminder"),
        logs: set.contains(&"logs"),
        quarantine: set.contains(&"quarantine"),
        only: Vec::new(),
    }
}

fn pointer(ctx: &Ctx) -> String {
    let raw = fs::read_to_string(ctx.env.layout().active_pointer()).expect("读指针失败");
    let value: serde_json::Value = serde_json::from_str(&raw).expect("解析指针失败");
    value["generation"].as_str().expect("指针缺 generation").into()
}

fn generation_ids(ctx: &Ctx) -> Vec<String> {
    let mut ids: Vec<String> = fs::read_dir(ctx.env.layout().generations_dir())
        .expect("读代际目录失败")
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    ids.sort();
    ids
}

fn seed_custom_theme(ctx: &Ctx) {
    let conn = ctx.conn();
    conn.execute(
        "INSERT INTO themes (id, name, mode, tokens, builtin, created_at, updated_at)
         VALUES ('theme-custom', '我的主题', 'dark', '{\"accent\":\"#123456\"}', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
        [],
    )
    .expect("插入自定义主题失败");
}

fn set_pref(ctx: &Ctx, key: &str, value: &str) {
    let conn = ctx.conn();
    settings::set(&conn, key, value, "2026-01-01T00:00:00Z").expect("写设置失败");
}

#[test]
fn empty_selection_is_refused() {
    let ctx = Ctx::new();
    let log = tempfile::tempdir().unwrap();
    let err = reset::run(&ctx.env, &ctx.hw, log.path(), &input(&[])).unwrap_err();
    assert!(err.message.contains("没有选择"), "{}", err.message);
}

#[test]
fn unknown_option_names_are_ignored_not_executed() {
    let ctx = Ctx::new();
    let log = tempfile::tempdir().unwrap();
    let mut req = input(&[]);
    req.only = vec!["订单".into()];
    let err = reset::run(&ctx.env, &ctx.hw, log.path(), &req).unwrap_err();
    assert!(err.message.contains("没有选择"), "{}", err.message);
}

#[test]
fn protected_files_are_refused_by_the_backend() {
    let ctx = Ctx::new();
    let log = tempfile::tempdir().unwrap();
    for name in ["highwater.sqlite", "active.json", "environment.json", "recovery", ".write.lock"] {
        let mut req = input(&[]);
        req.only = vec![name.into()];
        let err = reset::run(&ctx.env, &ctx.hw, log.path(), &req).unwrap_err();
        assert!(
            err.message.contains("不可重置"),
            "{name} 未被拒绝：{}",
            err.message
        );
    }
}

#[test]
fn business_reset_switches_to_a_fresh_v9_generation_and_keeps_prefs() {
    let ctx = Ctx::new();
    let log = tempfile::tempdir().unwrap();
    ctx.create_order("会被清掉的订单");
    set_pref(&ctx, settings::KEY_LIST_DENSITY, "compact");
    seed_custom_theme(&ctx);

    let old = pointer(&ctx);
    let report = reset::run(&ctx.env, &ctx.hw, log.path(), &input(&["business"])).unwrap();

    assert_eq!(report.overall, "all_ok");
    let new_id = report.new_generation.clone().expect("缺少新代际");
    assert_ne!(new_id, old);
    assert_eq!(pointer(&ctx), new_id);

    // 旧代际保留
    assert!(generation_ids(&ctx).contains(&old));
    assert_eq!(report.old_generation, old);
    assert!(Path::new(&report.old_generation_path).exists());

    // 新代际：空业务数据、结构等于当前最新版、完整性通过
    let db = ctx.env.layout().generation_db(&new_id);
    let conn = open_connection(&db).unwrap();
    let orders: i64 = conn.query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0)).unwrap();
    let clients: i64 = conn.query_row("SELECT COUNT(*) FROM clients", [], |r| r.get(0)).unwrap();
    assert_eq!((orders, clients), (0, 0));
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    assert_eq!(version, migrations::APP_SCHEMA_VERSION);
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
    assert_eq!(integrity, "ok");

    // 偏好原样保留（含自定义主题）
    assert_eq!(
        settings::get(&conn, settings::KEY_LIST_DENSITY).unwrap().as_deref(),
        Some("compact")
    );
    let custom: i64 = conn
        .query_row("SELECT COUNT(*) FROM themes WHERE id = 'theme-custom'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(custom, 1);

    // 安全快照存在，且在 backups/ 下
    let snapshot = PathBuf::from(report.snapshot_path.clone().expect("缺少快照"));
    assert!(snapshot.exists(), "快照未生成");
    assert_eq!(snapshot.parent(), Some(ctx.env.layout().backups_dir().as_path()));
}

#[test]
fn settings_only_reset_leaves_business_data_alone() {
    let ctx = Ctx::new();
    let log = tempfile::tempdir().unwrap();
    let order = ctx.create_order("不该被动的订单");
    set_pref(&ctx, settings::KEY_STARTUP_PAGE, "calendar");
    seed_custom_theme(&ctx);
    let before = pointer(&ctx);

    let report = reset::run(&ctx.env, &ctx.hw, log.path(), &input(&["settings"])).unwrap();
    assert_eq!(report.overall, "all_ok");
    assert!(report.new_generation.is_none());
    assert_eq!(pointer(&ctx), before);

    let conn = ctx.conn();
    let orders: i64 = conn.query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0)).unwrap();
    assert_eq!(orders, 1);
    assert_eq!(ctx.load(&order).title, "不该被动的订单");

    assert_eq!(settings::get(&conn, settings::KEY_STARTUP_PAGE).unwrap().as_deref(), Some("dashboard"));
    assert_eq!(
        settings::get(&conn, settings::KEY_LIST_DENSITY).unwrap().as_deref(),
        Some("comfortable")
    );
    let custom: i64 = conn
        .query_row("SELECT COUNT(*) FROM themes WHERE builtin = 0", [], |r| r.get(0))
        .unwrap();
    assert_eq!(custom, 0);
    let builtin: i64 = conn
        .query_row("SELECT COUNT(*) FROM themes WHERE builtin = 1", [], |r| r.get(0))
        .unwrap();
    assert!(builtin >= 1, "内置主题不能跟着删掉");
}

#[test]
fn both_options_reset_everything_to_defaults_without_a_second_pass() {
    let ctx = Ctx::new();
    let log = tempfile::tempdir().unwrap();
    ctx.create_order("清空");
    set_pref(&ctx, settings::KEY_STARTUP_PAGE, "calendar");
    seed_custom_theme(&ctx);

    let report = reset::run(&ctx.env, &ctx.hw, log.path(), &input(&["business", "settings"])).unwrap();
    assert_eq!(report.overall, "all_ok");
    let settings_item = report
        .items
        .iter()
        .find(|i| i.option == "settings")
        .expect("缺少 settings 结果");
    assert!(settings_item.detail.as_deref().unwrap_or("").contains("不再重复重置"));

    let new_id = report.new_generation.unwrap();
    let conn = open_connection(&ctx.env.layout().generation_db(&new_id)).unwrap();
    assert_eq!(
        settings::get(&conn, settings::KEY_STARTUP_PAGE).unwrap().as_deref(),
        Some("dashboard"),
        "两项都勾时不回填"
    );
    let custom: i64 = conn
        .query_row("SELECT COUNT(*) FROM themes WHERE builtin = 0", [], |r| r.get(0))
        .unwrap();
    assert_eq!(custom, 0);
}

#[test]
fn highwater_survives_a_business_reset() {
    let ctx = Ctx::new();
    let log = tempfile::tempdir().unwrap();
    let first = ctx.create_order("第一张");
    assert_eq!(ctx.load(&first).code, "AF-2026-0001");

    let highwater_file = ctx.env.layout().highwater_db();
    let before = fs::read(&highwater_file).unwrap();

    reset::run(&ctx.env, &ctx.hw, log.path(), &input(&["business"])).unwrap();

    // 编号库在 state/ 下，不属于任何代际，必须原样不动。
    assert_eq!(fs::read(&highwater_file).unwrap(), before);

    // 重启后（这里直接用同一份 highwater）新订单接续编号，不从 0001 重发。
    let mut conn = ctx.conn();
    let next = minidesk::domain::orders::create_order(
        &mut conn,
        &ctx.hw,
        common::tz(),
        minidesk::domain::orders::CreateOrderInput {
            title: "重置后的第一张".into(),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(next.code, "AF-2026-0002");
}

#[test]
fn recovery_directory_is_untouched() {
    let ctx = Ctx::new();
    let log = tempfile::tempdir().unwrap();
    let recovery = ctx.env.layout().recovery_dir();
    fs::create_dir_all(&recovery).unwrap();
    let marker = recovery.join("keep-me.txt");
    fs::write(&marker, b"do not delete").unwrap();

    reset::run(
        &ctx.env,
        &ctx.hw,
        log.path(),
        &input(&["business", "backups", "logs", "quarantine"]),
    )
    .unwrap();

    assert!(marker.exists(), "recovery/ 被清理了");
}

#[test]
fn backup_cleanup_keeps_the_safety_snapshot_of_this_run() {
    let ctx = Ctx::new();
    let log = tempfile::tempdir().unwrap();
    let backups = ctx.env.layout().backups_dir();
    fs::create_dir_all(&backups).unwrap();
    let old = backups.join("old-backup.zip");
    fs::write(&old, b"old").unwrap();

    let report = reset::run(&ctx.env, &ctx.hw, log.path(), &input(&["business", "backups"])).unwrap();
    assert_eq!(report.overall, "all_ok");

    let snapshot = PathBuf::from(report.snapshot_path.clone().unwrap());
    assert!(snapshot.exists(), "本次安全快照被一起删掉了");
    assert!(!old.exists(), "旧备份应当被清掉");

    // 另一次**独立**的「清空本地备份」是用户的显式指令：它没有"本次快照"，
    // 因此会连同上一轮的安全快照一起清掉——这是预期边界，不是缺陷。
    let again = reset::run(&ctx.env, &ctx.hw, log.path(), &ResetInput {
        backups: true,
        ..Default::default()
    })
    .unwrap();
    assert_eq!(again.overall, "all_ok");
    assert!(!snapshot.exists(), "显式清空备份应当清掉旧的全部备份");

    // 幂等：再清一次仍然是成功且无事可做
    let third = reset::run(&ctx.env, &ctx.hw, log.path(), &ResetInput {
        backups: true,
        ..Default::default()
    })
    .unwrap();
    assert_eq!(third.overall, "all_ok");
}

#[test]
fn reminder_reset_keeps_the_last_success_time() {
    let ctx = Ctx::new();
    let log = tempfile::tempdir().unwrap();
    let state = ctx.env.layout().state_dir().join("backup.json");
    fs::create_dir_all(state.parent().unwrap()).unwrap();
    fs::write(
        &state,
        r#"{"lastSuccessAt":"2026-11-01T10:00:00+08:00","lastPath":"/tmp/x.zip","reminderDays":14,"lastError":"boom"}"#,
    )
    .unwrap();

    reset::run(&ctx.env, &ctx.hw, log.path(), &input(&["reminder"])).unwrap();

    let raw = fs::read_to_string(&state).unwrap();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(value["reminderDays"], 0);
    assert_eq!(value["lastSuccessAt"], "2026-11-01T10:00:00+08:00");
}

#[test]
fn logs_and_quarantine_are_cleared_within_their_own_bounds() {
    let ctx = Ctx::new();
    let log_dir = tempfile::tempdir().unwrap();
    fs::write(log_dir.path().join("app.log"), b"log").unwrap();
    fs::write(log_dir.path().join("app.log.1"), b"log").unwrap();
    let outside = log_dir.path().parent().unwrap().join("outside-sentinel.txt");
    fs::write(&outside, b"keep").unwrap();

    let quarantine = ctx
        .env
        .layout()
        .attachments_dir(&ctx.env.active_generation())
        .join("quarantine");
    fs::create_dir_all(&quarantine).unwrap();
    fs::write(quarantine.join("orphan-1.png"), b"x").unwrap();

    let report = reset::run(
        &ctx.env,
        &ctx.hw,
        log_dir.path(),
        &input(&["logs", "quarantine"]),
    )
    .unwrap();
    assert_eq!(report.overall, "all_ok");

    assert!(!log_dir.path().join("app.log").exists());
    assert!(!log_dir.path().join("app.log.1").exists());
    assert!(outside.exists(), "日志清理越界了");
    assert!(quarantine.exists(), "隔离区目录本身应保留");
    assert_eq!(fs::read_dir(&quarantine).unwrap().count(), 0);
}

#[test]
fn failed_business_reset_keeps_the_pointer_and_skips_file_work() {
    let ctx = Ctx::new();
    let log = tempfile::tempdir().unwrap();
    ctx.create_order("原有订单");
    let backups = ctx.env.layout().backups_dir();
    fs::create_dir_all(&backups).unwrap();
    let sentinel = backups.join("untouched.zip");
    fs::write(&sentinel, b"keep").unwrap();

    // 让快照无法写入：backups 目录只读。
    let mut perms = fs::metadata(&backups).unwrap().permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0o500);
    }
    fs::set_permissions(&backups, perms).unwrap();

    let before = pointer(&ctx);
    let report = reset::run(&ctx.env, &ctx.hw, log.path(), &input(&["business", "backups"])).unwrap();

    // 恢复权限，便于后续断言与清理
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut p = fs::metadata(&backups).unwrap().permissions();
        p.set_mode(0o700);
        fs::set_permissions(&backups, p).unwrap();
    }

    assert_eq!(report.overall, "all_failed");
    assert_eq!(pointer(&ctx), before, "失败时不得切换指针");
    let business = report.items.iter().find(|i| i.option == "business").unwrap();
    assert_eq!(business.status, "failed");
    let backups_item = report.items.iter().find(|i| i.option == "backups").unwrap();
    assert_eq!(backups_item.status, "skipped", "业务失败后文件操作必须跳过");
    assert!(sentinel.exists(), "业务失败时备份不应被删");

    // 业务数据仍在
    let conn = ctx.conn();
    let orders: i64 = conn.query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0)).unwrap();
    assert_eq!(orders, 1);
}

#[test]
fn retry_only_touches_the_requested_items() {
    let ctx = Ctx::new();
    let log = tempfile::tempdir().unwrap();
    let backups = ctx.env.layout().backups_dir();
    fs::create_dir_all(&backups).unwrap();
    fs::write(backups.join("a.zip"), b"a").unwrap();

    // 只重试 backups：不应触碰业务数据或设置
    let mut req = ResetInput {
        backups: true,
        ..Default::default()
    };
    req.only = vec!["backups".into()];
    let report = reset::run(&ctx.env, &ctx.hw, log.path(), &req).unwrap();
    assert_eq!(report.items.len(), 1);
    assert_eq!(report.items[0].option, "backups");
    assert_eq!(report.overall, "all_ok");
    assert!(!backups.join("a.zip").exists());
}
