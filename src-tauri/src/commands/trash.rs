//! 回收站命令：查看已删除数据、删除、恢复。
//!
//! 命令只收业务 id（订单 id / 客户 id）；`deleted_batch` 是服务端内部依据，
//! 不出现在入参也不出现在出参。

use tauri::State;

use crate::domain::trash::{self, ClientDeleteImpact, DeletedClient, DeletedOrder, RestoredClient, RestoredOrder, TrashSnapshot};
use crate::error::AppResult;
use crate::infra::state::AppState;

#[tauri::command]
pub fn trash_snapshot(state: State<'_, AppState>) -> AppResult<TrashSnapshot> {
    let conn = state.env.open_db()?;
    trash::snapshot(&conn)
}

#[tauri::command]
pub fn trash_client_delete_impact(
    state: State<'_, AppState>,
    client_id: String,
) -> AppResult<ClientDeleteImpact> {
    let conn = state.env.open_db()?;
    trash::client_delete_impact(&conn, &client_id)
}

#[tauri::command]
pub fn trash_delete_order(state: State<'_, AppState>, order_id: String) -> AppResult<DeletedOrder> {
    let mut conn = state.env.open_db()?;
    trash::delete_order(&mut conn, &order_id)
}

#[tauri::command]
pub fn trash_delete_client(state: State<'_, AppState>, client_id: String) -> AppResult<DeletedClient> {
    let mut conn = state.env.open_db()?;
    trash::delete_client(&mut conn, &client_id)
}

#[tauri::command]
pub fn trash_restore_order(state: State<'_, AppState>, order_id: String) -> AppResult<RestoredOrder> {
    let mut conn = state.env.open_db()?;
    trash::restore_order(&mut conn, &order_id)
}

#[tauri::command]
pub fn trash_restore_client(state: State<'_, AppState>, client_id: String) -> AppResult<RestoredClient> {
    let mut conn = state.env.open_db()?;
    trash::restore_client(&mut conn, &client_id)
}
