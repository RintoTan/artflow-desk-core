//! v14：客户参考图。
//!
//! 客户参考图与订单附件是**两种归属**：一条参考图属于客户，不属于任何订单，
//! 订单被删除时它不该跟着消失。所以单独一张表，而不是给 `attachments` 加一列
//! `client_id` 把两种归属混进同一个主键空间。
//!
//! 文件仍然落在受管的 `attachments/` 目录树里（`originals/clients/<客户>/`），
//! 这样备份、恢复、完整性校验、隔离区这些既有的媒体通道不用改一行就覆盖了它——
//! 数据隔离与文件通道分开处理，两边都不吃亏。
//!
//! 刻意不加 `vis_*` 视图：参考图没有软删除语义，删除即真删（行 + 文件），
//! 与订单附件的可见性层不是一回事。

use rusqlite::Transaction;

use crate::error::AppResult;

pub fn apply(tx: &Transaction<'_>) -> AppResult<()> {
    tx.execute_batch(
        r#"
CREATE TABLE client_attachments (
  id             TEXT PRIMARY KEY,
  -- 客户被硬删除时行随之消失；文件由调用方在此之前登记清理任务。
  client_id      TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  original_name  TEXT NOT NULL,
  -- 相对代际目录的可移植路径，绝不含盘符或绝对路径。
  rel_path       TEXT NOT NULL UNIQUE,
  thumb_rel_path TEXT,
  mime_type      TEXT NOT NULL,
  byte_size      INTEGER NOT NULL CHECK (byte_size > 0),
  sha256         TEXT NOT NULL,
  width          INTEGER,
  height         INTEGER,
  -- 先落 'missing' 再补文件，最后改 'ok'：中途崩溃能看出这一条没写完。
  state          TEXT NOT NULL DEFAULT 'missing'
                   CHECK (state IN ('ok', 'missing', 'corrupt')),
  created_at     TEXT NOT NULL
);
CREATE INDEX client_attachments_client_idx ON client_attachments(client_id);
"#,
    )?;
    Ok(())
}
