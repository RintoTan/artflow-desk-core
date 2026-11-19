//! v6：`order_events` 支持改期事件。
//!
//! SQLite 不能修改已有 `CHECK` 约束，所以这里重建 `order_events`：
//! 1. 建新表（kind 增加 `rescheduled`，新增改期前后日期 / 原因 / 来源列）；
//! 2. 按 id 原样搬运全部历史事件（含 `request_id`）；
//! 3. 删旧表、改名、重建索引（含 `request_id` 的部分唯一索引）。
//!
//! 不丢行、不改 id、不动其它表；`orders` 与 `attachments` 无变化。

use rusqlite::Transaction;

use crate::error::AppResult;

pub fn apply(tx: &Transaction<'_>) -> AppResult<()> {
    tx.execute_batch(
        r#"
CREATE TABLE order_events_v6 (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id           TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN (
                       'created', 'work_started', 'work_start_undone',
                       'stage_advanced', 'stage_reworked', 'workflow_changed',
                       'completed', 'cancelled', 'reopened', 'rescheduled')),
  from_stage_id      TEXT,
  from_stage_title   TEXT,
  to_stage_id        TEXT,
  to_stage_title     TEXT,
  from_status        TEXT,
  to_status          TEXT,
  movement           TEXT CHECK (movement IS NULL OR movement IN ('forward', 'backward')),
  note               TEXT,
  request_id         TEXT,
  -- 改期事件专用：改动前后的计划日期快照（NULL 表示该端为空）。
  old_start_date     TEXT,
  old_delivery_date  TEXT,
  new_start_date     TEXT,
  new_delivery_date  TEXT,
  reason             TEXT,
  -- 改期来源，用于区分日历与订单详情两个入口。
  change_source      TEXT CHECK (change_source IS NULL OR change_source IN ('calendar', 'order_details')),
  occurred_at        TEXT NOT NULL
);

INSERT INTO order_events_v6 (
  id, order_id, kind, from_stage_id, from_stage_title, to_stage_id, to_stage_title,
  from_status, to_status, movement, note, request_id, occurred_at
)
SELECT
  id, order_id, kind, from_stage_id, from_stage_title, to_stage_id, to_stage_title,
  from_status, to_status, movement, note, request_id, occurred_at
FROM order_events
ORDER BY id;

DROP TABLE order_events;
ALTER TABLE order_events_v6 RENAME TO order_events;

CREATE INDEX IF NOT EXISTS order_events_order_idx ON order_events(order_id, id);
CREATE INDEX IF NOT EXISTS order_events_kind_idx ON order_events(kind, occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS order_events_request_uniq
  ON order_events(order_id, request_id) WHERE request_id IS NOT NULL;
"#,
    )?;
    Ok(())
}
