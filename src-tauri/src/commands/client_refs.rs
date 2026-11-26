//! 客户参考图命令。

use serde::Deserialize;
use tauri::State;

use crate::domain::client_attachments::{self, ClientCover, ClientRefOutcome, ClientRefView};
use crate::error::AppResult;
use crate::infra::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientRefImportInput {
    pub client_id: String,
    /// 由系统文件对话框或拖拽拿到的绝对路径；后端只读，不做写入。
    pub source_paths: Vec<String>,
}

#[tauri::command]
pub fn client_ref_list(
    state: State<'_, AppState>,
    client_id: String,
) -> AppResult<Vec<ClientRefView>> {
    let conn = state.env.open_db()?;
    client_attachments::list(
        &conn,
        state.env.layout(),
        state.env.active_generation(),
        &client_id,
    )
}

#[tauri::command]
pub fn client_ref_import(
    state: State<'_, AppState>,
    input: ClientRefImportInput,
) -> AppResult<Vec<ClientRefOutcome>> {
    let mut conn = state.env.open_db()?;
    let sources: Vec<std::path::PathBuf> = input.source_paths.iter().map(std::path::PathBuf::from).collect();
    client_attachments::import(
        &mut conn,
        state.env.layout(),
        state.env.active_generation(),
        &input.client_id,
        &sources,
    )
}

#[tauri::command]
pub fn client_ref_remove(
    state: State<'_, AppState>,
    client_id: String,
    attachment_id: String,
) -> AppResult<()> {
    let mut conn = state.env.open_db()?;
    client_attachments::remove(
        &mut conn,
        state.env.layout(),
        state.env.active_generation(),
        &client_id,
        &attachment_id,
    )
}

#[tauri::command]
pub fn client_ref_covers(
    state: State<'_, AppState>,
    client_ids: Vec<String>,
) -> AppResult<Vec<ClientCover>> {
    let conn = state.env.open_db()?;
    client_attachments::covers(
        &conn,
        state.env.layout(),
        state.env.active_generation(),
        &client_ids,
    )
}
