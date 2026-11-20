//! v8：回收站（软删除）字段 + 可见性视图。
//!
//! 本步只做结构加法，不改任何既有数据：
//! 1. `orders` / `clients` 各加 `deleted_at`、`deleted_batch` 两列；
//! 2. 建两个**部分索引**（只覆盖已删除行，回收站通常是少数）；
//! 3. 建三个视图，把「业务只看有效数据」变成结构性约束，而不是每处 SQL 手写 WHERE。
//!
//! 为什么用软删除列而不是独立回收站表：
//! - 客户与关联订单必须在同一事务里一起进出（`deleted_batch` 承担批次语义）；
//! - `order_events` / `order_stages` / `attachments` 都挂在 `orders` 上，
//!   搬行会破坏外键，且无法保证「客户与订单同批」；
//! - 现有 `orders.client_id` 是 `ON DELETE SET NULL`，硬删客户会把订单变成无主孤儿。
//!
//! 为什么删除不改 `status`：
//! `status` 是业务终态（active / complete / cancelled），删除是可见性。
//! 混在一起会污染 v7 的 CHECK 约束，也会让「已取消」与「已删除」无法区分。
//!
//! ⚠️ 视图列冻结（维护者必读）
//! SQLite 的 `CREATE VIEW ... AS SELECT *` 会在**建视图时**把 `*` 展开成当时的列清单。
//! 以后任何给 `orders` / `clients` 加列的迁移，都必须先 `DROP VIEW` 再按新列重建，
//! 否则新列在视图里不可见，表现为「字段莫名其妙读不到」。
//! `tests/migration_v8.rs` 有一条断言守着「视图列数 == 基表列数」，改表时它会先红。

use rusqlite::Transaction;

use crate::error::AppResult;

pub fn apply(tx: &Transaction<'_>) -> AppResult<()> {
    tx.execute_batch(
        r#"
-- 1) 软删除字段：NULL 表示有效，非 NULL 表示在回收站。
ALTER TABLE orders  ADD COLUMN deleted_at    TEXT;
ALTER TABLE orders  ADD COLUMN deleted_batch TEXT;
ALTER TABLE clients ADD COLUMN deleted_at    TEXT;
ALTER TABLE clients ADD COLUMN deleted_batch TEXT;

-- 2) 部分索引：只索引回收站里的少数行，比全列索引更小也更快。
CREATE INDEX idx_orders_deleted  ON orders(deleted_at)  WHERE deleted_at IS NOT NULL;
CREATE INDEX idx_clients_deleted ON clients(deleted_at) WHERE deleted_at IS NOT NULL;

-- 3) 可见性视图：业务查询一律走 *_visible，备份/诊断/QA 断言继续读基表。
CREATE VIEW orders_visible  AS SELECT * FROM orders  WHERE deleted_at IS NULL;
CREATE VIEW orders_trashed  AS SELECT * FROM orders  WHERE deleted_at IS NOT NULL;
CREATE VIEW clients_visible AS SELECT * FROM clients WHERE deleted_at IS NULL;
"#,
    )?;
    Ok(())
}
