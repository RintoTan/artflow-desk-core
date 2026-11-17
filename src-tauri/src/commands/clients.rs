//! 客户档案命令。

use tauri::State;

use crate::domain::clients::{self, ClientDetail, ClientView, CreateClientInput, UpdateClientInput};
use crate::error::AppResult;
use crate::infra::state::AppState;

#[tauri::command]
pub fn client_create(
    state: State<'_, AppState>,
    input: CreateClientInput,
) -> AppResult<ClientView> {
    let conn = state.env.open_db()?;
    clients::create(&conn, input)
}

#[tauri::command]
pub fn client_update(
    state: State<'_, AppState>,
    input: UpdateClientInput,
) -> AppResult<ClientView> {
    let mut conn = state.env.open_db()?;
    clients::update(&mut conn, input)
}

#[tauri::command]
pub fn client_detail(state: State<'_, AppState>, client_id: String) -> AppResult<ClientDetail> {
    let conn = state.env.open_db()?;
    clients::detail(&conn, &client_id)
}
