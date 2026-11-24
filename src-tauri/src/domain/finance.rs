//! 接单平台与默认手续费率（FIN-02）。
//!
//! 这一层只做「配置」，不碰收款流水。三条语义必须守住：
//!
//! 1. **NULL ≠ 0**。`fee_rate_bp` 为 NULL 表示还没配过，0 表示用户明确填了 0%。
//!    两者在 UI 上是「未设置」和「0.00%」，混起来会让所有净收入偏高。
//! 2. **费率转换只在 Rust 做一次**。界面把用户输入的原始文本送进来，
//!    这里负责校验与整数换算；前端不重复实现一套可能漂移的解析。
//! 3. **归档只是「不再可选」**。平台不删除、快照不动、名称继续占用；
//!    只有显式永久删除才移除配置行，而历史流水的名称/费率/手续费快照仍然保留
//!    （`payment_records.platform_id` 是 `ON DELETE SET NULL`）。
//!
//! 时间戳规则：用户动作更新 `updated_at`；`created_at` 从不动。
//! 注意与 C-3 区分——数据重置时是**系统搬运**，两个时间戳都原样保留。

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::store::{settings, timezone, visibility};

pub const NAME_MAX_CHARS: usize = 40;
pub const RATE_MAX_BP: i64 = 10_000;
const UNIQUE_INDEX: &str = "payment_platforms_name";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlatformView {
    pub id: String,
    pub name: String,
    /// NULL = 未配置；0 = 明确零费率。
    pub fee_rate_bp: Option<i64>,
    pub archived: bool,
    pub sort_position: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePlatformInput {
    pub name: String,
    /// 用户输入的百分比原文（最多两位小数）；空表示未配置。转换在这里做。
    pub fee_rate: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePlatformInput {
    pub id: String,
    pub name: String,
    pub fee_rate: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePlatformReport {
    pub id: String,
    pub name: String,
    /// 因本次删除而失去平台关联的收款流水数（这些流水的快照仍然保留）。
    pub detached_payments: i64,
}

/// 把用户输入的百分比转成整数基点。
///
/// `1.25` → 125、`5` → 500、`0` → 0、空串/纯空白 → None（未配置）。
/// 全程整数运算：先按小数点切分，再补足两位，不经过 f64。
pub fn parse_fee_rate(raw: Option<&str>) -> AppResult<Option<i64>> {
    let text = raw.unwrap_or("").trim();
    if text.is_empty() {
        return Ok(None);
    }

    if text.starts_with('-') {
        return Err(AppError::invalid("手续费率不能为负数"));
    }
    // 只接受「数字」或「数字.数字」：拒绝科学计数法、千分位、百分号、全角数字等。
    let mut parts = text.split('.');
    let whole = parts.next().unwrap_or("");
    let fraction = parts.next();
    if parts.next().is_some() {
        return Err(AppError::invalid("手续费率最多只能有一个小数点"));
    }
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::invalid("手续费率只能填数字，例如 1.25"));
    }
    let fraction = fraction.unwrap_or("");
    if !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::invalid("手续费率的小数部分只能填数字"));
    }
    if fraction.len() > 2 {
        return Err(AppError::invalid("手续费率最多两位小数"));
    }

    let whole: i64 = whole
        .parse()
        .map_err(|_| AppError::invalid("手续费率数值过大"))?;
    let cents = if fraction.is_empty() {
        0
    } else if fraction.len() == 1 {
        fraction.parse::<i64>().unwrap() * 10
    } else {
        fraction.parse::<i64>().unwrap()
    };
    let bp = whole
        .checked_mul(100)
        .and_then(|value| value.checked_add(cents))
        .ok_or_else(|| AppError::invalid("手续费率数值过大"))?;
    if bp > RATE_MAX_BP {
        return Err(AppError::invalid("手续费率不能超过 100%"));
    }
    Ok(Some(bp))
}

/// 基点转回输入框里的百分比文本：125 → "1.25"、500 → "5.00"、0 → "0.00"。
pub fn format_fee_rate(bp: Option<i64>) -> Option<String> {
    bp.map(|value| format!("{}.{:02}", value / 100, value % 100))
}

fn normalize_name(raw: &str) -> AppResult<String> {
    // Rust 的 trim 覆盖 Unicode 空白（含全角空格、不换行空格），
    // 数据库的 trim() 只认 ASCII 空格，两层都要有。
    let name = raw.trim();
    if name.is_empty() {
        return Err(AppError::invalid("平台名称不能为空"));
    }
    if name.chars().count() > NAME_MAX_CHARS {
        return Err(AppError::invalid(format!(
            "平台名称最多 {NAME_MAX_CHARS} 个字符"
        )));
    }
    Ok(name.to_string())
}

fn row_to_view(row: &rusqlite::Row<'_>) -> rusqlite::Result<PlatformView> {
    Ok(PlatformView {
        id: row.get(0)?,
        name: row.get(1)?,
        fee_rate_bp: row.get(2)?,
        archived: row.get::<_, i64>(3)? != 0,
        sort_position: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

const SELECT_COLUMNS: &str = "id, name, fee_rate_bp, archived, sort_position, created_at, updated_at";

/// 全部平台，正常的在前、归档的在后。归档项必须可见——用户要能恢复它。
pub fn list(conn: &Connection) -> AppResult<Vec<PlatformView>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLUMNS} FROM payment_platforms
         ORDER BY archived ASC, sort_position ASC, created_at ASC, id ASC"
    ))?;
    let rows = stmt.query_map([], row_to_view)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn load(conn: &Connection, id: &str) -> AppResult<PlatformView> {
    conn.query_row(
        &format!("SELECT {SELECT_COLUMNS} FROM payment_platforms WHERE id = ?1"),
        [id],
        row_to_view,
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("平台不存在或已被删除"))
}

/// 名称全局唯一——正常与归档之间也唯一，所以这里不带 `archived` 条件。
///
/// 两种情况给不同的提示：用户看到「已归档」才知道自己该去恢复而不是改名。
fn ensure_name_free(conn: &Connection, name: &str, exclude_id: Option<&str>) -> AppResult<()> {
    let taken: Option<i64> = conn
        .query_row(
            "SELECT archived FROM payment_platforms WHERE name = ?1 AND id IS NOT ?2",
            params![name, exclude_id.unwrap_or("")],
            |r| r.get(0),
        )
        .optional()?;
    match taken {
        None => Ok(()),
        Some(1) => Err(AppError::conflict(
            "同名平台已归档，可恢复原平台或修改名称",
        )),
        Some(_) => Err(AppError::conflict("已有同名平台，请更换名称")),
    }
}

/// 唯一索引是最后一道兜底：并发下前面的查询可能已经过期。
fn map_unique_violation(err: rusqlite::Error) -> AppError {
    let message = err.to_string();
    if message.contains(UNIQUE_INDEX) || message.contains("UNIQUE constraint failed") {
        AppError::conflict("已有同名平台，请更换名称")
    } else {
        AppError::from(err)
    }
}

fn next_sort_position(conn: &Connection) -> AppResult<i64> {
    // 空表给 0，与列默认值一致；否则排到最后。
    let max: Option<i64> = conn.query_row(
        "SELECT MAX(sort_position) FROM payment_platforms",
        [],
        |r| r.get(0),
    )?;
    Ok(max.unwrap_or(-1) + 1)
}

pub fn create(conn: &Connection, input: &CreatePlatformInput) -> AppResult<PlatformView> {
    let name = normalize_name(&input.name)?;
    let fee = parse_fee_rate(input.fee_rate.as_deref())?;
    ensure_name_free(conn, &name, None)?;

    let id = uuid::Uuid::new_v4().to_string();
    let now = timezone::now_timestamp();
    let position = next_sort_position(conn)?;
    conn.execute(
        "INSERT INTO payment_platforms
           (id, name, fee_rate_bp, archived, sort_position, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, ?4, ?5, ?5)",
        params![id, name, fee, position, now],
    )
    .map_err(map_unique_violation)?;
    load(conn, &id)
}

pub fn update(conn: &Connection, input: &UpdatePlatformInput) -> AppResult<PlatformView> {
    let name = normalize_name(&input.name)?;
    let fee = parse_fee_rate(input.fee_rate.as_deref())?;
    let current = load(conn, &input.id)?;
    ensure_name_free(conn, &name, Some(&input.id))?;

    let now = timezone::now_timestamp();
    let changed = conn
        .execute(
            "UPDATE payment_platforms SET name = ?1, fee_rate_bp = ?2, updated_at = ?3
             WHERE id = ?4",
            params![name, fee, now, current.id],
        )
        .map_err(map_unique_violation)?;
    if changed != 1 {
        return Err(AppError::not_found("平台不存在或已被删除"));
    }
    load(conn, &current.id)
}

fn set_archived(conn: &Connection, id: &str, archived: bool) -> AppResult<PlatformView> {
    let current = load(conn, id)?;
    let now = timezone::now_timestamp();
    conn.execute(
        "UPDATE payment_platforms SET archived = ?1, updated_at = ?2 WHERE id = ?3",
        params![i64::from(archived), now, current.id],
    )?;
    load(conn, &current.id)
}

/// 归档 = 停用：不再出现在新收款的可选平台里，但配置与名称都留着，随时可恢复。
pub fn archive(conn: &Connection, id: &str) -> AppResult<PlatformView> {
    set_archived(conn, id, true)
}

pub fn restore(conn: &Connection, id: &str) -> AppResult<PlatformView> {
    set_archived(conn, id, false)
}

/// 拖拽排序：只接受「当前全部正常平台」的一个排列。
///
/// 提交集合与现状不一致时直接拒绝，而不是宽容地只改交集——否则归档平台、
/// 被别的窗口新建的平台会在用户不知情的情况下被挪位置。
pub fn reorder(conn: &mut Connection, ids: &[String]) -> AppResult<Vec<PlatformView>> {
    if ids.is_empty() {
        return Err(AppError::invalid("排序列表不能为空"));
    }
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(id.as_str()) {
            return Err(AppError::invalid("排序列表里出现了重复的平台"));
        }
    }

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    {
        let mut stmt =
            tx.prepare("SELECT id FROM payment_platforms WHERE archived = 0 ORDER BY id")?;
        let current: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(stmt);

        let mut submitted: Vec<String> = ids.to_vec();
        submitted.sort();
        if current != submitted {
            return Err(AppError::conflict(
                "平台列表已变化（可能被归档或在别处新增），请刷新后重试",
            ));
        }
    }

    let now = timezone::now_timestamp();
    for (position, id) in ids.iter().enumerate() {
        let changed = tx.execute(
            "UPDATE payment_platforms SET sort_position = ?1, updated_at = ?2
             WHERE id = ?3 AND archived = 0",
            params![position as i64, now, id],
        )?;
        if changed != 1 {
            return Err(AppError::conflict("平台状态已变化，请刷新后重试"));
        }
    }
    tx.commit()?;
    list(conn)
}

/// 永久删除**配置行**，不删除任何收款流水。
///
/// 外键是 `ON DELETE SET NULL`，流水的 `platform_name` / `fee_rate_bp` / `fee_cents`
/// 快照本来就不依赖这一行，所以删完历史仍然自洽。
pub fn delete(conn: &Connection, id: &str) -> AppResult<DeletePlatformReport> {
    let current = load(conn, id)?;
    let detached: i64 = conn.query_row(
        "SELECT COUNT(*) FROM payment_records WHERE platform_id = ?1",
        [&current.id],
        |r| r.get(0),
    )?;
    let removed = conn.execute("DELETE FROM payment_platforms WHERE id = ?1", [&current.id])?;
    if removed != 1 {
        return Err(AppError::not_found("平台不存在或已被删除"));
    }
    Ok(DeletePlatformReport {
        id: current.id,
        name: current.name,
        detached_payments: detached,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_means_unconfigured_not_zero() {
        assert_eq!(parse_fee_rate(None).unwrap(), None);
        assert_eq!(parse_fee_rate(Some("")).unwrap(), None);
        assert_eq!(parse_fee_rate(Some("   ")).unwrap(), None);
        assert_eq!(parse_fee_rate(Some("0")).unwrap(), Some(0));
        assert_eq!(parse_fee_rate(Some("0.00")).unwrap(), Some(0));
    }

    #[test]
    fn percent_maps_to_basis_points() {
        assert_eq!(parse_fee_rate(Some("1")).unwrap(), Some(100));
        assert_eq!(parse_fee_rate(Some("1.2")).unwrap(), Some(120));
        assert_eq!(parse_fee_rate(Some("1.25")).unwrap(), Some(125));
        assert_eq!(parse_fee_rate(Some("5")).unwrap(), Some(500));
        assert_eq!(parse_fee_rate(Some("100")).unwrap(), Some(10_000));
        assert_eq!(parse_fee_rate(Some("100.00")).unwrap(), Some(10_000));
        assert_eq!(parse_fee_rate(Some(" 2.5 ")).unwrap(), Some(250));
    }

    #[test]
    fn rejects_anything_that_is_not_a_plain_percentage() {
        for raw in [
            "-1", "100.01", "101", "1.234", "abc", "1e3", "1.2.3", "1,5", "5%", "＋5", "١٢",
        ] {
            assert!(
                parse_fee_rate(Some(raw)).is_err(),
                "{raw:?} 不该被接受"
            );
        }
    }

    #[test]
    fn formatting_round_trips() {
        assert_eq!(format_fee_rate(Some(125)).as_deref(), Some("1.25"));
        assert_eq!(format_fee_rate(Some(0)).as_deref(), Some("0.00"));
        assert_eq!(format_fee_rate(Some(10_000)).as_deref(), Some("100.00"));
        assert_eq!(format_fee_rate(None), None);
    }

    #[test]
    fn names_are_trimmed_with_unicode_whitespace() {
        assert_eq!(normalize_name("  米画师  ").unwrap(), "米画师");
        assert_eq!(normalize_name("\u{3000}画加\u{3000}").unwrap(), "画加");
        assert!(normalize_name("   ").is_err());
        assert!(normalize_name("").is_err());
        assert_eq!(normalize_name(&"字".repeat(40)).unwrap().chars().count(), 40);
        assert!(normalize_name(&"字".repeat(41)).is_err());
    }
}

// ======================================================================
// FIN-03：付款计划与实际收款
//
// 「计划」是预期，「流水」是事实。这一节的全部派生结果都只在读取时算，
// 不写回数据库：净到账、待收、计划状态、逾期都是查询结果，不是字段。
// ======================================================================

pub const KIND_FULL: &str = "full";
pub const KIND_DEPOSIT: &str = "deposit";
pub const KIND_INSTALLMENT: &str = "installment";
pub const KIND_FINAL: &str = "final";

const METHODS: [&str; 5] = ["wechat", "alipay", "bank", "cash", "other"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItemInput {
    /// 有 id = 更新已有计划项；没有 = 新建。
    pub id: Option<String>,
    pub kind: String,
    pub amount_cents: i64,
    pub expected_date: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePlanInput {
    pub order_id: String,
    /// 空数组 = 清空全部付款计划（允许）。
    pub items: Vec<PlanItemInput>,
    /// 删除有流水的计划项时需要显式确认，否则整个保存被拒。
    pub confirm_detach: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRecordInput {
    pub order_id: String,
    pub schedule_id: Option<String>,
    pub kind: String,
    pub amount_cents: i64,
    pub received_on: String,
    pub platform_id: Option<String>,
    pub fee_cents: i64,
    pub method: Option<String>,
    pub note: Option<String>,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRecordInput {
    pub id: String,
    pub schedule_id: Option<String>,
    pub kind: String,
    pub amount_cents: i64,
    pub received_on: String,
    pub platform_id: Option<String>,
    pub fee_cents: i64,
    pub method: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoidRecordInput {
    pub id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentRecordView {
    pub id: String,
    pub order_id: String,
    pub schedule_id: Option<String>,
    pub kind: String,
    pub amount_cents: i64,
    pub received_on: String,
    pub platform_id: Option<String>,
    pub platform_name: Option<String>,
    pub fee_rate_bp: Option<i64>,
    pub fee_cents: i64,
    /// 派生值：`amount_cents - fee_cents`，不落库。
    pub net_cents: i64,
    pub method: Option<String>,
    pub note: Option<String>,
    pub voided_at: Option<String>,
    pub void_reason: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItemView {
    pub id: String,
    pub kind: String,
    pub amount_cents: i64,
    pub expected_date: Option<String>,
    pub sort_position: i64,
    pub received_cents: i64,
    pub outstanding_cents: i64,
    /// `unpaid` / `partial` / `settled` / `overdue`
    pub status: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderFinanceView {
    pub order_id: String,
    pub order_amount_cents: Option<i64>,
    /// `none` / `full` / `deposit_final` / `installment` / `mixed`
    pub plan_mode: &'static str,
    pub plan_items: Vec<PlanItemView>,
    pub plan_total_cents: i64,
    pub plan_matches_order: bool,
    pub records: Vec<PaymentRecordView>,
    pub voided_records: Vec<PaymentRecordView>,
    pub gross_received_cents: i64,
    pub fee_total_cents: i64,
    pub net_received_cents: i64,
    pub refunds: Vec<RefundView>,
    pub voided_refunds: Vec<RefundView>,
    /// 有效退款合计（未作废）。
    pub refund_total_cents: i64,
    /// 净到账 − 实际退款。允许为负：负数说明退款超过已记录到账，要提示而不是截断。
    pub net_retained_cents: i64,
    /// 订单已取消：财务只读，但退款仍可补录。
    pub cancelled: bool,
    /// 订单金额未知时为 None——不能拿 0 冒充「已结清」。
    pub remaining_cents: Option<i64>,
    pub over_received_cents: i64,
    /// 既没有计划也没有流水：系统不知道客户付过没有，界面要说「未记录收款信息」。
    pub unrecorded: bool,
    pub has_records_without_plan: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeeQuote {
    pub amount_cents: i64,
    pub fee_rate_bp: Option<i64>,
    /// 费率未知时为 None：不替用户猜一个 0。
    pub suggested_fee_cents: Option<i64>,
}

struct OrderMoney {
    amount_cents: Option<i64>,
    status: String,
}

fn order_money(conn: &Connection, order_id: &str) -> AppResult<OrderMoney> {
    conn.query_row(
        "SELECT amount_cents, status FROM orders_visible WHERE id = ?1",
        [order_id],
        |row| {
            Ok(OrderMoney {
                amount_cents: row.get(0)?,
                status: row.get(1)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("订单不存在或已在回收站"))
}

/// 取消单不进财务：读取报错，写入拒绝。
///
/// 之所以读取也报错而不是返回一堆 0，是因为 0 会被读成「一分没收」，
/// 而实际情况是「这笔委托不算钱了」。含糊比拒绝更危险。
fn ensure_finance_open(order: &OrderMoney) -> AppResult<()> {
    if order.status == "cancelled" {
        return Err(AppError::conflict(
            "订单已取消，不参与财务统计；如需修正历史收款，请先恢复订单",
        ));
    }
    Ok(())
}

/// 与订单创建同一套幂等语义：去空白、空的当没有、过长拒绝。
fn clean_request_id(raw: &Option<String>) -> AppResult<Option<String>> {
    match raw.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(value) if value.chars().count() > 120 => Err(AppError::invalid("请求标识过长")),
        Some(value) => Ok(Some(value.to_string())),
    }
}

fn normalize_kind(raw: &str) -> AppResult<String> {
    let kind = raw.trim();
    match kind {
        KIND_FULL | KIND_DEPOSIT | KIND_INSTALLMENT | KIND_FINAL => Ok(kind.to_string()),
        _ => Err(AppError::invalid("不支持的收款类型")),
    }
}

fn clean_method(raw: &Option<String>) -> AppResult<Option<String>> {
    match raw.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(value) if METHODS.contains(&value) => Ok(Some(value.to_string())),
        Some(_) => Err(AppError::invalid("不支持的收款方式")),
    }
}

fn clean_note(raw: &Option<String>) -> AppResult<Option<String>> {
    match raw.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(value) if value.chars().count() > 500 => Err(AppError::invalid("备注过长")),
        Some(value) => Ok(Some(value.to_string())),
    }
}

/// 到账日期：必须是真实日历日期，且不能是未来。
///
/// 「未来到账」不是笔误就是猜的，两者都不该进账。过去日期一律放行——
/// 补录历史收款是正常需求，不设人为下限。
fn record_date(conn: &Connection, raw: &str) -> AppResult<String> {
    let parsed = timezone::parse_calendar_date(raw)?;
    let tz = settings::working_timezone(conn)?;
    let today = timezone::local_today(tz);
    if parsed > today {
        return Err(AppError::invalid("收款日期不能晚于今天"));
    }
    Ok(parsed.format("%Y-%m-%d").to_string())
}

/// 预计收款日期：同样要求真实存在，但过去和未来都行。
fn expected_date(raw: &Option<String>) -> AppResult<Option<String>> {
    match raw.as_deref().map(str::trim) {
        None | Some("") => Ok(None),
        Some(value) => Ok(Some(
            timezone::parse_calendar_date(value)?.format("%Y-%m-%d").to_string(),
        )),
    }
}

fn check_amount(amount_cents: i64) -> AppResult<()> {
    if amount_cents <= 0 {
        return Err(AppError::invalid("金额必须大于 0"));
    }
    Ok(())
}

fn check_fee(amount_cents: i64, fee_cents: i64) -> AppResult<()> {
    if fee_cents < 0 {
        return Err(AppError::invalid("手续费不能为负数"));
    }
    if fee_cents > amount_cents {
        return Err(AppError::invalid("手续费不能超过本笔收款金额"));
    }
    Ok(())
}

/// 预计手续费：`amount × rate / 10000`，整数四舍五入（半分远离零）。
pub fn suggest_fee(amount_cents: i64, fee_rate_bp: Option<i64>) -> AppResult<Option<i64>> {
    let Some(rate) = fee_rate_bp else {
        return Ok(None);
    };
    if !(0..=RATE_MAX_BP).contains(&rate) {
        return Err(AppError::invalid("手续费率超出范围"));
    }
    check_amount(amount_cents)?;
    let value = (amount_cents as i128 * rate as i128 + 5_000) / 10_000;
    i64::try_from(value)
        .map(Some)
        .map_err(|_| AppError::invalid("手续费计算溢出"))
}

pub fn quote(amount_cents: i64, fee_rate_bp: Option<i64>) -> AppResult<FeeQuote> {
    Ok(FeeQuote {
        amount_cents,
        fee_rate_bp,
        suggested_fee_cents: suggest_fee(amount_cents, fee_rate_bp)?,
    })
}

fn record_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PaymentRecordView> {
    let amount_cents: i64 = row.get("amount_cents")?;
    let fee_cents: i64 = row.get("fee_cents")?;
    Ok(PaymentRecordView {
        id: row.get("id")?,
        order_id: row.get("order_id")?,
        schedule_id: row.get("schedule_id")?,
        kind: row.get("kind")?,
        amount_cents,
        received_on: row.get("received_on")?,
        platform_id: row.get("platform_id")?,
        platform_name: row.get("platform_name")?,
        fee_rate_bp: row.get("fee_rate_bp")?,
        fee_cents,
        net_cents: amount_cents - fee_cents,
        method: row.get("method")?,
        note: row.get("note")?,
        voided_at: row.get("voided_at")?,
        void_reason: row.get("void_reason")?,
        created_at: row.get("created_at")?,
    })
}

const RECORD_COLUMNS: &str = "id, order_id, schedule_id, kind, amount_cents, received_on,
     platform_id, platform_name, fee_rate_bp, fee_cents, method, note,
     voided_at, void_reason, created_at";

fn load_record(conn: &Connection, id: &str) -> AppResult<PaymentRecordView> {
    conn.query_row(
        &format!("SELECT {RECORD_COLUMNS} FROM payment_records WHERE id = ?1"),
        [id],
        record_row,
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("收款记录不存在"))
}

/// 平台快照：名称与费率都是**写入当时**的值，之后平台改名/改费率/归档都不回改历史。
fn platform_snapshot(
    conn: &Connection,
    platform_id: &Option<String>,
) -> AppResult<(Option<String>, Option<String>, Option<i64>)> {
    let Some(id) = platform_id.as_deref().map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok((None, None, None));
    };
    let platform = load(conn, id)?;
    if platform.archived {
        return Err(AppError::conflict("该平台已归档，不能用于新收款"));
    }
    Ok((Some(platform.id), Some(platform.name), platform.fee_rate_bp))
}

fn assert_schedule_usable(conn: &Connection, schedule_id: &str, order_id: &str, kind: &str) -> AppResult<()> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT order_id, kind FROM payment_schedules WHERE id = ?1",
            [schedule_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (schedule_order, schedule_kind) =
        row.ok_or_else(|| AppError::not_found("付款计划不存在"))?;
    if schedule_order != order_id {
        return Err(AppError::invalid("收款流水与付款计划不属于同一订单"));
    }
    if schedule_kind != kind {
        return Err(AppError::invalid("收款类型与付款计划类型不一致"));
    }
    Ok(())
}

// ---------------------------------------------------------------- 付款计划

fn clean_schedule_id(raw: &Option<String>) -> Option<String> {
    raw.as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub fn save_plan(conn: &mut Connection, input: &SavePlanInput) -> AppResult<OrderFinanceView> {
    visibility::require_visible_order(conn, &input.order_id)?;
    let order = order_money(conn, &input.order_id)?;
    ensure_finance_open(&order)?;

    // 1) 结构校验：全款 1 项 / 定金+尾款 2 项 / 分期 ≥2 项 / 空 = 清空。
    let mut kinds = Vec::with_capacity(input.items.len());
    for item in &input.items {
        kinds.push(normalize_kind(&item.kind)?);
        check_amount(item.amount_cents)?;
    }
    if !kinds.is_empty() {
        let full = kinds.iter().filter(|k| *k == KIND_FULL).count();
        let deposit = kinds.iter().filter(|k| *k == KIND_DEPOSIT).count();
        let final_count = kinds.iter().filter(|k| *k == KIND_FINAL).count();
        let installment = kinds.iter().filter(|k| *k == KIND_INSTALLMENT).count();
        let valid = (kinds.len() == 1 && full == 1)
            || (kinds.len() == 2 && deposit == 1 && final_count == 1)
            || (installment == kinds.len() && kinds.len() >= 2);
        if !valid {
            return Err(AppError::invalid(
                "付款计划只能是「全款」「定金 + 尾款」或「至少两期分期」",
            ));
        }
    }

    // 2) 金额校验：有订单总额才能建计划，且合计必须严格相等。
    if !input.items.is_empty() {
        let total = order
            .amount_cents
            .filter(|value| *value > 0)
            .ok_or_else(|| AppError::invalid("订单金额未填写，无法建立付款计划"))?;
        let sum: i64 = input.items.iter().map(|i| i.amount_cents).sum();
        if sum != total {
            let diff = sum - total;
            return Err(AppError::invalid(format!(
                "付款计划合计 {} 元与订单总额 {} 元不一致（相差 {} 元）",
                yuan(sum),
                yuan(total),
                yuan(diff.abs())
            )));
        }
    }

    let mut dates = Vec::with_capacity(input.items.len());
    for item in &input.items {
        dates.push(expected_date(&item.expected_date)?);
    }

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // 3) 与库内现状比对，算出要删/要改/要建。
    let existing: Vec<String> = {
        let mut stmt = tx.prepare("SELECT id FROM payment_schedules WHERE order_id = ?1")?;
        let rows = stmt
            .query_map([&input.order_id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let mut seen = std::collections::HashSet::new();
    for item in &input.items {
        if let Some(id) = &item.id {
            if !seen.insert(id.as_str()) {
                return Err(AppError::invalid("付款计划里出现了重复的计划项"));
            }
            if !existing.iter().any(|e| e == id) {
                return Err(AppError::invalid("付款计划项不属于该订单"));
            }
        }
    }
    let keep: Vec<&str> = input
        .items
        .iter()
        .filter_map(|i| i.id.as_deref())
        .collect();
    let to_delete: Vec<&str> = existing
        .iter()
        .map(String::as_str)
        .filter(|id| !keep.contains(id))
        .collect();

    let mut detached = 0_i64;
    for id in &to_delete {
        detached += tx.query_row(
            "SELECT COUNT(*) FROM payment_records WHERE schedule_id = ?1",
            [id],
            |r| r.get::<_, i64>(0),
        )?;
    }
    if detached > 0 && !input.confirm_detach {
        return Err(AppError::conflict(format!(
            "有 {detached} 笔收款流水关联在将被移除的计划上，确认解除关联后才能保存（流水不会被删除）"
        )));
    }
    for (item, kind) in input.items.iter().zip(kinds.iter()) {
        let Some(id) = &item.id else { continue };
        let current: String = tx.query_row(
            "SELECT kind FROM payment_schedules WHERE id = ?1",
            [id],
            |r| r.get(0),
        )?;
        if &current != kind {
            let linked: i64 = tx.query_row(
                "SELECT COUNT(*) FROM payment_records WHERE schedule_id = ?1",
                [id],
                |r| r.get::<_, i64>(0),
            )?;
            if linked > 0 {
                return Err(AppError::conflict(
                    "该付款计划已有收款流水，不能修改类型；请移除后再新建",
                ));
            }
        }
    }

    let now = timezone::now_timestamp();
    for id in &to_delete {
        tx.execute("DELETE FROM payment_schedules WHERE id = ?1", [id])?;
    }
    for (index, (item, kind)) in input.items.iter().zip(kinds.iter()).enumerate() {
        let date = dates.get(index).cloned().flatten();
        match &item.id {
            Some(id) => {
                tx.execute(
                    "UPDATE payment_schedules
                        SET kind = ?1, amount_cents = ?2, expected_date = ?3, sort_position = ?4
                      WHERE id = ?5",
                    params![kind, item.amount_cents, date, index as i64, id],
                )?;
            }
            None => {
                tx.execute(
                    "INSERT INTO payment_schedules
                       (id, order_id, kind, amount_cents, expected_date, sort_position, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        uuid::Uuid::new_v4().to_string(),
                        input.order_id,
                        kind,
                        item.amount_cents,
                        date,
                        index as i64,
                        now
                    ],
                )?;
            }
        }
    }
    tx.commit()?;
    snapshot(conn, &input.order_id)
}

fn yuan(cents: i64) -> String {
    format!("{}.{:02}", cents / 100, (cents % 100).abs())
}

// ---------------------------------------------------------------- 收款流水

pub fn create_record(
    conn: &mut Connection,
    input: &CreateRecordInput,
) -> AppResult<PaymentRecordView> {
    visibility::require_visible_order(conn, &input.order_id)?;
    let order = order_money(conn, &input.order_id)?;
    ensure_finance_open(&order)?;
    check_amount(input.amount_cents)?;
    check_fee(input.amount_cents, input.fee_cents)?;
    let kind = normalize_kind(&input.kind)?;
    let received_on = record_date(conn, &input.received_on)?;
    let method = clean_method(&input.method)?;
    let note = clean_note(&input.note)?;
    let request_id = clean_request_id(&input.request_id)?;

    if let Some(rid) = &request_id {
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM payment_records WHERE request_id = ?1",
                [rid],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = existing {
            // 同一请求重放：返回原记录，不重复记账。
            return load_record(conn, &id);
        }
    }

    let schedule_id = clean_schedule_id(&input.schedule_id);
    if let Some(sid) = &schedule_id {
        assert_schedule_usable(conn, sid, &input.order_id, &kind)?;
    }
    let (platform_id, platform_name, fee_rate_bp) = platform_snapshot(conn, &input.platform_id)?;

    let id = uuid::Uuid::new_v4().to_string();
    let now = timezone::now_timestamp();
    conn.execute(
        "INSERT INTO payment_records
           (id, order_id, schedule_id, kind, amount_cents, received_on,
            platform_id, platform_name, fee_rate_bp, fee_cents, method, note,
            request_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            id,
            input.order_id,
            schedule_id,
            kind,
            input.amount_cents,
            received_on,
            platform_id,
            platform_name,
            fee_rate_bp,
            input.fee_cents,
            method,
            note,
            request_id,
            now
        ],
    )?;
    load_record(conn, &id)
}

pub fn update_record(
    conn: &mut Connection,
    input: &UpdateRecordInput,
) -> AppResult<PaymentRecordView> {
    let current = load_record(conn, &input.id)?;
    if current.voided_at.is_some() {
        return Err(AppError::conflict("已作废的收款记录不能再修改"));
    }
    visibility::require_visible_order(conn, &current.order_id)?;
    let order = order_money(conn, &current.order_id)?;
    ensure_finance_open(&order)?;

    check_amount(input.amount_cents)?;
    check_fee(input.amount_cents, input.fee_cents)?;
    let kind = normalize_kind(&input.kind)?;
    let received_on = record_date(conn, &input.received_on)?;
    let method = clean_method(&input.method)?;
    let note = clean_note(&input.note)?;

    let schedule_id = clean_schedule_id(&input.schedule_id);
    if let Some(sid) = &schedule_id {
        assert_schedule_usable(conn, sid, &current.order_id, &kind)?;
    }

    // 平台没换就沿用原快照，换了才重新取一次——绝不因为平台后来改了费率
    // 就把历史流水的费率改掉。
    let new_platform = clean_schedule_id(&input.platform_id);
    let (platform_id, platform_name, fee_rate_bp) = match (new_platform, &current.platform_id) {
        (None, _) => (None, None, None),
        (Some(id), Some(old)) if &id == old => (
            current.platform_id.clone(),
            current.platform_name.clone(),
            current.fee_rate_bp,
        ),
        (Some(id), _) => platform_snapshot(conn, &Some(id))?,
    };

    conn.execute(
        "UPDATE payment_records
            SET schedule_id = ?1, kind = ?2, amount_cents = ?3, received_on = ?4,
                platform_id = ?5, platform_name = ?6, fee_rate_bp = ?7,
                fee_cents = ?8, method = ?9, note = ?10
          WHERE id = ?11",
        params![
            schedule_id,
            kind,
            input.amount_cents,
            received_on,
            platform_id,
            platform_name,
            fee_rate_bp,
            input.fee_cents,
            method,
            note,
            current.id
        ],
    )?;
    load_record(conn, &current.id)
}

pub fn void_record(
    conn: &mut Connection,
    input: &VoidRecordInput,
) -> AppResult<PaymentRecordView> {
    let current = load_record(conn, &input.id)?;
    if current.voided_at.is_some() {
        return Err(AppError::conflict("该收款记录已经作废"));
    }
    visibility::require_visible_order(conn, &current.order_id)?;
    let order = order_money(conn, &current.order_id)?;
    ensure_finance_open(&order)?;

    let reason = input.reason.trim();
    if reason.is_empty() {
        return Err(AppError::invalid("作废原因不能为空"));
    }
    if reason.chars().count() > 500 {
        return Err(AppError::invalid("作废原因过长"));
    }

    let now = timezone::now_timestamp();
    conn.execute(
        "UPDATE payment_records SET voided_at = ?1, void_reason = ?2 WHERE id = ?3",
        params![now, reason, current.id],
    )?;
    load_record(conn, &current.id)
}

// ------------------------------------------------------------ 读取模型

fn plan_mode(items: &[PlanItemView]) -> &'static str {
    if items.is_empty() {
        return "none";
    }
    let has = |kind: &str| items.iter().any(|i| i.kind == kind);
    if items.len() == 1 && has(KIND_FULL) {
        "full"
    } else if items.len() == 2 && has(KIND_DEPOSIT) && has(KIND_FINAL) {
        "deposit_final"
    } else if items.iter().all(|i| i.kind == KIND_INSTALLMENT) {
        "installment"
    } else {
        "mixed"
    }
}

/// 订单财务全景。所有数字都是现算的，表里没有「已收」「待收」这类字段。
pub fn snapshot(conn: &Connection, order_id: &str) -> AppResult<OrderFinanceView> {
    let order = order_money(conn, order_id)?;
    // 取消单仍然可以读：用户要看自己的历史收款与退款。写入才拦。
    let cancelled = order.status == "cancelled";
    let tz = settings::working_timezone(conn)?;
    let today = timezone::local_today(tz);

    // 计划项 + 每项已收（只算未作废流水）。
    let items: Vec<PlanItemView> = {
        let mut stmt = conn.prepare(
            "SELECT s.id, s.kind, s.amount_cents, s.expected_date, s.sort_position,
                    COALESCE((
                      SELECT SUM(r.amount_cents) FROM payment_records r
                       WHERE r.schedule_id = s.id AND r.voided_at IS NULL
                    ), 0)
               FROM payment_schedules s
              WHERE s.order_id = ?1
              ORDER BY s.sort_position ASC, s.created_at ASC, s.id ASC",
        )?;
        let rows = stmt.query_map([order_id], |row| {
            let amount: i64 = row.get(2)?;
            let received: i64 = row.get(5)?;
            let expected: Option<String> = row.get(3)?;
            let settled = received >= amount;
            let overdue = !settled
                && expected
                    .as_deref()
                    .and_then(|d| timezone::parse_calendar_date(d).ok())
                    .is_some_and(|date| date < today);
            let status = if overdue {
                "overdue"
            } else if settled {
                "settled"
            } else if received == 0 {
                "unpaid"
            } else {
                "partial"
            };
            Ok(PlanItemView {
                id: row.get(0)?,
                kind: row.get(1)?,
                amount_cents: amount,
                expected_date: expected,
                sort_position: row.get(4)?,
                received_cents: received,
                outstanding_cents: (amount - received).max(0),
                status,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let all_records: Vec<PaymentRecordView> = {
        let mut stmt = conn.prepare(&format!(
            "SELECT {RECORD_COLUMNS} FROM payment_records
              WHERE order_id = ?1
              ORDER BY received_on DESC, created_at DESC, id DESC"
        ))?;
        let rows = stmt.query_map([order_id], record_row)?;
        rows.collect::<Result<Vec<_>, _>>()?
    };
    let (voided_records, records): (Vec<_>, Vec<_>) =
        all_records.into_iter().partition(|r| r.voided_at.is_some());

    let all_refunds = refunds_of(conn, order_id)?;
    let (voided_refunds, refunds): (Vec<_>, Vec<_>) =
        all_refunds.into_iter().partition(|r| r.voided_at.is_some());
    let refund_total_cents: i64 = refunds.iter().map(|r| r.amount_cents).sum();

    let gross_received_cents: i64 = records.iter().map(|r| r.amount_cents).sum();
    let fee_total_cents: i64 = records.iter().map(|r| r.fee_cents).sum();
    let plan_total_cents: i64 = items.iter().map(|i| i.amount_cents).sum();
    let plan_is_empty = items.is_empty();
    let mode = plan_mode(&items);

    Ok(OrderFinanceView {
        order_id: order_id.to_string(),
        order_amount_cents: order.amount_cents,
        plan_mode: mode,
        plan_items: items,
        plan_total_cents,
        plan_matches_order: order.amount_cents == Some(plan_total_cents) && plan_total_cents > 0,
        records,
        voided_records,
        gross_received_cents,
        fee_total_cents,
        net_received_cents: gross_received_cents - fee_total_cents,
        refunds,
        voided_refunds,
        refund_total_cents,
        net_retained_cents: gross_received_cents - fee_total_cents - refund_total_cents,
        cancelled,
        remaining_cents: order
            .amount_cents
            .map(|total| (total - gross_received_cents).max(0)),
        over_received_cents: order
            .amount_cents
            .map(|total| (gross_received_cents - total).max(0))
            .unwrap_or(0),
        unrecorded: plan_is_empty && all_records_is_empty(conn, order_id)?,
        has_records_without_plan: plan_total_cents == 0 && gross_received_cents > 0,
    })
}

fn all_records_is_empty(conn: &Connection, order_id: &str) -> AppResult<bool> {
    let rows: i64 = conn.query_row(
        "SELECT COUNT(*) FROM payment_records WHERE order_id = ?1",
        [order_id],
        |r| r.get(0),
    )?;
    Ok(rows == 0)
}

// ======================================================================
// 退款：真实资金流出，独立成表
//
// 三件事必须分清：
// - **作废**：原收款录错了，这笔钱从来没进来。
// - **退款**：钱确实进来了，后来又退回去了。
// - 因此退款不能写成负数流水，也不能拿「作废原收款」冒充。
// ======================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundView {
    pub id: String,
    pub order_id: String,
    pub payment_record_id: Option<String>,
    pub amount_cents: i64,
    pub refunded_on: String,
    pub method: Option<String>,
    pub note: Option<String>,
    pub voided_at: Option<String>,
    pub void_reason: Option<String>,
    pub created_at: String,
    /// 未关联原收款：系统核验不了「还能退多少」，界面必须提示。
    pub unmatched: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefundInput {
    pub order_id: String,
    /// 可选。历史订单可能根本没录过收款，但退款确实发生了。
    pub payment_record_id: Option<String>,
    pub amount_cents: i64,
    pub refunded_on: String,
    pub method: Option<String>,
    pub note: Option<String>,
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRefundInput {
    pub id: String,
    pub payment_record_id: Option<String>,
    pub amount_cents: i64,
    pub refunded_on: String,
    pub method: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoidRefundInput {
    pub id: String,
    pub reason: String,
}

const REFUND_COLUMNS: &str = "id, order_id, payment_record_id, amount_cents, refunded_on,
     method, note, voided_at, void_reason, created_at";

fn refund_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RefundView> {
    let payment_record_id: Option<String> = row.get("payment_record_id")?;
    Ok(RefundView {
        id: row.get("id")?,
        order_id: row.get("order_id")?,
        unmatched: payment_record_id.is_none(),
        payment_record_id,
        amount_cents: row.get("amount_cents")?,
        refunded_on: row.get("refunded_on")?,
        method: row.get("method")?,
        note: row.get("note")?,
        voided_at: row.get("voided_at")?,
        void_reason: row.get("void_reason")?,
        created_at: row.get("created_at")?,
    })
}

fn refunds_of(conn: &Connection, order_id: &str) -> AppResult<Vec<RefundView>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {REFUND_COLUMNS} FROM refund_records
          WHERE order_id = ?1
          ORDER BY refunded_on DESC, created_at DESC, id DESC"
    ))?;
    let rows = stmt.query_map([order_id], refund_row)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn load_refund(conn: &Connection, id: &str) -> AppResult<RefundView> {
    conn.query_row(
        &format!("SELECT {REFUND_COLUMNS} FROM refund_records WHERE id = ?1"),
        [id],
        refund_row,
    )
    .optional()?
    .ok_or_else(|| AppError::not_found("退款记录不存在"))
}

/// 退款日期：真实、不得晚于今天。历史补录不设下限。
fn refund_date(conn: &Connection, raw: &str) -> AppResult<String> {
    let parsed = timezone::parse_calendar_date(raw)?;
    let tz = settings::working_timezone(conn)?;
    if parsed > timezone::local_today(tz) {
        return Err(AppError::invalid("退款日期不能晚于今天"));
    }
    Ok(parsed.format("%Y-%m-%d").to_string())
}

fn clean_payment_link(raw: &Option<String>) -> Option<String> {
    raw.as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// 退款额度校验：`原收款金额 − 其它有效退款合计` 就是还能退的上限。
///
/// `skip_id` 用于编辑时把自己排除掉。数据库有同样的触发器，
/// 这里先算一遍只是为了给出可读的中文错误。
fn assert_refundable(
    conn: &Connection,
    payment_id: &str,
    order_id: &str,
    amount_cents: i64,
    skip_id: Option<&str>,
) -> AppResult<()> {
    let (owner, paid, voided): (String, i64, Option<String>) = conn
        .query_row(
            "SELECT order_id, amount_cents, voided_at FROM payment_records WHERE id = ?1",
            [payment_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("关联的收款记录不存在"))?;
    if owner != order_id {
        return Err(AppError::invalid("退款与原收款不属于同一订单"));
    }
    if voided.is_some() {
        return Err(AppError::conflict("不能关联已作废的收款记录"));
    }
    let already: i64 = conn.query_row(
        "SELECT COALESCE(SUM(amount_cents), 0) FROM refund_records
          WHERE payment_record_id = ?1 AND voided_at IS NULL AND id IS NOT ?2",
        params![payment_id, skip_id.unwrap_or("")],
        |r| r.get(0),
    )?;
    if already + amount_cents > paid {
        return Err(AppError::invalid(format!(
            "累计退款超过原收款金额（可退 {} 元，本次 {} 元）",
            yuan(paid - already),
            yuan(amount_cents)
        )));
    }
    Ok(())
}

/// 单条退款的校验 + 写入。可在事务内复用（订单取消时与取消同事务）。
pub fn insert_refund(conn: &Connection, input: &RefundInput) -> AppResult<RefundView> {
    visibility::require_visible_order(conn, &input.order_id)?;
    check_amount(input.amount_cents)?;
    let refunded_on = refund_date(conn, &input.refunded_on)?;
    let method = clean_method(&input.method)?;
    let note = clean_note(&input.note)?;
    let request_id = clean_request_id(&input.request_id)?;

    if let Some(rid) = &request_id {
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM refund_records WHERE request_id = ?1",
                [rid],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = existing {
            return load_refund(conn, &id);
        }
    }

    let payment_record_id = clean_payment_link(&input.payment_record_id);
    if let Some(pid) = &payment_record_id {
        assert_refundable(conn, pid, &input.order_id, input.amount_cents, None)?;
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = timezone::now_timestamp();
    conn.execute(
        "INSERT INTO refund_records
           (id, order_id, payment_record_id, amount_cents, refunded_on,
            method, note, request_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            input.order_id,
            payment_record_id,
            input.amount_cents,
            refunded_on,
            method,
            note,
            request_id,
            now
        ],
    )?;
    load_refund(conn, &id)
}

pub fn create_refund(conn: &mut Connection, input: &RefundInput) -> AppResult<RefundView> {
    insert_refund(conn, input)
}

pub fn update_refund(conn: &mut Connection, input: &UpdateRefundInput) -> AppResult<RefundView> {
    let current = load_refund(conn, &input.id)?;
    if current.voided_at.is_some() {
        return Err(AppError::conflict("已作废的退款记录不能再修改"));
    }
    visibility::require_visible_order(conn, &current.order_id)?;
    check_amount(input.amount_cents)?;
    let refunded_on = refund_date(conn, &input.refunded_on)?;
    let method = clean_method(&input.method)?;
    let note = clean_note(&input.note)?;

    let payment_record_id = clean_payment_link(&input.payment_record_id);
    if let Some(pid) = &payment_record_id {
        assert_refundable(
            conn,
            pid,
            &current.order_id,
            input.amount_cents,
            Some(&current.id),
        )?;
    }

    conn.execute(
        "UPDATE refund_records
            SET payment_record_id = ?1, amount_cents = ?2, refunded_on = ?3,
                method = ?4, note = ?5
          WHERE id = ?6",
        params![
            payment_record_id,
            input.amount_cents,
            refunded_on,
            method,
            note,
            current.id
        ],
    )?;
    load_refund(conn, &current.id)
}

pub fn void_refund(conn: &mut Connection, input: &VoidRefundInput) -> AppResult<RefundView> {
    let current = load_refund(conn, &input.id)?;
    if current.voided_at.is_some() {
        return Err(AppError::conflict("该退款记录已经作废"));
    }
    visibility::require_visible_order(conn, &current.order_id)?;
    let reason = input.reason.trim();
    if reason.is_empty() {
        return Err(AppError::invalid("作废原因不能为空"));
    }
    if reason.chars().count() > 500 {
        return Err(AppError::invalid("作废原因过长"));
    }
    let now = timezone::now_timestamp();
    conn.execute(
        "UPDATE refund_records SET voided_at = ?1, void_reason = ?2 WHERE id = ?3",
        params![now, reason, current.id],
    )?;
    load_refund(conn, &current.id)
}
