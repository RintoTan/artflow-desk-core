//! QA 沙箱隔离与预置数据验证。
//!
//! 全部在 `tempfile` 临时目录里跑：不打开、不写入真实用户数据目录。
//! 这里检查的是**结构性质**（两个根互不可达）与**真实数据状态**，不是比较配置字符串。

use std::fs;

use tempfile::TempDir;

use minidesk::domain::{attachments, orders};
use minidesk::infra::state::AppState;
use minidesk::qa_dataset::{self, SeedOptions};
use minidesk::store::qa::{self, Scenario};
use minidesk::store::settings;

fn env_roots(outer: &TempDir) -> (std::path::PathBuf, std::path::PathBuf) {
    // 模拟两个应用标识下的 app_data_dir：正式与 QA 是兄弟目录。
    let production = outer.path().join("dev.artflow.minidesk");
    let qa_base = outer.path().join("dev.artflow.minidesk.qa");
    fs::create_dir_all(&production).unwrap();
    (production, qa_base)
}

fn seed_dir(outer: &TempDir) -> std::path::PathBuf {
    let (_, base) = env_roots(outer);
    let dir = qa::scenario_root(&base, Scenario::Seeded);
    qa_dataset::seed_seeded(&dir, &SeedOptions::default()).unwrap();
    dir
}

// ---------------------------------------------------------------- 隔离

#[test]
fn qa_and_production_directories_differ() {
    let outer = TempDir::new().unwrap();
    let (production, base) = env_roots(&outer);
    let seeded = qa::scenario_root(&base, Scenario::Seeded);
    let clean = qa::scenario_root(&base, Scenario::Clean);

    assert_ne!(production, seeded);
    assert_ne!(production, clean);
    assert_ne!(seeded, clean, "两个场景必须互相隔离");
    assert!(seeded.starts_with(&base) && clean.starts_with(&base));
    qa::ensure_isolated(&seeded, Some(&production)).unwrap();
    qa::ensure_isolated(&clean, Some(&production)).unwrap();
}

#[test]
fn symlink_alias_cannot_bypass_the_isolation_check() {
    let outer = TempDir::new().unwrap();
    let (production, base) = env_roots(&outer);

    // 建一个指向正式目录的符号链接，再把它当成"QA 父目录"。
    let alias = outer.path().join("alias-to-prod");
    std::os::unix::fs::symlink(&production, &alias).unwrap();

    let sneaky = alias.join("seeded");
    let err = qa::ensure_isolated(&sneaky, Some(&production)).unwrap_err();
    assert_eq!(err.code, "ENV");
    assert!(err.message.contains("重叠"), "{}", err.message);

    // 反向：正式目录藏在 QA 目录里面，也要被拒。
    let nested_prod = base.join("hidden-prod");
    fs::create_dir_all(&nested_prod).unwrap();
    let err2 = qa::ensure_isolated(&base, Some(&nested_prod)).unwrap_err();
    assert_eq!(err2.code, "ENV");
}

#[test]
fn scenario_names_are_allowlisted_not_paths() {
    assert_eq!(Scenario::parse("seeded").unwrap(), Scenario::Seeded);
    assert_eq!(Scenario::parse("clean").unwrap(), Scenario::Clean);
    for bad in ["/tmp", "../../etc", "seeded/../clean", ""] {
        let err = Scenario::parse(bad).unwrap_err();
        assert_eq!(err.code, "ENV", "{bad} 不应被接受");
    }
}

#[test]
fn only_the_qa_identifier_enters_qa_mode() {
    assert!(qa::is_qa_identifier(qa::QA_IDENTIFIER));
    assert!(!qa::is_qa_identifier(qa::PRODUCTION_IDENTIFIER));
    assert!(!qa::is_qa_identifier("dev.artflow.minidesk.qa.evil"));
}

#[test]
fn production_start_refuses_when_a_qa_marker_sits_in_the_real_root() {
    let outer = TempDir::new().unwrap();
    let (production, _) = env_roots(&outer);
    qa::write_marker(&production).unwrap();

    let err = qa::guard_production_root(&production).unwrap_err();
    assert_eq!(err.code, "ENV");
    assert!(err.message.contains(qa::QA_MARKER_FILE));
}

#[test]
fn qa_marker_is_required_before_any_wipe() {
    let outer = TempDir::new().unwrap();
    let plain = outer.path().join("plain");
    fs::create_dir_all(&plain).unwrap();
    fs::write(plain.join("keep-me"), b"data").unwrap();

    let err = qa::verify_marker(&plain).unwrap_err();
    assert_eq!(err.code, "DENIED");
    assert!(plain.join("keep-me").exists(), "没有标记时不得删除任何东西");
}

// ---------------------------------------------------------------- 数据独立性

#[test]
fn qa_and_production_keep_separate_highwater_and_pointer() {
    let outer = TempDir::new().unwrap();
    let (production, base) = env_roots(&outer);
    let seeded = qa::scenario_root(&base, Scenario::Seeded);
    qa_dataset::seed_seeded(&seeded, &SeedOptions::default()).unwrap();

    let prod_state = AppState::open(&production).unwrap();
    let qa_state = AppState::open_qa(&seeded, Some(Scenario::Seeded)).unwrap();

    assert_ne!(
        prod_state.env.active_generation(),
        qa_state.env.active_generation(),
        "代际指针必须独立"
    );
    // 启动时会对根做 canonicalize（macOS 的 /var → /private/var），比较用同一份。
    assert!(
        qa_state
            .env
            .layout()
            .highwater_db()
            .starts_with(qa::normalize(&seeded)),
        "QA 高水位必须在 QA 根内"
    );
    assert!(
        prod_state
            .env
            .layout()
            .highwater_db()
            .starts_with(qa::normalize(&production)),
        "正式高水位必须在正式根内"
    );

    let prod_conn = prod_state.env.open_db().unwrap();
    let qa_conn = qa_state.env.open_db().unwrap();
    let prod_orders: i64 = prod_conn
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    let qa_orders: i64 = qa_conn
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    assert_eq!(prod_orders, 0, "QA 预置不得写进正式库");
    assert!(qa_orders >= 12, "seeded 场景应有预置订单");
}

#[test]
fn qa_attachment_files_live_only_under_the_qa_root() {
    let outer = TempDir::new().unwrap();
    let seeded = seed_dir(&outer);
    let state = AppState::open_qa(&seeded, Some(Scenario::Seeded)).unwrap();
    let layout = state.env.layout().clone();
    let generation = state.env.active_generation().to_string();
    let conn = state.env.open_db().unwrap();

    let first_order: String = conn
        .query_row("SELECT order_id FROM attachments LIMIT 1", [], |r| r.get(0))
        .unwrap();
    let list = attachments::list(&conn, &layout, &generation, &first_order).unwrap();
    assert!(!list.is_empty(), "seeded 场景应至少有一张附件");

    let seeded_canon = qa::normalize(&seeded);
    for item in &list {
        let path = state
            .env
            .layout()
            .attachments_dir(&generation)
            .join(&item.original_path);
        assert!(
            path.starts_with(&seeded_canon),
            "附件 {} 落在 QA 根之外：{}",
            item.original_path,
            path.display()
        );
        assert!(path.exists(), "附件文件应真实存在：{}", path.display());
    }
}

#[test]
fn cleanup_of_the_qa_layout_does_not_touch_other_roots() {
    let outer = TempDir::new().unwrap();
    let seeded = seed_dir(&outer);
    let (production, _) = env_roots(&outer);

    let prod_attach = production
        .join("generations")
        .join("gen-prod")
        .join("attachments")
        .join("originals");
    fs::create_dir_all(&prod_attach).unwrap();
    let sentinel = prod_attach.join("prod-only.png");
    fs::write(&sentinel, b"production-bytes").unwrap();

    let state = AppState::open_qa(&seeded, Some(Scenario::Seeded)).unwrap();
    let layout = state.env.layout().clone();
    let generation = state.env.active_generation().to_string();
    let mut conn = state.env.open_db().unwrap();
    let report = attachments::run_cleanup(&mut conn, &layout, &generation).unwrap();
    assert_eq!(report.refused, 0, "QA 清理不应拒绝（说明没有越界目标）");

    assert!(sentinel.exists(), "正式附件被 QA 清理删除");
    assert_eq!(fs::read(&sentinel).unwrap(), b"production-bytes");
}

#[test]
fn both_environments_can_be_open_at_the_same_time() {
    let outer = TempDir::new().unwrap();
    let (production, base) = env_roots(&outer);
    let seeded = qa::scenario_root(&base, Scenario::Seeded);
    qa_dataset::seed_seeded(&seeded, &SeedOptions::default()).unwrap();

    let prod = AppState::open(&production).unwrap();
    let qa_state = AppState::open_qa(&seeded, Some(Scenario::Seeded)).unwrap();
    assert!(prod.env.lock_verify().is_ok());
    assert!(qa_state.env.lock_verify().is_ok());

    // 同一个 QA 根再开一次必须被锁挡住（证明确实是两个独立的锁域）。
    let second = AppState::open_qa(&seeded, Some(Scenario::Seeded));
    assert!(second.is_err(), "同一个 QA 根不应允许两个进程同时写");
}

// ---------------------------------------------------------------- 预置数据

#[test]
fn seeding_twice_does_not_duplicate_orders() {
    let outer = TempDir::new().unwrap();
    let (_, base) = env_roots(&outer);
    let dir = qa::scenario_root(&base, Scenario::Seeded);

    let first = qa_dataset::seed_seeded(&dir, &SeedOptions::default()).unwrap();
    let second = qa_dataset::seed_seeded(&dir, &SeedOptions::default()).unwrap();

    assert!(!first.already_seeded);
    assert!(second.already_seeded, "第二次必须是幂等的");
    assert_eq!(first.orders, second.orders);
    assert_eq!(first.attachments, second.attachments);
}

#[test]
fn interrupted_seed_leaves_no_complete_looking_data_and_can_be_rerun() {
    let outer = TempDir::new().unwrap();
    let (_, base) = env_roots(&outer);
    let dir = qa::scenario_root(&base, Scenario::Seeded);

    let err = qa_dataset::seed_seeded(
        &dir,
        &SeedOptions {
            rebuild: false,
            fail_after: Some(2),
        },
    )
    .unwrap_err();
    assert_eq!(err.code, "DB");

    assert!(
        !dir.join("environment.json").exists(),
        "失败后不应留下 environment.json"
    );
    assert!(!dir.join("generations").exists(), "失败后不应留下代际目录");
    assert!(qa::has_marker(&dir), "QA 标记应保留，便于重新预置");

    let report = qa_dataset::seed_seeded(&dir, &SeedOptions::default()).unwrap();
    assert!(report.orders >= 12);
}

#[test]
fn clean_scenario_bootstraps_to_an_empty_business_state() {
    let outer = TempDir::new().unwrap();
    let (_, base) = env_roots(&outer);
    let dir = qa::scenario_root(&base, Scenario::Clean);

    let report = qa_dataset::prepare_clean(&dir, false).unwrap();
    assert_eq!(report.orders, 0);
    assert!(!dir.join("environment.json").exists(), "clean 必须是真正的首次启动");
    assert!(qa::has_marker(&dir));

    let state = AppState::open_qa(&dir, Some(Scenario::Clean)).unwrap();
    assert!(state.env.outcome().first_run, "应当是首次启动");
    let conn = state.env.open_db().unwrap();
    let orders: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    let events: i64 = conn
        .query_row("SELECT COUNT(*) FROM order_events", [], |r| r.get(0))
        .unwrap();
    assert_eq!((orders, events), (0, 0));
}

#[test]
fn seeded_scenario_has_the_expected_events_amounts_and_deadlines() {
    let outer = TempDir::new().unwrap();
    let seeded = seed_dir(&outer);
    let state = AppState::open_qa(&seeded, Some(Scenario::Seeded)).unwrap();
    let conn = state.env.open_db().unwrap();

    let completions: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM order_events e JOIN orders o ON o.id = e.order_id
             WHERE o.title = '双完成演示稿' AND e.kind = 'completed'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(completions, 2);

    let reopened: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM order_events e JOIN orders o ON o.id = e.order_id
             WHERE o.title = '双完成演示稿' AND e.kind = 'reopened'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(reopened, 1);

    let cross: (String, String) = conn
        .query_row(
            "SELECT o.created_at, e.occurred_at FROM orders o
             JOIN order_events e ON e.order_id = o.id AND e.kind = 'completed'
             WHERE o.title = '跨月完成稿'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(cross.0.starts_with("2026-09"), "创建时间应固定在 9 月：{}", cross.0);
    assert!(cross.1.starts_with("2026-10"), "完成时间应固定在 10 月：{}", cross.1);

    let unknown: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders WHERE amount_cents IS NULL", [], |r| {
            r.get(0)
        })
        .unwrap();
    let zero: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders WHERE amount_cents = 0", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert!(unknown >= 1, "应有未知金额订单");
    assert!(zero >= 1, "应有 0 元订单");

    let tz = settings::working_timezone(&conn).unwrap();
    assert_eq!(tz.name(), "Asia/Shanghai");
    use minidesk::domain::deadline::DeadlineState;
    let list = orders::list(&conn).unwrap();
    for expected in [
        DeadlineState::Today,
        DeadlineState::Overdue,
        DeadlineState::Unscheduled,
        DeadlineState::DueSoon,
    ] {
        assert!(
            list.iter().any(|o| o.deadline_state == expected),
            "缺少到期状态 {expected:?}"
        );
    }

    let (total, distinct_names): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), COUNT(DISTINCT display_name) FROM clients",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(total, 3);
    assert_eq!(distinct_names, 2, "应有同名不同 ID 的客户");

    let (tpl_total, defaults): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), SUM(is_default) FROM stage_templates",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(tpl_total >= 3, "默认 + 两套非默认");
    assert_eq!(defaults, 1, "必须只有一个默认模板");
}

/// asset 协议 scope 必须覆盖 QA 场景下的附件路径，否则界面上图片显示不出来。
#[test]
fn qa_asset_scope_covers_scenario_attachment_paths() {
    let config: serde_json::Value =
        serde_json::from_str(&fs::read_to_string("tauri.qa.conf.json").unwrap()).unwrap();
    let scopes = config["app"]["security"]["assetProtocol"]["scope"]
        .as_array()
        .expect("QA 配置必须有 assetProtocol.scope");
    let patterns: Vec<&str> = scopes.iter().filter_map(|v| v.as_str()).collect();

    // v2：scope 不再有静态 glob，改为启动时按活动代际 `allow_directory`。
    // 因此这里校验的是「静态配置不得覆盖任何附件路径」，真正的放行由运行时按代际授权。
    let home = std::env::var("HOME").unwrap();
    let qa_appdata = format!("{home}/Library/Application Support/dev.artflow.minidesk.qa");
    let expand = |p: &str| p.replace("$APPDATA", &qa_appdata);

    for scenario in ["seeded", "clean"] {
        let sample = format!(
            "{qa_appdata}/{scenario}/generations/gen-abc/attachments/originals/x.png"
        );
        let covered = patterns.iter().any(|p| {
            glob::Pattern::new(&expand(p))
                .map(|pat| pat.matches(&sample))
                .unwrap_or(false)
        });
        assert!(
            !covered,
            "{scenario} 场景的附件路径不应再由静态 scope 覆盖（跨代际通配会被真实 WebView 利用）"
        );
    }

    // 正式目录的附件路径同样不能被静态 scope 覆盖。
    let production_sample = format!(
        "{home}/Library/Application Support/dev.artflow.minidesk/generations/gen-abc/attachments/originals/x.png"
    );
    let covers_production = patterns.iter().any(|p| {
        glob::Pattern::new(&expand(p))
            .map(|pat| pat.matches(&production_sample))
            .unwrap_or(false)
    });
    assert!(!covers_production, "QA 构建不应能读到正式附件");
}

#[test]
fn dataset_report_matches_reality() {
    let outer = TempDir::new().unwrap();
    let seeded = seed_dir(&outer);
    let state = AppState::open_qa(&seeded, Some(Scenario::Seeded)).unwrap();
    let conn = state.env.open_db().unwrap();

    let stored = settings::get(&conn, "qa.seed.version").unwrap();
    assert_eq!(stored.as_deref(), Some(qa_dataset::DATASET_VERSION));

    let orders: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap();
    assert!(orders >= 12, "数据集应至少 12 张订单，实际 {orders}");
}
