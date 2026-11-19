//! 退出闸门：让 Cmd+Q 也走"先问界面"的路径。
//!
//! 为什么需要 Rust 这一层：macOS 的 Cmd+Q 不是窗口关闭，而是应用退出请求
//! （`RunEvent::ExitRequested`），网页层拿不到。这里的做法是——
//!
//! 1. 收到"窗口还活着"的退出请求时，若还没有被授权，就 `prevent_exit()` 拦下，
//!    并发 `app://exit-requested` 给界面；
//! 2. 界面确认（保存成功或明确放弃）后调用 `confirm_close`，把闸门打开再 `exit(0)`；
//! 3. 第二次 `ExitRequested` 因为闸门已开，正常退出。
//!
//! **不能拦"最后一个窗口已销毁"的退出请求**：`tauri-runtime-wry` 是在窗口的
//! `Destroyed` 事件里、窗口表清空后才发出 `ExitRequested { code: None }` 的，
//! 那时 WebView 已经不存在，没人能回答确认。拦下它只会留下一个不可见、也打不开
//! 窗口的进程 —— 用户看到的就是"窗口关了，任务管理器里进程还在，再点也打不开"。
//! 所以闸门只对"界面尚在"的请求生效，见 [`should_block_exit`]。
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

/// 退出请求该不该拦。
///
/// - `gate_allowed`：界面已经确认过退出；
/// - `has_window`：此刻还有窗口存在（意味着 WebView 也还在，事件有人接）；
/// - `code`：`Some(_)` 是"应用级退出"（Cmd+Q、`app.exit`、重启），
///   `None` 是"窗口全部销毁后的收尾退出"。
///
/// 三个条件缺一不可：任何一个不满足都放行，避免把进程关在没有窗口的状态里。
pub fn should_block_exit(gate_allowed: bool, has_window: bool, code: Option<i32>) -> bool {
    !gate_allowed && has_window && code.is_some()
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

    #[test]
    fn blocks_only_when_someone_can_answer() {
        // 窗口在、闸门关、应用级退出：拦下问用户。
        assert!(should_block_exit(false, true, Some(0)));
        assert!(should_block_exit(false, true, Some(tauri::RESTART_EXIT_CODE)));
        // 窗口已销毁（code: None）：界面没了，拦住只会留下不可见进程。
        assert!(!should_block_exit(false, false, None));
        // 没有窗口的任何退出都直接放行。
        assert!(!should_block_exit(false, false, Some(0)));
        // 已确认过退出：一律放行。
        assert!(!should_block_exit(true, true, Some(0)));
        assert!(!should_block_exit(true, false, None));
    }
}
