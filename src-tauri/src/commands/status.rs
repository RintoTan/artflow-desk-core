//! 环境状态查询（只读）。这里只做字段装配，SQL 全部在 store 层。

use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::infra::state::AppState;
use crate::store::diagnostics;
use crate::store::highwater::YearWatermark;
use crate::store::settings;
use crate::store::timezone;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentStatus {
    pub app_version: String,
    pub first_run: bool,
    pub generation: String,
    pub schema_version: i64,
    pub upgraded_from: Option<i64>,
    pub root_path: String,
    /// true = 本次进程跑在 QA 沙箱里；界面必须显式标注，避免把测试数据当正式数据。
    pub qa_mode: bool,
    pub sqlite_version: String,
    pub journal_mode: String,
    pub working_timezone: String,
    pub system_timezone: String,
    pub lock_held: bool,
    pub orders: i64,
    pub clients: i64,
    pub templates: i64,
    pub attachments: i64,
    pub pending_cleanup: i64,
    pub high_water: Vec<YearWatermark>,
    pub integrity: String,
}

#[tauri::command]
pub fn environment_status(state: State<'_, AppState>) -> AppResult<EnvironmentStatus> {
    let conn = state.env.open_db()?;
    let facts = diagnostics::facts(&conn)?;
    let outcome = state.env.outcome();

    Ok(EnvironmentStatus {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        first_run: outcome.first_run,
        generation: outcome.generation.clone(),
        schema_version: outcome.schema_version,
        upgraded_from: outcome.upgraded_from,
        root_path: state.env.root().to_string_lossy().to_string(),
        qa_mode: state.qa_mode(),
        sqlite_version: facts.sqlite_version,
        journal_mode: facts.journal_mode,
        working_timezone: settings::working_timezone(&conn)
            .map(|tz| tz.name().to_string())
            .unwrap_or_else(|_| outcome.working_timezone.clone()),
        system_timezone: timezone::system_timezone().name().to_string(),
        // 命令能被执行，说明本进程仍持有独占锁。
        lock_held: state.env.lock_verify().is_ok(),
        orders: facts.counts.orders,
        clients: facts.counts.clients,
        templates: facts.counts.templates,
        attachments: facts.counts.attachments,
        pending_cleanup: facts.counts.pending_cleanup,
        high_water: state.highwater.snapshot()?,
        integrity: facts.integrity,
    })
}
