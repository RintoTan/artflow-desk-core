//! 工作台指标。
//!
//! 全部是只读派生值，不落库、不缓存；口径与订单列表共用 `deadline` 模块，
//! 因此不会出现"工作台说逾期、列表里没有标记"。

use chrono::NaiveDate;
use chrono_tz::Tz;
use rusqlite::Connection;
use serde::Serialize;

use crate::domain::deadline::{self, DeadlineState};
use crate::error::AppResult;
use crate::store::{settings, timezone};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardMetrics {
    /// 活动订单总数（status = active）
    pub active_total: i64,
    /// 排队中（活动且没有有效开工记录）
    pub queued: i64,
    /// 制作中（活动且已开工）
    pub in_progress: i64,
    /// 明天至第三天到期（含第三天）
    pub due_soon: i64,
    /// 今天到期
    pub due_today: i64,
    /// 已逾期
    pub overdue: i64,
    /// 未排期（交付日期为 NULL）
    pub unscheduled: i64,
    /// 本月发生的完成事件次数（不是当前状态为 completed 的订单数）
    pub completed_this_month: i64,
    /// 本月取消事件次数
    pub cancelled_this_month: i64,
    /// 本月新建事件次数
    pub created_this_month: i64,
    /// 工作时时区
    pub timezone: String,
    /// 工作时时区的今天
    pub today: String,
    /// 本月标识，例如 2026-11
    pub month: String,
}

fn count(conn: &Connection, sql: &str, params: &[&dyn rusqlite::ToSql]) -> AppResult<i64> {
    Ok(conn.query_row(sql, params, |r| r.get(0))?)
}

pub fn metrics(conn: &Connection) -> AppResult<DashboardMetrics> {
    let tz: Tz = settings::working_timezone(conn)?;
    let today: NaiveDate = deadline::today_in(tz);
    let month = today.format("%Y-%m").to_string();

    let active_total = count(conn, "SELECT COUNT(*) FROM orders_visible WHERE status = 'active'", &[])?;
    let queued = count(
        conn,
        "SELECT COUNT(*) FROM orders_visible WHERE status = 'active' AND started_at IS NULL",
        &[],
    )?;
    let in_progress = count(
        conn,
        "SELECT COUNT(*) FROM orders_visible WHERE status = 'active' AND started_at IS NOT NULL",
        &[],
    )?;

    // 四类互斥，全部在 Rust 侧用同一套日历判定，避免 SQL 里的日期运算与时区打架。
    let mut due_soon = 0i64;
    let mut due_today = 0i64;
    let mut overdue = 0i64;
    let mut unscheduled = 0i64;
    {
        let mut stmt = conn.prepare(
            "SELECT planned_delivery_date FROM orders_visible WHERE status = 'active'",
        )?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let raw: Option<String> = row.get(0)?;
            match deadline::classify_str(raw.as_deref(), tz)? {
                DeadlineState::Overdue => overdue += 1,
                DeadlineState::Today => due_today += 1,
                DeadlineState::DueSoon => due_soon += 1,
                DeadlineState::Unscheduled => unscheduled += 1,
                DeadlineState::Scheduled => {}
            }
        }
    }

    // 事件次数必须按 occurred_at 落在本月的真实事件统计。
    let (from, to) = timezone::month_bounds_utc(tz, &month)?;
    let completed_stmt = "SELECT COUNT(*) FROM order_events e
                          JOIN orders_visible o ON o.id = e.order_id
                          WHERE e.kind = ?1 AND e.occurred_at >= ?2 AND e.occurred_at < ?3";
    let completed_this_month = count(conn, completed_stmt, &[&"completed", &from, &to])?;
    let cancelled_this_month = count(conn, completed_stmt, &[&"cancelled", &from, &to])?;
    let created_this_month = count(conn, completed_stmt, &[&"created", &from, &to])?;

    Ok(DashboardMetrics {
        active_total,
        queued,
        in_progress,
        due_soon,
        due_today,
        overdue,
        unscheduled,
        completed_this_month,
        cancelled_this_month,
        created_this_month,
        timezone: tz.name().to_string(),
        today: today.format("%Y-%m-%d").to_string(),
        month,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedEventRow {
    pub event_id: i64,
    pub order_id: String,
    pub code: String,
    pub title: String,
    pub occurred_at: String,
    /// 工作时时区下的时间，供界面直接显示
    pub local_time: String,
    pub stage_title: Option<String>,
}

/// 某个自然月内真实发生的完成事件（用于「本月完成次数」下钻）。
pub fn completed_events_in_month(
    conn: &Connection,
    month: &str,
) -> AppResult<Vec<CompletedEventRow>> {
    let tz = settings::working_timezone(conn)?;
    let (from, to) = timezone::month_bounds_utc(tz, month)?;

    let mut stmt = conn.prepare(
        "SELECT e.id, e.order_id, o.code, o.title, e.occurred_at, e.from_stage_title
         FROM order_events e
         JOIN orders_visible o ON o.id = e.order_id
         WHERE e.kind = 'completed' AND e.occurred_at >= ?1 AND e.occurred_at < ?2
         ORDER BY e.occurred_at DESC, e.id DESC",
    )?;
    let rows = stmt
        .query_map([&from, &to], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(rows
        .into_iter()
        .map(|(event_id, order_id, code, title, occurred_at, stage_title)| CompletedEventRow {
            event_id,
            order_id,
            code,
            title,
            local_time: timezone::to_local_string(&occurred_at, tz),
            occurred_at,
            stage_title,
        })
        .collect())
}
