//! 全局流程模板命令。

use tauri::State;

use crate::domain::templates::{
    self, CreateTemplateInput, DeleteTemplateInput, DuplicateTemplateInput, SetDefaultInput,
    TemplateView, UpdateTemplateInput,
};
use crate::error::AppResult;
use crate::infra::state::AppState;

#[tauri::command]
pub fn template_list(state: State<'_, AppState>) -> AppResult<Vec<TemplateView>> {
    let conn = state.env.open_db()?;
    templates::list(&conn)
}

#[tauri::command]
pub fn template_create(
    state: State<'_, AppState>,
    input: CreateTemplateInput,
) -> AppResult<TemplateView> {
    let mut conn = state.env.open_db()?;
    templates::create(&mut conn, input)
}

#[tauri::command]
pub fn template_update(
    state: State<'_, AppState>,
    input: UpdateTemplateInput,
) -> AppResult<TemplateView> {
    let mut conn = state.env.open_db()?;
    templates::update(&mut conn, input)
}

#[tauri::command]
pub fn template_duplicate(
    state: State<'_, AppState>,
    input: DuplicateTemplateInput,
) -> AppResult<TemplateView> {
    let mut conn = state.env.open_db()?;
    templates::duplicate(&mut conn, input)
}

#[tauri::command]
pub fn template_delete(
    state: State<'_, AppState>,
    input: DeleteTemplateInput,
) -> AppResult<Vec<TemplateView>> {
    let mut conn = state.env.open_db()?;
    templates::remove(&mut conn, input)
}

#[tauri::command]
pub fn template_set_default(
    state: State<'_, AppState>,
    input: SetDefaultInput,
) -> AppResult<Vec<TemplateView>> {
    let mut conn = state.env.open_db()?;
    templates::set_default(&mut conn, input)
}
