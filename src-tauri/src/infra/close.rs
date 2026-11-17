//! 退出闸门：让 Cmd+Q 也走"先问界面"的路径。
//!
//! 为什么需要 Rust 这一层：macOS 的 Cmd+Q 不是窗口关闭，而是应用退出请求
//! （`RunEvent::ExitRequested`），网页层拿不到。这里的做法是——
//!
//! 1. 收到退出请求时，若还没有被授权，就 `prevent_exit()` 拦下，并发
//!    `app://exit-requested` 给界面；
//! 2. 界面确认（保存成功或明确放弃）后调用 `confirm_close`，把闸门打开再 `exit(0)`；
//! 3. 第二次 `ExitRequested` 因为闸门已开，正常退出。
//!
//! 闸门只在进程内有效，不落盘：崩溃或断电时它无关紧要（那种情况本来就拦不住）。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, State};

use crate::error::AppResult;

#[derive(Default)]
pub struct ExitGate {
    allowed: AtomicBool,
}

impl ExitGate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn allow(&self) {
        self.allowed.store(true, Ordering::SeqCst);
    }

    pub fn is_allowed(&self) -> bool {
        self.allowed.load(Ordering::SeqCst)
    }
}

/// 界面已确认可以关闭：打开闸门并退出。
///
/// 窗口关闭与应用退出共用这一个出口——macOS 单窗口应用里两者都是"结束进程"，
/// 分成两条实现只会引入两套时序。
#[tauri::command]
pub fn confirm_close(app: AppHandle, gate: State<'_, ExitGate>) -> AppResult<()> {
    gate.allow();
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_starts_closed_and_opens_once() {
        let gate = ExitGate::new();
        assert!(!gate.is_allowed());
        gate.allow();
        assert!(gate.is_allowed());
    }
}
