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
pub mod qa_dataset;
pub mod store;

use tauri::{Emitter, Manager};

use infra::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_menu_event(|handle, event| {
            crate::infra::menu::handle_menu_event(handle, event.id().as_ref());
        })
        .setup(|app| {
            // 数据根只由"构建标识"决定：
            // - 正式标识 → 正式目录，任何环境变量都不参与；
            // - QA 标识  → <qa 目录>/<scenario>，场景名走白名单，不接受路径。
            let identifier = app.config().identifier.clone();
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("无法解析应用数据目录：{e}"))?;

            let (root, qa) = if crate::store::qa::is_qa_identifier(&identifier) {
                let scenario = crate::store::qa::scenario_from_env()?;
                let root = crate::store::qa::scenario_root(&app_data_dir, scenario);
                crate::store::qa::ensure_not_production(&root)?;
                crate::store::qa::write_marker(&root)?;
                (root, Some(scenario))
            } else {
                crate::store::qa::guard_production_root(&app_data_dir)?;
                (app_data_dir, None)
            };

            // 打开环境即取得跨进程独占锁；此后整个进程生命周期都持有它。
            let state = AppState::open_qa(&root, qa)?;
            let outcome = state.env.outcome();
            println!(
                "[minidesk] env ready mode={} scenario={} identifier={} path={} generation={} schema=v{} first_run={} tz={}",
                if state.qa_mode() { "qa" } else { "production" },
                state.qa_scenario().unwrap_or("-"),
                identifier,
                state.env.root().display(),
                outcome.generation,
                outcome.schema_version,
                outcome.first_run,
                outcome.working_timezone
            );

            // 启动维护：先按操作日志收敛崩溃遗留，再执行上次没做完的文件清理。
            // 两件事都以"只删自己确认过的文件"为前提，失败不影响启动。
            {
                let mut conn = state.env.open_db()?;
                let generation = state.env.active_generation().to_string();
                let layout = state.env.layout().clone();
                match crate::domain::attachments::recover(&mut conn, &layout, &generation) {
                    Ok(report) => {
                        if report.completed + report.rolled_back > 0
                            || !report.quarantined.is_empty()
                            || !report.kept_unknown.is_empty()
                        {
                            println!(
                                "[minidesk] attachment recovery: completed={} rolled_back={} quarantined={} kept={} failed={}",
                                report.completed,
                                report.rolled_back,
                                report.quarantined.len(),
                                report.kept_unknown.len(),
                                report.failed
                            );
                        }
                    }
                    Err(e) => eprintln!("[minidesk] attachment recovery failed: {}", e.message),
                }
                match crate::domain::attachments::run_cleanup(&mut conn, &layout, &generation) {
                    Ok(report) => {
                        if report.removed + report.failed + report.refused > 0 {
                            println!(
                                "[minidesk] cleanup: removed={} already_gone={} stale={} refused={} failed={}",
                                report.removed,
                                report.already_gone,
                                report.skipped_stale,
                                report.refused,
                                report.failed
                            );
                        }
                    }
                    Err(e) => eprintln!("[minidesk] cleanup failed: {}", e.message),
                }
            }

            app.manage(state);
            app.manage(infra::close::ExitGate::new());

            // macOS：默认菜单的 Quit 绑定 NSApplication terminate:，会绕过所有 Rust 事件，
            // 必须换成自定义菜单项才能拦下 Cmd+Q。
            #[cfg(target_os = "macos")]
            infra::menu::install(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::status::environment_status,
            commands::preferences::working_timezone_get,
            commands::preferences::working_timezone_set,
            commands::orders::create_order,
            commands::orders::list_orders,
            commands::orders::get_order,
            commands::orders::list_order_events,
            commands::orders::list_clients,
            commands::orders::update_order_details,
            commands::orders::start_work,
            commands::orders::undo_start_work,
            commands::orders::advance_stage,
            commands::orders::rework_stage,
            commands::orders::complete_order,
            commands::orders::cancel_order,
            commands::orders::reopen_order,
            commands::orders::workflow_add_stage,
            commands::orders::workflow_rename_stage,
            commands::orders::workflow_remove_stage,
            commands::orders::workflow_reorder_stages,
            commands::queue::queue_list,
            commands::queue::queue_move,
            commands::clients::client_create,
            commands::clients::client_update,
            commands::clients::client_detail,
            commands::templates::template_list,
            commands::templates::template_create,
            commands::templates::template_update,
            commands::templates::template_duplicate,
            commands::templates::template_delete,
            commands::templates::template_set_default,
            commands::preferences::preference_get,
            commands::preferences::preference_set,
            commands::attachments::attachment_list,
            commands::attachments::attachment_import,
            commands::attachments::attachment_remove,
            commands::attachments::attachment_verify,
            commands::attachments::attachment_rebuild_thumbs,
            commands::attachments::attachment_repair,
            commands::attachments::attachment_update_meta,
            commands::stats::dashboard_metrics,
            commands::stats::dashboard_completed_events,
            commands::stats::stats_report,
            commands::stats::export_summary_csv,
            commands::stats::export_orders_csv,
            infra::close::confirm_close,
            commands::theme::ui_theme_get,
            commands::theme::ui_theme_set,
            commands::app_icon::ui_icon_get,
            commands::app_icon::ui_icon_set
        ])
        .build(tauri::generate_context!())
        .expect("ArtFlow miniDesk 启动失败");

    // Cmd+Q 与应用退出走这里：没被授权就拦下，交给界面问用户。
    app.run(|handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let gate = handle.state::<infra::close::ExitGate>();
            if !gate.is_allowed() {
                api.prevent_exit();
                let _ = handle.emit("app://exit-requested", ());
            }
        }
    });
}
