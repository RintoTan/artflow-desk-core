//! FIN-06：客户维度财务汇总。
//!
//! 聚合身份只有一个：`clients.id`。两个都叫「小明」的客户就是两个客户，
//! 按名字 GROUP BY 会把两个人的钱并成一个，且事后无法拆开。
//!
//! 计算方式刻意避开「一条大 SQL 把订单、收款、退款 JOIN 在一起」：
//! 那样一个订单有两笔收款、一笔退款就会把订单金额和退款各放大一遍。
//! 这里先按 `order_id` 各自汇总，再在 Rust 里按客户累加——口径和订单详情完全一致：
//! 待收与超额都是**逐单**取正负之后才汇总。

use std::collections::HashMap;

use rusqlite::Connection;
use serde::Serialize;

use crate::error::AppResult;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClientFinance {
    pub client_id: String,
    pub display_name: String,
    pub orders: i64,
    /// 累计委托金额：当前订单金额之和，不含 NULL、不含取消单。
    pub order_amount_cents: i64,
    pub unknown_amount_orders: i64,
    pub gross_received_cents: i64,
    pub fee_total_cents: i64,
    pub net_received_cents: i64,
    pub refund_total_cents: i64,
    pub net_retained_cents: i64,
    pub remaining_cents: i64,
    pub over_received_cents: i64,
    /// 既没有付款计划也没有收款流水——不代表客户没付钱。
    pub unrecorded_orders: i64,
}

#[derive(Default, Clone)]
struct OrderMoney {
    amount: Option<i64>,
    gross: i64,
    fee: i64,
    refund: i64,
    has_plan: bool,
    has_record: bool,
}

/// 按订单汇总一次，避免多表 JOIN 造成的放大。
fn orders_by_client(conn: &Connection) -> AppResult<HashMap<String, Vec<(String, OrderMoney)>>> {
    let mut payments: HashMap<String, (i64, i64)> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT order_id, SUM(amount_cents), SUM(fee_cents)
               FROM payment_records WHERE voided_at IS NULL GROUP BY order_id",
        )?;
        for row in stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
        })? {
            let (id, gross, fee) = row?;
            payments.insert(id, (gross, fee));
        }
    }

    let mut refunds: HashMap<String, i64> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT order_id, SUM(amount_cents)
               FROM refund_records WHERE voided_at IS NULL GROUP BY order_id",
        )?;
        for row in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
            let (id, total) = row?;
            refunds.insert(id, total);
        }
    }

    let mut plans: HashMap<String, bool> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT DISTINCT order_id FROM payment_schedules")?;
        for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
            plans.insert(row?, true);
        }
    }

    let mut out: HashMap<String, Vec<(String, OrderMoney)>> = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT o.id, o.client_id, o.amount_cents
           FROM orders_visible o
          WHERE o.status <> 'cancelled' AND o.client_id IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<i64>>(2)?,
        ))
    })?;
    for row in rows {
        let (order_id, client_id, amount) = row?;
        let (gross, fee) = payments.get(&order_id).copied().unwrap_or((0, 0));
        let money = OrderMoney {
            amount,
            gross,
            fee,
            refund: refunds.get(&order_id).copied().unwrap_or(0),
            has_plan: plans.contains_key(&order_id),
            has_record: payments.contains_key(&order_id)
                || refunds.contains_key(&order_id)
                || has_any_record(conn, &order_id)?,
        };
        out.entry(client_id).or_default().push((order_id, money));
    }
    Ok(out)
}

/// 作废流水也算「有记录」——否则一笔只录过错账的订单会被说成「未记录收款信息」。
fn has_any_record(conn: &Connection, order_id: &str) -> AppResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM payment_records WHERE order_id = ?1)",
        [order_id],
        |r| r.get(0),
    )?;
    Ok(count == 1)
}

fn build(client_id: &str, display_name: &str, orders: &[(String, OrderMoney)]) -> ClientFinance {
    let mut out = ClientFinance {
        client_id: client_id.to_string(),
        display_name: display_name.to_string(),
        orders: orders.len() as i64,
        order_amount_cents: 0,
        unknown_amount_orders: 0,
        gross_received_cents: 0,
        fee_total_cents: 0,
        net_received_cents: 0,
        refund_total_cents: 0,
        net_retained_cents: 0,
        remaining_cents: 0,
        over_received_cents: 0,
        unrecorded_orders: 0,
    };
    for (_, money) in orders {
        match money.amount {
            Some(amount) => {
                out.order_amount_cents += amount;
                // 逐单取正负再汇总：先把客户所有订单加总再减，会丢掉单笔上下限。
                out.remaining_cents += (amount - money.gross).max(0);
                out.over_received_cents += (money.gross - amount).max(0);
            }
            None => out.unknown_amount_orders += 1,
        }
        out.gross_received_cents += money.gross;
        out.fee_total_cents += money.fee;
        out.refund_total_cents += money.refund;
        if !money.has_plan && !money.has_record {
            out.unrecorded_orders += 1;
        }
    }
    out.net_received_cents = out.gross_received_cents - out.fee_total_cents;
    out.net_retained_cents = out.net_received_cents - out.refund_total_cents;
    out
}

/// 全部客户的累计财务汇总（不随日期范围变化）。
pub fn all(conn: &Connection) -> AppResult<Vec<ClientFinance>> {
    let grouped = orders_by_client(conn)?;
    let mut stmt = conn.prepare("SELECT id, display_name FROM clients_visible")?;
    let clients = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut rows: Vec<ClientFinance> = clients
        .into_iter()
        .map(|(id, name)| {
            let orders = grouped.get(&id).cloned().unwrap_or_default();
            build(&id, &name, &orders)
        })
        // 没有任何有效订单的客户也列出来（全 0），这样表格和客户列表能对上。
        .collect();

    rows.sort_by(|a, b| {
        b.order_amount_cents
            .cmp(&a.order_amount_cents)
            .then_with(|| a.display_name.cmp(&b.display_name))
            .then_with(|| a.client_id.cmp(&b.client_id))
    });
    Ok(rows)
}

/// 单个客户的累计财务汇总。
pub fn summary(conn: &Connection, client_id: &str) -> AppResult<ClientFinance> {
    let display_name: String = conn
        .query_row(
            "SELECT display_name FROM clients_visible WHERE id = ?1",
            [client_id],
            |r| r.get(0),
        )
        .map_err(|_| crate::error::AppError::not_found("客户不存在或已在回收站"))?;
    let grouped = orders_by_client(conn)?;
    let orders = grouped.get(client_id).cloned().unwrap_or_default();
    Ok(build(client_id, &display_name, &orders))
}
