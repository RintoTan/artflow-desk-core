//! ArtFlow Desk Core —— 本地优先的单画师委托管理桌面应用。
//!
//! 分层：`commands`（薄壳） → `domain`（业务规则） → `store`（持久化与代际）
//! 以及 `media`（附件路径与限制）、`backup`（备份包校验）、`infra`（锁、状态与诊断）。
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

use error::{AppError, AppResult};
use infra::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();

    let app = match build_app() {
        Ok(app) => app,
        Err(message) => {
            // 连窗口都没建起来：没有界面可用，只能写日志 + 原生消息框。
            crate::infra::diag::log_or_stderr("startup", &message);
            crate::infra::diag::native_message("ArtFlow Desk Core 无法启动", &message);
            std::process::exit(1);
        }
    };

    app.run(|handle, event| {
        match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { .. },
                ..
            } => {
                crate::infra::diag::log("window", &format!("close requested: {label}"));
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } => {
                crate::infra::diag::log("window", &format!("destroyed: {label}"));
            }
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                // 单实例路径不会执行 setup（另一个进程已持有数据目录锁），
                // 这时 ExitGate 还没注册。用 try_state 兜住，否则退出回调会 panic：
                // "state() called before manage() for ExitGate"。
                let gate_open = handle
                    .try_state::<infra::close::ExitGate>()
                    .map(|gate| gate.is_allowed())
                    .unwrap_or(true);
                let has_window = !handle.webview_windows().is_empty();
                let block = infra::close::should_block_exit(gate_open, has_window, code);
                crate::infra::diag::log(
                    "exit",
                    &format!(
                        "requested code={} windows={} gate_open={} block={}",
                        code.map(|c| c.to_string()).unwrap_or_else(|| "none".into()),
                        has_window,
                        gate_open,
                        block
                    ),
                );
                if block {
                    api.prevent_exit();
                    let _ = handle.emit("app://exit-requested", ());
                }
            }
            tauri::RunEvent::Exit => {
                crate::infra::diag::log("exit", "process exiting");
            }
            _ => {}
        }
    });
}

fn build_app() -> Result<tauri::App, String> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_menu_event(|handle, event| {
            crate::infra::menu::handle_menu_event(handle, event.id().as_ref());
        })
        .setup(|app| {
            if let Err(e) = setup_app(app) {
                let handle = app.handle().clone();
                crate::infra::diag::log_or_stderr("startup", &format!("初始化失败：{e}"));
                crate::infra::diag::show_fatal(
                    &handle,
                    "ArtFlow Desk Core 无法启动",
                    &fatal_message(&e),
                );
                std::process::exit(1);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::status::environment_status,
            commands::autostart::autostart_get,
            commands::autostart::autostart_set,
            commands::preferences::working_timezone_get,
            commands::preferences::working_timezone_set,
            commands::orders::create_order,
            commands::orders::duplicate_order,
            commands::orders::list_orders,
            commands::orders::order_archive,
            commands::orders::order_unarchive,
            commands::orders::order_pin,
            commands::orders::order_unpin,
            commands::orders::get_order,
            commands::orders::list_order_events,
            commands::orders::list_clients,
            commands::orders::update_order_details,
            commands::orders::start_work,
            commands::orders::undo_start_work,
            commands::orders::advance_stage,
            commands::orders::rework_stage,
            commands::orders::skip_stage,
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
            commands::clients::client_tag_list,
            commands::clients::client_tag_create,
            commands::clients::client_tag_delete,
            commands::clients::client_tag_link,
            commands::clients::client_tag_unlink,
            commands::trash::trash_snapshot,
            commands::trash::trash_client_delete_impact,
            commands::trash::trash_delete_order,
            commands::trash::trash_delete_client,
            commands::trash::trash_restore_order,
            commands::trash::trash_restore_client,
            commands::trash::trash_purge_order,
            commands::trash::trash_purge_client,
            commands::trash::trash_empty,
            commands::trash::trash_cleanup_status,
            commands::trash::trash_retry_cleanup,
            commands::templates::template_list,
            commands::templates::template_create,
            commands::templates::template_update,
            commands::templates::template_duplicate,
            commands::templates::template_delete,
            commands::templates::template_set_default,
            commands::preferences::preference_get,
            commands::preferences::preference_set,
            commands::attachments::attachment_list,
            commands::attachments::attachment_covers,
            commands::client_refs::client_ref_list,
            commands::client_refs::client_ref_covers,
            commands::client_refs::client_ref_import,
            commands::client_refs::client_ref_remove,
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
            commands::backup::backup_status,
            commands::backup::backup_create,
            commands::backup::backup_inspect,
            commands::backup::backup_restore,
            commands::backup::backup_set_reminder,
            commands::backup::restart_app,
            commands::maintenance::maintenance_quarantine,
            commands::reset::data_reset,
            commands::storage::storage_status,
            commands::storage::storage_preview,
            commands::storage::storage_migrate,
            commands::storage::storage_use_default,
            commands::maintenance::maintenance_quarantine_clear,
            commands::maintenance::maintenance_jobs,
            commands::maintenance::maintenance_jobs_prune,
            infra::close::confirm_close,
            commands::diag::diag_note,
            commands::theme::ui_theme_get,
            commands::theme::ui_theme_set,
            commands::app_icon::ui_icon_get,
            commands::app_icon::ui_icon_set,
            commands::finance::finance_platform_list,
            commands::finance::finance_platform_create,
            commands::finance::finance_platform_update,
            commands::finance::finance_platform_archive,
            commands::finance::finance_platform_restore,
            commands::finance::finance_platform_reorder,
            commands::finance::finance_platform_delete,
            commands::finance::finance_order_snapshot,
            commands::finance::finance_payment_plan_save,
            commands::finance::finance_payment_record_create,
            commands::finance::finance_payment_record_update,
            commands::finance::finance_payment_record_void,
            commands::finance::finance_payment_fee_quote,
            commands::finance::finance_refund_create,
            commands::finance::finance_refund_update,
            commands::finance::finance_refund_void,
            commands::finance::finance_stats_report,
            commands::finance::finance_client_summary,
            commands::stats::export_finance_stats_csv,
            commands::stats::export_payments_csv
        ])
        .build(tauri::generate_context!())
        .map_err(|e| format!("构建应用失败：{e}"))
}

/// 装配顺序：先定数据根（决定 QA/正式），再开库与锁，最后才把资源交给界面。
fn setup_app(app: &mut tauri::App) -> AppResult<()> {
    let identifier = app.config().identifier.clone();
    let version = app.package_info().version.to_string();
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::env(format!("无法解析应用数据目录：{e}")))?;

    // 日志跟着应用标识走：正式与 QA 天然分目录，且都在用户可写的数据目录内。
    crate::infra::diag::init(&app_data_dir.join(crate::infra::diag::LOG_DIR));
    crate::infra::diag::log(
        "startup",
        &format!(
            "identifier={identifier} version={version} os={} app_data={}",
            std::env::consts::OS,
            app_data_dir.display()
        ),
    );

    // 数据根只由"构建标识"决定：
    // - 正式标识 → 正式目录，任何环境变量都不参与；
    // - QA 标识  → <qa 目录>/<scenario>，场景名走白名单，不接受路径。
    // 自定义数据位置的指针固定在应用数据目录里（不随数据根移动）。
    let qa_scenario = if crate::store::qa::is_qa_identifier(&identifier) {
        Some(crate::store::qa::scenario_from_env()?)
    } else {
        None
    };
    let pointer_path =
        crate::store::rootptr::pointer_path(&app_data_dir, qa_scenario.map(|s| s.as_str()));

    let (root, qa) = if let Some(scenario) = qa_scenario {
        let fallback = crate::store::qa::scenario_root(&app_data_dir, scenario);
        let root = match crate::store::rootptr::read(&pointer_path)? {
            Some(pointer) => {
                let custom = std::path::PathBuf::from(&pointer.data_root);
                crate::store::rootptr::validate_existing_root(&custom)?;
                custom
            }
            None => fallback,
        };
        crate::store::qa::ensure_not_production(&root)?;
        crate::store::qa::write_marker(&root)?;
        (root, Some(scenario))
    } else {
        crate::store::qa::guard_production_root(&app_data_dir)?;
        let root = match crate::store::rootptr::read(&pointer_path)? {
            Some(pointer) => {
                let custom = std::path::PathBuf::from(&pointer.data_root);
                crate::store::rootptr::validate_existing_root(&custom)?;
                // 正式环境绝不能指向一个带 QA 标记的目录。
                crate::store::qa::guard_production_root(&custom)?;
                custom
            }
            // 后面还要用 app_data_dir 定单实例通道与指针，这里不能 move。
            None => app_data_dir.clone(),
        };
        (root, None)
    };

    // 「是否自定义」要和该环境的默认根比：QA 的默认根本身就在 app_data 下面，
    // 直接跟 app_data_dir 比会永远得到 custom=true。
    let default_root = match qa {
        Some(scenario) => crate::store::qa::scenario_root(&app_data_dir, scenario),
        None => app_data_dir.clone(),
    };
    crate::infra::diag::log(
        "startup",
        &format!(
            "data root resolved to {} (default={} pointer={} custom={})",
            root.display(),
            default_root.display(),
            pointer_path.display(),
            root != default_root
        ),
    );

    // 打开环境即取得跨进程独占锁；此后整个进程生命周期都持有它。
    //
    // 拿不到锁有两种可能：真的还有一个实例在跑，或者锁文件被人替换过。
    // 前者请它把窗口拉到前面就退出，后者必须当作错误报出来。
    let state = match AppState::open_qa(&root, qa) {
        Ok(state) => state,
        Err(e) if e.code == "BUSY" && crate::infra::activate::request(&app_data_dir) => {
            crate::infra::diag::log(
                "startup",
                "another instance is running; asked it to focus and exiting",
            );
            println!("[minidesk] another instance is running; activated it and exiting");
            return Ok(());
        }
        Err(e) => return Err(e),
    };
    let outcome = state.env.outcome();
    crate::infra::diag::log(
        "startup",
        &format!(
            "env ready mode={} scenario={} root={} generation={} schema=v{} first_run={} tz={}",
            if state.qa_mode() { "qa" } else { "production" },
            state.qa_scenario().unwrap_or("-"),
            state.env.root().display(),
            outcome.generation,
            outcome.schema_version,
            outcome.first_run,
            outcome.working_timezone
        ),
    );
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
                    crate::infra::diag::log(
                        "startup",
                        &format!(
                            "attachment recovery completed={} rolled_back={} quarantined={} kept={} failed={}",
                            report.completed,
                            report.rolled_back,
                            report.quarantined.len(),
                            report.kept_unknown.len(),
                            report.failed
                        ),
                    );
                }
            }
            Err(e) => {
                eprintln!("[minidesk] attachment recovery failed: {}", e.message);
                crate::infra::diag::log("startup", &format!("attachment recovery failed: {}", e.message));
            }
        }
        // 启动时的有限自动重试：只碰 purge 任务，attempts < 3 才重新排队。
        // 放在 run_cleanup 之前，本次启动就能把它们再试一遍。
        match crate::domain::trash::reset_purge_failures(&conn, &generation, Some(3)) {
            Ok(0) => {}
            Ok(n) => crate::infra::diag::log(
                "startup",
                &format!("purge cleanup retry queued={n}"),
            ),
            Err(e) => {
                eprintln!("[minidesk] purge cleanup reset failed: {}", e.message);
            }
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
            Err(e) => {
                eprintln!("[minidesk] cleanup failed: {}", e.message);
                crate::infra::diag::log("startup", &format!("cleanup failed: {}", e.message));
            }
        }
    }

    // 只把「当前代际的附件目录」交给 asset 协议。
    //
    // 静态 glob 一旦写成 `generations/*/attachments/**`，就等于允许通过 asset URL
    // 读任意代际的附件（历史上确实这样配过，运行时实测能读到别的代际的图）。
    // 这里改成运行时按代际授权：scope 里没有跨代际通配，别的代际目录不在允许列表内。
    {
        let attachments = state
            .env
            .layout()
            .attachments_dir(state.env.active_generation());
        app.asset_protocol_scope()
            .allow_directory(&attachments, true)
            .map_err(|e| AppError::env(format!("无法授权附件目录给 asset 协议：{e}")))?;
    }

    app.manage(state);
    app.manage(infra::close::ExitGate::new());

    // macOS：默认菜单的 Quit 绑定 NSApplication terminate:，会绕过所有 Rust 事件，
    // 必须换成自定义菜单项才能拦下 Cmd+Q。
    #[cfg(target_os = "macos")]
    infra::menu::install(app).map_err(|e| AppError::env(format!("无法安装菜单：{e}")))?;

    // 窗口由配置创建，这里只确认它真的建出来了——白屏与"窗口没建"要能分开。
    // 单实例激活通道：位置固定在应用数据目录，不随数据根迁移。
    {
        let handle = app.handle().clone();
        crate::infra::activate::serve(&app_data_dir, move || {
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        })?;
    }

    match app.get_webview_window("main") {
        Some(window) => {
            let url = window
                .url()
                .map(|u| u.to_string())
                .unwrap_or_else(|e| format!("<url error: {e}>"));
            crate::infra::diag::log("window", &format!("main window created url={url}"));
        }
        None => {
            crate::infra::diag::log("window", "main window missing after setup");
        }
    }

    Ok(())
}

/// 给用户看的失败说明：先讲人话，再给诊断日志位置。
fn fatal_message(e: &AppError) -> String {
    let hint = if e.code == "BUSY" {
        "\n\n可能还有一个 ArtFlow Desk Core 进程在后台运行。\n\
         请先在任务管理器中结束残留的 ArtFlow Desk Core 进程，再重新启动。"
    } else {
        ""
    };
    let log = crate::infra::diag::log_path()
        .map(|p| format!("\n\n诊断日志：{}", p.display()))
        .unwrap_or_default();
    format!("{}{}{}", e.message, hint, log)
}

/// 未捕获 panic 也要留痕：Windows 上没有控制台，否则只剩"进程消失了"。
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "<unknown>".into());
        crate::infra::diag::log("panic", &format!("at {location}: {info}"));
        previous(info);
    }));
}
