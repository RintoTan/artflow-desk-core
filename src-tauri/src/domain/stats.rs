//! 历史统计。
//!
//! 两条口径必须同时成立，缺一不可：
//! - 新建/完成/取消 **按生命周期事件次数**（同一订单再次完成算两次）；
//! - 金额 **按订单创建月份归属其当前记录金额**（改金额会影响创建月份）。
//!
//! 统计只读，不写任何业务表，也不缓存。

use chrono::{Datelike, NaiveDate};
use chrono_tz::Tz;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::store::{settings, timezone};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StatsRange {
    ThisMonth,
    Last6,
    Last12,
    All,
}

impl StatsRange {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ThisMonth => "thisMonth",
            Self::Last6 => "last6",
            Self::Last12 => "last12",
            Self::All => "all",
        }
    }

    fn months_back(self) -> Option<i64> {
        match self {
            Self::ThisMonth => Some(0),
            Self::Last6 => Some(5),
            Self::Last12 => Some(11),
            Self::All => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MonthBucket {
    /// YYYY-MM
    pub month: String,
    pub created: i64,
    pub completed: i64,
    pub cancelled: i64,
    /// 已知金额合计（整数分）
    pub amount_cents: i64,
    /// 已知金额的订单数（含 0 元订单）
    pub known_orders: i64,
    /// 金额未知（NULL）的订单数
    pub unknown_orders: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsReport {
    pub range: String,
    pub timezone: String,
    pub from_month: String,
    pub to_month: String,
    /// 自然月，按时间正序
    pub months: Vec<MonthBucket>,
    pub totals: MonthBucket,
    /// 口径说明，直接展示给用户
    pub basis: Vec<String>,
}

fn month_key(date: NaiveDate) -> String {
    format!("{:04}-{:02}", date.year(), date.month())
}

fn add_months(base: NaiveDate, delta: i64) -> NaiveDate {
    let total = base.year() as i64 * 12 + (base.month0() as i64) + delta;
    let year = (total.div_euclid(12)) as i32;
    let month = (total.rem_euclid(12)) as u32 + 1;
    NaiveDate::from_ymd_opt(year, month, 1).unwrap_or(base)
}

fn month_range(from: &str, to: &str) -> AppResult<Vec<String>> {
    let start = NaiveDate::parse_from_str(&format!("{from}-01"), "%Y-%m-%d")
        .map_err(|_| AppError::invalid(format!("月份格式不合法：{from}")))?;
    let end = NaiveDate::parse_from_str(&format!("{to}-01"), "%Y-%m-%d")
        .map_err(|_| AppError::invalid(format!("月份格式不合法：{to}")))?;
    if start > end {
        return Err(AppError::invalid("起始月份不能晚于结束月份"));
    }
    let mut months = Vec::new();
    let mut cursor = start;
    while cursor <= end {
        months.push(month_key(cursor));
        cursor = add_months(cursor, 1);
    }
    Ok(months)
}

/// 事件归属月份：按工作时时区判定。
fn event_month(occurred_at: &str, tz: Tz) -> AppResult<String> {
    let date = timezone::local_date(occurred_at, tz)?;
    Ok(month_key(date))
}

pub fn report(conn: &Connection, range: StatsRange) -> AppResult<StatsReport> {
    let tz: Tz = settings::working_timezone(conn)?;
    let today = timezone::local_today(tz);
    let current_month = month_key(today);

    // 最早数据月份（仅用于 All）
    let earliest_order: Option<String> = conn
        .query_row("SELECT MIN(created_at) FROM orders_visible", [], |r| {
            r.get::<_, Option<String>>(0)
        })
        .unwrap_or(None);
    let earliest_event: Option<String> = conn
        .query_row(
            "SELECT MIN(e.occurred_at) FROM order_events e JOIN orders_visible o ON o.id = e.order_id",
            [],
            |r| r.get::<_, Option<String>>(0),
        )
        .unwrap_or(None);

    let from_month = match range.months_back() {
        Some(back) => month_key(add_months(
            NaiveDate::from_ymd_opt(today.year(), today.month(), 1)
                .ok_or_else(|| AppError::invalid("无法确定当前月份"))?,
            -back,
        )),
        None => {
            let mut candidates: Vec<String> = Vec::new();
            if let Some(raw) = earliest_order {
                candidates.push(event_month(&raw, tz)?);
            }
            if let Some(raw) = earliest_event {
                candidates.push(event_month(&raw, tz)?);
            }
            candidates.sort();
            candidates.first().cloned().unwrap_or_else(|| current_month.clone())
        }
    };

    let months = month_range(&from_month, &current_month)?;
    let index: std::collections::HashMap<&str, usize> = months
        .iter()
        .enumerate()
        .map(|(i, m)| (m.as_str(), i))
        .collect();

    let mut buckets: Vec<MonthBucket> = months
        .iter()
        .map(|m| MonthBucket {
            month: m.clone(),
            ..Default::default()
        })
        .collect();

    // ---- 事件次数：只统计仍然有效的订单（JOIN orders_visible）
    {
        let mut stmt = conn.prepare(
            "SELECT e.kind, e.occurred_at
             FROM order_events e
             JOIN orders_visible o ON o.id = e.order_id
             WHERE e.kind IN ('created', 'completed', 'cancelled')",
        )?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;

        for (kind, occurred_at) in rows {
            let month = event_month(&occurred_at, tz)?;
            let Some(&position) = index.get(month.as_str()) else {
                continue;
            };
            let bucket = &mut buckets[position];
            match kind.as_str() {
                "created" => bucket.created += 1,
                "completed" => bucket.completed += 1,
                "cancelled" => bucket.cancelled += 1,
                _ => {}
            }
        }
    }

    // ---- 金额：按订单创建月份归属，计入其**当前**金额
    {
        let mut stmt = conn.prepare("SELECT created_at, amount_cents FROM orders_visible")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        for (created_at, amount) in rows {
            let month = event_month(&created_at, tz)?;
            let Some(&position) = index.get(month.as_str()) else {
                continue;
            };
            let bucket = &mut buckets[position];
            match amount {
                Some(cents) => {
                    bucket.amount_cents += cents;
                    bucket.known_orders += 1;
                }
                None => bucket.unknown_orders += 1,
            }
        }
    }

    let mut totals = MonthBucket {
        month: format!("{from_month}~{current_month}"),
        ..Default::default()
    };
    for bucket in &buckets {
        totals.created += bucket.created;
        totals.completed += bucket.completed;
        totals.cancelled += bucket.cancelled;
        totals.amount_cents += bucket.amount_cents;
        totals.known_orders += bucket.known_orders;
        totals.unknown_orders += bucket.unknown_orders;
    }

    Ok(StatsReport {
        range: range.as_str().to_string(),
        timezone: tz.name().to_string(),
        from_month,
        to_month: current_month,
        months: buckets,
        totals,
        basis: vec![
            "新建 / 完成 / 取消按订单生命周期事件次数统计（同一订单再次完成计为第二次）。".into(),
            "完成与取消按事件发生时间归属月份；新建按订单创建事件归属月份。".into(),
            "委托金额按订单创建月份归属，取该订单当前的记录金额；修改金额会影响创建月份的汇总。".into(),
            "金额未知（未填写）的订单不计入合计，单独计数；金额为 0 元的订单属于已知金额。".into(),
            "月份与日期均按应用内的工作时时区计算；近 6 / 12 个月为包含当前月的自然月区间。".into(),
        ],
    })
}

/// 供导出复用的金额格式化：整数分 → 元，两位小数。
pub fn cents_to_yuan(cents: i64) -> String {
    let sign = if cents < 0 { "-" } else { "" };
    let abs = cents.abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
}
