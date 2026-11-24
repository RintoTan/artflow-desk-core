//! v10：财务数据三张表。
//!
//! 本步只建地基，不带任何业务逻辑：没有平台种子数据、没有付款计划、没有收款流水。
//! 旧订单的 `amount_cents` 原样保留，**不**据此推断"已收款"，也**不**生成补录记录——
//! 界面将来要显示「未记录收款信息」，而不是「未收款 ¥1000」。
//!
//! ## 为什么不给 `orders` 加列
//!
//! 订单总金额继续用既有的 `orders.amount_cents`（NULL ≠ 0）。财务数据全部在
//! 侧表里，所以本步**不需要重建** `orders_visible` / `orders_trashed` /
//! `clients_visible`——v9 踩过的「视图列冻结」这次碰不到。
//! 这也是财务（v10）与订单置顶（v11）必须分成两步的理由。
//!
//! ## 三个语义决定
//!
//! 1. **费率可空，且空 ≠ 0**。`fee_rate_bp` 允许 NULL：NULL = 没配过/不知道，
//!    `0` = 用户明确填了 0%。把两者折成 0 会让"平台还没配费率"悄悄变成
//!    "这个平台不收费"，之后所有净收入都偏高。
//! 2. **`fee_cents` 没有默认值**。实际手续费必须由写入口明确给出，不能靠
//!    `DEFAULT 0` 兜底——那等于把"没算过"记成"收了我 0 元手续费"。
//! 3. **净到账不存**。`net = amount_cents - fee_cents` 永远派生；存第三个数
//!    迟早和另两个对不上。收款状态同理，由「计划金额 vs 未作废流水」派生。
//!
//! ## 作废不是退款
//!
//! `voided_at` 只用来标记"这笔流水录错了"，不作资金流出。取消订单不改动流水行，
//! 只在统计层排除（口径另定）。因此本步没有任何退款字段或退款表。

use rusqlite::Transaction;

use crate::error::AppResult;

pub fn apply(tx: &Transaction<'_>) -> AppResult<()> {
    tx.execute_batch(
        r#"
-- 1) 接单平台与默认费率。
--    fee_rate_bp 可空：NULL = 未配置，0 = 明确零费率。单位是基点，10000 = 100%。
CREATE TABLE payment_platforms (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
  fee_rate_bp   INTEGER CHECK (fee_rate_bp IS NULL
                               OR fee_rate_bp BETWEEN 0 AND 10000),
  archived      INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  sort_position INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 名称唯一：沿用项目默认的二进制比较，不做大小写折叠。
CREATE UNIQUE INDEX payment_platforms_name ON payment_platforms(name);

-- 2) 付款计划：描述"应收"，不代表"已收"。
--    一笔计划款可以由多笔实际收款分摊；计划日期可空，不用截稿日期顶替。
CREATE TABLE payment_schedules (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('full', 'deposit', 'installment', 'final')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  expected_date TEXT CHECK (expected_date IS NULL
                            OR expected_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  sort_position INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX payment_schedules_order ON payment_schedules(order_id, sort_position);

-- 3) 收款流水：描述"实际到账"。
--    platform_name 是快照，删平台不毁历史；schedule_id 置空不删流水。
--    fee_cents 故意不给 DEFAULT：实际手续费必须显式写明。
CREATE TABLE payment_records (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  schedule_id   TEXT REFERENCES payment_schedules(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('full', 'deposit', 'installment', 'final')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  received_on   TEXT NOT NULL CHECK (received_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  platform_id   TEXT REFERENCES payment_platforms(id) ON DELETE SET NULL,
  platform_name TEXT,
  fee_rate_bp   INTEGER CHECK (fee_rate_bp IS NULL
                               OR fee_rate_bp BETWEEN 0 AND 10000),
  fee_cents     INTEGER NOT NULL CHECK (fee_cents >= 0),
  method        TEXT CHECK (method IS NULL
                            OR method IN ('wechat', 'alipay', 'bank', 'cash', 'other')),
  note          TEXT,
  voided_at     TEXT,
  void_reason   TEXT,
  request_id    TEXT UNIQUE,
  created_at    TEXT NOT NULL,
  CHECK (fee_cents <= amount_cents)
);
CREATE INDEX payment_records_order ON payment_records(order_id, received_on);
"#,
    )?;
    Ok(())
}
