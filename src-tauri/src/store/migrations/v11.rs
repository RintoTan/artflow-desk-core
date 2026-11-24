//! v11：财务三表的约束补强。
//!
//! v10 建表时留了三个口子，趁表还是空的补齐：
//!
//! 1. **类型亲和性不是约束**。`INTEGER` 只是亲和性，`1.5` 会被原样存成 REAL，
//!    `CHECK (amount_cents > 0)` 照样通过；`id TEXT PRIMARY KEY` 在 rowid 表里
//!    还允许 NULL（SQLite 的历史兼容行为）。改用 `STRICT` 之后两件事一起解决：
//!    INTEGER 列拒收 REAL，主键隐式 NOT NULL（仍然显式写出来）。
//! 2. **流水可以挂到别人订单的计划上**。`order_id` 与 `schedule_id` 两个外键各自
//!    有效，但没有约束它们属于同一订单。
//! 3. **日期只校验了形状**。`GLOB` 拦不住 `2026-02-31`。
//!
//! ## 为什么不用复合外键
//!
//! `UNIQUE(id, order_id)` + `FOREIGN KEY (schedule_id, order_id)` 确实能拦住跨订单
//! 关联，但 `ON DELETE SET NULL` 会把复合键的**两列一起**置空，`order_id` 是
//! NOT NULL，结果是「删除付款计划」直接失败——把已冻结的语义（删计划、留流水、
//! `schedule_id` 置空）破坏了。所以这里保留单列外键承担 SET NULL，另用触发器
//! 守同订单不变量。
//!
//! ## 为什么必须先断言空表
//!
//! `PRAGMA foreign_keys` 在事务内是 no-op，迁移关不掉外键；而这三张表互相引用，
//! 按「建新表→搬迁→删旧→改名」的常规套路，`DROP TABLE payment_schedules` 会触发
//! 子表 `ON DELETE SET NULL`，把已搬过去的 `schedule_id` 静默抹掉。
//!
//! 因此本步不做数据搬迁，而是**先确认三表为空再重建**。v10 至今没有任何写入入口，
//! 空是事实；万一不空，这里会响亮地失败，而不是悄悄丢数据。
//!
//! 这条断言只属于 v11 迁移，不是「重置业务数据必须清空平台」之类的新规则。

use rusqlite::Transaction;

use crate::error::{AppError, AppResult};

pub fn apply(tx: &Transaction<'_>) -> AppResult<()> {
    // 1) 空表断言：必须在任何 DDL 之前。
    let mut occupied = Vec::new();
    for table in ["payment_platforms", "payment_schedules", "payment_records"] {
        let rows: i64 = tx.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?;
        if rows != 0 {
            occupied.push(format!("{table}={rows}"));
        }
    }
    if !occupied.is_empty() {
        return Err(AppError::conflict(format!(
            "财务表在 v11 重建前必须为空，检测到 {}。本迁移不做数据搬迁，已中止且未改动任何数据",
            occupied.join("、")
        )));
    }

    tx.execute_batch(
        r#"
-- 2) 按依赖倒序删：先删子表，避免删父表时触发 SET NULL。
DROP TABLE payment_records;
DROP TABLE payment_schedules;
DROP TABLE payment_platforms;

-- 3) 重建为 STRICT：
--    STRICT 让 INTEGER 列真的只收整数，主键也隐式 NOT NULL。
--    名称同时要求「去空格后 1–40 字」与「已无首尾空格」。
CREATE TABLE payment_platforms (
  id            TEXT NOT NULL PRIMARY KEY,
  name          TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40
                                     AND name = trim(name)),
  fee_rate_bp   INTEGER CHECK (fee_rate_bp IS NULL
                               OR fee_rate_bp BETWEEN 0 AND 10000),
  archived      INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  sort_position INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX payment_platforms_name ON payment_platforms(name);

-- 日期列两道关：GLOB 管形状，date(x) IS x 管真实存在。
-- SQLite 的 date() 会把 2026-02-31 归一化成 2026-03-03，所以「回读不相等」正好能抓住溢出日。
CREATE TABLE payment_schedules (
  id            TEXT NOT NULL PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('full', 'deposit', 'installment', 'final')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  expected_date TEXT CHECK (expected_date IS NULL
                            OR (expected_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                                AND date(expected_date) IS expected_date)),
  sort_position INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
) STRICT;

CREATE INDEX payment_schedules_order ON payment_schedules(order_id, sort_position);

CREATE TABLE payment_records (
  id            TEXT NOT NULL PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  schedule_id   TEXT REFERENCES payment_schedules(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('full', 'deposit', 'installment', 'final')),
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  received_on   TEXT NOT NULL CHECK (received_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                                       AND date(received_on) IS received_on),
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
  CHECK (fee_cents <= amount_cents),
  -- 关联了平台就必须留名称快照；平台被删后 platform_id 置空，快照仍在。
  CHECK (platform_id IS NULL OR platform_name IS NOT NULL),
  -- 名称快照与 platform_id 无关，但一旦存在就不该是空字符串。
  CHECK (platform_name IS NULL OR length(trim(platform_name)) > 0)
) STRICT;

CREATE INDEX payment_records_order ON payment_records(order_id, received_on);
-- 按计划聚合已收（FIN-03 的付款计划状态计算）。
CREATE INDEX payment_records_schedule ON payment_records(schedule_id);
-- 月度现金流按实际到账日范围扫描，复合索引的第二列不能单独用。
CREATE INDEX payment_records_received ON payment_records(received_on);

-- 4) 同订单不变量。
--    只在该计划确实存在时判归属，计划不存在交给外键报错，别用误导性的消息抢话。
CREATE TRIGGER payment_records_same_order_insert
BEFORE INSERT ON payment_records
WHEN NEW.schedule_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM payment_schedules WHERE id = NEW.schedule_id)
BEGIN
  SELECT RAISE(ABORT, '收款流水与付款计划不属于同一订单')
  WHERE (SELECT order_id FROM payment_schedules WHERE id = NEW.schedule_id)
        IS NOT NEW.order_id;
END;

CREATE TRIGGER payment_records_same_order_update
BEFORE UPDATE OF schedule_id, order_id ON payment_records
WHEN NEW.schedule_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM payment_schedules WHERE id = NEW.schedule_id)
BEGIN
  SELECT RAISE(ABORT, '收款流水与付款计划不属于同一订单')
  WHERE (SELECT order_id FROM payment_schedules WHERE id = NEW.schedule_id)
        IS NOT NEW.order_id;
END;

-- 反方向：已挂了流水的计划不能改挂到别的订单，否则同样破坏不变量。
CREATE TRIGGER payment_schedules_order_update
BEFORE UPDATE OF order_id ON payment_schedules
WHEN NEW.order_id IS NOT OLD.order_id
BEGIN
  SELECT RAISE(ABORT, '该付款计划已有收款流水，不能改挂到其他订单')
  WHERE EXISTS (SELECT 1 FROM payment_records WHERE schedule_id = OLD.id);
END;
"#,
    )?;
    Ok(())
}
