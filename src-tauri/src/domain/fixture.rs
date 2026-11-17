//! QA 预置专用：受控的时间戳 fixture。
//!
//! 为什么需要它：统计口径要求"创建月份 ≠ 完成月份"的订单，而正常领域函数
//! 一律使用当前时间。为了不伪造业务状态，这里**只改时间戳字段**：
//!
//! - 不改状态、阶段、金额、编号、队列位置；
//! - 不改事件种类与归属订单；
//! - 调用方必须是 `seed` 模块或测试，产品命令层不暴露。
//!
//! 与"正常业务操作"的区别必须在报告里说清：这些订单的时间是**写死的**，
//! 用来验证"跨月归属"，而不是真实发生过的操作。

use rusqlite::{params, Connection};

use crate::error::{AppError, AppResult};

/// 把订单的创建时间与它的 `created` 事件一起挪到指定时刻。
///
/// 两者必须同时挪，否则会出现"订单 9 月创建、created 事件却在 11 月"的矛盾数据。
pub fn shift_order_created_at(conn: &Connection, order_id: &str, timestamp: &str) -> AppResult<()> {
    assert_timestamp(timestamp)?;
    let changed = conn.execute(
        "UPDATE orders SET created_at = ?1 WHERE id = ?2",
        params![timestamp, order_id],
    )?;
    if changed != 1 {
        return Err(AppError::not_found("订单不存在，无法设置预置时间"));
    }
    conn.execute(
        "UPDATE order_events SET occurred_at = ?1
         WHERE order_id = ?2 AND kind = 'created'",
        params![timestamp, order_id],
    )?;
    Ok(())
}

/// 只改一条事件的 `occurred_at`。用于制造"上个月完成"这类历史事件。
pub fn set_event_timestamp(conn: &Connection, event_id: i64, timestamp: &str) -> AppResult<()> {
    assert_timestamp(timestamp)?;
    let changed = conn.execute(
        "UPDATE order_events SET occurred_at = ?1 WHERE id = ?2",
        params![timestamp, event_id],
    )?;
    if changed != 1 {
        return Err(AppError::not_found("事件不存在，无法设置预置时间"));
    }
    Ok(())
}

fn assert_timestamp(timestamp: &str) -> AppResult<()> {
    // 预置只允许 UTC RFC3339（带 Z 与毫秒），避免把本地时间写进库里。
    if !timestamp.ends_with('Z') || !timestamp.contains('T') || timestamp.len() < 20 {
        return Err(AppError::invalid(format!(
            "预置时间必须是 UTC RFC3339，收到 {timestamp:?}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_utc_timestamps() {
        assert!(assert_timestamp("2026-10-08 10:00:00").is_err());
        assert!(assert_timestamp("2026-10-08T10:00:00+08:00").is_err());
        assert!(assert_timestamp("2026-10-08T02:00:00.000Z").is_ok());
    }
}
