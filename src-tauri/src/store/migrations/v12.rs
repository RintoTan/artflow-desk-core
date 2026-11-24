//! v12：收款流水与付款计划的类型一致。
//!
//! 一张「定金」计划下面挂一笔「尾款」流水，金额上未必看得出来，但分类统计
//! 会立刻失真——所以这条不变量既要领域层挡，也要数据库挡。
//!
//! ## 为什么是触发器而不是 CHECK
//!
//! SQLite 的 `CHECK` 只能看本行。跨表比较只能用触发器，而且现有三张表已经
//! 是 `STRICT`，加约束必须重建表——那会把已经可能存在的真实财务数据卷进来。
//! 触发器不动数据、不动表结构，是这里代价最小的做法。
//!
//! ## 为什么迁移前要查一遍旧数据
//!
//! v11 的库在理论上可能存在跨类型关联（v11 没有这条约束）。触发器只能拦新写入，
//! 拦不住已经躺在那里的行。所以先查：有冲突就整步中止并指出具体行，
//! 让人的决定来修，而不是迁移自己猜。
//!
//! ## 不能误伤外键的 SET NULL
//!
//! 删付款计划时 `payment_records.schedule_id` 会被置空。UPDATE 触发器带
//! `NEW.schedule_id IS NOT NULL` 的前提，所以这条既定语义不受影响。

use rusqlite::{params, Transaction};

use crate::error::{AppError, AppResult};

pub fn apply(tx: &Transaction<'_>) -> AppResult<()> {
    // 1) 旧数据自检：任何跨类型关联都中止迁移，不做自动修复。
    let mut stmt = tx.prepare(
        "SELECT r.id, r.kind, s.id, s.kind
           FROM payment_records r
           JOIN payment_schedules s ON s.id = r.schedule_id
          WHERE r.kind IS NOT s.kind
          LIMIT 5",
    )?;
    let conflicts = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);

    if !conflicts.is_empty() {
        let detail = conflicts
            .iter()
            .map(|(rid, rkind, sid, skind)| {
                format!("流水 {rid}({rkind}) ↔ 计划 {sid}({skind})")
            })
            .collect::<Vec<_>>()
            .join("；");
        return Err(AppError::conflict(format!(
            "存在收款类型与付款计划类型不一致的历史记录，v12 中止且未改动任何数据：{detail}"
        )));
    }

    tx.execute_batch(
        r#"
-- 2) 插入时就拦住跨类型关联。
--    计划不存在时交给外键报错，这里只在计划确实存在时比较类型。
CREATE TRIGGER payment_records_kind_match_insert
BEFORE INSERT ON payment_records
WHEN NEW.schedule_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM payment_schedules WHERE id = NEW.schedule_id)
BEGIN
  SELECT RAISE(ABORT, '收款类型与付款计划类型不一致')
  WHERE (SELECT kind FROM payment_schedules WHERE id = NEW.schedule_id) IS NOT NEW.kind;
END;

-- 3) 改流水类型或改关联计划时重查一次。
--    `NEW.schedule_id IS NOT NULL` 让外键的 SET NULL 正常通过。
CREATE TRIGGER payment_records_kind_match_update
BEFORE UPDATE OF schedule_id, kind ON payment_records
WHEN NEW.schedule_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM payment_schedules WHERE id = NEW.schedule_id)
BEGIN
  SELECT RAISE(ABORT, '收款类型与付款计划类型不一致')
  WHERE (SELECT kind FROM payment_schedules WHERE id = NEW.schedule_id) IS NOT NEW.kind;
END;


-- 4) 已经挂了流水的计划不能改类型：否则历史流水的分类会被回头改写。
--    没挂流水的计划仍然可以改（用户配错了计划本来就该能改）。
CREATE TRIGGER payment_schedules_kind_locked
BEFORE UPDATE OF kind ON payment_schedules
WHEN NEW.kind IS NOT OLD.kind
BEGIN
  SELECT RAISE(ABORT, '该付款计划已有收款流水，不能修改类型')
  WHERE EXISTS (SELECT 1 FROM payment_records WHERE schedule_id = OLD.id);
END;

-- 5) 退款记录：真实资金流出，独立成表。
--    不能写成负数收款，也不能用「作废原收款」冒充退款：那是三件不同的事。
CREATE TABLE refund_records (
  id                TEXT NOT NULL PRIMARY KEY,
  order_id          TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  -- 允许为空：历史订单可能压根没录过收款，但退款确实发生了。
  payment_record_id TEXT REFERENCES payment_records(id) ON DELETE SET NULL,
  amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
  refunded_on       TEXT NOT NULL CHECK (refunded_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                                          AND date(refunded_on) IS refunded_on),
  method            TEXT CHECK (method IS NULL
                                OR method IN ('wechat', 'alipay', 'bank', 'cash', 'other')),
  note              TEXT,
  voided_at         TEXT,
  void_reason       TEXT,
  request_id        TEXT UNIQUE,
  created_at        TEXT NOT NULL,
  -- 作废必须成对：没时间就没原因，有时间就必须有原因。
  CHECK ((voided_at IS NULL AND void_reason IS NULL)
      OR (voided_at IS NOT NULL AND length(trim(void_reason)) > 0))
) STRICT;

CREATE INDEX refund_records_order ON refund_records(order_id, refunded_on);
CREATE INDEX refund_records_payment ON refund_records(payment_record_id);
CREATE INDEX refund_records_date ON refund_records(refunded_on);

-- 6) 退款必须和它关联的原收款属于同一张订单。
CREATE TRIGGER refund_records_same_order_insert
BEFORE INSERT ON refund_records
WHEN NEW.payment_record_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM payment_records WHERE id = NEW.payment_record_id)
BEGIN
  SELECT RAISE(ABORT, '退款与原收款不属于同一订单')
  WHERE (SELECT order_id FROM payment_records WHERE id = NEW.payment_record_id)
        IS NOT NEW.order_id;
END;

CREATE TRIGGER refund_records_same_order_update
BEFORE UPDATE OF payment_record_id, order_id ON refund_records
WHEN NEW.payment_record_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM payment_records WHERE id = NEW.payment_record_id)
BEGIN
  SELECT RAISE(ABORT, '退款与原收款不属于同一订单')
  WHERE (SELECT order_id FROM payment_records WHERE id = NEW.payment_record_id)
        IS NOT NEW.order_id;
END;

-- 7) 作废的收款不能挂退款；累计有效退款不能超过原收款金额。
CREATE TRIGGER refund_records_payment_valid_insert
BEFORE INSERT ON refund_records
WHEN NEW.payment_record_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM payment_records WHERE id = NEW.payment_record_id)
BEGIN
  SELECT RAISE(ABORT, '不能关联已作废的收款记录')
  WHERE (SELECT voided_at FROM payment_records WHERE id = NEW.payment_record_id) IS NOT NULL;
  SELECT RAISE(ABORT, '累计退款超过原收款金额')
  WHERE NEW.voided_at IS NULL
    AND (SELECT amount_cents FROM payment_records WHERE id = NEW.payment_record_id)
        < NEW.amount_cents + COALESCE((
              SELECT SUM(amount_cents) FROM refund_records
               WHERE payment_record_id = NEW.payment_record_id AND voided_at IS NULL), 0);
END;

CREATE TRIGGER refund_records_payment_valid_update
BEFORE UPDATE OF payment_record_id, amount_cents, voided_at ON refund_records
WHEN NEW.payment_record_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM payment_records WHERE id = NEW.payment_record_id)
BEGIN
  SELECT RAISE(ABORT, '不能关联已作废的收款记录')
  WHERE NEW.voided_at IS NULL
    AND (SELECT voided_at FROM payment_records WHERE id = NEW.payment_record_id) IS NOT NULL;
  SELECT RAISE(ABORT, '累计退款超过原收款金额')
  WHERE NEW.voided_at IS NULL
    AND (SELECT amount_cents FROM payment_records WHERE id = NEW.payment_record_id)
        < NEW.amount_cents + COALESCE((
              SELECT SUM(amount_cents) FROM refund_records
               WHERE payment_record_id = NEW.payment_record_id
                 AND voided_at IS NULL AND id IS NOT NEW.id), 0);
END;

-- 8) 作废不可逆：已经作废的退款不能被「恢复」成有效。
CREATE TRIGGER refund_records_void_irreversible
BEFORE UPDATE OF voided_at ON refund_records
WHEN OLD.voided_at IS NOT NULL AND NEW.voided_at IS NULL
BEGIN
  SELECT RAISE(ABORT, '已作废的退款记录不能恢复');
END;

-- 9) 有有效退款的收款不能被作废：否则退款就挂在一笔「不存在的收款」上了。
CREATE TRIGGER payment_records_void_blocked_by_refunds
BEFORE UPDATE OF voided_at ON payment_records
WHEN OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, '该收款已有退款记录，不能作废')
  WHERE EXISTS (SELECT 1 FROM refund_records
                 WHERE payment_record_id = OLD.id AND voided_at IS NULL);
END;

"#,
    )?;

    // 5) 自检：三条触发器都建好了才算这一步成功。
    for trigger in [
        "payment_records_kind_match_insert",
        "payment_records_kind_match_update",
        "payment_schedules_kind_locked",
        "refund_records_same_order_insert",
        "refund_records_same_order_update",
        "refund_records_payment_valid_insert",
        "refund_records_payment_valid_update",
        "refund_records_void_irreversible",
        "payment_records_void_blocked_by_refunds",
    ] {
        let found: i64 = tx.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = ?1",
            params![trigger],
            |r| r.get(0),
        )?;
        if found != 1 {
            return Err(AppError::schema(format!("v12 缺少触发器 {trigger}")));
        }
    }
    Ok(())
}
