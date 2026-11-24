//! 单实例激活通道：真的建 socket、真的连上去，不用线程模拟"已经有实例在跑"。
//!
//! Windows 的命名管道实现无法在这里运行（也没有在 Windows 上跑过），
//! 所以这些用例只在 Unix 上执行。

#![cfg(unix)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use minidesk::infra::activate;

fn wait_for(pred: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if pred() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

#[test]
fn a_second_launch_reaches_the_running_instance() {
    let dir = tempfile::tempdir().unwrap();
    let hits = Arc::new(AtomicUsize::new(0));

    let counter = hits.clone();
    activate::serve(dir.path(), move || {
        counter.fetch_add(1, Ordering::SeqCst);
    })
    .unwrap();

    // 监听线程起来有一定延迟，重试到它真的接住为止。
    let mut delivered = false;
    for _ in 0..40 {
        if activate::request(dir.path()) {
            delivered = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    assert!(delivered, "激活请求必须被已运行的实例接住");
    assert!(wait_for(|| hits.load(Ordering::SeqCst) == 1), "回调没有被调用");
}

#[test]
fn with_nobody_listening_the_request_reports_failure() {
    let dir = tempfile::tempdir().unwrap();
    assert!(
        !activate::request(dir.path()),
        "没有实例在跑时必须返回 false，让调用方去报真正的错误"
    );
}

#[test]
fn a_stale_socket_file_does_not_block_startup() {
    let dir = tempfile::tempdir().unwrap();
    let endpoint = activate::endpoint(dir.path());
    // 上次崩溃留下的残留：路径存在但没人监听。
    std::fs::write(&endpoint, b"stale").unwrap();

    let hits = Arc::new(AtomicUsize::new(0));
    let counter = hits.clone();
    activate::serve(dir.path(), move || {
        counter.fetch_add(1, Ordering::SeqCst);
    })
    .expect("残留文件不应阻止建立通道");

    let mut delivered = false;
    for _ in 0..40 {
        if activate::request(dir.path()) {
            delivered = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(delivered, "清理残留后必须能正常接住请求");
}

#[test]
fn the_endpoint_lives_next_to_the_app_data_not_the_data_root() {
    let dir = tempfile::tempdir().unwrap();
    let endpoint = activate::endpoint(dir.path());
    assert_eq!(endpoint.parent(), Some(dir.path()));
    assert!(
        endpoint
            .file_name()
            .map(|n| n.to_string_lossy() == ".instance")
            .unwrap_or(false),
        "通道文件名必须稳定"
    );
}
