//! ArtFlow miniDesk —— 本地优先的单画师委托管理桌面应用。
//!
//! 分层：`commands`（薄壳） → `domain`（业务规则） → `store`（持久化与代际）
//! 以及 `media`（附件路径与限制）、`backup`（备份包校验）、`infra`（锁与状态）。
//! 命令层不写 SQL，`lib.rs` 只做装配。

pub mod backup;
pub mod commands;
pub mod domain;
pub mod error;
pub mod infra;
pub mod media;
pub mod store;

use tauri::Manager;

use infra::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let root = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("无法解析应用数据目录：{e}"))?;

            // 打开环境即取得跨进程独占锁；此后整个进程生命周期都持有它。
            let state = AppState::open(&root)?;
            let outcome = state.env.outcome();
            println!(
                "[minidesk] env ready path={} generation={} schema=v{} first_run={} tz={}",
                state.env.root().display(),
                outcome.generation,
                outcome.schema_version,
                outcome.first_run,
                outcome.working_timezone
            );

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::status::environment_status,
            commands::preferences::working_timezone_get,
            commands::preferences::working_timezone_set,
            commands::orders::create_order
        ])
        .run(tauri::generate_context!())
        .expect("ArtFlow miniDesk 启动失败");
}
