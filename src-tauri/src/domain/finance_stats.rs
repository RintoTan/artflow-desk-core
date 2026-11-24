//! FIN-05：财务统计。
//!
//! 这一层只做「按真实资金时点归类」，不重算任何一条财务规则：
//!
//! - **到账**按 `received_on` 归月，**退款**按 `refunded_on` 归月——两者各归各的月份，
//!   绝不把 12 月的退款回填到 11 月的收款上。
//! - **手续费**取每笔流水当时记下的 `fee_cents`，不拿平台现在的默认费率重算。
//! - **取消单一律排除**（C-1）：钱进来了也还在库里，但不进金额统计。
//! - **净留存允许为负**：退款大于净到账是可能发生的真实情况，截断成 0 就是骗人。
//!
//! 所有查询只读，且都走 `orders_visible`；本文件不写库、不碰 revision。

use chrono::Datelike;
use rusqlite::Connection;
use serde::Serialize;

use crate::domain::stats::{month_window, StatsRange};
use crate::error::{AppError, AppResult};
use crate::store::{settings, timezone};

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MoneyTotals {
    pub gross_received_cents: i64,
    pub fee_total_cents: i64,
    pub net_received_cents: i64,
    pub refund_total_cents: i64,
    /// 净到账 − 有效退款；可以为负。
    pub net_retained_cents: i64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentSnapshot {
    /// 全部未取消订单的待收合计（订单金额已知的那些）。
    pub remaining_cents: i64,
    pub over_received_cents: i64,
    /// 既没有付款计划也没有收款流水的订单数——不代表客户没付钱。
    pub unrecorded_orders: i64,
    pub unknown_amount_orders: i64,
    /// 有计划但计划合计 ≠ 订单金额。
    pub plan_mismatch_orders: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MonthCashFlow {
    pub month: String,
    pub gross_received_cents: i64,
    pub fee_total_cents: i64,
    pub net_received_cents: i64,
    pub refund_total_cents: i64,
    pub net_retained_cents: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct YearNetReceived {
    pub year: String,
    pub gross_received_cents: i64,
    pub fee_total_cents: i64,
    pub net_received_cents: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedMonth {
    pub month: String,
    pub amount_cents: i64,
    pub count: i64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedReceipts {
    /// 已过预计日期且仍有未收的部分。
    pub overdue_cents: i64,
    pub overdue_count: i64,
    /// 当前月 + 后续 5 个自然月。
    pub months: Vec<ExpectedMonth>,
    pub unscheduled_cents: i64,
    pub unscheduled_count: i64,
    /// 窗口之后更远的计划。
    pub beyond_cents: i64,
    pub beyond_count: i64,
    /// 没有建立任何付款计划的未取消订单数（不计入预计收款）。
    pub no_plan_orders: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlatformRow {
    /// 历史快照里的名字；NULL 表示当时没记平台。
    pub platform_name: Option<String>,
    pub count: i64,
    pub gross_received_cents: i64,
    pub fee_total_cents: i64,
    pub net_received_cents: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MethodRow {
    pub method: Option<String>,
    pub count: i64,
    pub gross_received_cents: i64,
    pub fee_total_cents: i64,
    pub net_received_cents: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OrderTypeRow {
    pub order_type: Option<String>,
    pub orders: i64,
    /// 该类型订单的当前金额合计（不含 NULL）。
    pub order_amount_cents: i64,
    pub unknown_amount_orders: i64,
    pub gross_received_cents: i64,
    pub fee_total_cents: i64,
    pub net_received_cents: i64,
    pub refund_total_cents: i64,
    pub net_retained_cents: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinanceStatsReport {
    pub range: String,
    pub timezone: String,
    pub from_month: String,
    pub to_month: String,
    /// 全历史累计（不受日期范围影响），已排除取消单。
    pub lifetime: MoneyTotals,
    /// 当前状态快照，同样不受日期范围影响。
    pub current: CurrentSnapshot,
    /// 所选区间内的合计。
    pub period: MoneyTotals,
    pub monthly: Vec<MonthCashFlow>,
    pub annual: Vec<YearNetReceived>,
    pub expected: ExpectedReceipts,
    pub by_platform: Vec<PlatformRow>,
    pub by_method: Vec<MethodRow>,
    pub by_order_type: Vec<OrderTypeRow>,
    pub basis: Vec<String>,
}

/// 有效收款：未作废，且所属订单可见、没取消。
const VALID_PAYMENTS: &str = "FROM payment_records r
      JOIN orders_visible o ON o.id = r.order_id
     WHERE r.voided_at IS NULL AND o.status <> 'cancelled'";

/// 有效退款：同上口径。
const VALID_REFUNDS: &str = "FROM refund_records f
      JOIN orders_visible o ON o.id = f.order_id
     WHERE f.voided_at IS NULL AND o.status <> 'cancelled'";

fn month_start(month: &str) -> AppResult<String> {
    let date = chrono::NaiveDate::parse_from_str(&format!("{month}-01"), "%Y-%m-%d")
        .map_err(|_| AppError::invalid(format!("月份格式不合法：{month}")))?;
    Ok(date.format("%Y-%m-%d").to_string())
}

/// 区间上界（不含）：to_month 的下个月 1 号。
fn next_month_start(month: &str) -> AppResult<String> {
    let date = chrono::NaiveDate::parse_from_str(&format!("{month}-01"), "%Y-%m-%d")
        .map_err(|_| AppError::invalid(format!("月份格式不合法：{month}")))?;
    let total = date.year() as i64 * 12 + date.month0() as i64 + 1;
    let year = total.div_euclid(12) as i32;
    let m = total.rem_euclid(12) as u32 + 1;
    Ok(chrono::NaiveDate::from_ymd_opt(year, m, 1)
        .ok_or_else(|| AppError::invalid("无法计算月份上界"))?
        .format("%Y-%m-%d")
        .to_string())
}

fn add_months(month: &str, delta: i64) -> AppResult<String> {
    let date = chrono::NaiveDate::parse_from_str(&format!("{month}-01"), "%Y-%m-%d")
        .map_err(|_| AppError::invalid(format!("月份格式不合法：{month}")))?;
    let total = date.year() as i64 * 12 + date.month0() as i64 + delta;
    let year = total.div_euclid(12) as i32;
    let m = total.rem_euclid(12) as u32 + 1;
    Ok(format!("{year:04}-{m:02}"))
}

fn totals_between(conn: &Connection, from: Option<&str>, to: Option<&str>) -> AppResult<MoneyTotals> {
    // None 表示不设日期边界（全历史）。
    let pay_sql = format!(
        "SELECT COALESCE(SUM(r.amount_cents), 0), COALESCE(SUM(r.fee_cents), 0) {VALID_PAYMENTS}
           AND (?1 IS NULL OR r.received_on >= ?1)
           AND (?2 IS NULL OR r.received_on < ?2)"
    );
    let (gross, fee): (i64, i64) = conn.query_row(&pay_sql, rusqlite::params![from, to], |r| {
        Ok((r.get(0)?, r.get(1)?))
    })?;
    let ref_sql = format!(
        "SELECT COALESCE(SUM(f.amount_cents), 0) {VALID_REFUNDS}
           AND (?1 IS NULL OR f.refunded_on >= ?1)
           AND (?2 IS NULL OR f.refunded_on < ?2)"
    );
    let refund: i64 = conn.query_row(&ref_sql, rusqlite::params![from, to], |r| r.get(0))?;
    let net = gross - fee;
    Ok(MoneyTotals {
        gross_received_cents: gross,
        fee_total_cents: fee,
        net_received_cents: net,
        refund_total_cents: refund,
        net_retained_cents: net - refund,
    })
}

fn current_snapshot(conn: &Connection) -> AppResult<CurrentSnapshot> {
    // 待收/超额：逐单算完再汇总，避免把 NULL 金额当成 0。
    let mut stmt = conn.prepare(
        "SELECT o.amount_cents,
                COALESCE((SELECT SUM(r.amount_cents) FROM payment_records r
                           WHERE r.order_id = o.id AND r.voided_at IS NULL), 0)
           FROM orders_visible o
          WHERE o.status <> 'cancelled'",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, i64>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut snapshot = CurrentSnapshot::default();
    for (amount, received) in rows {
        match amount {
            None => snapshot.unknown_amount_orders += 1,
            Some(total) => {
                snapshot.remaining_cents += (total - received).max(0);
                snapshot.over_received_cents += (received - total).max(0);
            }
        }
    }

    snapshot.unrecorded_orders = conn.query_row(
        "SELECT COUNT(*) FROM orders_visible o
          WHERE o.status <> 'cancelled'
            AND NOT EXISTS (SELECT 1 FROM payment_schedules s WHERE s.order_id = o.id)
            AND NOT EXISTS (SELECT 1 FROM payment_records r WHERE r.order_id = o.id)",
        [],
        |r| r.get(0),
    )?;

    snapshot.plan_mismatch_orders = conn.query_row(
        "SELECT COUNT(*) FROM (
           SELECT o.id, o.amount_cents, SUM(s.amount_cents) AS plan_total
             FROM orders_visible o
             JOIN payment_schedules s ON s.order_id = o.id
            WHERE o.status <> 'cancelled'
            GROUP BY o.id
           HAVING o.amount_cents IS NOT NULL AND SUM(s.amount_cents) <> o.amount_cents
         )",
        [],
        |r| r.get(0),
    )?;

    Ok(snapshot)
}

fn monthly(conn: &Connection, from: &str, to: &str, tz_label: &str) -> AppResult<Vec<MonthCashFlow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT substr(r.received_on, 1, 7) AS m,
                SUM(r.amount_cents), SUM(r.fee_cents)
           {VALID_PAYMENTS}
             AND r.received_on >= ?1 AND r.received_on < ?2
          GROUP BY m"
    ))?;
    let mut buckets: std::collections::BTreeMap<String, MonthCashFlow> = Default::default();
    for row in stmt.query_map([from, to], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
    })? {
        let (month, gross, fee) = row?;
        buckets.insert(
            month.clone(),
            MonthCashFlow {
                month,
                gross_received_cents: gross,
                fee_total_cents: fee,
                net_received_cents: gross - fee,
                refund_total_cents: 0,
                net_retained_cents: gross - fee,
            },
        );
    }

    let mut stmt = conn.prepare(&format!(
        "SELECT substr(f.refunded_on, 1, 7) AS m, SUM(f.amount_cents)
           {VALID_REFUNDS}
             AND f.refunded_on >= ?1 AND f.refunded_on < ?2
          GROUP BY m"
    ))?;
    for row in stmt.query_map([from, to], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
    })? {
        let (month, refund) = row?;
        let entry = buckets.entry(month.clone()).or_insert_with(|| MonthCashFlow {
            month,
            gross_received_cents: 0,
            fee_total_cents: 0,
            net_received_cents: 0,
            refund_total_cents: 0,
            net_retained_cents: 0,
        });
        entry.refund_total_cents = refund;
        entry.net_retained_cents = entry.net_received_cents - refund;
    }

    let _ = tz_label;
    Ok(buckets.into_values().collect())
}

fn annual(conn: &Connection, from: &str, to: &str) -> AppResult<Vec<YearNetReceived>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT substr(r.received_on, 1, 4) AS y, SUM(r.amount_cents), SUM(r.fee_cents)
           {VALID_PAYMENTS}
             AND r.received_on >= ?1 AND r.received_on < ?2
          GROUP BY y ORDER BY y"
    ))?;
    let rows = stmt
        .query_map([from, to], |r| {
            Ok(YearNetReceived {
                year: r.get(0)?,
                gross_received_cents: r.get(1)?,
                fee_total_cents: r.get(2)?,
                net_received_cents: r.get::<_, i64>(1)? - r.get::<_, i64>(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 预计收款：只认用户自己建的付款计划，不拿截稿日期顶替。
fn expected(conn: &Connection, today: &str, window_end: &str) -> AppResult<ExpectedReceipts> {
    let mut stmt = conn.prepare(
        "SELECT s.expected_date,
                s.amount_cents - COALESCE((SELECT SUM(r.amount_cents) FROM payment_records r
                                            WHERE r.schedule_id = s.id AND r.voided_at IS NULL), 0) AS outstanding
           FROM payment_schedules s
           JOIN orders_visible o ON o.id = s.order_id
          WHERE o.status <> 'cancelled'",
    )?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, i64>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut out = ExpectedReceipts::default();
    let mut by_month: std::collections::BTreeMap<String, (i64, i64)> = Default::default();
    for (date, outstanding) in rows {
        if outstanding <= 0 {
            continue;
        }
        match date {
            None => {
                out.unscheduled_cents += outstanding;
                out.unscheduled_count += 1;
            }
            Some(day) => {
                if day.as_str() < today {
                    out.overdue_cents += outstanding;
                    out.overdue_count += 1;
                    continue;
                }
                if day.as_str() >= window_end {
                    out.beyond_cents += outstanding;
                    out.beyond_count += 1;
                    continue;
                }
                let month = day[..7].to_string();
                let entry = by_month.entry(month).or_insert((0, 0));
                entry.0 += outstanding;
                entry.1 += 1;
            }
        }
    }
    out.months = by_month
        .into_iter()
        .map(|(month, (amount, count))| ExpectedMonth {
            month,
            amount_cents: amount,
            count,
        })
        .collect();

    out.no_plan_orders = conn.query_row(
        "SELECT COUNT(*) FROM orders_visible o
          WHERE o.status <> 'cancelled'
            AND NOT EXISTS (SELECT 1 FROM payment_schedules s WHERE s.order_id = o.id)",
        [],
        |r| r.get(0),
    )?;
    Ok(out)
}

fn by_platform(conn: &Connection, from: &str, to: &str) -> AppResult<Vec<PlatformRow>> {
    // 按流水里的名称快照分组：平台改名或删除后，历史仍归原名字。
    let mut stmt = conn.prepare(&format!(
        "SELECT r.platform_name, COUNT(*), SUM(r.amount_cents), SUM(r.fee_cents)
           {VALID_PAYMENTS}
             AND r.received_on >= ?1 AND r.received_on < ?2
          GROUP BY r.platform_name
          ORDER BY SUM(r.amount_cents) DESC"
    ))?;
    let rows = stmt
        .query_map([from, to], |r| {
            let gross: i64 = r.get(2)?;
            let fee: i64 = r.get(3)?;
            Ok(PlatformRow {
                platform_name: r.get(0)?,
                count: r.get(1)?,
                gross_received_cents: gross,
                fee_total_cents: fee,
                net_received_cents: gross - fee,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn by_method(conn: &Connection, from: &str, to: &str) -> AppResult<Vec<MethodRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT r.method, COUNT(*), SUM(r.amount_cents), SUM(r.fee_cents)
           {VALID_PAYMENTS}
             AND r.received_on >= ?1 AND r.received_on < ?2
          GROUP BY r.method
          ORDER BY SUM(r.amount_cents) DESC"
    ))?;
    let rows = stmt
        .query_map([from, to], |r| {
            let gross: i64 = r.get(2)?;
            let fee: i64 = r.get(3)?;
            Ok(MethodRow {
                method: r.get(0)?,
                count: r.get(1)?,
                gross_received_cents: gross,
                fee_total_cents: fee,
                net_received_cents: gross - fee,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn by_order_type(conn: &Connection, from: &str, to: &str) -> AppResult<Vec<OrderTypeRow>> {
    // 订单数量与合同金额是「当前全部订单」的口径；到账/退款按区间统计。
    let mut stmt = conn.prepare(
        "SELECT o.commission_type,
                COUNT(*),
                COALESCE(SUM(o.amount_cents), 0),
                SUM(CASE WHEN o.amount_cents IS NULL THEN 1 ELSE 0 END),
                COALESCE(SUM((SELECT SUM(r.amount_cents) FROM payment_records r
                               WHERE r.order_id = o.id AND r.voided_at IS NULL
                                 AND r.received_on >= ?1 AND r.received_on < ?2)), 0),
                COALESCE(SUM((SELECT SUM(r.fee_cents) FROM payment_records r
                               WHERE r.order_id = o.id AND r.voided_at IS NULL
                                 AND r.received_on >= ?1 AND r.received_on < ?2)), 0),
                COALESCE(SUM((SELECT SUM(f.amount_cents) FROM refund_records f
                               WHERE f.order_id = o.id AND f.voided_at IS NULL
                                 AND f.refunded_on >= ?1 AND f.refunded_on < ?2)), 0)
           FROM orders_visible o
          WHERE o.status <> 'cancelled'
          GROUP BY o.commission_type
          ORDER BY COUNT(*) DESC",
    )?;
    let rows = stmt
        .query_map([from, to], |r| {
            let gross: i64 = r.get(4)?;
            let fee: i64 = r.get(5)?;
            let refund: i64 = r.get(6)?;
            Ok(OrderTypeRow {
                order_type: r.get(0)?,
                orders: r.get(1)?,
                order_amount_cents: r.get(2)?,
                unknown_amount_orders: r.get(3)?,
                gross_received_cents: gross,
                fee_total_cents: fee,
                net_received_cents: gross - fee,
                refund_total_cents: refund,
                net_retained_cents: gross - fee - refund,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn report(conn: &Connection, range: StatsRange) -> AppResult<FinanceStatsReport> {
    let tz = settings::working_timezone(conn)?;
    let today = timezone::local_today(tz);
    let (mut from_month, to_month) = month_window(conn, range)?;

    // 「全部」的起点由订单与事件决定，但收款/退款可以被补录到更早的日期
    // （比如今天给一张老订单补记去年的到账）。财务口径必须把这种月份也包进来，
    // 否则用户选了「全部」却看不到自己刚补的那笔。
    if matches!(range, StatsRange::All) {
        let earliest_payment: Option<String> = conn.query_row(
            "SELECT MIN(received_on) FROM payment_records WHERE voided_at IS NULL",
            [],
            |r| r.get::<_, Option<String>>(0),
        )?;
        let earliest_refund: Option<String> = conn.query_row(
            "SELECT MIN(refunded_on) FROM refund_records WHERE voided_at IS NULL",
            [],
            |r| r.get::<_, Option<String>>(0),
        )?;
        for candidate in [earliest_payment, earliest_refund].into_iter().flatten() {
            let month = candidate[..7.min(candidate.len())].to_string();
            if month < from_month {
                from_month = month;
            }
        }
    }
    let from = month_start(&from_month)?;
    let to = next_month_start(&to_month)?;

    // 预计收款窗口：当前自然月 + 后续 5 个月。
    let window_end = month_start(&add_months(&to_month, 6)?)?;

    let lifetime = totals_between(conn, None, None)?;
    let period = totals_between(conn, Some(&from), Some(&to))?;

    Ok(FinanceStatsReport {
        range: range.as_str().to_string(),
        timezone: tz.name().to_string(),
        from_month,
        to_month,
        lifetime,
        current: current_snapshot(conn)?,
        period,
        monthly: monthly(conn, &from, &to, tz.name())?,
        annual: annual(conn, &from, &to)?,
        expected: expected(conn, &today.format("%Y-%m-%d").to_string(), &window_end)?,
        by_platform: by_platform(conn, &from, &to)?,
        by_method: by_method(conn, &from, &to)?,
        by_order_type: by_order_type(conn, &from, &to)?,
        basis: vec![
            "实际到账按收款日期归属月份；退款按退款日期归属，不回填到原收款的月份。".into(),
            "手续费取每笔收款当时记录的实际扣费，不用平台现在的默认费率重算。".into(),
            "净到账 = 实际到账 − 手续费；净留存 = 净到账 − 退款。两者都不是利润，系统没有成本与税费数据。".into(),
            "已取消订单的金额一律不进入统计；订单数量与取消次数仍按事件统计。".into(),
            "预计收款只看你实际建立的付款计划，不按截稿日期推算。".into(),
            "累计与当前状态（待收、超额、未知金额、未记录收款）不受日期范围影响。".into(),
        ],
    })
}
