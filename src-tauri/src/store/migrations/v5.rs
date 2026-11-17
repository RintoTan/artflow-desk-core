//! schema v5：把"可展示 ⇒ 必须是成品"提升为**数据库层**约束。
//!
//! 为什么不是改 v4：v4 已经落到部分 QA 代际（实测 `gen-3f3b125…` 已是 user_version=4）。
//! 改旧迁移文件不会回头作用于已迁移的库，只会让新库与旧库结构分叉。
//!
//! 为什么用触发器而不是重建表：SQLite 不支持 `ALTER TABLE ADD CONSTRAINT`，
//! 重建 `attachments` 要搬数据、还要处理引用与索引，风险远大于收益。
//! 触发器对 INSERT 与 UPDATE 都生效，且对已存在的行同样生效。
//!
//! 为什么不用跨列 CHECK：`(gallery_visible = 0 OR role = 'final')` 在
//! `gallery_visible = 1`、`role = NULL` 时求值为 NULL，SQLite 把 NULL 当作"未违反"，
//! 于是非法组合照样写进去（实测 CREATE TABLE 与 ADD COLUMN 都是如此）。
//! `role IS 'final'` 才是 NULL 安全的写法，这里用触发器把条件写成显式的 IS NULL 判断。

use rusqlite::Transaction;

use crate::error::AppResult;

pub const SQL: &str = r#"
CREATE TRIGGER IF NOT EXISTS attachments_gallery_visible_insert
BEFORE INSERT ON attachments
WHEN NEW.gallery_visible = 1
  AND (NEW.role IS NULL OR NEW.role <> 'final')
BEGIN
  SELECT RAISE(ABORT, 'gallery_visible 需要 role = final');
END;

CREATE TRIGGER IF NOT EXISTS attachments_gallery_visible_update
BEFORE UPDATE OF role, gallery_visible ON attachments
WHEN NEW.gallery_visible = 1
  AND (NEW.role IS NULL OR NEW.role <> 'final')
BEGIN
  SELECT RAISE(ABORT, 'gallery_visible 需要 role = final');
END;
"#;

pub fn apply(tx: &Transaction<'_>) -> AppResult<()> {
    tx.execute_batch(SQL)?;
    Ok(())
}
