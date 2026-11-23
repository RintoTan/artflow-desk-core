//! DEV-0.1.1-04：数据重置命令。

use tauri::{AppHandle, Manager, State};

use crate::domain::reset::{self, ResetInput, ResetReport};
use crate::error::AppResult;
use crate::infra::state::AppState;

/// 日志不在数据根里，必须由应用数据目录解析，不能假定它跟着数据根走。
#[tauri::command]
pub fn data_reset(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ResetInput,
) -> AppResult<ResetReport> {
    let log_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| crate::error::AppError::env(format!("无法解析应用数据目录：{e}")))?
        .join(crate::infra::diag::LOG_DIR);

    let report = reset::run(&state.env, &state.highwater, &log_dir, &input)?;

    crate::infra::diag::log(
        "reset",
        &format!(
            "overall={} items={}",
            report.overall,
            report.items.len()
        ),
    );

    Ok(report)
}
