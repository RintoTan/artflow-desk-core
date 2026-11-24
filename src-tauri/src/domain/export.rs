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
    /// 订单 ID：只用于导出时回查财务数据，不写进 CSV。
    pub id: String,
    pub code: String,
    pub title: String,
    pub client_name: Option<String>,
    /// 原始状态（`active` / `complete` / `cancelled`），不因进回收站而改写。
    pub status: String,
    pub created_at: String,
    pub planned_delivery_date: Option<String>,
    pub current_stage_title: Option<String>,
    pub amount_cents: Option<i64>,
    /// 该行是否来自回收站。只有 `include_trashed` 时可能为真。
    pub deleted: bool,
}

fn status_label(raw: &str) -> &'static str {
    match raw {
        "active" => "活动",
        "complete" => "已完成",
        "cancelled" => "已取消",
        _ => "未知",
    }
}

/// CSV 的状态文案。回收站行写作「已删除 · 原状态」，不改 `status` 列本身。
fn csv_status(row: &OrderExportRow) -> String {
    if row.deleted {
        format!("已删除 · {}", status_label(&row.status))
    } else {
        status_label(&row.status).to_string()
    }
}

/// 读取要导出的订单。
///
/// `order_ids` 为空表示全部；`include_trashed` 决定是否把回收站订单也纳入。
/// 默认 `false`：业务导出只看有效订单，与列表口径一致。
pub fn collect_orders(
    conn: &Connection,
    order_ids: &[String],
    include_trashed: bool,
) -> AppResult<Vec<OrderExportRow>> {
    // 视图与基表列同名，只有 `deleted_at` 是基表独有；因此按需拼表名，
    // 而不是写两份几乎相同的 SQL。
    let table = if include_trashed {
        "orders"
    } else {
        "orders_visible"
    };

    type RawRow = (
        String,
        String,
        String,
        Option<String>,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
    );

    let map_row = |r: &rusqlite::Row<'_>| -> rusqlite::Result<RawRow> {
        Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
            r.get(6)?,
            r.get(7)?,
            r.get(8)?,
            r.get(9)?,
        ))
    };

    let sql_base = format!(
        "SELECT o.id, o.code, o.title, c.display_name, o.status, o.created_at,
                o.planned_delivery_date,
                (SELECT s.title FROM order_stages s
                  WHERE s.order_id = o.id AND s.stage_id = o.current_stage_id),
                o.amount_cents, o.deleted_at
         FROM {table} o LEFT JOIN clients c ON c.id = o.client_id"
    );

    let rows: Vec<RawRow> = if order_ids.is_empty() {
        let mut stmt = conn.prepare(&format!("{sql_base} ORDER BY o.created_at, o.code"))?;
        let rows: Vec<_> = stmt.query_map([], map_row)?.collect::<Result<Vec<_>, _>>()?;
        rows
    } else {
        let mut stmt = conn.prepare(&format!("{sql_base} WHERE o.id = ?1"))?;
        let mut out = Vec::new();
        for id in order_ids {
            out.push(stmt.query_row([id], map_row)?);
        }
        out
    };

    Ok(rows
        .into_iter()
        .map(
            |(id, code, title, client_name, status, created_at, delivery, stage, amount, deleted_at)| {
                OrderExportRow {
                    id,
                    code,
                    title,
                    client_name,
                    status,
                    created_at,
                    planned_delivery_date: delivery,
                    current_stage_title: stage,
                    amount_cents: amount,
                    deleted: deleted_at.is_some(),
                }
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
        // ---- 以下为财务字段，追加在原有列之后，原有列顺序一律不动 ----
        text("付款计划模式"),
        text("计划项数"),
        text("计划合计（元）"),
        text("付款计划摘要"),
        text("实际到账（元）"),
        text("平台手续费（元）"),
        text("净到账（元）"),
        text("实际退款（元）"),
        text("净留存（元）"),
        text("待收款（元）"),
        text("超额收款（元）"),
        text("收款信息状态"),
        text("计划匹配状态"),
    ]));

    for row in rows {
        // 与订单详情共用同一份派生结果，避免 CSV 里出现另一套算法。
        let finance = OrderFinanceCells::build(conn, row)?;
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
            text(csv_status(row)),
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
            finance.plan_mode_cell(),
            finance.plan_items_cell(),
            finance.plan_total_cell(),
            finance.plan_summary_cell(),
            finance.gross_cell(),
            finance.fee_cell(),
            finance.net_cell(),
            finance.refund_cell(),
            finance.retained_cell(),
            finance.remaining_cell(),
            finance.over_cell(),
            finance.record_state_cell(),
            finance.plan_match_cell(),
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

// ------------------------------------------------------ FIN-06 财务列

/// 订单 CSV 末尾那 13 列的取值。
///
/// 直接复用 `finance::snapshot`：订单详情怎么算，导出就怎么算。
/// 已取消订单在财务统计里被排除，这里也把金额列留空，只保留状态说明——
/// 否则 CSV 上会出现一行「已取消」却带着到账金额的数字。
struct OrderFinanceCells {
    /// 金额列是否整段留空：已取消（不计入统计）或已进回收站（没有快照可读）。
    blank: bool,
    state_text: &'static str,
    unrecorded: bool,
    plan_mode: &'static str,
    plan_items: i64,
    plan_total: Option<i64>,
    plan_summary: Option<String>,
    gross: i64,
    fee: i64,
    net: i64,
    refund: i64,
    retained: i64,
    remaining: Option<i64>,
    over: i64,
    plan_matches: bool,
    has_plan: bool,
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "full" => "全款",
        "deposit" => "定金",
        "installment" => "分期款",
        "final" => "尾款",
        _ => "其他",
    }
}

fn plan_status_label(status: &str) -> &'static str {
    match status {
        "settled" => "已收齐",
        "partial" => "部分收款",
        "overdue" => "逾期未收",
        _ => "未收",
    }
}

impl OrderFinanceCells {
    fn build(conn: &Connection, row: &OrderExportRow) -> AppResult<Self> {
        // 回收站里的订单不在 `orders_visible` 里，没有可读的财务快照；
        // 它们在统计里本来也不该出现，所以整段留空并说明原因。
        if row.deleted {
            return Ok(Self {
                blank: true,
                state_text: "回收站，金额统计排除",
                unrecorded: false,
                plan_mode: "未设置",
                plan_items: 0,
                plan_total: None,
                plan_summary: None,
                gross: 0,
                fee: 0,
                net: 0,
                refund: 0,
                retained: 0,
                remaining: None,
                over: 0,
                plan_matches: false,
                has_plan: false,
            });
        }
        let snapshot = crate::domain::finance::snapshot(conn, &row.id)?;
        let has_plan = !snapshot.plan_items.is_empty();
        let summary = if has_plan {
            Some(
                snapshot
                    .plan_items
                    .iter()
                    .map(|item| {
                        let when = item
                            .expected_date
                            .clone()
                            .map(|date| date.to_string())
                            .unwrap_or_else(|| "未安排".to_string());
                        format!(
                            "{} ¥{}（{}，{}）",
                            kind_label(&item.kind),
                            stats::cents_to_yuan(item.amount_cents),
                            when,
                            plan_status_label(item.status)
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("；"),
            )
        } else {
            None
        };
        Ok(Self {
            blank: snapshot.cancelled,
            state_text: if snapshot.cancelled {
                "已取消，金额统计排除"
            } else if snapshot.unrecorded {
                "未记录收款信息"
            } else {
                "已有收款记录"
            },
            unrecorded: snapshot.unrecorded,
            plan_mode: match snapshot.plan_mode {
                "full" => "全款",
                "deposit_final" => "定金 + 尾款",
                "installment" => "分期",
                "mixed" => "混合",
                _ => "未设置",
            },
            plan_items: snapshot.plan_items.len() as i64,
            plan_total: has_plan.then_some(snapshot.plan_total_cents),
            plan_summary: summary,
            gross: snapshot.gross_received_cents,
            fee: snapshot.fee_total_cents,
            net: snapshot.net_received_cents,
            refund: snapshot.refund_total_cents,
            retained: snapshot.net_retained_cents,
            remaining: if snapshot.cancelled || snapshot.unrecorded {
                None
            } else {
                snapshot.remaining_cents
            },
            over: snapshot.over_received_cents,
            plan_matches: snapshot.plan_matches_order,
            has_plan,
        })
    }

    fn money(&self, cents: i64) -> Cell {
        if self.blank {
            Cell::Empty
        } else {
            Cell::Money(cents)
        }
    }

    fn plan_mode_cell(&self) -> Cell {
        if self.blank {
            Cell::Empty
        } else {
            text(self.plan_mode)
        }
    }

    fn plan_items_cell(&self) -> Cell {
        if self.blank || !self.has_plan {
            Cell::Empty
        } else {
            Cell::Integer(self.plan_items)
        }
    }

    fn plan_total_cell(&self) -> Cell {
        match (self.blank, self.plan_total) {
            (false, Some(cents)) => Cell::Money(cents),
            _ => Cell::Empty,
        }
    }

    fn plan_summary_cell(&self) -> Cell {
        match (self.blank, &self.plan_summary) {
            (false, Some(summary)) => text(summary.clone()),
            _ => Cell::Empty,
        }
    }

    fn gross_cell(&self) -> Cell {
        self.money(self.gross)
    }

    fn fee_cell(&self) -> Cell {
        self.money(self.fee)
    }

    fn net_cell(&self) -> Cell {
        self.money(self.net)
    }

    fn refund_cell(&self) -> Cell {
        self.money(self.refund)
    }

    fn retained_cell(&self) -> Cell {
        self.money(self.retained)
    }

    fn remaining_cell(&self) -> Cell {
        match (self.blank, self.unrecorded, self.remaining) {
            (true, _, _) | (_, true, _) => Cell::Empty,
            (_, _, Some(cents)) => Cell::Money(cents),
            _ => Cell::Empty,
        }
    }

    fn over_cell(&self) -> Cell {
        match (self.blank, self.unrecorded) {
            (true, _) | (_, true) => Cell::Empty,
            _ => Cell::Money(self.over),
        }
    }

    fn record_state_cell(&self) -> Cell {
        text(self.state_text)
    }

    fn plan_match_cell(&self) -> Cell {
        if self.blank {
            Cell::Empty
        } else if !self.has_plan {
            text("未设置付款计划")
        } else if self.plan_matches {
            text("一致")
        } else {
            text("与订单金额不一致")
        }
    }
}

// ------------------------------------------------ FIN-06 财务统计 CSV

fn range_label(range: StatsRange) -> &'static str {
    match range {
        StatsRange::ThisMonth => "本月",
        StatsRange::Last6 => "近 6 个月",
        StatsRange::Last12 => "近 12 个月",
        StatsRange::All => "全部",
    }
}

/// 财务统计汇总 CSV：分区结构与页面一一对应，金额口径不另算。
pub fn finance_stats_csv(conn: &Connection, range: StatsRange) -> AppResult<Vec<u8>> {
    let report = crate::domain::finance_stats::report(conn, range)?;
    let tz = timezone::parse(&report.timezone).unwrap_or(chrono_tz::Tz::UTC);

    let mut body = String::from(BOM);
    body.push_str(&line(&[text("ArtFlow miniDesk 财务统计")]));
    body.push_str(&line(&[text("统计范围"), text(range_label(range))]));
    body.push_str(&line(&[
        text("月份区间"),
        text(format!("{} ~ {}", report.from_month, report.to_month)),
    ]));
    body.push_str(&line(&[text("工作时区"), text(report.timezone.clone())]));
    body.push_str(&line(&[text("币种"), text("CNY")]));
    body.push_str(&line(&[
        text("导出时间"),
        text(timezone::to_local_string(&timezone::now_timestamp(), tz)),
    ]));
    body.push_str(&line(&[
        text("隐私说明"),
        text("不包含客户联系方式、私人备注、收款备注与任何附件或系统路径"),
    ]));
    body.push_str(LINE_ENDING);

    body.push_str(&line(&[text("A. 累计财务（全部历史）")]));
    body.push_str(&line(&[
        text("累计实际到账"),
        Cell::Money(report.lifetime.gross_received_cents),
    ]));
    body.push_str(&line(&[
        text("累计平台手续费"),
        Cell::Money(report.lifetime.fee_total_cents),
    ]));
    body.push_str(&line(&[
        text("累计净到账"),
        Cell::Money(report.lifetime.net_received_cents),
    ]));
    body.push_str(&line(&[
        text("累计实际退款"),
        Cell::Money(report.lifetime.refund_total_cents),
    ]));
    body.push_str(&line(&[
        text("累计净留存"),
        Cell::Money(report.lifetime.net_retained_cents),
    ]));
    body.push_str(LINE_ENDING);

    body.push_str(&line(&[text("B. 当前财务状态")]));
    body.push_str(&line(&[text("待收款"), Cell::Money(report.current.remaining_cents)]));
    body.push_str(&line(&[
        text("超额收款"),
        Cell::Money(report.current.over_received_cents),
    ]));
    body.push_str(&line(&[
        text("未记录收款信息订单数"),
        Cell::Integer(report.current.unrecorded_orders),
    ]));
    body.push_str(&line(&[
        text("未知金额订单数"),
        Cell::Integer(report.current.unknown_amount_orders),
    ]));
    body.push_str(&line(&[
        text("计划与总额不一致订单数"),
        Cell::Integer(report.current.plan_mismatch_orders),
    ]));
    body.push_str(LINE_ENDING);

    body.push_str(&line(&[text("C. 所选区间合计")]));
    body.push_str(&line(&[text("实际到账"), Cell::Money(report.period.gross_received_cents)]));
    body.push_str(&line(&[text("平台手续费"), Cell::Money(report.period.fee_total_cents)]));
    body.push_str(&line(&[text("净到账"), Cell::Money(report.period.net_received_cents)]));
    body.push_str(&line(&[text("实际退款"), Cell::Money(report.period.refund_total_cents)]));
    body.push_str(&line(&[text("净留存"), Cell::Money(report.period.net_retained_cents)]));
    body.push_str(LINE_ENDING);

    body.push_str(&line(&[text("D. 月度现金流")]));
    body.push_str(&line(&[
        text("月份"),
        text("实际到账（元）"),
        text("平台手续费（元）"),
        text("净到账（元）"),
        text("实际退款（元）"),
        text("净留存（元）"),
    ]));
    for month in &report.monthly {
        body.push_str(&line(&[
            text(month.month.clone()),
            Cell::Money(month.gross_received_cents),
            Cell::Money(month.fee_total_cents),
            Cell::Money(month.net_received_cents),
            Cell::Money(month.refund_total_cents),
            Cell::Money(month.net_retained_cents),
        ]));
    }
    body.push_str(LINE_ENDING);

    body.push_str(&line(&[text("E. 年度净到账")]));
    body.push_str(&line(&[
        text("年份"),
        text("实际到账（元）"),
        text("平台手续费（元）"),
        text("净到账（元）"),
    ]));
    for year in &report.annual {
        body.push_str(&line(&[
            text(year.year.clone()),
            Cell::Money(year.gross_received_cents),
            Cell::Money(year.fee_total_cents),
            Cell::Money(year.net_received_cents),
        ]));
    }
    body.push_str(LINE_ENDING);

    body.push_str(&line(&[text("F. 预计收款")]));
    body.push_str(&line(&[text("已逾期"), Cell::Money(report.expected.overdue_cents)]));
    body.push_str(&line(&[
        text("未安排日期"),
        Cell::Money(report.expected.unscheduled_cents),
    ]));
    body.push_str(&line(&[
        text("更远期计划"),
        Cell::Money(report.expected.beyond_cents),
    ]));
    body.push_str(&line(&[
        text("没有付款计划的订单数"),
        Cell::Integer(report.expected.no_plan_orders),
    ]));
    body.push_str(&line(&[text("预计月份"), text("金额（元）"), text("笔数")]));
    for month in &report.expected.months {
        body.push_str(&line(&[
            text(month.month.clone()),
            Cell::Money(month.amount_cents),
            Cell::Integer(month.count),
        ]));
    }
    body.push_str(LINE_ENDING);

    body.push_str(&line(&[text("G1. 按接单平台")]));
    body.push_str(&line(&[
        text("平台"),
        text("笔数"),
        text("实际到账（元）"),
        text("平台手续费（元）"),
        text("净到账（元）"),
    ]));
    for row in &report.by_platform {
        body.push_str(&line(&[
            match &row.platform_name {
                Some(name) => text(name.clone()),
                None => text("未记录平台"),
            },
            Cell::Integer(row.count),
            Cell::Money(row.gross_received_cents),
            Cell::Money(row.fee_total_cents),
            Cell::Money(row.net_received_cents),
        ]));
    }
    body.push_str(LINE_ENDING);

    body.push_str(&line(&[text("G2. 按付款方式")]));
    body.push_str(&line(&[
        text("付款方式"),
        text("笔数"),
        text("实际到账（元）"),
        text("平台手续费（元）"),
        text("净到账（元）"),
    ]));
    for row in &report.by_method {
        let label = match row.method.as_deref() {
            Some("wechat") => "微信",
            Some("alipay") => "支付宝",
            Some("bank") => "银行卡",
            Some("cash") => "现金",
            Some("other") => "其他",
            _ => "未记录方式",
        };
        body.push_str(&line(&[
            text(label),
            Cell::Integer(row.count),
            Cell::Money(row.gross_received_cents),
            Cell::Money(row.fee_total_cents),
            Cell::Money(row.net_received_cents),
        ]));
    }
    body.push_str(LINE_ENDING);

    body.push_str(&line(&[text("G3. 按委托类型")]));
    body.push_str(&line(&[
        text("委托类型"),
        text("订单数"),
        text("订单金额（元）"),
        text("未知金额订单数"),
        text("实际到账（元）"),
        text("平台手续费（元）"),
        text("实际退款（元）"),
        text("净留存（元）"),
    ]));
    for row in &report.by_order_type {
        body.push_str(&line(&[
            match &row.order_type {
                Some(kind) => text(kind.clone()),
                None => text("未分类"),
            },
            Cell::Integer(row.orders),
            Cell::Money(row.order_amount_cents),
            Cell::Integer(row.unknown_amount_orders),
            Cell::Money(row.gross_received_cents),
            Cell::Money(row.fee_total_cents),
            Cell::Money(row.refund_total_cents),
            Cell::Money(row.net_retained_cents),
        ]));
    }
    body.push_str(LINE_ENDING);

    body.push_str(&line(&[text("G4. 按客户（累计）")]));
    body.push_str(&line(&[
        text("客户"),
        text("订单数"),
        text("累计委托金额（元）"),
        text("未知金额订单数"),
        text("实际到账（元）"),
        text("平台手续费（元）"),
        text("净到账（元）"),
        text("实际退款（元）"),
        text("净留存（元）"),
        text("待收款（元）"),
        text("超额收款（元）"),
        text("未记录收款信息订单数"),
    ]));
    for row in &report.by_client {
        body.push_str(&line(&[
            text(row.display_name.clone()),
            Cell::Integer(row.orders),
            Cell::Money(row.order_amount_cents),
            Cell::Integer(row.unknown_amount_orders),
            Cell::Money(row.gross_received_cents),
            Cell::Money(row.fee_total_cents),
            Cell::Money(row.net_received_cents),
            Cell::Money(row.refund_total_cents),
            Cell::Money(row.net_retained_cents),
            Cell::Money(row.remaining_cents),
            Cell::Money(row.over_received_cents),
            Cell::Integer(row.unrecorded_orders),
        ]));
    }
    body.push_str(LINE_ENDING);

    body.push_str(&line(&[text("H. 口径说明")]));
    for note in &report.basis {
        body.push_str(&line(&[text(note.clone())]));
    }
    body.push_str(&line(&[text(
        "订单总额是合同金额，不等于实际到账；净到账已扣除实际手续费；净留存已扣除实际退款；两者都不是利润。",
    )]));
    body.push_str(&line(&[text(
        "已取消订单不进入任何金额统计；NULL 订单金额不按 0 元处理，单独计数。",
    )]));

    Ok(body.into_bytes())
}

/// 收款流水 CSV：原始记录，含作废行。不是统计报表。
pub fn payments_csv(conn: &Connection) -> AppResult<Vec<u8>> {
    let tz_name: String = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'working_timezone'",
            [],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "UTC".to_string());
    let tz = timezone::parse(&tz_name).unwrap_or(chrono_tz::Tz::UTC);

    let mut body = String::from(BOM);
    body.push_str(&line(&[text("ArtFlow miniDesk 收款流水")]));
    body.push_str(&line(&[text("说明"), text("原始记录明细，包含已作废流水；作废流水不进入财务统计")]));
    body.push_str(&line(&[text("工作时区"), text(tz.name().to_string())]));
    body.push_str(&line(&[
        text("导出时间"),
        text(timezone::to_local_string(&timezone::now_timestamp(), tz)),
    ]));
    body.push_str(&line(&[
        text("隐私说明"),
        text("不包含客户联系方式、客户备注、订单备注与收款备注"),
    ]));
    body.push_str(LINE_ENDING);

    body.push_str(&line(&[
        text("订单编号"),
        text("委托名称"),
        text("客户"),
        text("订单状态"),
        text("收款类型"),
        text("收款日期"),
        text("收款金额（元）"),
        text("收款平台"),
        text("手续费率（%）"),
        text("实际手续费（元）"),
        text("净到账（元）"),
        text("收款方式"),
        text("关联计划类型"),
        text("计划预计日期"),
        text("流水状态"),
        text("作废日期"),
        text("作废原因"),
    ]));

    let mut stmt = conn.prepare(
        "SELECT o.code, o.title, c.display_name, o.status,
                r.kind, r.received_on, r.amount_cents, r.platform_name,
                r.fee_rate_bp, r.fee_cents, r.method,
                s.kind, s.expected_date,
                r.voided_at, r.void_reason
           FROM payment_records r
           JOIN orders_visible o ON o.id = r.order_id
           LEFT JOIN clients_visible c ON c.id = o.client_id
           LEFT JOIN payment_schedules s ON s.id = r.schedule_id
          ORDER BY r.received_on, o.code, r.created_at",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, i64>(6)?,
            r.get::<_, Option<String>>(7)?,
            r.get::<_, Option<i64>>(8)?,
            r.get::<_, i64>(9)?,
            r.get::<_, Option<String>>(10)?,
            r.get::<_, Option<String>>(11)?,
            r.get::<_, Option<String>>(12)?,
            r.get::<_, Option<String>>(13)?,
            r.get::<_, Option<String>>(14)?,
        ))
    })?;

    for row in rows {
        let (
            code,
            title,
            client,
            status,
            kind,
            received_on,
            amount,
            platform,
            rate_bp,
            fee,
            method,
            schedule_kind,
            expected_date,
            voided_at,
            void_reason,
        ) = row?;
        let rate_cell = match rate_bp {
            Some(bp) => Cell::Text(format!("{}.{:02}", bp / 100, bp % 100)),
            None => Cell::Empty,
        };
        body.push_str(&line(&[
            text(code),
            text(title),
            match client {
                Some(name) => text(name),
                None => Cell::Empty,
            },
            text(status_label(&status)),
            text(kind_label(&kind)),
            text(received_on),
            Cell::Money(amount),
            match platform {
                Some(name) => text(name),
                None => text("未记录平台"),
            },
            rate_cell,
            Cell::Money(fee),
            Cell::Money(amount - fee),
            match method.as_deref() {
                Some("wechat") => text("微信"),
                Some("alipay") => text("支付宝"),
                Some("bank") => text("银行卡"),
                Some("cash") => text("现金"),
                Some("other") => text("其他"),
                _ => Cell::Empty,
            },
            match schedule_kind {
                Some(kind) => text(kind_label(&kind)),
                None => Cell::Empty,
            },
            match expected_date {
                Some(date) => text(date),
                None => Cell::Empty,
            },
            text(if voided_at.is_some() { "已作废" } else { "有效" }),
            match &voided_at {
                Some(at) => text(timezone::to_local_string(at, tz)),
                None => Cell::Empty,
            },
            match void_reason {
                Some(reason) => text(reason),
                None => Cell::Empty,
            },
        ]));
    }

    Ok(body.into_bytes())
}
