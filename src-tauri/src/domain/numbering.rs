//! 订单展示编号 `AF-YYYY-NNNN`。
//!
//! 编号与活动队列位置**完全分离**：编号只在创建时分配一次，之后不因排序、
//! 删除、完成或重开而改变，也不复用。
//! 高水位来自独立小库（见 `store::highwater`），绝不通过扫描订单表求最大值。

use chrono_tz::Tz;

use crate::error::{AppError, AppResult};
use crate::store::highwater::HighWater;
use crate::store::timezone;

pub const CODE_PREFIX: &str = "AF";

pub fn format_code(year: i32, sequence: i64) -> String {
    if sequence < 0 {
        return format!("{CODE_PREFIX}-{year:04}-0000");
    }
    // 超过四位时自然延长，不截断（截断会导致复用）。
    format!("{CODE_PREFIX}-{year:04}-{sequence:04}")
}

pub fn parse_code(code: &str) -> Option<(i32, i64)> {
    let rest = code.strip_prefix(CODE_PREFIX)?.strip_prefix('-')?;
    let (year, seq) = rest.split_once('-')?;
    if year.len() != 4 || seq.len() < 4 {
        return None;
    }
    let year: i32 = year.parse().ok()?;
    let seq: i64 = seq.parse().ok()?;
    Some((year, seq))
}

/// 持久保留一个编号并格式化。年份按**当时的工作时区**确定并固定。
pub fn reserve(hw: &HighWater, timestamp_utc: &str, tz: Tz) -> AppResult<String> {
    let year = timezone::year_of(timestamp_utc, tz)?;
    let sequence = hw.reserve(year)?;
    Ok(format_code(year, sequence))
}

pub fn ensure_well_formed(code: &str) -> AppResult<()> {
    match parse_code(code) {
        Some(_) => Ok(()),
        None => Err(AppError::numbering(format!("订单编号格式不合法：{code}"))),
    }
}
