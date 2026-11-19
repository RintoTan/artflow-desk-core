//! v7：`order_events` 支持阶段跳级（`stage_skipped`）。
//!
//! SQLite 不能改已有 `CHECK`，所以与 v6 同样的做法重建 `order_events`：
//! 1. 建新表（kind 增加 `stage_skipped`，新增被跳过阶段快照与跳级原因两列）；
//! 2. 按 id 原样搬运全部历史事件（含 v6 的改期六字段与 `request_id`）；
//! 3. 删旧表、改名、重建原有三个索引。
//!
//! 约束设计：
//! - `stage_skipped` 必须带非空、合法的 JSON 数组快照 —— 没有快照的跳级事件无法还原历史；
//! - 其它类型不得写快照，避免把两种语义混进同一列；
//! - 跳级原因独立成列，不复用 `reason`（改期原因）与 `note`（事件备注）。

use rusqlite::Transaction;

use crate::error::AppResult;

pub fn apply(tx: &Transaction<'_>) -> AppResult<()> {
    tx.execute_batch(
        r#"
CREATE TABLE order_events_v7 (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id           TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN (
                       'created', 'work_started', 'work_start_undone',
                       'stage_advanced', 'stage_reworked', 'stage_skipped',
                       'workflow_changed', 'completed', 'cancelled', 'reopened',
                       'rescheduled')),
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
  -- 跳级事件专用：被跳过阶段的快照 JSON（[{stage_id,title,position}, ...]）。
  skipped_stages     TEXT,
  -- 跳级原因（选填）；与改期 `reason`、事件 `note` 分开存。
  skip_reason        TEXT,
  occurred_at        TEXT NOT NULL,
  CHECK (kind <> 'stage_skipped'
         OR (skipped_stages IS NOT NULL
             AND json_valid(skipped_stages)
             AND json_array_length(skipped_stages) > 0)),
  CHECK (kind = 'stage_skipped' OR skipped_stages IS NULL)
);

INSERT INTO order_events_v7 (
  id, order_id, kind, from_stage_id, from_stage_title, to_stage_id, to_stage_title,
  from_status, to_status, movement, note, request_id,
  old_start_date, old_delivery_date, new_start_date, new_delivery_date,
  reason, change_source, occurred_at
)
SELECT
  id, order_id, kind, from_stage_id, from_stage_title, to_stage_id, to_stage_title,
  from_status, to_status, movement, note, request_id,
  old_start_date, old_delivery_date, new_start_date, new_delivery_date,
  reason, change_source, occurred_at
FROM order_events
ORDER BY id;

DROP TABLE order_events;
ALTER TABLE order_events_v7 RENAME TO order_events;

CREATE INDEX IF NOT EXISTS order_events_order_idx ON order_events(order_id, id);
CREATE INDEX IF NOT EXISTS order_events_kind_idx ON order_events(kind, occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS order_events_request_uniq
  ON order_events(order_id, request_id) WHERE request_id IS NOT NULL;
"#,
    )?;
    Ok(())
}
