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

// ---------------------------------------------------------------- 标签

#[tauri::command]
pub fn client_tag_list(state: State<'_, AppState>) -> AppResult<Vec<clients::TagView>> {
    let conn = state.env.open_db()?;
    clients::list_tags(&conn)
}

#[tauri::command]
pub fn client_tag_create(state: State<'_, AppState>, name: String) -> AppResult<clients::TagView> {
    let conn = state.env.open_db()?;
    clients::create_tag(&conn, &name)
}

#[tauri::command]
pub fn client_tag_delete(state: State<'_, AppState>, tag_id: String) -> AppResult<()> {
    let conn = state.env.open_db()?;
    clients::delete_tag(&conn, &tag_id)
}

#[tauri::command]
pub fn client_tag_link(
    state: State<'_, AppState>,
    client_id: String,
    tag_id: String,
) -> AppResult<Vec<clients::TagView>> {
    let conn = state.env.open_db()?;
    clients::link_tag(&conn, &client_id, &tag_id)
}

#[tauri::command]
pub fn client_tag_unlink(
    state: State<'_, AppState>,
    client_id: String,
    tag_id: String,
) -> AppResult<Vec<clients::TagView>> {
    let conn = state.env.open_db()?;
    clients::unlink_tag(&conn, &client_id, &tag_id)
}
