//! QA-FIXTURE-01：DEV-06D-2 时间线验收场景的数据证据。
//!
//! 全部在 `tempfile` 临时目录里跑：不打开、不写入真实用户数据目录。
//! 这里断言的是**真实 SQLite 里的行数与日期字段**，不是比较配置字符串。

use std::path::PathBuf;

use tempfile::TempDir;

use minidesk::infra::state::AppState;
use minidesk::qa_dataset::{self, FixtureFacts, SeedOptions};
use minidesk::store::qa::{self, Scenario};

const ALL: [Scenario; 4] = [
    Scenario::TimelineUnscheduled,
    Scenario::TimelineEmpty,
    Scenario::TimelineNoDates,
    Scenario::TimelineTerminal,
];

fn qa_base(outer: &TempDir) -> PathBuf {
    let base = outer.path().join("dev.artflow.minidesk.qa");
    std::fs::create_dir_all(&base).unwrap();
    base
}

fn seed(outer: &TempDir, scenario: Scenario) -> PathBuf {
    let root = qa::scenario_root(&qa_base(outer), scenario);
    qa_dataset::seed_timeline(scenario, &root, &SeedOptions::default()).unwrap();
    root
}

/// 数据目录是跨进程独占锁，同一个进程里第二次 open 也会拿到 BUSY；
/// 所以每次读数都开一个 state、用完立刻关，不在一个测试里同时持有两个。
fn with_root<T>(root: &PathBuf, f: impl FnOnce(&rusqlite::Connection) -> T) -> T {
    let state = AppState::open_qa(root, None).unwrap();
    let conn = state.env.open_db().unwrap();
    f(&conn)
}

fn facts(root: &PathBuf) -> FixtureFacts {
    with_root(root, |conn| qa_dataset::timeline_facts(conn).unwrap())
}

fn titles(root: &PathBuf) -> Vec<String> {
    with_root(root, |conn| {
        let mut stmt = conn.prepare("SELECT title FROM orders ORDER BY title").unwrap();
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
        rows.collect::<Result<Vec<_>, _>>().unwrap()
    })
}

#[test]
fn scenario_names_are_allowlisted_and_stay_inside_the_qa_root() {
    let outer = TempDir::new().unwrap();
    let base = qa_base(&outer);
    for scenario in ALL {
        let root = qa::scenario_root(&base, scenario);
        assert_eq!(root.parent().unwrap(), base, "{} 必须直接落在 QA 根下", scenario.as_str());
        assert_eq!(Scenario::parse(scenario.as_str()).unwrap(), scenario);
        assert!(scenario.is_timeline_fixture());
    }
    for bad in ["timeline", "timeline-", "../timeline-empty", "/timeline-empty"] {
        assert!(Scenario::parse(bad).is_err(), "{bad} 不应被接受");
    }
    assert!(!Scenario::Seeded.is_timeline_fixture());
    assert!(!Scenario::Clean.is_timeline_fixture());
}

#[test]
fn scenario_a_covers_all_four_date_shapes() {
    let outer = TempDir::new().unwrap();
    let root = seed(&outer, Scenario::TimelineUnscheduled);
    let f = facts(&root);
    assert_eq!(
        f,
        FixtureFacts {
            total: 5,
            active: 5,
            complete: 0,
            cancelled: 0,
            both_empty: 2,
            only_start: 1,
            only_delivery: 1,
            both_dates: 1,
        }
    );

    // 只有开始日期的那单：交付日必须真的为 NULL（＝后端"待定交付日"口径）
    let (start, delivery): (Option<String>, Option<String>) = with_root(&root, |conn| {
        conn.query_row(
            "SELECT planned_start_date, planned_delivery_date FROM orders WHERE title = 'QA-A 仅有开始日期'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    });
    assert!(start.is_some(), "仅开始日期的订单必须有 start");
    assert!(delivery.is_none(), "仅开始日期的订单不能有 delivery");

    // 后端未排期口径（delivery IS NULL）应为 3：2 条两空 + 1 条仅开始
    let backend_unscheduled: i64 = with_root(&root, |conn| {
        conn.query_row(
            "SELECT COUNT(*) FROM orders WHERE status = 'active' AND planned_delivery_date IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap()
    });
    assert_eq!(backend_unscheduled, 3, "后端未排期口径 ≠ 时间线未排期口径");

    let titles = titles(&root);
    assert_eq!(titles.len(), 5);
    assert!(titles.iter().all(|t| t.starts_with("QA-A ")), "{titles:?}");
}

#[test]
fn scenario_b_is_initialized_but_has_zero_orders() {
    let outer = TempDir::new().unwrap();
    let root = seed(&outer, Scenario::TimelineEmpty);
    let f = facts(&root);
    assert_eq!(f.total, 0);
    assert_eq!(f.both_empty, 0);
    // 环境真的初始化了（有代际与 highwater），不是"目录不存在"的假空
    assert!(root.join("generations").is_dir());
    assert!(root.join("state").join("active.json").exists());
    assert!(root.join("environment.json").exists());
}

#[test]
fn scenario_c_has_only_undated_active_orders() {
    let outer = TempDir::new().unwrap();
    let root = seed(&outer, Scenario::TimelineNoDates);
    let f = facts(&root);
    assert_eq!(f.total, 2);
    assert_eq!(f.active, 2);
    assert_eq!(f.complete + f.cancelled, 0, "不能有终态订单，否则会落到另一个空状态");
    assert_eq!(f.both_empty, 2);
}

#[test]
fn scenario_d_is_terminal_only_and_undated() {
    let outer = TempDir::new().unwrap();
    let root = seed(&outer, Scenario::TimelineTerminal);
    let f = facts(&root);
    assert_eq!(f.total, 2);
    assert_eq!(f.active, 0, "有一条活动订单就会破坏终态空状态");
    assert_eq!(f.complete, 1);
    assert_eq!(f.cancelled, 1);
    assert_eq!(f.both_empty, 2, "FIX-01 的前提就是终态订单两个日期都为空");

    let titles = titles(&root);
    assert!(titles.iter().any(|t| t.contains("已完成")), "{titles:?}");
    assert!(titles.iter().any(|t| t.contains("已取消")), "{titles:?}");
}

#[test]
fn scenarios_do_not_leak_into_each_other() {
    let outer = TempDir::new().unwrap();
    for scenario in ALL {
        seed(&outer, scenario);
    }
    let base = qa_base(&outer);
    let counts: Vec<i64> = ALL
        .iter()
        .map(|s| facts(&qa::scenario_root(&base, *s)).total)
        .collect();
    assert_eq!(counts, vec![5, 0, 2, 2]);

    // 目录彼此独立，且都带 QA 标记
    for scenario in ALL {
        let root = qa::scenario_root(&base, scenario);
        qa::verify_marker(&root).unwrap();
    }
    assert!(!base.join("seeded").join(".qa-root").exists(), "不应顺手创建 seeded 目录");
}

#[test]
fn seeding_is_idempotent_and_rebuild_is_explicit() {
    let outer = TempDir::new().unwrap();
    let root = seed(&outer, Scenario::TimelineUnscheduled);
    assert_eq!(facts(&root).total, 5);

    // 第二次不带 --rebuild：直接返回，不重复插单
    let again = qa_dataset::seed_timeline(
        Scenario::TimelineUnscheduled,
        &root,
        &SeedOptions::default(),
    )
    .unwrap();
    assert!(again.already_seeded);
    assert_eq!(facts(&root).total, 5);

    // 带 --rebuild：清空后重建，仍是 5 条而不是 10 条
    qa_dataset::seed_timeline(
        Scenario::TimelineUnscheduled,
        &root,
        &SeedOptions { rebuild: true, fail_after: None },
    )
    .unwrap();
    assert_eq!(facts(&root).total, 5);
}

#[test]
fn failed_seed_leaves_no_half_finished_data() {
    let outer = TempDir::new().unwrap();
    let root = qa::scenario_root(&qa_base(&outer), Scenario::TimelineUnscheduled);
    let err = qa_dataset::seed_timeline(
        Scenario::TimelineUnscheduled,
        &root,
        &SeedOptions { rebuild: false, fail_after: Some(2) },
    )
    .unwrap_err();
    assert_eq!(err.code, "DB");
    // 只留 QA 标记，没有可用的数据根
    assert!(root.join(".qa-root").exists());
    assert!(!root.join("generations").exists());
}

#[test]
fn existing_seeded_scenario_is_untouched_by_the_new_ones() {
    let outer = TempDir::new().unwrap();
    let base = qa_base(&outer);
    let seeded = qa::scenario_root(&base, Scenario::Seeded);
    let before = qa_dataset::seed_seeded(&seeded, &SeedOptions::default()).unwrap();
    assert!(before.orders >= 12);

    for scenario in ALL {
        qa_dataset::seed_timeline(
            scenario,
            &qa::scenario_root(&base, scenario),
            &SeedOptions::default(),
        )
        .unwrap();
    }

    // 原 seeded 场景的订单数不变，且仍能被识别为同版本预置
    let orders: i64 = {
        let after = AppState::open_qa(&seeded, Some(Scenario::Seeded)).unwrap();
        let conn = after.env.open_db().unwrap();
        let count = conn
            .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
            .unwrap();
        drop(conn);
        drop(after);
        count
    };
    assert_eq!(orders, before.orders);
    let again = qa_dataset::seed_seeded(&seeded, &SeedOptions::default()).unwrap();
    assert!(again.already_seeded);
}
