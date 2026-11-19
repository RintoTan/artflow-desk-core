//! 订单命令：薄壳，只做参数转发与状态读取。业务规则全部在 domain 层。

use tauri::State;

use crate::domain::events::Event;
use crate::domain::lifecycle::{self, LifecycleInput, ReworkInput, SkipInput};
use crate::domain::clients::ClientView;
use crate::domain::orders::{self, CreateOrderInput, OrderView, UpdateDetailsInput};
use crate::domain::workflow::{
    self, AddStageInput, RemoveStageInput, RenameStageInput, ReorderStagesInput,
};
use crate::error::AppResult;
use crate::infra::state::AppState;
use crate::store::settings;

#[tauri::command]
pub fn create_order(state: State<'_, AppState>, input: CreateOrderInput) -> AppResult<OrderView> {
    let mut conn = state.env.open_db()?;
    let tz = settings::working_timezone(&conn)?;
    let view = orders::create_order(&mut conn, &state.highwater, tz, input)?;
    println!(
        "[minidesk] create_order {} stage={:?} queue={}",
        view.code, view.current_stage_title, view.queue_position
    );
    Ok(view)
}

#[tauri::command]
pub fn list_orders(state: State<'_, AppState>) -> AppResult<Vec<OrderView>> {
    let conn = state.env.open_db()?;
    orders::list(&conn)
}

#[tauri::command]
pub fn get_order(state: State<'_, AppState>, order_id: String) -> AppResult<OrderView> {
    let conn = state.env.open_db()?;
    orders::load(&conn, &order_id)
}

#[tauri::command]
pub fn list_order_events(state: State<'_, AppState>, order_id: String) -> AppResult<Vec<Event>> {
    let conn = state.env.open_db()?;
    crate::domain::events::list(&conn, &order_id)
}

#[tauri::command]
pub fn list_clients(state: State<'_, AppState>) -> AppResult<Vec<ClientView>> {
    let conn = state.env.open_db()?;
    crate::domain::clients::list(&conn)
}

#[tauri::command]
pub fn update_order_details(
    state: State<'_, AppState>,
    input: UpdateDetailsInput,
) -> AppResult<OrderView> {
    let mut conn = state.env.open_db()?;
    orders::update_details(&mut conn, input)
}

#[tauri::command]
pub fn start_work(state: State<'_, AppState>, input: LifecycleInput) -> AppResult<OrderView> {
    let mut conn = state.env.open_db()?;
    lifecycle::start_work(&mut conn, input)
}

#[tauri::command]
pub fn undo_start_work(state: State<'_, AppState>, input: LifecycleInput) -> AppResult<OrderView> {
    let mut conn = state.env.open_db()?;
    lifecycle::undo_start_work(&mut conn, input)
}

#[tauri::command]
pub fn advance_stage(state: State<'_, AppState>, input: LifecycleInput) -> AppResult<OrderView> {
    let mut conn = state.env.open_db()?;
    lifecycle::advance_stage(&mut conn, input)
}

#[tauri::command]
pub fn rework_stage(state: State<'_, AppState>, input: ReworkInput) -> AppResult<OrderView> {
    let mut conn = state.env.open_db()?;
    lifecycle::rework_stage(&mut conn, input)
}

#[tauri::command]
pub fn skip_stage(state: State<'_, AppState>, input: SkipInput) -> AppResult<OrderView> {
    let mut conn = state.env.open_db()?;
    lifecycle::skip_stage(&mut conn, input)
}

#[tauri::command]
pub fn complete_order(state: State<'_, AppState>, input: LifecycleInput) -> AppResult<OrderView> {
    let mut conn = state.env.open_db()?;
    lifecycle::complete_order(&mut conn, input)
}

#[tauri::command]
pub fn cancel_order(state: State<'_, AppState>, input: LifecycleInput) -> AppResult<OrderView> {
    let mut conn = state.env.open_db()?;
    lifecycle::cancel_order(&mut conn, input)
}

#[tauri::command]
pub fn reopen_order(state: State<'_, AppState>, input: LifecycleInput) -> AppResult<OrderView> {
    let mut conn = state.env.open_db()?;
    lifecycle::reopen_order(&mut conn, input)
}

#[tauri::command]
pub fn workflow_add_stage(state: State<'_, AppState>, input: AddStageInput) -> AppResult<OrderView> {
    let mut conn = state.env.open_db()?;
    workflow::add_stage(&mut conn, input)
}

#[tauri::command]
pub fn workflow_rename_stage(
    state: State<'_, AppState>,
    input: RenameStageInput,
) -> AppResult<OrderView> {
    let mut conn = state.env.open_db()?;
    workflow::rename_stage(&mut conn, input)
}

#[tauri::command]
pub fn workflow_remove_stage(
    state: State<'_, AppState>,
    input: RemoveStageInput,
) -> AppResult<OrderView> {
    let mut conn = state.env.open_db()?;
    workflow::remove_stage(&mut conn, input)
}

#[tauri::command]
pub fn workflow_reorder_stages(
    state: State<'_, AppState>,
    input: ReorderStagesInput,
) -> AppResult<OrderView> {
    let mut conn = state.env.open_db()?;
    workflow::reorder_stages(&mut conn, input)
}
