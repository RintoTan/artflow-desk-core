//! schema v2：队列版本、订单说明、事件幂等键、订单阶段重名约束。

use rusqlite::Transaction;

use crate::error::AppResult;

pub const SQL: &str = r#"
-- 活动队列整体排序版本，独立于订单 revision。
CREATE TABLE IF NOT EXISTS queue_state (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT OR IGNORE INTO queue_state (id, revision) VALUES (1, 0);

-- 普通委托说明（属于"资料"，整体保存，不写制作历史）。
ALTER TABLE orders ADD COLUMN note TEXT;

-- 幂等键：同一订单内同一个 request_id 只允许写一条事件（按订单作用域，
-- 不同订单可以复用同一个键）。
ALTER TABLE order_events ADD COLUMN request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS order_events_request_uniq
  ON order_events(order_id, request_id) WHERE request_id IS NOT NULL;

-- 同一订单内阶段不允许重名（数据库层兜底，领域层给出更友好的提示）。
CREATE UNIQUE INDEX IF NOT EXISTS order_stages_title_uniq
  ON order_stages(order_id, title);
"#;

pub fn apply(tx: &Transaction<'_>) -> AppResult<()> {
    tx.execute_batch(SQL)?;
    Ok(())
}
