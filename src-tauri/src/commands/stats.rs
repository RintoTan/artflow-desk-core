//! 工作台 / 统计 / CSV 导出命令。全部只读业务数据，唯一副作用是写用户选择的 CSV 文件。

use std::path::PathBuf;

use serde::Deserialize;
use tauri::State;

use crate::domain::dashboard::{self, CompletedEventRow, DashboardMetrics};
use crate::domain::export::{self, ExportResult};
use crate::domain::stats::{self, StatsRange, StatsReport};
use crate::error::AppResult;
use crate::infra::state::AppState;

#[tauri::command]
pub fn dashboard_metrics(state: State<'_, AppState>) -> AppResult<DashboardMetrics> {
    let conn = state.env.open_db()?;
    dashboard::metrics(&conn)
}

#[tauri::command]
pub fn dashboard_completed_events(
    state: State<'_, AppState>,
    month: String,
) -> AppResult<Vec<CompletedEventRow>> {
    let conn = state.env.open_db()?;
    dashboard::completed_events_in_month(&conn, &month)
}

#[tauri::command]
pub fn stats_report(state: State<'_, AppState>, range: StatsRange) -> AppResult<StatsReport> {
    let conn = state.env.open_db()?;
    stats::report(&conn, range)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryExportInput {
    pub path: String,
    pub range: StatsRange,
}

#[tauri::command]
pub fn export_summary_csv(
    state: State<'_, AppState>,
    input: SummaryExportInput,
) -> AppResult<ExportResult> {
    let conn = state.env.open_db()?;
    let bytes = export::summary_csv(&conn, input.range)?;
    let report = stats::report(&conn, input.range)?;
    export::write_file(PathBuf::from(&input.path).as_path(), &bytes, report.months.len() as i64 + 1)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrdersExportInput {
    pub path: String,
    /// "all" 或 "filtered"
    pub scope: String,
    /// scope = filtered 时由前端传入它所看到的订单 ID
    #[serde(default)]
    pub order_ids: Vec<String>,
    /// 是否把回收站订单也写进 CSV。默认关闭；开启时已删除行状态为「已删除 · 原状态」。
    #[serde(default)]
    pub include_trashed: bool,
}

#[tauri::command]
pub fn export_orders_csv(
    state: State<'_, AppState>,
    input: OrdersExportInput,
) -> AppResult<ExportResult> {
    let conn = state.env.open_db()?;
    let (rows, label) = match input.scope.as_str() {
        "all" => {
            let rows = export::collect_orders(&conn, &[], input.include_trashed)?;
            let label = if input.include_trashed {
                "全部订单（含回收站）".to_string()
            } else {
                "全部订单".to_string()
            };
            (rows, label)
        }
        "filtered" => {
            if input.order_ids.is_empty() {
                return Err(crate::error::AppError::invalid("当前筛选结果为空，没有可导出的订单"));
            }
            let rows = export::collect_orders(&conn, &input.order_ids, input.include_trashed)?;
            let label = format!("当前筛选结果（{} 条）", rows.len());
            (rows, label)
        }
        other => {
            return Err(crate::error::AppError::invalid(format!(
                "未知的导出范围：{other}"
            )))
        }
    };
    let bytes = export::orders_csv(&conn, &rows, &label)?;
    let count = rows.len() as i64;
    export::write_file(PathBuf::from(&input.path).as_path(), &bytes, count)
}
