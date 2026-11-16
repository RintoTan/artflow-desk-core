//! 年度订单编号高水位（FIX-01 / R-02）。
//!
//! 存放于**业务代际之外的独立 SQLite 小库**，因此恢复旧备份不会回退编号。
//! 两个文件之间**没有**跨文件事务；因此采用"先持久保留编号，再创建订单"：
//! 预留成功后业务失败或进程中断只会跳号，绝不会复用已保留编号。

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS number_high_water (
  year           INTEGER PRIMARY KEY,
  last_allocated INTEGER NOT NULL CHECK (last_allocated >= 0)
);
CREATE TABLE IF NOT EXISTS high_water_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

pub const FORMAT_KEY: &str = "format";
pub const FORMAT_VALUE: &str = "artflow-minidesk-highwater-v1";
pub const EPOCH_KEY: &str = "epoch";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct YearWatermark {
    pub year: i32,
    pub last_allocated: i64,
}

pub struct HighWater {
    path: PathBuf,
}

impl HighWater {
    /// 打开（必要时创建）高水位库。
    ///
    /// 任何"说不清状态"的情况都返回错误，而不是重建：重建会静默降低高水位。
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let existed = path.exists();
        let conn = Self::connect(path)?;

        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| AppError::numbering(format!("编号记录无法校验：{e}")))?;
        if integrity != "ok" {
            return Err(AppError::numbering(format!(
                "编号记录已损坏（integrity_check={integrity}），已停止编号分配"
            )));
        }

        conn.execute_batch(SCHEMA)
            .map_err(|e| AppError::numbering(format!("编号记录结构异常：{e}")))?;

        if !existed {
            // 新库：写入格式标记与随机 epoch，便于识别"被替换过的编号记录"。
            conn.execute(
                "INSERT OR IGNORE INTO high_water_meta (key, value) VALUES (?1, ?2)",
                params![FORMAT_KEY, FORMAT_VALUE],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO high_water_meta (key, value) VALUES (?1, ?2)",
                params![EPOCH_KEY, uuid::Uuid::new_v4().to_string()],
            )?;
        } else {
            let format = Self::meta(&conn, FORMAT_KEY)
                .ok_or_else(|| AppError::numbering("编号记录缺少格式标记，已停止编号分配"))?;
            if format != FORMAT_VALUE {
                return Err(AppError::numbering(format!(
                    "编号记录格式不认识（{format}），已停止编号分配"
                )));
            }
        }
        Ok(Self {
            path: path.to_path_buf(),
        })
    }

    fn connect(path: &Path) -> AppResult<Connection> {
        let conn = Connection::open(path)
            .map_err(|e| AppError::numbering(format!("编号记录无法打开：{e}")))?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| AppError::numbering(format!("编号记录无法设置超时：{e}")))?;
        conn.pragma_update(None, "journal_mode", "wal")
            .map_err(|e| AppError::numbering(format!("编号记录不是可用的数据库：{e}")))?;
        conn.pragma_update(None, "synchronous", "full")
            .map_err(|e| AppError::numbering(format!("编号记录无法设置同步模式：{e}")))?;
        Ok(conn)
    }

    fn meta(conn: &Connection, key: &str) -> Option<String> {
        conn.query_row(
            "SELECT value FROM high_water_meta WHERE key = ?1",
            [key],
            |r| r.get(0),
        )
        .ok()
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 持久保留下一个编号并返回它。提交即视为"已保留"，此后不可复用。
    pub fn reserve(&self, year: i32) -> AppResult<i64> {
        let mut conn = Self::connect(&self.path)?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let allocated: i64 = tx.query_row(
            "INSERT INTO number_high_water (year, last_allocated) VALUES (?1, 1)
             ON CONFLICT(year) DO UPDATE SET last_allocated = last_allocated + 1
             RETURNING last_allocated",
            [year],
            |r| r.get(0),
        )?;
        tx.commit()?;
        Ok(allocated)
    }

    pub fn peek(&self, year: i32) -> AppResult<Option<i64>> {
        let conn = Self::connect(&self.path)?;
        let value = conn
            .query_row(
                "SELECT last_allocated FROM number_high_water WHERE year = ?1",
                [year],
                |r| r.get::<_, i64>(0),
            )
            .ok();
        Ok(value)
    }

    pub fn snapshot(&self) -> AppResult<Vec<YearWatermark>> {
        let conn = Self::connect(&self.path)?;
        let mut stmt =
            conn.prepare("SELECT year, last_allocated FROM number_high_water ORDER BY year")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(YearWatermark {
                    year: r.get(0)?,
                    last_allocated: r.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    /// 合并外部高水位（来自备份）：逐年取较大值，**永不降低**。
    /// 返回实际发生变化（被抬高）的年份。
    pub fn merge(&self, incoming: &[YearWatermark]) -> AppResult<Vec<YearWatermark>> {
        let mut conn = Self::connect(&self.path)?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut raised = Vec::new();
        for item in incoming {
            if item.last_allocated < 0 {
                continue;
            }
            let current: Option<i64> = tx
                .query_row(
                    "SELECT last_allocated FROM number_high_water WHERE year = ?1",
                    [item.year],
                    |r| r.get(0),
                )
                .ok();
            match current {
                Some(existing) if existing >= item.last_allocated => {}
                _ => {
                    tx.execute(
                        "INSERT INTO number_high_water (year, last_allocated) VALUES (?1, ?2)
                         ON CONFLICT(year) DO UPDATE SET last_allocated = excluded.last_allocated",
                        params![item.year, item.last_allocated],
                    )?;
                    raised.push(item.clone());
                }
            }
        }
        tx.commit()?;
        Ok(raised)
    }
}
