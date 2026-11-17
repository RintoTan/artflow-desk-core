//! 活动队列命令。

use tauri::State;

use crate::domain::queue::{self, MoveInput, QueueSnapshot};
use crate::error::AppResult;
use crate::infra::state::AppState;

#[tauri::command]
pub fn queue_list(state: State<'_, AppState>) -> AppResult<QueueSnapshot> {
    let conn = state.env.open_db()?;
    queue::snapshot(&conn)
}

#[tauri::command]
pub fn queue_move(state: State<'_, AppState>, input: MoveInput) -> AppResult<QueueSnapshot> {
    let mut conn = state.env.open_db()?;
    queue::move_order(&mut conn, input)
}
