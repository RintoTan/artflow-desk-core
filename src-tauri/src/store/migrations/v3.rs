//! schema v3：附件操作日志（导入 / 修复的崩溃恢复凭据）。
//!
//! 文件系统与 SQLite 没有跨介质事务，因此把"打算做什么"先持久化：
//! 崩溃后用这条日志判断该补做还是该回滚，而不是靠猜。

use rusqlite::Transaction;

use crate::error::AppResult;

pub const SQL: &str = r#"
CREATE TABLE IF NOT EXISTS attachment_jobs (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('import', 'repair')),
  attachment_id   TEXT NOT NULL,
  generation      TEXT NOT NULL,
  rel_path        TEXT NOT NULL,
  temp_rel_path   TEXT,
  expected_sha256 TEXT,
  state           TEXT NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'done', 'failed')),
  note            TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attachment_jobs_state
  ON attachment_jobs(state, kind);
"#;

pub fn apply(tx: &Transaction<'_>) -> AppResult<()> {
    tx.execute_batch(SQL)?;
    Ok(())
}
