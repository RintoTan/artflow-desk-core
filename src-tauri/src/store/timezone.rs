//! 持久工作时区（FIX-08）。
//!
//! - 首次初始化取系统时区并持久化；此后系统时区变化**不静默覆盖**。
//! - 计划日期是日历日期；事件时间戳是真实时间点（UTC）。
//! - 修改工作时区不改变已保存的时间点，只改变展示、提醒与统计月份归属。

use std::str::FromStr;

use chrono::{DateTime, Datelike, NaiveDate, SecondsFormat, TimeZone, Utc};
use chrono_tz::Tz;

use crate::error::{AppError, AppResult};

/// 系统时区；无法识别时回退 UTC（并保持可解释）。
pub fn system_timezone() -> Tz {
    match iana_time_zone::get_timezone() {
        Ok(name) => Tz::from_str(&name).unwrap_or(Tz::UTC),
        Err(_) => Tz::UTC,
    }
}

pub fn parse(name: &str) -> AppResult<Tz> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::timezone("工作时区不能为空"));
    }
    Tz::from_str(trimmed)
        .map_err(|_| AppError::timezone(format!("不是有效的 IANA 时区：{trimmed}")))
}

pub fn is_valid(name: &str) -> bool {
    parse(name).is_ok()
}

/// 统一的事件时间戳格式：UTC RFC3339，毫秒精度，`Z` 结尾。
pub fn now_timestamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn timestamp_at(moment: DateTime<Utc>) -> String {
    moment.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// 按工作时区取"此刻"的年份——订单编号年份用它确定。
pub fn local_year(tz: Tz) -> i32 {
    Utc::now().with_timezone(&tz).year()
}

pub fn year_of(timestamp_utc: &str, tz: Tz) -> AppResult<i32> {
    let parsed = DateTime::parse_from_rfc3339(timestamp_utc)
        .map_err(|e| AppError::timezone(format!("时间戳无法解析：{e}")))?;
    Ok(parsed.with_timezone(&tz).year())
}

/// 计划日期解析（纯日历日期，不带时间与时区）。
pub fn parse_calendar_date(raw: &str) -> AppResult<NaiveDate> {
    NaiveDate::parse_from_str(raw.trim(), "%Y-%m-%d")
        .map_err(|_| AppError::invalid(format!("日期格式必须是 YYYY-MM-DD：{raw}")))
}

/// 时间戳在工作时区的日历日期（用于统计月份归属）。
pub fn local_date(timestamp_utc: &str, tz: Tz) -> AppResult<NaiveDate> {
    let parsed = DateTime::parse_from_rfc3339(timestamp_utc)
        .map_err(|e| AppError::timezone(format!("时间戳无法解析：{e}")))?;
    Ok(parsed.with_timezone(&tz).date_naive())
}

/// 给定年月与当天时刻，构造该时区的一个明确时间点（仅用于测试与诊断）。
pub fn moment_in_year(year: i32, tz: Tz) -> AppResult<DateTime<Utc>> {
    let naive = NaiveDate::from_ymd_opt(year, 6, 15)
        .and_then(|d| d.and_hms_opt(9, 0, 0))
        .ok_or_else(|| AppError::timezone("无法构造时间点"))?;
    tz.from_local_datetime(&naive)
        .single()
        .map(|dt| dt.with_timezone(&Utc))
        .ok_or_else(|| AppError::timezone("该时区此本地时间不存在"))
}
