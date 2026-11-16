//! 跨进程独占锁：真实操作系统子进程，不用线程模拟。

mod common;

use std::fs;
use std::process::{Command, Stdio};

use minidesk::store::environment::Environment;

const PROBE: &str = env!("CARGO_BIN_EXE_minidesk-probe");

fn probe(args: &[&str]) -> std::process::Output {
    Command::new(PROBE)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("启动探针失败")
}

fn setup() -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let env = common::open(&root);
    drop(env);
    (dir, root)
}

#[test]
fn single_process_acquires_the_lock() {
    let (_dir, root) = setup();
    let env = common::open(&root);
    assert!(
        root.join(".write.lock").exists(),
        "锁文件必须位于数据根目录"
    );
    assert!(env.active_generation().starts_with("gen-"));
}

#[test]
fn second_process_is_rejected_while_first_holds_the_lock() {
    let (_dir, root) = setup();
    let _env = common::open(&root);

    let out = probe(&["try", root.to_str().unwrap()]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(3), "第二进程应被拒绝：{stdout}");
    assert!(stdout.contains("BUSY"), "{stdout}");
    assert!(stdout.contains("另一个"), "{stdout}");
}

#[test]
fn lock_is_released_after_normal_exit() {
    let (_dir, root) = setup();
    {
        let _env = common::open(&root);
    }
    let out = probe(&["try", root.to_str().unwrap()]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{stdout}");
    assert!(stdout.contains("ACQUIRED"), "{stdout}");
}

#[test]
fn lock_is_released_by_the_kernel_after_abort() {
    let (_dir, root) = setup();
    let out = probe(&["hold-crash", root.to_str().unwrap()]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(!out.status.success(), "探针应异常退出");
    assert!(stdout.contains("LOCKED"), "{stdout}");

    let out = probe(&["try", root.to_str().unwrap()]);
    let again = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "崩溃后应能重新取得锁：{again}");
    assert!(again.contains("ACQUIRED"));
}

#[test]
fn exactly_one_of_two_contending_processes_wins() {
    let (_dir, root) = setup();

    let mut a = Command::new(PROBE)
        .args(["hold", root.to_str().unwrap(), "2"])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();

    // 等到子进程真的打印 LOCKED，避免用固定 sleep 与调度竞争。
    {
        use std::io::{BufRead, BufReader};
        let stdout = a.stdout.take().unwrap();
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.contains("LOCKED"), "第一个进程应取得锁：{line}");
    }

    let b = probe(&["try", root.to_str().unwrap()]);
    let out_a = a.wait_with_output().unwrap();
    let _sa = String::from_utf8_lossy(&out_a.stdout);
    let sb = String::from_utf8_lossy(&b.stdout);

    assert_eq!(b.status.code(), Some(3), "第二个进程应被拒绝：{sb}");
    assert!(sb.contains("BUSY"));
}

#[test]
fn different_data_roots_are_independent() {
    let dir = tempfile::tempdir().unwrap();
    let a = common::open(&dir.path().join("a"));
    let b = common::open(&dir.path().join("b"));
    assert_ne!(a.active_generation(), b.active_generation());
}

#[cfg(unix)]
#[test]
fn symlink_alias_cannot_bypass_the_lock() {
    let (dir, root) = setup();
    let _env = common::open(&root);

    let alias = dir.path().join("alias");
    std::os::unix::fs::symlink(&root, &alias).unwrap();

    let out = probe(&["try", alias.to_str().unwrap()]);
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert_eq!(out.status.code(), Some(3), "别名路径也必须被拒绝：{stdout}");
    assert!(stdout.contains("BUSY"));
}

#[test]
fn same_process_cannot_hold_two_locks_on_one_root() {
    let (_dir, root) = setup();
    let _first = common::open(&root);
    let second = Environment::open(&root);
    assert!(second.is_err(), "同进程内第二次打开同一环境必须失败");
}

#[cfg(unix)]
#[test]
fn replacing_the_lock_file_is_detected() {
    let (_dir, root) = setup();
    let env = common::open(&root);
    let lock_path = root.join(".write.lock");

    // 模拟有人删掉锁文件（外部进程可借此拿到一个新 inode 上的锁）。
    fs::remove_file(&lock_path).unwrap();
    fs::write(&lock_path, b"").unwrap();

    let verified = env.lock_verify();
    assert!(verified.is_err(), "锁文件身份变化必须被发现");
    let err = verified.err().unwrap();
    assert_eq!(err.code, "BUSY");
}

#[test]
fn concurrent_writers_leave_data_intact() {
    let (_dir, root) = setup();
    let env = common::open(&root);
    let mut conn = env.open_db().unwrap();
    common::insert_order(&mut conn, "AF-2026-0001", "被竞争保护");
    drop(conn);

    let out = probe(&["try", root.to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(3));

    let conn = env.open_db().unwrap();
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 1, "锁竞争不得损坏数据");
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
    assert_eq!(integrity, "ok");
}
