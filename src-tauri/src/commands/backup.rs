//! 备份与恢复命令面。全部走同一套校验：导出写完自检，恢复先校验再隔离解包。

use std::path::PathBuf;

use tauri::State;

use crate::backup::{create, restore, state as backup_state};
use crate::domain::events;
use crate::error::{AppError, AppResult};
use crate::infra::state::AppState;
use crate::store::migrations;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    pub schema_version: i64,
    pub format_version: u32,
    pub app_version: String,
    pub generation: String,
    pub root: String,
    pub working_timezone: String,
    pub last_success_at: Option<String>,
    pub last_path: Option<String>,
    pub reminder_days: u32,
    pub reminder_due: bool,
    pub days_since_last: Option<i64>,
    pub last_error: Option<String>,
    pub orders: i64,
    pub attachments: i64,
    pub database_bytes: u64,
    pub reachable: bool,
}

#[tauri::command]
pub fn backup_status(state: State<'_, AppState>) -> AppResult<BackupStatus> {
    let layout = state.env.layout();
    let st = backup_state::load(layout);
    let now = chrono::Utc::now();
    let days = backup_state::days_since_last(&st, now);
    let due = backup_state::reminder_due(&st, now);

    let conn = state.env.open_db()?;
    let orders: i64 = conn
        .query_row("SELECT COUNT(*) FROM orders", [], |r| r.get(0))
        .unwrap_or(0);
    let attachments: i64 = conn
        .query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get(0))
        .unwrap_or(0);
    let tz = crate::store::settings::working_timezone(&conn)?.name().to_string();
    drop(conn);

    let db_bytes = std::fs::metadata(state.env.db_path())
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(BackupStatus {
        schema_version: migrations::APP_SCHEMA_VERSION,
        format_version: crate::backup::zip_read::FORMAT_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        generation: state.env.active_generation().to_string(),
        root: layout.root().to_string_lossy().to_string(),
        working_timezone: tz,
        last_success_at: st.last_success_at.clone(),
        last_path: st.last_path.clone(),
        reminder_days: st.reminder_days,
        reminder_due: due,
        days_since_last: days,
        last_error: st.last_error.clone(),
        orders,
        attachments,
        database_bytes: db_bytes,
        reachable: true,
    })
}

#[tauri::command]
pub fn backup_create(
    state: State<'_, AppState>,
    target_path: Option<String>,
) -> AppResult<create::Created> {
    let layout = state.env.layout();
    let target = match target_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => {
            let path = PathBuf::from(raw);
            if !path.is_absolute() {
                return Err(AppError::invalid("备份路径必须是绝对路径"));
            }
            if path.extension().and_then(|e| e.to_str()) != Some("zip") {
                return Err(AppError::invalid("备份文件必须以 .zip 结尾"));
            }
            path
        }
        None => create::default_target(layout, &chrono::Local::now()),
    };
    // 不允许把包写进 generations/ 或 state/：那里是运行时数据，混进去会污染代际。
    if target.starts_with(layout.generations_dir()) || target.starts_with(layout.state_dir()) {
        return Err(AppError::invalid("不能把备份写进 generations/ 或 state/ 目录"));
    }
    match create::create(&state.env, &state.highwater, &target) {
        Ok(done) => Ok(done),
        Err(e) => {
            let _ = backup_state::record_error(layout, &e.message);
            Err(e)
        }
    }
}

#[tauri::command]
pub fn backup_inspect(state: State<'_, AppState>, path: String) -> AppResult<restore::Preview> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(AppError::invalid("备份路径必须是绝对路径"));
    }
    if !path.is_file() {
        return Err(AppError::invalid("备份文件不存在"));
    }
    restore::preview(&state.env, &path)
}

#[tauri::command]
pub fn backup_restore(state: State<'_, AppState>, path: String) -> AppResult<restore::Restored> {
    let path = PathBuf::from(path);
    if !path.is_absolute() || !path.is_file() {
        return Err(AppError::invalid("备份文件不存在或路径不合法"));
    }
    restore::restore(
        &state.env,
        &state.highwater,
        &path,
        &migrations::production(),
    )
}

#[tauri::command]
pub fn backup_set_reminder(state: State<'_, AppState>, days: u32) -> AppResult<BackupStatus> {
    // 只接受一组有意义的档位，避免写成负数或天文数字。
    const ALLOWED: &[u32] = &[0, 7, 14, 30, 90];
    if !ALLOWED.contains(&days) {
        return Err(AppError::invalid("提醒周期只能是 0/7/14/30/90 天"));
    }
    let layout = state.env.layout();
    let mut st = backup_state::load(layout);
    st.reminder_days = days;
    backup_state::save(layout, &st)?;
    drop(st);
    backup_status(state)
}

/// 恢复成功后必须让进程重新加载代际：直接退出，由用户重启（受控重启）。
#[tauri::command]
pub fn restart_app(
    app: tauri::AppHandle,
    gate: State<'_, crate::infra::close::ExitGate>,
) -> AppResult<()> {
    // 重启走的是 ExitRequested(code=RESTART_EXIT_CODE)，会被退出闸门当成"用户要关窗"
    // 拦下来问一句，然后永远等不到回答。这里是程序自己决定的退出，先放行。
    gate.allow();
    app.restart();
}

#[allow(dead_code)]
fn _keep_events_import_used() {
    let _ = events::STAGE_SKIPPED;
}
