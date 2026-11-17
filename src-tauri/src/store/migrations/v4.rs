//! schema v4：订单来源、作品分类与本地展示状态、客户手工标签。
//!
//! 三组变更一次到位，原因：正式库每经历一次结构变化就要多做一次升级验收；
//! 合并在同一步迁移里失败时整步回滚，不会留下半套结构。
//!
//! 约束分工（实测结论）：
//! - 单列 CHECK 在 `ADD COLUMN` 后**确实生效**，因此取值范围交给数据库；
//! - 跨列 CHECK（如"可展示 ⇒ 必须是成品"）在 `ADD COLUMN` 后**不被强制执行**，
//!   所以这条规则由领域层校验并配测试，不假装数据库已经保证。

use rusqlite::Transaction;

use crate::error::AppResult;

pub const SQL: &str = r#"
-- 接稿渠道：可空（旧订单 = 未设置）。长度上限 40 字，空白视为未设置。
ALTER TABLE orders ADD COLUMN source TEXT
  CHECK (source IS NULL OR (length(trim(source)) BETWEEN 1 AND 40));

-- 附件角色：NULL = 尚未分类；reference = 参考素材；final = 画师标记的成品。
ALTER TABLE attachments ADD COLUMN role TEXT
  CHECK (role IS NULL OR role IN ('reference', 'final'));

-- 本机画廊默认展示：0 = 不出现，1 = 出现。旧附件一律 0，绝不自动公开。
ALTER TABLE attachments ADD COLUMN gallery_visible INTEGER NOT NULL DEFAULT 0
  CHECK (gallery_visible IN (0, 1));

CREATE TABLE IF NOT EXISTS client_tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 20),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS client_tag_link (
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  tag_id    TEXT NOT NULL REFERENCES client_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (client_id, tag_id)
);

CREATE INDEX IF NOT EXISTS client_tag_link_tag ON client_tag_link(tag_id);
CREATE INDEX IF NOT EXISTS orders_source ON orders(source);
"#;

pub fn apply(tx: &Transaction<'_>) -> AppResult<()> {
    tx.execute_batch(SQL)?;
    Ok(())
}
