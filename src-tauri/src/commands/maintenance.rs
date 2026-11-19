//! 附件维护命令：只读盘点 + 用户显式发起的手动清理。

use tauri::State;

use crate::domain::maintenance::{self, JobsReport, PruneInput, PruneReport, QuarantineCleared, QuarantineReport};
use crate::error::AppResult;
use crate::infra::state::AppState;

#[tauri::command]
pub fn maintenance_quarantine(state: State<'_, AppState>) -> AppResult<QuarantineReport> {
    let conn = state.env.open_db()?;
    maintenance::quarantine_report(
        &conn,
        state.env.layout(),
        state.env.active_generation(),
    )
}

/// 清理用户点名的 quarantine 文件；仍被数据库引用的会被跳过并如实回报。
#[tauri::command]
pub fn maintenance_quarantine_clear(
    state: State<'_, AppState>,
    names: Vec<String>,
) -> AppResult<QuarantineCleared> {
    let conn = state.env.open_db()?;
    maintenance::quarantine_clear(
        &conn,
        state.env.layout(),
        state.env.active_generation(),
        &names,
    )
}

#[tauri::command]
pub fn maintenance_jobs(state: State<'_, AppState>, prune_days: u32) -> AppResult<JobsReport> {
    let conn = state.env.open_db()?;
    maintenance::jobs_report(&conn, prune_days)
}

/// `dryRun: true` 只统计不删除，前端用它做二次确认前的预览。
#[tauri::command]
pub fn maintenance_jobs_prune(
    state: State<'_, AppState>,
    input: PruneInput,
) -> AppResult<PruneReport> {
    let mut conn = state.env.open_db()?;
    maintenance::jobs_prune(&mut conn, &input)
}
