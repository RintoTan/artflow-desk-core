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
