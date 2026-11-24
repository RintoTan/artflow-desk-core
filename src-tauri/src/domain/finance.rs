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
use crate::store::timezone;

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
