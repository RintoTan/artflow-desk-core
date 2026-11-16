//! 编号高水位（FIX-01 / R-02）：序号只增、不复用、不因代际恢复而回退。

mod common;

use std::fs;
use std::process::{Command, Stdio};

use minidesk::domain::numbering;
use minidesk::domain::orders::{create_order, CreateOrderInput};
use minidesk::infra::state::AppState;
use minidesk::store::environment::Environment;
use minidesk::store::highwater::{HighWater, YearWatermark};

const PROBE: &str = env!("CARGO_BIN_EXE_minidesk-probe");

fn probe(args: &[&str]) -> std::process::Output {
    Command::new(PROBE)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("启动探针失败")
}

fn reserve_at(_env: &Environment, hw: &HighWater, timestamp: &str) -> String {
    numbering::reserve(hw, timestamp, common::tz()).expect("预留编号失败")
}

const Y2025: &str = "2025-06-01T02:00:00.000Z";
const Y2026: &str = "2026-06-01T02:00:00.000Z";

#[test]
fn first_code_starts_at_0001() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let hw = common::highwater(&env);
    assert_eq!(reserve_at(&env, &hw, Y2026), "AF-2026-0001");
}

#[test]
fn sequential_allocation_within_the_same_year() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let hw = common::highwater(&env);
    let codes: Vec<String> = (0..3).map(|_| reserve_at(&env, &hw, Y2026)).collect();
    assert_eq!(codes, vec!["AF-2026-0001", "AF-2026-0002", "AF-2026-0003"]);
    assert_eq!(hw.peek(2026).unwrap(), Some(3));
}

#[test]
fn new_year_restarts_sequence_and_keeps_old_year() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let hw = common::highwater(&env);

    assert_eq!(reserve_at(&env, &hw, Y2025), "AF-2025-0001");
    assert_eq!(reserve_at(&env, &hw, Y2025), "AF-2025-0002");
    assert_eq!(reserve_at(&env, &hw, Y2026), "AF-2026-0001");

    let snapshot = hw.snapshot().unwrap();
    assert_eq!(
        snapshot,
        vec![
            YearWatermark { year: 2025, last_allocated: 2 },
            YearWatermark { year: 2026, last_allocated: 1 },
        ]
    );
}

#[test]
fn deleting_an_order_does_not_lower_the_watermark() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let hw = common::highwater(&env);
    let mut conn = env.open_db().unwrap();

    let first = create_order(
        &mut conn,
        &hw,
        common::tz(),
        CreateOrderInput { title: "第一张".into(), ..Default::default() },
    )
    .unwrap();
    assert_eq!(first.code, "AF-2026-0001");

    conn.execute("DELETE FROM orders WHERE id = ?1", [&first.id]).unwrap();

    let second = create_order(
        &mut conn,
        &hw,
        common::tz(),
        CreateOrderInput { title: "删除后新建".into(), ..Default::default() },
    )
    .unwrap();
    assert_eq!(second.code, "AF-2026-0002", "删除不得让编号回退或复用");
}

#[test]
fn code_is_independent_of_queue_position() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let hw = common::highwater(&env);
    let mut conn = env.open_db().unwrap();

    let a = create_order(
        &mut conn,
        &hw,
        common::tz(),
        CreateOrderInput { title: "甲".into(), ..Default::default() },
    )
    .unwrap();
    let b = create_order(
        &mut conn,
        &hw,
        common::tz(),
        CreateOrderInput { title: "乙".into(), ..Default::default() },
    )
    .unwrap();
    assert_eq!((a.code.as_str(), a.queue_position), ("AF-2026-0001", 0));
    assert_eq!((b.code.as_str(), b.queue_position), ("AF-2026-0002", 1));

    // 把乙插到队列最前：编号不变，只有 queue_position 变。
    conn.execute("UPDATE orders SET queue_position = 0 WHERE id = ?1", [&b.id])
        .unwrap();
    conn.execute("UPDATE orders SET queue_position = 1 WHERE id = ?1", [&a.id])
        .unwrap();

    let code_a: String = conn
        .query_row("SELECT code FROM orders WHERE id = ?1", [&a.id], |r| r.get(0))
        .unwrap();
    let pos_b: i64 = conn
        .query_row("SELECT queue_position FROM orders WHERE id = ?1", [&b.id], |r| r.get(0))
        .unwrap();
    assert_eq!(code_a, "AF-2026-0001", "排序不得改变编号");
    assert_eq!(pos_b, 0, "队列位置可以改变");
}

#[test]
fn failed_business_write_leaves_a_gap_but_never_reuses() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let hw = common::highwater(&env);
    let mut conn = env.open_db().unwrap();

    // 先占掉 0001 并模拟"订单写入失败"（直接丢弃，没有落库）。
    let reserved = reserve_at(&env, &hw, "2026-06-01T02:00:00.000Z");
    assert_eq!(reserved, "AF-2026-0001");

    let created = create_order(
        &mut conn,
        &hw,
        common::tz(),
        CreateOrderInput { title: "失败后的下一张".into(), ..Default::default() },
    )
    .unwrap();
    assert_eq!(created.code, "AF-2026-0002", "跳号允许，复用不允许");

    let used: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders WHERE code = 'AF-2026-0001'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(used, 0);
}

#[test]
fn duplicate_code_insert_is_rejected_by_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let hw = common::highwater(&env);
    let mut conn = env.open_db().unwrap();

    let first = create_order(
        &mut conn,
        &hw,
        common::tz(),
        CreateOrderInput { title: "占号".into(), ..Default::default() },
    )
    .unwrap();

    let now = minidesk::store::timezone::now_timestamp();
    let tx = conn.transaction().unwrap();
    let insert = tx.execute(
        "INSERT INTO orders (id, code, title, status, current_stage_id, queue_position,
                             revision, created_at, updated_at)
         VALUES ('dup', ?1, '重复编号', 'active', 'draft', 9, 0, ?2, ?2)",
        rusqlite::params![first.code, now],
    );
    assert!(insert.is_err(), "数据库层必须挡住重复编号");
}

#[test]
fn idempotent_request_creates_only_one_order() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let hw = common::highwater(&env);
    let mut conn = env.open_db().unwrap();

    let input = CreateOrderInput {
        title: "重试请求".into(),
        request_id: Some("req-abc".into()),
        ..Default::default()
    };
    let first = create_order(&mut conn, &hw, common::tz(), input.clone()).unwrap();
    let second = create_order(&mut conn, &hw, common::tz(), input).unwrap();

    assert_eq!(first.id, second.id, "相同 request_id 必须返回同一张订单");
    assert_eq!(first.code, second.code);
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 1, "不得重复建单");
}

#[test]
fn restore_from_old_backup_never_lowers_the_watermark() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let hw = common::highwater(&env);

    // 本机已经用到 2026-0007
    for _ in 0..7 {
        reserve_at(&env, &hw, Y2026);
    }
    assert_eq!(hw.peek(2026).unwrap(), Some(7));

    // 旧备份只记录到 2026-0003，另有一个更早年份。
    let raised = hw
        .merge(&[
            YearWatermark { year: 2026, last_allocated: 3 },
            YearWatermark { year: 2024, last_allocated: 9 },
        ])
        .unwrap();

    assert_eq!(hw.peek(2026).unwrap(), Some(7), "本机高水位不得降低");
    assert_eq!(hw.peek(2024).unwrap(), Some(9), "备份中更早的年份应被吸收");
    assert_eq!(
        raised,
        vec![YearWatermark { year: 2024, last_allocated: 9 }],
        "只有真正被抬高的年份需要上报"
    );
    assert_eq!(reserve_at(&env, &hw, Y2026), "AF-2026-0008");
}

#[test]
fn merge_with_higher_backup_raises_local_watermark() {
    let dir = tempfile::tempdir().unwrap();
    let env = common::open(&dir.path().join("data"));
    let hw = common::highwater(&env);
    reserve_at(&env, &hw, Y2026);

    hw.merge(&[YearWatermark { year: 2026, last_allocated: 41 }])
        .unwrap();
    assert_eq!(reserve_at(&env, &hw, Y2026), "AF-2026-0042");
}

#[test]
fn corrupted_highwater_file_blocks_allocation() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let path = env.layout().highwater_db();
    drop(env);

    fs::write(&path, b"this is definitely not a sqlite database").unwrap();

    let err = match HighWater::open(&path) {
        Ok(_) => panic!("损坏的编号记录必须被拒绝"),
        Err(e) => e,
    };
    assert_eq!(err.code, "NUMBERING");
}

#[test]
fn missing_highwater_file_blocks_startup() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    let path = env.layout().highwater_db();
    drop(env);

    fs::remove_file(&path).unwrap();
    let err = match AppState::open(&root) {
        Ok(_) => panic!("缺少编号记录必须阻止启动"),
        Err(e) => e,
    };
    assert_eq!(err.code, "NUMBERING");
    assert!(!path.exists(), "不得静默重建编号记录");
}

#[test]
fn highwater_survives_process_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    {
        let env = common::open(&root);
        let hw = common::highwater(&env);
        reserve_at(&env, &hw, Y2026);
        reserve_at(&env, &hw, Y2026);
    }
    let env = common::open(&root);
    let hw = common::highwater(&env);
    assert_eq!(hw.peek(2026).unwrap(), Some(2));
    assert_eq!(reserve_at(&env, &hw, Y2026), "AF-2026-0003");
}

#[test]
fn crashed_process_does_not_lose_reserved_numbers() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    drop(env);

    let out = probe(&["reserve-crash", root.to_str().unwrap()]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(!out.status.success(), "探针应异常退出");
    assert!(stdout.contains("RESERVED"), "{stdout}");

    // 崩溃后重新打开：已保留的编号仍然算数，下一个小号不会重复。
    let env = common::open(&root);
    let hw = common::highwater(&env);
    let next = reserve_at(&env, &hw, "2026-06-01T02:00:00.000Z");
    assert!(
        next > "AF-2026-0001".to_string(),
        "崩溃后编号必须继续前进，实际得到 {next}"
    );
}

#[test]
fn two_processes_never_get_the_same_number() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    drop(env);

    // 顺序两次子进程预留：锁保证互斥，编号必须递增且不相同。
    let a = probe(&["reserve", root.to_str().unwrap()]);
    let b = probe(&["reserve", root.to_str().unwrap()]);
    let ca = String::from_utf8_lossy(&a.stdout).trim().to_string();
    let cb = String::from_utf8_lossy(&b.stdout).trim().to_string();
    assert!(a.status.success() && b.status.success(), "{ca} / {cb}");
    assert_ne!(ca, cb, "两次预留不得拿到同一编号");
}
