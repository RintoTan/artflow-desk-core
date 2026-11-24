//! FIN-02：平台配置命令面。
//!
//! 命令只负责取连接与返回结果；校验、费率换算、唯一性与事务都在 `domain::finance`。
//! 费率**以字符串**接收用户原文，不让前端各写一套解析。

use tauri::State;

use crate::domain::finance::{self, CreatePlatformInput, DeletePlatformReport, PlatformView, UpdatePlatformInput};
use crate::error::AppResult;
use crate::infra::state::AppState;

#[tauri::command]
pub fn finance_platform_list(state: State<'_, AppState>) -> AppResult<Vec<PlatformView>> {
    let conn = state.env.open_db()?;
    finance::list(&conn)
}

#[tauri::command]
pub fn finance_platform_create(
    state: State<'_, AppState>,
    input: CreatePlatformInput,
) -> AppResult<PlatformView> {
    let conn = state.env.open_db()?;
    finance::create(&conn, &input)
}

#[tauri::command]
pub fn finance_platform_update(
    state: State<'_, AppState>,
    input: UpdatePlatformInput,
) -> AppResult<PlatformView> {
    let conn = state.env.open_db()?;
    finance::update(&conn, &input)
}

#[tauri::command]
pub fn finance_platform_archive(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<PlatformView> {
    let conn = state.env.open_db()?;
    finance::archive(&conn, &id)
}

#[tauri::command]
pub fn finance_platform_restore(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<PlatformView> {
    let conn = state.env.open_db()?;
    finance::restore(&conn, &id)
}

#[tauri::command]
pub fn finance_platform_reorder(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> AppResult<Vec<PlatformView>> {
    let mut conn = state.env.open_db()?;
    finance::reorder(&mut conn, &ids)
}

#[tauri::command]
pub fn finance_platform_delete(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<DeletePlatformReport> {
    let conn = state.env.open_db()?;
    finance::delete(&conn, &id)
}

// ---------------------------------------------------------------- FIN-03

#[tauri::command]
pub fn finance_order_snapshot(
    state: State<'_, AppState>,
    order_id: String,
) -> AppResult<finance::OrderFinanceView> {
    let conn = state.env.open_db()?;
    finance::snapshot(&conn, &order_id)
}

#[tauri::command]
pub fn finance_payment_plan_save(
    state: State<'_, AppState>,
    input: finance::SavePlanInput,
) -> AppResult<finance::OrderFinanceView> {
    let mut conn = state.env.open_db()?;
    finance::save_plan(&mut conn, &input)
}

#[tauri::command]
pub fn finance_payment_record_create(
    state: State<'_, AppState>,
    input: finance::CreateRecordInput,
) -> AppResult<finance::PaymentRecordView> {
    let mut conn = state.env.open_db()?;
    finance::create_record(&mut conn, &input)
}

#[tauri::command]
pub fn finance_payment_record_update(
    state: State<'_, AppState>,
    input: finance::UpdateRecordInput,
) -> AppResult<finance::PaymentRecordView> {
    let mut conn = state.env.open_db()?;
    finance::update_record(&mut conn, &input)
}

#[tauri::command]
pub fn finance_payment_record_void(
    state: State<'_, AppState>,
    input: finance::VoidRecordInput,
) -> AppResult<finance::PaymentRecordView> {
    let mut conn = state.env.open_db()?;
    finance::void_record(&mut conn, &input)
}

#[tauri::command]
pub fn finance_payment_fee_quote(
    amount_cents: i64,
    fee_rate_bp: Option<i64>,
) -> AppResult<finance::FeeQuote> {
    finance::quote(amount_cents, fee_rate_bp)
}

// ---------------------------------------------------------------- 退款

#[tauri::command]
pub fn finance_refund_create(
    state: State<'_, AppState>,
    input: finance::RefundInput,
) -> AppResult<finance::RefundView> {
    let mut conn = state.env.open_db()?;
    finance::create_refund(&mut conn, &input)
}

#[tauri::command]
pub fn finance_refund_update(
    state: State<'_, AppState>,
    input: finance::UpdateRefundInput,
) -> AppResult<finance::RefundView> {
    let mut conn = state.env.open_db()?;
    finance::update_refund(&mut conn, &input)
}

#[tauri::command]
pub fn finance_refund_void(
    state: State<'_, AppState>,
    input: finance::VoidRefundInput,
) -> AppResult<finance::RefundView> {
    let mut conn = state.env.open_db()?;
    finance::void_refund(&mut conn, &input)
}

// ---------------------------------------------------------------- FIN-05

/// 财务统计：只读聚合。前端不重算任何一条财务规则。
#[tauri::command]
pub fn finance_stats_report(
    state: State<'_, AppState>,
    range: crate::domain::stats::StatsRange,
) -> AppResult<crate::domain::finance_stats::FinanceStatsReport> {
    let conn = state.env.open_db()?;
    crate::domain::finance_stats::report(&conn, range)
}

/// 客户维度财务汇总：客户详情与统计页共用同一份聚合。
#[tauri::command]
pub fn finance_client_summary(
    state: State<'_, AppState>,
    client_id: String,
) -> AppResult<crate::domain::finance_clients::ClientFinance> {
    let conn = state.env.open_db()?;
    crate::domain::finance_clients::summary(&conn, &client_id)
}
