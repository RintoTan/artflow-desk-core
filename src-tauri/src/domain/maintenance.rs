//! 附件维护：quarantine 与 `attachment_jobs` 的**只读盘点 + 手动清理**。
//!
//! 两条硬规矩：
//! 1. 任何清理都由用户显式发起，没有定时器、没有「超过 N 天自动删」；
//! 2. 只删「确定没人引用」的文件 —— 数据库里仍有引用的一律跳过。
//!
//! quarantine 不是垃圾箱：它是崩溃恢复时把可疑文件挪出来的地方，用于人工比对。
//! 所以这里的定位是「让你看清它占了多少、里面是什么、然后你决定删哪些」，
//! 而不是「帮你定期清空」。

use std::fs;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::store::paths::Layout;

const DIR_QUARANTINE: &str = "attachments/quarantine";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineItem {
    pub name: String,
    pub bytes: u64,
    pub modified_at: String,
    /// 仍被 `attachments` 或 `attachment_jobs` 引用：清理时必须跳过。
    pub referenced: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineReport {
    pub generation: String,
    pub dir: String,
    pub items: Vec<QuarantineItem>,
    pub total_bytes: u64,
    pub referenced_count: usize,
    pub removable_count: usize,
    pub removable_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantineCleared {
    pub removed: usize,
    pub skipped_referenced: usize,
    pub skipped_unsafe: usize,
    pub bytes_freed: u64,
    pub errors: Vec<String>,
}

fn quarantine_dir(layout: &Layout, generation: &str) -> std::path::PathBuf {
    layout.generation_dir(generation).join(DIR_QUARANTINE)
}

/// 收集数据库里所有可能指向附件文件的相对路径。
fn referenced_paths(conn: &Connection) -> AppResult<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT rel_path FROM attachments
         UNION SELECT thumb_rel_path FROM attachments WHERE thumb_rel_path IS NOT NULL
         UNION SELECT rel_path FROM attachment_jobs
         UNION SELECT temp_rel_path FROM attachment_jobs WHERE temp_rel_path IS NOT NULL",
    )?;
    for row in stmt.query_map([], |r| r.get::<_, String>(0))? {
        out.push(row?);
    }
    Ok(out)
}

/// 只接受「quarantine 目录里的单个文件名」：带分隔符、`..`、隐藏文件一律拒绝。
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && !name.contains('/')
        && !name.contains('\\')
        && name != ".."
}

pub fn quarantine_report(
    conn: &Connection,
    layout: &Layout,
    generation: &str,
) -> AppResult<QuarantineReport> {
    let dir = quarantine_dir(layout, generation);
    let referenced: Vec<String> = referenced_paths(conn)?
        .into_iter()
        .filter(|p| p.starts_with(DIR_QUARANTINE))
        .collect();

    let mut items: Vec<QuarantineItem> = Vec::new();
    if dir.exists() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            let meta = fs::symlink_metadata(entry.path())?;
            if !meta.is_file() || meta.file_type().is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let rel = format!("{DIR_QUARANTINE}/{name}");
            items.push(QuarantineItem {
                referenced: referenced.iter().any(|p| p == &rel),
                name,
                bytes: meta.len(),
                modified_at: meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs().to_string())
                    .unwrap_or_default(),
            });
        }
    }
    items.sort_by(|a, b| a.name.cmp(&b.name));

    let total_bytes = items.iter().map(|i| i.bytes).sum();
    let removable: Vec<&QuarantineItem> = items.iter().filter(|i| !i.referenced).collect();
    Ok(QuarantineReport {
        generation: generation.to_string(),
        dir: dir.to_string_lossy().to_string(),
        removable_count: removable.len(),
        removable_bytes: removable.iter().map(|i| i.bytes).sum(),
        referenced_count: items.len() - removable.len(),
        total_bytes,
        items,
    })
}

/// 删除用户明确点名的 quarantine 文件。
///
/// 只做文件删除：这些文件本来就没有数据库行指向它们（有引用的会被跳过），
/// 因此不需要事务，也不会出现「事务未提交就删文件」的问题。
pub fn quarantine_clear(
    conn: &Connection,
    layout: &Layout,
    generation: &str,
    names: &[String],
) -> AppResult<QuarantineCleared> {
    let mut report = QuarantineCleared {
        removed: 0,
        skipped_referenced: 0,
        skipped_unsafe: 0,
        bytes_freed: 0,
        errors: Vec::new(),
    };
    if names.is_empty() {
        return Ok(report);
    }
    let referenced: Vec<String> = referenced_paths(conn)?
        .into_iter()
        .filter(|p| p.starts_with(DIR_QUARANTINE))
        .collect();
    let dir = quarantine_dir(layout, generation);

    for name in names {
        if !safe_name(name) {
            report.skipped_unsafe += 1;
            continue;
        }
        let rel = format!("{DIR_QUARANTINE}/{name}");
        if referenced.iter().any(|p| p == &rel) {
            report.skipped_referenced += 1;
            continue;
        }
        let path = dir.join(name);
        let meta = match fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => {
                report.errors.push(format!("{name}：文件已不存在"));
                continue;
            }
        };
        if !meta.is_file() || meta.file_type().is_symlink() {
            report.skipped_unsafe += 1;
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => {
                report.removed += 1;
                report.bytes_freed += meta.len();
            }
            Err(e) => report.errors.push(format!("{name}：{e}")),
        }
    }
    Ok(report)
}

// ---------------------------------------------------------------- 作业记录

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobCounts {
    pub pending: i64,
    /// 当前 schema 只允许 pending/done/failed；保留该字段以便将来引入 running 时不用改前端。
    pub running: i64,
    pub done: i64,
    pub failed: i64,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsReport {
    pub counts: JobCounts,
    /// 可清理的候选条数（done/failed 且早于候选阈值），仅用于展示，不代表已删。
    pub prunable: i64,
    pub oldest_done_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneInput {
    /// 只清理 N 天之前的 done/failed；pending/running 永不参与。
    pub older_than_days: u32,
    /// 预览模式：只统计不删除。
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneReport {
    pub cutoff: String,
    pub matched: i64,
    pub removed: i64,
    pub kept_pending: i64,
    pub kept_recent: i64,
}

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

fn cutoff_iso(days: u32, now: chrono::DateTime<chrono::Utc>) -> String {
    (now - chrono::Duration::milliseconds(DAY_MS * days as i64))
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string()
}

pub fn jobs_report(conn: &Connection, prune_days: u32) -> AppResult<JobsReport> {
    let count = |state: &str| -> AppResult<i64> {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM attachment_jobs WHERE state = ?1",
            [state],
            |r| r.get(0),
        )?)
    };
    let counts = JobCounts {
        pending: count("pending")?,
        running: count("running")?,
        done: count("done")?,
        failed: count("failed")?,
        total: conn.query_row("SELECT COUNT(*) FROM attachment_jobs", [], |r| r.get(0))?,
    };
    let oldest: Option<String> = conn
        .query_row(
            "SELECT MIN(updated_at) FROM attachment_jobs WHERE state IN ('done','failed')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(None);
    let cutoff = cutoff_iso(prune_days.max(1), chrono::Utc::now());
    let prunable: i64 = conn.query_row(
        "SELECT COUNT(*) FROM attachment_jobs
         WHERE state IN ('done','failed') AND updated_at < ?1",
        [&cutoff],
        |r| r.get(0),
    )?;
    Ok(JobsReport {
        counts,
        prunable,
        oldest_done_at: oldest,
    })
}

/// 清理历史作业记录。
///
/// 只删 `done` / `failed` 且早于 cutOff 的行：`pending` 是崩溃恢复的唯一线索，
/// `running` 说明有任务正在写文件，两者都不能动。
pub fn jobs_prune(conn: &mut Connection, input: &PruneInput) -> AppResult<PruneReport> {
    let days = input.older_than_days.clamp(1, 3650);
    let cutoff = cutoff_iso(days, chrono::Utc::now());
    let matched: i64 = conn.query_row(
        "SELECT COUNT(*) FROM attachment_jobs
         WHERE state IN ('done','failed') AND updated_at < ?1",
        [&cutoff],
        |r| r.get(0),
    )?;
    let kept_pending: i64 = conn.query_row(
        "SELECT COUNT(*) FROM attachment_jobs WHERE state IN ('pending','running')",
        [],
        |r| r.get(0),
    )?;
    let kept_recent: i64 = conn.query_row(
        "SELECT COUNT(*) FROM attachment_jobs
         WHERE state IN ('done','failed') AND updated_at >= ?1",
        [&cutoff],
        |r| r.get(0),
    )?;

    let removed = if input.dry_run {
        0
    } else {
        conn.execute(
            "DELETE FROM attachment_jobs WHERE state IN ('done','failed') AND updated_at < ?1",
            [&cutoff],
        )? as i64
    };

    Ok(PruneReport {
        cutoff,
        matched,
        removed,
        kept_pending,
        kept_recent,
    })
}
