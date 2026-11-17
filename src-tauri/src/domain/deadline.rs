//! 交付日期风险分类。
//!
//! 只在这里定义一次：工作台指标、订单列表徽标、筛选都读同一个结论，
//! 避免"工作台说逾期、列表里看不出来"。
//!
//! 全部按**工作时时区**的本地日历日期判定，不做 24 小时乘法——
//! 跨月、跨年、夏令时都由日历日期本身保证正确。

use chrono::{Days, NaiveDate};
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::store::timezone;

/// 「未来三日内到期」包含今天之后的第 1～3 天。
pub const DUE_SOON_DAYS: u64 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeadlineState {
    /// 交付日早于今天
    Overdue,
    /// 交付日等于今天
    Today,
    /// 交付日在明天至第三天（含）
    DueSoon,
    /// 交付日为 NULL
    Unscheduled,
    /// 已排期但还早
    Scheduled,
}

impl DeadlineState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Overdue => "overdue",
            Self::Today => "today",
            Self::DueSoon => "dueSoon",
            Self::Unscheduled => "unscheduled",
            Self::Scheduled => "scheduled",
        }
    }
}

/// 工作时时区的"今天"。
pub fn today_in(tz: chrono_tz::Tz) -> NaiveDate {
    timezone::local_today(tz)
}

pub fn parse_delivery(raw: Option<&str>) -> AppResult<Option<NaiveDate>> {
    match raw {
        None => Ok(None),
        Some(value) if value.trim().is_empty() => Ok(None),
        Some(value) => timezone::parse_calendar_date(value)
            .map(Some)
            .map_err(|_| AppError::invalid(format!("交付日期格式不合法：{value}"))),
    }
}

/// 四类互斥：Overdue / Today / DueSoon / Unscheduled，其余为 Scheduled。
pub fn classify(delivery: Option<NaiveDate>, today: NaiveDate) -> DeadlineState {
    let Some(delivery) = delivery else {
        return DeadlineState::Unscheduled;
    };
    if delivery < today {
        return DeadlineState::Overdue;
    }
    if delivery == today {
        return DeadlineState::Today;
    }
    let horizon = today
        .checked_add_days(Days::new(DUE_SOON_DAYS))
        .unwrap_or(today);
    if delivery <= horizon {
        return DeadlineState::DueSoon;
    }
    DeadlineState::Scheduled
}

/// 便捷包装：直接按字符串交付日期与工作时时区判定。
pub fn classify_str(delivery: Option<&str>, tz: chrono_tz::Tz) -> AppResult<DeadlineState> {
    Ok(classify(parse_delivery(delivery)?, today_in(tz)))
}

/// 需要提醒的状态（工作台与列表都用它决定是否显示风险徽标）。
pub fn is_attention(state: DeadlineState) -> bool {
    matches!(
        state,
        DeadlineState::Overdue
            | DeadlineState::Today
            | DeadlineState::DueSoon
            | DeadlineState::Unscheduled
    )
}

pub fn label(state: DeadlineState) -> &'static str {
    match state {
        DeadlineState::Overdue => "已逾期",
        DeadlineState::Today => "今天到期",
        DeadlineState::DueSoon => "三日内到期",
        DeadlineState::Unscheduled => "未排期",
        DeadlineState::Scheduled => "已排期",
    }
}
