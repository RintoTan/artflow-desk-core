//! 前端诊断回执。
//!
//! 只做一件事：让 Rust 侧日志能区分"页面已加载到可交互"与"窗口已创建但白屏"。
//! 这两者在任务管理器里长得一样，排障时必须分得开。

/// 记录一条来自界面的短消息（已截断，不接收长文本）。
#[tauri::command]
pub fn diag_note(message: String) {
    let trimmed: String = message.chars().take(200).collect();
    crate::infra::diag::log("ui", &trimmed);
}
