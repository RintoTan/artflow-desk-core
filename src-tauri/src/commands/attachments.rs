//! 订单参考图片命令。

use std::path::PathBuf;

use serde::Deserialize;
use tauri::State;

use crate::domain::attachments::{
    self, AttachmentView, ImportOutcome, RepairInput, ThumbReport, UpdateAttachmentMetaInput,
    VerifyReport,
};
use crate::error::AppResult;
use crate::infra::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportInput {
    pub order_id: String,
    /// 由系统文件对话框返回的绝对路径；后端只读取，不做任何写入。
    pub source_paths: Vec<String>,
    pub tag: Option<String>,
}

#[tauri::command]
pub fn attachment_list(
    state: State<'_, AppState>,
    order_id: String,
) -> AppResult<Vec<AttachmentView>> {
    let conn = state.env.open_db()?;
    attachments::list(
        &conn,
        state.env.layout(),
        state.env.active_generation(),
        &order_id,
    )
}

#[tauri::command]
pub fn attachment_import(
    state: State<'_, AppState>,
    input: ImportInput,
) -> AppResult<Vec<ImportOutcome>> {
    let mut conn = state.env.open_db()?;
    let sources: Vec<PathBuf> = input.source_paths.iter().map(PathBuf::from).collect();
    let outcomes = attachments::import(
        &mut conn,
        state.env.layout(),
        state.env.active_generation(),
        &input.order_id,
        &sources,
        input.tag.as_deref(),
    )?;
    let ok = outcomes.iter().filter(|o| o.ok).count();
    println!(
        "[minidesk] attachment_import order={} ok={}/{}",
        input.order_id,
        ok,
        outcomes.len()
    );
    Ok(outcomes)
}

#[tauri::command]
pub fn attachment_remove(state: State<'_, AppState>, attachment_id: String) -> AppResult<()> {
    let mut conn = state.env.open_db()?;
    attachments::remove(
        &mut conn,
        state.env.layout(),
        state.env.active_generation(),
        &attachment_id,
    )
}

#[tauri::command]
pub fn attachment_verify(
    state: State<'_, AppState>,
    order_id: String,
) -> AppResult<VerifyReport> {
    let mut conn = state.env.open_db()?;
    attachments::verify(
        &mut conn,
        state.env.layout(),
        state.env.active_generation(),
        &order_id,
    )
}

#[tauri::command]
pub fn attachment_rebuild_thumbs(
    state: State<'_, AppState>,
    order_id: String,
) -> AppResult<ThumbReport> {
    let mut conn = state.env.open_db()?;
    attachments::rebuild_thumbs(
        &mut conn,
        state.env.layout(),
        state.env.active_generation(),
        &order_id,
    )
}

#[tauri::command]
pub fn attachment_repair(
    state: State<'_, AppState>,
    input: RepairInput,
) -> AppResult<AttachmentView> {
    let mut conn = state.env.open_db()?;
    attachments::repair(
        &mut conn,
        state.env.layout(),
        state.env.active_generation(),
        input,
    )
}

#[tauri::command]
pub fn attachment_update_meta(
    state: State<'_, AppState>,
    input: UpdateAttachmentMetaInput,
) -> AppResult<AttachmentView> {
    let conn = state.env.open_db()?;
    attachments::update_meta(
        &conn,
        state.env.layout(),
        state.env.active_generation(),
        input,
    )
}
