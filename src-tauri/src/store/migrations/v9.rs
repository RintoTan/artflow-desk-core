//! v9：订单归档字段。
//!
//! 归档是**收纳**，不是删除，也不是业务状态：
//! - `archived_at` 与 `status`、`deleted_at` 三者各管一件事；
//! - 只有「订单信息」页的普通列表按它过滤；客户详情、工作台、日历、统计
//!   仍然看到同一张订单，口径不变；
//! - 归档不写 `order_events`，也不动阶段、金额、排期、附件。
//!
//! 为什么不用 `status` 表达归档：`status` 是业务终态（active / complete /
//! cancelled），混进「已收纳」会让「已完成且归档」无法表达，也会污染 v7 的
//! CHECK 约束。为什么不用 `deleted_at`：那是回收站，恢复与永久删除都挂在
//! 它上面，混用会把「取消归档」和「恢复」变成同一个动作。
//!
//! ⚠️ 视图必须重建：SQLite 的 `CREATE VIEW ... AS SELECT *` 在建视图时把列
//! 清单冻结，只加列不重建视图会让 `archived_at` 在视图里不可见。

use rusqlite::Transaction;

use crate::error::AppResult;

pub fn apply(tx: &Transaction<'_>) -> AppResult<()> {
    tx.execute_batch(
        r#"
-- 1) 归档时间：NULL 表示未归档。
ALTER TABLE orders ADD COLUMN archived_at TEXT;

-- 2) 部分索引：归档通常是少数，只索引已归档行。
CREATE INDEX idx_orders_archived ON orders(archived_at) WHERE archived_at IS NOT NULL;

-- 3) 重建视图，让新列在 views 里可见（列冻结）。
DROP VIEW orders_visible;
DROP VIEW orders_trashed;
CREATE VIEW orders_visible  AS SELECT * FROM orders  WHERE deleted_at IS NULL;
CREATE VIEW orders_trashed  AS SELECT * FROM orders  WHERE deleted_at IS NOT NULL;
"#,
    )?;
    Ok(())
}
