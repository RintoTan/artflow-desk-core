//! 订单命令（DEV-01 只暴露"创建订单"这一个最小写入口）。

use tauri::State;

use crate::domain::orders::{self, CreateOrderInput, Order};
use crate::error::AppResult;
use crate::infra::state::AppState;
use crate::store::settings;

#[tauri::command]
pub fn create_order(state: State<'_, AppState>, input: CreateOrderInput) -> AppResult<Order> {
    let mut conn = state.env.open_db()?;
    let tz = settings::working_timezone(&conn)?;
    let order = orders::create_order(&mut conn, &state.highwater, tz, input)?;
    // 不打印标题等业务内容，只记录编号与结果，便于排查。
    println!(
        "[minidesk] create_order -> {} stage={:?} queue={}",
        order.code, order.current_stage_title, order.queue_position
    );
    Ok(order)
}
