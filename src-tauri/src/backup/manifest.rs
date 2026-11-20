//! 备份包的 Manifest：数据摘要、文件清单与结构版本声明。
//!
//! Manifest 的结构定义在 `zip_read` 里（读取侧先落地），这里只负责**生成**，
//! 并保证两侧共用同一份类型，避免读写字段漂移。

use std::path::Path;

use rusqlite::Connection;
use sha2::{Digest, Sha256};

use crate::backup::zip_read::{Manifest, ManifestFile, YearWatermark};
use crate::error::{AppError, AppResult};

/// 备份时顺带记录的业务摘要，方便恢复前给用户看"这个包里有什么"。
///
/// `orders` / `clients` 是**总数**（含回收站），`trashed_*` 是其中的回收站部分。
/// 两者分开是刻意的：把回收站并进总数会让用户以为「恢复后能直接看到这些订单」。
/// 新字段带 `serde(default)`，读任何不含这两个字段的旧摘要都不会失败。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSummary {
    pub orders: i64,
    pub active_orders: i64,
    pub clients: i64,
    pub templates: i64,
    pub events: i64,
    pub attachments: i64,
    pub stage_skips: i64,
    pub reschedules: i64,
    /// 回收站中的订单数（`orders` 的子集）。
    #[serde(default)]
    pub trashed_orders: i64,
    /// 回收站中的客户数（`clients` 的子集）。
    #[serde(default)]
    pub trashed_clients: i64,
}

/// 表不存在时按 0 计：旧备份 / 未来新增表都不该让摘要失败。
fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0)
}

pub fn summarize(conn: &Connection) -> AppResult<DataSummary> {
    Ok(DataSummary {
        orders: count(conn, "SELECT COUNT(*) FROM orders"),
        active_orders: count(
            conn,
            "SELECT COUNT(*) FROM orders WHERE status = 'active'",
        ),
        clients: count(conn, "SELECT COUNT(*) FROM clients"),
        templates: count(conn, "SELECT COUNT(*) FROM stage_templates"),
        events: count(conn, "SELECT COUNT(*) FROM order_events"),
        attachments: count(conn, "SELECT COUNT(*) FROM attachments"),
        stage_skips: count(
            conn,
            "SELECT COUNT(*) FROM order_events WHERE kind = 'stage_skipped'",
        ),
        reschedules: count(
            conn,
            "SELECT COUNT(*) FROM order_events WHERE kind = 'rescheduled'",
        ),
        // 回收站数据必须进备份：这里是「备份里有几条」，不是「业务能看见几条」，
        // 所以查基表、不过滤 deleted_at。
        trashed_orders: count(conn, "SELECT COUNT(*) FROM orders WHERE deleted_at IS NOT NULL"),
        trashed_clients: count(conn, "SELECT COUNT(*) FROM clients WHERE deleted_at IS NOT NULL"),
    })
}

pub fn sha256_file(path: &Path) -> AppResult<(u64, String)> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)
        .map_err(|e| AppError::io(format!("无法读取 {}：{e}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 128 * 1024];
    let mut total = 0u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| AppError::io(format!("读取失败 {}：{e}", path.display())))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    let digest: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    Ok((total, digest))
}

pub fn build(
    app_version: &str,
    schema_version: i64,
    created_at: &str,
    working_timezone: &str,
    watermarks: &[YearWatermark],
    files: Vec<ManifestFile>,
) -> Manifest {
    let total_bytes = files.iter().map(|f| f.bytes).sum();
    let total_files = files.len();
    Manifest {
        format: crate::backup::zip_read::FORMAT_NAME.to_string(),
        format_version: crate::backup::zip_read::FORMAT_VERSION,
        app_version: app_version.to_string(),
        schema_version,
        created_at: created_at.to_string(),
        working_timezone: working_timezone.to_string(),
        number_high_water: watermarks.to_vec(),
        files,
        total_files,
        total_bytes,
    }
}
