//! v13：订单置顶字段。
//!
//! 置顶是**展示优先级**，不是订单状态：它不改 `status`、不改 `queue_position`、
//! 不改生命周期，只在列表里把订单提到普通订单之前。因此它单独一列，而不是混进
//! 已有的 `status` / `archived_at` / `deleted_at` —— 那三个各自已经在回答别的问题。
//!
//! 为什么存时间戳而不是布尔：`NULL` 天然表示「没置顶」，非空还能回答「什么时候置的」，
//! 将来若要「置顶按时间排序」也不必再加列。
//!
//! ⚠️ 视图必须重建：`CREATE VIEW ... AS SELECT *` 在建视图那一刻把列清单冻结，
//! 只加列不重建视图会让 `pinned_at` 在 `orders_visible` / `orders_trashed` 里不可见。
//! 这条坑 v8、v9 都踩过，`tests/migration_v8.rs` 与 `v9.rs` 的「视图列数 == 基表列数」
//! 断言就是为它设的守门人。

use rusqlite::Transaction;

use crate::error::AppResult;

pub fn apply(tx: &Transaction<'_>) -> AppResult<()> {
    tx.execute_batch(
        r#"
-- 1) 置顶时间：NULL 表示未置顶。
ALTER TABLE orders ADD COLUMN pinned_at TEXT;

-- 2) 部分索引：置顶最多 5 个，全表索引没有意义。
CREATE INDEX idx_orders_pinned ON orders(pinned_at) WHERE pinned_at IS NOT NULL;

-- 3) 视图列冻结：先拆后建，新列才可见。
DROP VIEW orders_visible;
DROP VIEW orders_trashed;
CREATE VIEW orders_visible  AS SELECT * FROM orders  WHERE deleted_at IS NULL;
CREATE VIEW orders_trashed  AS SELECT * FROM orders  WHERE deleted_at IS NOT NULL;
"#,
    )?;
    Ok(())
}
