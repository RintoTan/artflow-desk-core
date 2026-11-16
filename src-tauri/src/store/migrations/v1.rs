//! 正式业务 schema v1。
//!
//! 单一业务库承载：客户、模板、订单、订单独立阶段、生命周期事件、
//! 附件元数据、清理任务、主题、应用设置。

use rusqlite::Transaction;

use crate::error::AppResult;

pub const SQL: &str = r#"
-- ---------------------------------------------------------------- 元信息
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------- 设置
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- 客户
CREATE TABLE IF NOT EXISTS clients (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  contact      TEXT,
  note         TEXT,
  revision     INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
-- 同名客户不自动合并，因此不做唯一约束。
CREATE INDEX IF NOT EXISTS clients_name_idx ON clients(display_name);

-- ---------------------------------------------------------------- 阶段模板
CREATE TABLE IF NOT EXISTS stage_templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  revision   INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 系统始终有且只有一个默认模板。
CREATE UNIQUE INDEX IF NOT EXISTS stage_templates_one_default
  ON stage_templates(is_default) WHERE is_default = 1;

CREATE TABLE IF NOT EXISTS stage_template_steps (
  template_id TEXT NOT NULL REFERENCES stage_templates(id) ON DELETE CASCADE,
  step_id     TEXT NOT NULL,
  title       TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 80),
  position    INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (template_id, step_id),
  -- 同一模板内不允许重名阶段。
  UNIQUE (template_id, title)
);
CREATE INDEX IF NOT EXISTS stage_template_steps_pos
  ON stage_template_steps(template_id, position);

-- ---------------------------------------------------------------- 订单
CREATE TABLE IF NOT EXISTS orders (
  id                   TEXT PRIMARY KEY,
  -- 展示编号 AF-YYYY-NNNN，创建后永不改变、永不复用。
  code                 TEXT NOT NULL UNIQUE,
  title                TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 120),
  client_id            TEXT REFERENCES clients(id) ON DELETE SET NULL,
  commission_type      TEXT,
  -- 金额：可空整数分；NULL（未知）与 0（零元）必须区分。
  amount_cents         INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
  status               TEXT NOT NULL CHECK (status IN ('active', 'complete', 'cancelled')),
  stage_template_id    TEXT,
  current_stage_id     TEXT,
  -- 活动队列位置，与展示编号完全无关，可由排序改变。
  queue_position       INTEGER NOT NULL CHECK (queue_position >= 0),
  -- 计划日期是日历日期（YYYY-MM-DD），不是时间点。
  planned_start_date   TEXT CHECK (planned_start_date IS NULL
                                   OR planned_start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  planned_delivery_date TEXT CHECK (planned_delivery_date IS NULL
                                    OR planned_delivery_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- 有效开工时间（真实时间点，UTC RFC3339）。NULL = 排队中。
  started_at           TEXT,
  -- 当前有效终态时间，重开时清空（历史事件保留）。
  completed_at         TEXT,
  cancelled_at         TEXT,
  request_id           TEXT UNIQUE,
  revision             INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  CHECK (planned_start_date IS NULL
         OR planned_delivery_date IS NULL
         OR planned_delivery_date >= planned_start_date),
  CHECK (status <> 'active' OR current_stage_id IS NOT NULL),
  CHECK ((status = 'complete') = (completed_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  -- 订单与当前阶段必须同时存在且同属本单，提交时校验（可延迟）。
  FOREIGN KEY (id, current_stage_id)
    REFERENCES order_stages(order_id, stage_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS orders_queue_idx ON orders(queue_position, code);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status, queue_position);
CREATE INDEX IF NOT EXISTS orders_client_idx ON orders(client_id);

-- 订单独立制作流程（创建时从模板复制，之后与模板无关）。
CREATE TABLE IF NOT EXISTS order_stages (
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL,
  title    TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 80),
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (order_id, stage_id)
);
CREATE INDEX IF NOT EXISTS order_stages_pos ON order_stages(order_id, position);

-- ---------------------------------------------------------------- 生命周期事件
CREATE TABLE IF NOT EXISTS order_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN (
                     'created', 'work_started', 'work_start_undone',
                     'stage_advanced', 'stage_reworked', 'workflow_changed',
                     'completed', 'cancelled', 'reopened')),
  -- 阶段标题快照：改名后历史仍保留当时的名称。
  from_stage_id    TEXT,
  from_stage_title TEXT,
  to_stage_id      TEXT,
  to_stage_title   TEXT,
  from_status      TEXT,
  to_status        TEXT,
  movement         TEXT CHECK (movement IS NULL OR movement IN ('forward', 'backward')),
  note             TEXT,
  occurred_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS order_events_order_idx ON order_events(order_id, id);
CREATE INDEX IF NOT EXISTS order_events_kind_idx ON order_events(kind, occurred_at);

-- ---------------------------------------------------------------- 附件元数据
CREATE TABLE IF NOT EXISTS attachments (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  original_name  TEXT NOT NULL,
  display_name   TEXT,
  note           TEXT,
  tag            TEXT,
  -- 相对代际目录的可移植路径，绝不含盘符或绝对路径。
  rel_path       TEXT NOT NULL UNIQUE,
  thumb_rel_path TEXT,
  mime_type      TEXT NOT NULL,
  byte_size      INTEGER NOT NULL CHECK (byte_size > 0),
  sha256         TEXT NOT NULL,
  width          INTEGER,
  height         INTEGER,
  state          TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'missing', 'corrupt')),
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_order_idx ON attachments(order_id);

-- ---------------------------------------------------------------- 持久清理任务
CREATE TABLE IF NOT EXISTS cleanup_tasks (
  id              TEXT PRIMARY KEY,
  generation      TEXT NOT NULL,
  order_id        TEXT,
  rel_path        TEXT NOT NULL,
  reason          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  state           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'done', 'failed')),
  created_at      TEXT NOT NULL,
  last_attempt_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS cleanup_tasks_pending_uniq
  ON cleanup_tasks(generation, rel_path) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS cleanup_tasks_state_idx ON cleanup_tasks(state);

-- ---------------------------------------------------------------- 主题
CREATE TABLE IF NOT EXISTS themes (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  mode       TEXT NOT NULL CHECK (mode IN ('light', 'dark')),
  tokens     TEXT NOT NULL CHECK (json_valid(tokens)),
  builtin    INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
"#;

pub fn apply(tx: &Transaction<'_>) -> AppResult<()> {
    tx.execute_batch(SQL)?;
    Ok(())
}
