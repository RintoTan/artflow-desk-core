//! CSV 导出（只读报表，不可用于恢复或导入）。
//!
//! 三条硬要求：
//! 1. UTF-8 BOM + CRLF，保证常见表格软件打开中文不乱码；
//! 2. 严格按 RFC 4180 转义（逗号、双引号、换行）；
//! 3. **防公式注入**：文本单元格若以 `= + - @`、制表符或回车开头（允许前导空白），
//!    前置单引号使其保持文本；数字单元格不加前缀，避免破坏数值语义。

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::domain::stats::{self, StatsRange};
use crate::error::{AppError, AppResult};
use crate::store::timezone;

pub const BOM: &str = "\u{feff}";
pub const LINE_ENDING: &str = "\r\n";

/// 一行的单元格类型。类型决定是否做防注入处理。
#[derive(Debug, Clone)]
pub enum Cell {
    Text(String),
    Integer(i64),
    /// 金额，整数分，输出为两位小数的十进制字符串（不加引号、不加前缀）
    Money(i64),
    Empty,
}

fn is_dangerous_prefix(text: &str) -> bool {
    // 跳过前导空白与控制字符后再判断，防止 " =cmd" 这类绕过。
    let trimmed = text.trim_start_matches(|c: char| c.is_whitespace() || c.is_control());
    matches!(
        trimmed.chars().next(),
        Some('=') | Some('+') | Some('-') | Some('@') | Some('\t') | Some('\r')
    )
}

fn quote(raw: &str) -> String {
    if raw.contains(',') || raw.contains('"') || raw.contains('\n') || raw.contains('\r') {
        format!("\"{}\"", raw.replace('"', "\"\""))
    } else {
        raw.to_string()
    }
}

pub fn cell_to_string(cell: &Cell) -> String {
    match cell {
        Cell::Empty => String::new(),
        Cell::Integer(value) => value.to_string(),
        Cell::Money(cents) => stats::cents_to_yuan(*cents),
        Cell::Text(raw) => {
            if is_dangerous_prefix(raw) {
                quote(&format!("'{raw}"))
            } else {
                quote(raw)
            }
        }
    }
}

pub fn line(cells: &[Cell]) -> String {
    let mut out = cells.iter().map(cell_to_string).collect::<Vec<_>>().join(",");
    out.push_str(LINE_ENDING);
    out
}

fn text(raw: impl Into<String>) -> Cell {
    Cell::Text(raw.into())
}

/// 汇总 CSV：说明块 + 月度明细 + 合计。
pub fn summary_csv(conn: &Connection, range: StatsRange) -> AppResult<Vec<u8>> {
    let report = stats::report(conn, range)?;
    let mut body = String::from(BOM);

    body.push_str(&line(&[text("ArtFlow miniDesk 统计汇总")]));
    body.push_str(&line(&[
        text("统计范围"),
        text(format!("{} ~ {}", report.from_month, report.to_month)),
    ]));
    body.push_str(&line(&[
        text("工作时时区"),
        text(report.timezone.clone()),
    ]));
    body.push_str(&line(&[
        text("导出时间"),
        text(timezone::to_local_string(
            &timezone::now_timestamp(),
            timezone::parse(&report.timezone)?,
        )),
    ]));
    body.push_str(&line(&[
        text("完成统计口径"),
        text("按 completed 生命周期事件次数（同一订单多次完成计多次）"),
    ]));
    body.push_str(&line(&[
        text("金额统计口径"),
        text("按订单创建月份归属，取当前记录金额；未知金额不计入合计"),
    ]));
    body.push_str(LINE_ENDING);

    body.push_str(&line(&[
        text("月份"),
        text("新建次数"),
        text("完成次数"),
        text("取消次数"),
        text("已知金额合计（元）"),
        text("已知金额订单数"),
        text("未知金额订单数"),
    ]));

    for bucket in &report.months {
        body.push_str(&line(&[
            text(bucket.month.clone()),
            Cell::Integer(bucket.created),
            Cell::Integer(bucket.completed),
            Cell::Integer(bucket.cancelled),
            Cell::Money(bucket.amount_cents),
            Cell::Integer(bucket.known_orders),
            Cell::Integer(bucket.unknown_orders),
        ]));
    }

    body.push_str(&line(&[
        text("合计"),
        Cell::Integer(report.totals.created),
        Cell::Integer(report.totals.completed),
        Cell::Integer(report.totals.cancelled),
        Cell::Money(report.totals.amount_cents),
        Cell::Integer(report.totals.known_orders),
        Cell::Integer(report.totals.unknown_orders),
    ]));

    body.push_str(LINE_ENDING);
    for note in &report.basis {
        body.push_str(&line(&[text("口径说明"), text(note.clone())]));
    }

    Ok(body.into_bytes())
}

// ---------------------------------------------------------------- 订单明细

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderExportRow {
    pub code: String,
    pub title: String,
    pub client_name: Option<String>,
    pub status: String,
    pub created_at: String,
    pub planned_delivery_date: Option<String>,
    pub current_stage_title: Option<String>,
    pub amount_cents: Option<i64>,
}

fn status_label(raw: &str) -> &'static str {
    match raw {
        "active" => "活动",
        "complete" => "已完成",
        "cancelled" => "已取消",
        _ => "未知",
    }
}

/// 读取要导出的订单。`order_ids` 为空表示导出全部（由调用方决定 scope）。
pub fn collect_orders(conn: &Connection, order_ids: &[String]) -> AppResult<Vec<OrderExportRow>> {
    let rows: Vec<(String, String, Option<String>, String, String, Option<String>, Option<String>, Option<i64>)> = if order_ids.is_empty() {
        let mut stmt = conn.prepare(
            "SELECT o.code, o.title, c.display_name, o.status, o.created_at,
                    o.planned_delivery_date,
                    (SELECT s.title FROM order_stages s
                      WHERE s.order_id = o.id AND s.stage_id = o.current_stage_id),
                    o.amount_cents
             FROM orders_visible o LEFT JOIN clients c ON c.id = o.client_id
             ORDER BY o.created_at, o.code",
        )?;
        let rows: Vec<_> = stmt
            .query_map([], |r| {
                Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    } else {
        let mut stmt = conn.prepare(
            "SELECT o.code, o.title, c.display_name, o.status, o.created_at,
                    o.planned_delivery_date,
                    (SELECT s.title FROM order_stages s
                      WHERE s.order_id = o.id AND s.stage_id = o.current_stage_id),
                    o.amount_cents
             FROM orders_visible o LEFT JOIN clients c ON c.id = o.client_id
             WHERE o.id = ?1",
        )?;
        let mut out = Vec::new();
        for id in order_ids {
            let row = stmt.query_row([id], |r| {
                Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?,
                ))
            })?;
            out.push(row);
        }
        out
    };

    Ok(rows
        .into_iter()
        .map(
            |(code, title, client_name, status, created_at, delivery, stage, amount)| OrderExportRow {
                code,
                title,
                client_name,
                status,
                created_at,
                planned_delivery_date: delivery,
                current_stage_title: stage,
                amount_cents: amount,
            },
        )
        .collect())
}

/// 明细 CSV。**不导出**客户联系方式、备注、附件路径或任何内部系统信息。
pub fn orders_csv(
    conn: &Connection,
    rows: &[OrderExportRow],
    scope_label: &str,
) -> AppResult<Vec<u8>> {
    let tz_name = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'working_timezone'",
            [],
            |r| r.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "UTC".to_string());
    let tz = timezone::parse(&tz_name).unwrap_or(chrono_tz::Tz::UTC);

    let mut body = String::from(BOM);
    body.push_str(&line(&[text("ArtFlow miniDesk 订单明细")]));
    body.push_str(&line(&[text("导出范围"), text(scope_label)]));
    body.push_str(&line(&[text("订单条数"), Cell::Integer(rows.len() as i64)]));
    body.push_str(&line(&[text("工作时时区"), text(tz.name().to_string())]));
    body.push_str(&line(&[
        text("导出时间"),
        text(timezone::to_local_string(&timezone::now_timestamp(), tz)),
    ]));
    body.push_str(&line(&[
        text("隐私说明"),
        text("不包含客户联系方式、私人备注与任何附件或系统路径"),
    ]));
    body.push_str(LINE_ENDING);

    body.push_str(&line(&[
        text("订单编号"),
        text("标题"),
        text("客户"),
        text("状态"),
        text("创建时间"),
        text("计划交付日期"),
        text("当前阶段"),
        text("金额（元）"),
        text("金额是否未知"),
    ]));

    for row in rows {
        let amount_cell = match row.amount_cents {
            Some(cents) => Cell::Money(cents),
            None => Cell::Empty,
        };
        body.push_str(&line(&[
            text(row.code.clone()),
            text(row.title.clone()),
            match &row.client_name {
                Some(name) => text(name.clone()),
                None => Cell::Empty,
            },
            text(status_label(&row.status)),
            text(timezone::to_local_string(&row.created_at, tz)),
            match &row.planned_delivery_date {
                Some(date) => text(date.clone()),
                None => Cell::Empty,
            },
            match &row.current_stage_title {
                Some(stage) => text(stage.clone()),
                None => Cell::Empty,
            },
            amount_cell,
            text(if row.amount_cents.is_none() { "是" } else { "否" }),
        ]));
    }

    Ok(body.into_bytes())
}

// ---------------------------------------------------------------- 写盘

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub rows: i64,
    pub bytes: i64,
}

/// 先写同目录临时文件再 rename：部分写入不会留下半个报表。
pub fn write_file(target: &Path, bytes: &[u8], rows: i64) -> AppResult<ExportResult> {
    if target.as_os_str().is_empty() {
        return Err(AppError::invalid("保存路径为空"));
    }
    let parent = target
        .parent()
        .ok_or_else(|| AppError::invalid("保存路径无效"))?;
    if !parent.is_dir() {
        return Err(AppError::invalid("保存目录不存在"));
    }
    if let Ok(meta) = std::fs::symlink_metadata(target) {
        if meta.file_type().is_symlink() || meta.is_dir() {
            return Err(AppError::invalid("目标不是可覆盖的普通文件"));
        }
    }

    let temp: PathBuf = parent.join(format!(
        ".minidesk-export-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&temp, bytes)
        .map_err(|e| AppError::io(format!("写入导出文件失败：{e}")))?;
    if let Err(e) = std::fs::rename(&temp, target) {
        let _ = std::fs::remove_file(&temp);
        return Err(AppError::io(format!("保存导出文件失败：{e}")));
    }

    Ok(ExportResult {
        path: target.to_string_lossy().to_string(),
        rows,
        bytes: bytes.len() as i64,
    })
}
