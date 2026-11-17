//! 订单参考图片：导入、列表、移除、校验、修复、缩略图重建、崩溃恢复。
//!
//! ## 为什么需要一份"操作日志"
//!
//! 文件系统和 SQLite 之间没有跨介质事务。DEV-04 第一版的顺序是"先落文件、再写行"，
//! 进程在两步之间崩溃就会留下**没有任何元数据的孤立原图**——它既不出现在界面上，
//! 也不会被任何清理逻辑回收。所以这里先把"打算做什么"写进 `attachment_jobs`：
//!
//! ```text
//! import:  记意图 → 落原图 → 生成缩略图 → (行 + job done) 同一事务
//! repair:  记意图(含期望哈希) → 写 staging → 备份旧图 → 原子替换 → (更新行 + job done)
//! ```
//!
//! 崩溃后 `recover` 按日志判断该补做还是该回滚；无法判断时**保留文件并报告**，
//! 绝不因为"看到陌生文件"就清空目录。

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::media::import::{self, ValidatedImage};
use crate::media::thumb;
use crate::media::{self, ImageKind};
use crate::store::paths::Layout;
use crate::store::timezone;

const DIR_ORIGINALS: &str = "attachments/originals";
const DIR_THUMBS: &str = "attachments/thumbs";
const DIR_STAGING: &str = "attachments/staging";
const DIR_BACKUP: &str = "attachments/backup";
const DIR_QUARANTINE: &str = "attachments/quarantine";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentView {
    pub id: String,
    pub order_id: String,
    pub original_name: String,
    pub display_name: Option<String>,
    pub note: Option<String>,
    pub tag: Option<String>,
    pub mime_type: String,
    pub byte_size: i64,
    pub sha256: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub state: String,
    pub created_at: String,
    pub original_path: String,
    pub thumb_path: Option<String>,
    pub file_exists: bool,
    pub thumb_exists: bool,
    /// 缩略图缓存自身是否可用（不存在 / 无法解码 / 尺寸不对都算不可用）。
    pub thumb_state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub source_name: String,
    pub ok: bool,
    pub attachment: Option<AttachmentView>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbReport {
    pub total: usize,
    pub rebuilt: usize,
    pub skipped: usize,
    pub failed: usize,
    pub failures: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub ok: usize,
    pub missing: usize,
    pub corrupt: usize,
    pub thumbs_broken: usize,
    pub attachments: Vec<AttachmentView>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryReport {
    /// 崩溃后补做完成的修复
    pub completed: usize,
    /// 崩溃后回滚掉的导入 / 修复
    pub rolled_back: usize,
    /// 被移入隔离目录的孤立文件
    pub quarantined: Vec<String>,
    /// 无法判断、保留原样并上报的文件
    pub kept_unknown: Vec<String>,
    pub failed: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    pub removed: usize,
    pub already_gone: usize,
    pub skipped_stale: usize,
    pub refused: usize,
    pub failed: usize,
    pub notes: Vec<String>,
}

// ---------------------------------------------------------------- 路径

fn gen_root(layout: &Layout, generation: &str) -> PathBuf {
    layout.generation_dir(generation)
}

fn abs_path(layout: &Layout, generation: &str, rel: &str) -> AppResult<PathBuf> {
    media::safe_join(&gen_root(layout, generation), rel)
}

fn staging_rel(id: &str, ext: &str) -> String {
    format!("{DIR_STAGING}/{id}.{ext}.new")
}

fn backup_rel(id: &str, ext: &str) -> String {
    format!("{DIR_BACKUP}/{id}.{ext}.bak")
}

fn is_managed_path(rel: &str) -> bool {
    rel.starts_with(&format!("{DIR_ORIGINALS}/")) || rel.starts_with(&format!("{DIR_THUMBS}/"))
}

fn extension_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_string()
}

// ---------------------------------------------------------------- 读取

fn order_exists(conn: &Connection, order_id: &str) -> AppResult<()> {
    let found: Option<i64> = conn
        .query_row("SELECT 1 FROM orders WHERE id = ?1", [order_id], |r| r.get(0))
        .optional()?;
    found.map(|_| ()).ok_or_else(|| AppError::not_found("订单不存在"))
}

/// 只把"确定在代际目录内"的路径交给前端。
/// 路径可疑（含 `..`、解析后越界、无可信父目录）时返回空串，前端因此拿不到可用 URL。
fn published_path(root: &Path, abs: &Path) -> String {
    let canonical_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    if abs.exists() {
        if let Ok(real) = std::fs::canonicalize(abs) {
            if real.starts_with(&canonical_root) {
                return real.to_string_lossy().to_string();
            }
            return String::new();
        }
    }
    if abs.starts_with(&canonical_root) && !abs.to_string_lossy().contains("..") {
        abs.to_string_lossy().to_string()
    } else {
        String::new()
    }
}

fn thumb_state_of(path: Option<&Path>) -> String {
    match path {
        None => "missing".to_string(),
        Some(p) if !p.exists() => "missing".to_string(),
        Some(p) if thumb::is_valid(p) => "ok".to_string(),
        Some(_) => "corrupt".to_string(),
    }
}

fn read_view(
    conn: &Connection,
    layout: &Layout,
    generation: &str,
    attachment_id: &str,
) -> AppResult<AttachmentView> {
    let row = conn
        .query_row(
            "SELECT id, order_id, original_name, display_name, note, tag, rel_path,
                    thumb_rel_path, mime_type, byte_size, sha256, width, height, state, created_at
             FROM attachments WHERE id = ?1",
            [attachment_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, String>(8)?,
                    r.get::<_, i64>(9)?,
                    r.get::<_, String>(10)?,
                    r.get::<_, Option<i64>>(11)?,
                    r.get::<_, Option<i64>>(12)?,
                    r.get::<_, String>(13)?,
                    r.get::<_, String>(14)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("附件不存在"))?;

    let root = gen_root(layout, generation);
    let original = abs_path(layout, generation, &row.6)?;
    let thumb_abs = match &row.7 {
        Some(rel) => Some(abs_path(layout, generation, rel)?),
        None => None,
    };
    let thumb_state = thumb_state_of(thumb_abs.as_deref());
    let original_published = published_path(&root, &original);
    let thumb_published = thumb_abs
        .as_ref()
        .map(|p| published_path(&root, p))
        .filter(|s| !s.is_empty());

    Ok(AttachmentView {
        id: row.0,
        order_id: row.1,
        original_name: row.2,
        display_name: row.3,
        note: row.4,
        tag: row.5,
        mime_type: row.8,
        byte_size: row.9,
        sha256: row.10,
        width: row.11,
        height: row.12,
        state: row.13,
        created_at: row.14,
        file_exists: original.is_file() && !original_published.is_empty(),
        thumb_exists: thumb_abs.as_ref().map(|p| p.is_file()).unwrap_or(false),
        thumb_state,
        original_path: original_published,
        thumb_path: thumb_published,
    })
}

pub fn list(
    conn: &Connection,
    layout: &Layout,
    generation: &str,
    order_id: &str,
) -> AppResult<Vec<AttachmentView>> {
    order_exists(conn, order_id)?;
    let mut stmt =
        conn.prepare("SELECT id FROM attachments WHERE order_id = ?1 ORDER BY created_at, id")?;
    let ids: Vec<String> = stmt
        .query_map([order_id], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    ids.iter()
        .map(|id| read_view(conn, layout, generation, id))
        .collect()
}

// ---------------------------------------------------------------- 落盘

fn write_atomic(target: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = target.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    std::fs::write(&temp, bytes)?;
    std::fs::rename(&temp, target).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        AppError::io(format!("写入附件失败：{e}"))
    })?;
    Ok(())
}

/// 丢弃 staging 临时文件（只删我们自己命名过的普通文件）。
fn discard_temp(layout: &Layout, generation: &str, rel: Option<&str>) {
    let Some(rel) = rel else { return };
    if !rel.starts_with(&format!("{DIR_STAGING}/")) {
        return;
    }
    if let Ok(path) = abs_path(layout, generation, rel) {
        if let Ok(meta) = std::fs::symlink_metadata(&path) {
            if meta.is_file() && !meta.file_type().is_symlink() {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

fn move_to_quarantine(layout: &Layout, generation: &str, rel: &str) -> AppResult<bool> {
    let source = abs_path(layout, generation, rel)?;
    if !source.is_file() {
        return Ok(false);
    }
    // 符号链接一律不搬：它的目标不在我们的管辖范围内。
    let meta = std::fs::symlink_metadata(&source)?;
    if meta.file_type().is_symlink() {
        return Ok(false);
    }
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let target = abs_path(
        layout,
        generation,
        &format!("{DIR_QUARANTINE}/{}-{name}", uuid::Uuid::new_v4().simple()),
    )?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(&source, &target)?;
    Ok(true)
}

// ---------------------------------------------------------------- 操作日志

fn start_job(
    conn: &Connection,
    kind: &str,
    attachment_id: &str,
    generation: &str,
    rel_path: &str,
    temp_rel: Option<&str>,
    expected_sha: Option<&str>,
    note: Option<&str>,
) -> AppResult<String> {
    let id = format!("job-{}", uuid::Uuid::new_v4().simple());
    let now = timezone::now_timestamp();
    conn.execute(
        "INSERT INTO attachment_jobs (
            id, kind, attachment_id, generation, rel_path, temp_rel_path,
            expected_sha256, state, note, created_at, updated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9, ?9)",
        params![id, kind, attachment_id, generation, rel_path, temp_rel, expected_sha, note, now],
    )?;
    Ok(id)
}

fn finish_job(conn: &Connection, job_id: &str, state: &str, note: Option<&str>) -> AppResult<()> {
    let now = timezone::now_timestamp();
    conn.execute(
        "UPDATE attachment_jobs SET state = ?1, note = COALESCE(?2, note), updated_at = ?3
         WHERE id = ?4",
        params![state, note, now, job_id],
    )?;
    Ok(())
}

struct PendingJob {
    id: String,
    kind: String,
    attachment_id: String,
    rel_path: String,
    temp_rel_path: Option<String>,
    expected_sha256: Option<String>,
}

fn pending_jobs(conn: &Connection, generation: &str) -> AppResult<Vec<PendingJob>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, attachment_id, rel_path, temp_rel_path, expected_sha256
         FROM attachment_jobs WHERE state = 'pending' AND generation = ?1
         ORDER BY created_at",
    )?;
    let rows = stmt
        .query_map([generation], |r| {
            Ok(PendingJob {
                id: r.get(0)?,
                kind: r.get(1)?,
                attachment_id: r.get(2)?,
                rel_path: r.get(3)?,
                temp_rel_path: r.get(4)?,
                expected_sha256: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

// ---------------------------------------------------------------- 导入

fn insert_row(
    conn: &mut Connection,
    layout: &Layout,
    generation: &str,
    order_id: &str,
    image: &ValidatedImage,
    tag: Option<&str>,
) -> AppResult<AttachmentView> {
    let id = uuid::Uuid::new_v4().to_string();
    let rel = media::original_rel_path(&id, image.kind.extension());
    let thumb_rel = media::thumb_rel_path(&id);
    let original_path = abs_path(layout, generation, &rel)?;
    let thumb_path = abs_path(layout, generation, &thumb_rel)?;

    // 1) 先记意图，再动文件
    let job_id = start_job(conn, "import", &id, generation, &rel, None, Some(&image.sha256), None)?;

    // 2) 发布原图
    if let Err(e) = write_atomic(&original_path, &image.bytes) {
        let _ = finish_job(conn, &job_id, "failed", Some("写入原图失败"));
        return Err(e);
    }

    // 3) 缩略图（失败不影响导入）
    let thumb_written = match thumb::render_webp(&image.bytes) {
        Ok(bytes) => write_atomic(&thumb_path, &bytes).is_ok(),
        Err(_) => false,
    };

    // 4) 元数据与收尾在同一事务
    let now = timezone::now_timestamp();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let inserted = tx.execute(
        "INSERT INTO attachments (
            id, order_id, original_name, display_name, note, tag, rel_path, thumb_rel_path,
            mime_type, byte_size, sha256, width, height, state, created_at
         ) VALUES (?1, ?2, ?3, NULL, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'ok', ?12)",
        params![
            id,
            order_id,
            image.original_name,
            tag,
            rel,
            if thumb_written { Some(thumb_rel.clone()) } else { None },
            image.kind.mime(),
            image.bytes.len() as i64,
            image.sha256,
            image.width as i64,
            image.height as i64,
            now
        ],
    );

    if let Err(e) = inserted {
        drop(tx);
        let _ = std::fs::remove_file(&original_path);
        if thumb_written {
            let _ = std::fs::remove_file(&thumb_path);
        }
        let _ = finish_job(conn, &job_id, "failed", Some("写元数据失败"));
        return Err(e.into());
    }
    finish_job(&tx, &job_id, "done", None)?;
    tx.commit()?;

    read_view(conn, layout, generation, &id)
}

/// 批量导入；单张失败不影响其它张，逐项返回结果。
pub fn import(
    conn: &mut Connection,
    layout: &Layout,
    generation: &str,
    order_id: &str,
    sources: &[PathBuf],
    tag: Option<&str>,
) -> AppResult<Vec<ImportOutcome>> {
    order_exists(conn, order_id)?;
    if sources.is_empty() {
        return Ok(Vec::new());
    }

    let mut out = Vec::with_capacity(sources.len());
    for source in sources {
        let name = source
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| source.to_string_lossy().to_string());
        match import::read_and_validate(source) {
            Ok(image) => match insert_row(conn, layout, generation, order_id, &image, tag) {
                Ok(view) => out.push(ImportOutcome {
                    source_name: name,
                    ok: true,
                    attachment: Some(view),
                    error: None,
                }),
                Err(e) => out.push(ImportOutcome {
                    source_name: name,
                    ok: false,
                    attachment: None,
                    error: Some(e.message),
                }),
            },
            Err(e) => out.push(ImportOutcome {
                source_name: name,
                ok: false,
                attachment: None,
                error: Some(e.message),
            }),
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------- 修复

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairInput {
    pub attachment_id: String,
    pub source_path: String,
}

/// 用一张新的有效图片替换原图内容。
///
/// 协议：写 staging → 备份旧图 → 原子替换 → 更新元数据。
/// 中途崩溃由 `recover` 按 `expected_sha256` 判断该补做还是回滚。
/// 附件 ID、订单关联、相对路径、制作历史都不变。
pub fn repair(
    conn: &mut Connection,
    layout: &Layout,
    generation: &str,
    input: RepairInput,
) -> AppResult<AttachmentView> {
    let current = read_view(conn, layout, generation, &input.attachment_id)?;
    let image = import::read_and_validate(Path::new(&input.source_path))?;

    let ext = extension_of(&current.original_path);
    let rel = format!("{DIR_ORIGINALS}/{}.{ext}", current.id);
    let final_path = abs_path(layout, generation, &rel)?;
    let stage_rel = staging_rel(&current.id, image.kind.extension());
    let staging_path = abs_path(layout, generation, &stage_rel)?;
    let backup_path = abs_path(layout, generation, &backup_rel(&current.id, &ext))?;

    let job_id = start_job(
        conn,
        "repair",
        &current.id,
        generation,
        &rel,
        Some(&stage_rel),
        Some(&image.sha256),
        None,
    )?;

    // 1) 完整写入 staging（同卷，后续 rename 是原子的）
    if let Err(e) = write_atomic(&staging_path, &image.bytes) {
        let _ = finish_job(conn, &job_id, "failed", Some("写 staging 失败"));
        return Err(e);
    }

    // 2) 备份现有原图；备份不成功就不敢替换
    if final_path.is_file() {
        if let Some(parent) = backup_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if let Err(e) = std::fs::copy(&final_path, &backup_path) {
            let _ = std::fs::remove_file(&staging_path);
            let _ = finish_job(conn, &job_id, "failed", Some("备份旧原图失败，已放弃修复"));
            return Err(AppError::io(format!("备份原图失败，未做任何修改：{e}")));
        }
    }

    // 3) 原子替换
    if let Err(e) = std::fs::rename(&staging_path, &final_path) {
        let _ = std::fs::remove_file(&staging_path);
        let _ = finish_job(conn, &job_id, "failed", Some("替换原图失败"));
        return Err(AppError::io(format!("替换原图失败：{e}")));
    }

    // 4) 缩略图与元数据
    let thumb_rel = media::thumb_rel_path(&current.id);
    let thumb_path = abs_path(layout, generation, &thumb_rel)?;
    let thumb_written = match thumb::render_webp(&image.bytes) {
        Ok(bytes) => write_atomic(&thumb_path, &bytes).is_ok(),
        Err(_) => false,
    };

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let updated = tx.execute(
        "UPDATE attachments
         SET mime_type = ?1, byte_size = ?2, sha256 = ?3, width = ?4, height = ?5,
             state = 'ok', thumb_rel_path = ?6
         WHERE id = ?7",
        params![
            image.kind.mime(),
            image.bytes.len() as i64,
            image.sha256,
            image.width as i64,
            image.height as i64,
            if thumb_written { Some(thumb_rel) } else { None },
            current.id
        ],
    )?;
    if updated != 1 {
        drop(tx);
        let _ = finish_job(conn, &job_id, "failed", Some("更新元数据失败"));
        return Err(AppError::not_found("附件已不存在"));
    }
    finish_job(&tx, &job_id, "done", None)?;
    tx.commit()?;

    // 成功后才丢弃备份
    let _ = std::fs::remove_file(&backup_path);

    read_view(conn, layout, generation, &current.id)
}

// ---------------------------------------------------------------- 恢复

/// 启动时的安全扫描：先处理崩溃遗留的任务，再隔离孤立文件。
pub fn recover(conn: &mut Connection, layout: &Layout, generation: &str) -> AppResult<RecoveryReport> {
    let mut report = RecoveryReport::default();

    for job in pending_jobs(conn, generation)? {
        match job.kind.as_str() {
            "import" => {
                let exists: Option<i64> = conn
                    .query_row(
                        "SELECT 1 FROM attachments WHERE id = ?1",
                        [&job.attachment_id],
                        |r| r.get(0),
                    )
                    .optional()?;
                if exists.is_some() {
                    finish_job(conn, &job.id, "done", Some("恢复：元数据已存在"))?;
                    report.completed += 1;
                    continue;
                }
                // 没有元数据：这次导入没成功，文件是孤儿 → 隔离而不是删除
                let mut moved = false;
                if move_to_quarantine(layout, generation, &job.rel_path)? {
                    report.quarantined.push(job.rel_path.clone());
                    moved = true;
                }
                let thumb_rel = media::thumb_rel_path(&job.attachment_id);
                if move_to_quarantine(layout, generation, &thumb_rel)? {
                    report.quarantined.push(thumb_rel);
                    moved = true;
                }
                discard_temp(layout, generation, job.temp_rel_path.as_deref());
                let note = if moved {
                    "恢复：导入未提交，文件已隔离"
                } else {
                    "恢复：导入未提交"
                };
                finish_job(conn, &job.id, "failed", Some(note))?;
                report.rolled_back += 1;
            }
            "repair" => {
                let row_exists: Option<i64> = conn
                    .query_row(
                        "SELECT 1 FROM attachments WHERE id = ?1",
                        [&job.attachment_id],
                        |r| r.get(0),
                    )
                    .optional()?;
                discard_temp(layout, generation, job.temp_rel_path.as_deref());
                if row_exists.is_none() {
                    finish_job(conn, &job.id, "failed", Some("恢复：附件已不存在"))?;
                    report.failed += 1;
                    continue;
                }

                let final_path = abs_path(layout, generation, &job.rel_path)?;
                let actual = import::file_sha256(&final_path)?;
                let expected = job.expected_sha256.clone().unwrap_or_default();

                if !expected.is_empty() && actual.as_deref() == Some(expected.as_str()) {
                    // 文件已经是新内容，只差分录：把这次修复补完
                    let bytes = std::fs::read(&final_path)?;
                    let decoded = image::load_from_memory(&bytes).ok();
                    let (width, height) = decoded
                        .map(|d| (d.width() as i64, d.height() as i64))
                        .unwrap_or((0, 0));
                    let thumb_rel = media::thumb_rel_path(&job.attachment_id);
                    let thumb_path = abs_path(layout, generation, &thumb_rel)?;
                    let thumb_ok = match thumb::render_webp(&bytes) {
                        Ok(rendered) => write_atomic(&thumb_path, &rendered).is_ok(),
                        Err(_) => false,
                    };
                    let mime = match image::guess_format(&bytes) {
                        Ok(image::ImageFormat::Png) => "image/png",
                        Ok(image::ImageFormat::Jpeg) => "image/jpeg",
                        Ok(image::ImageFormat::WebP) => "image/webp",
                        _ => "application/octet-stream",
                    };
                    conn.execute(
                        "UPDATE attachments
                         SET mime_type = ?1, byte_size = ?2, sha256 = ?3, width = ?4, height = ?5,
                             state = 'ok', thumb_rel_path = ?6
                         WHERE id = ?7",
                        params![
                            mime,
                            bytes.len() as i64,
                            expected,
                            width,
                            height,
                            if thumb_ok { Some(thumb_rel) } else { None },
                            job.attachment_id
                        ],
                    )?;
                    finish_job(conn, &job.id, "done", Some("恢复：补完修复"))?;
                    report.completed += 1;
                } else {
                    // 文件还是旧内容或状态不明：能回滚就回滚，否则报告并保留
                    let ext = extension_of(&job.rel_path);
                    let backup =
                        abs_path(layout, generation, &backup_rel(&job.attachment_id, &ext))?;
                    if backup.is_file() {
                        std::fs::rename(&backup, &final_path)?;
                        finish_job(conn, &job.id, "failed", Some("恢复：已回滚到修复前"))?;
                        report.rolled_back += 1;
                    } else {
                        finish_job(conn, &job.id, "failed", Some("恢复：无法判断一致性，保留现状"))?;
                        report
                            .kept_unknown
                            .push(format!("{} 修复中断且缺少备份", job.rel_path));
                    }
                }
            }
            _ => {
                finish_job(conn, &job.id, "failed", Some("未知任务类型"))?;
                report.failed += 1;
            }
        }
    }

    // 孤立文件扫描：只隔离、不删除；有引用的、任务在途的一律不动。
    let referenced: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT rel_path FROM attachments
             UNION SELECT thumb_rel_path FROM attachments WHERE thumb_rel_path IS NOT NULL",
        )?;
        let rows: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let in_flight: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT rel_path, temp_rel_path FROM attachment_jobs WHERE state = 'pending'")?;
        let rows: Vec<(String, Option<String>)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .flat_map(|(rel, temp)| [Some(rel), temp].into_iter().flatten())
            .collect()
    };

    for dir in [DIR_ORIGINALS, DIR_THUMBS] {
        let abs = abs_path(layout, generation, dir)?;
        if !abs.is_dir() {
            continue;
        }
        for entry in std::fs::read_dir(&abs)?.flatten() {
            let rel = format!("{dir}/{}", entry.file_name().to_string_lossy());
            if referenced.iter().any(|r| r == &rel) || in_flight.iter().any(|r| r == &rel) {
                continue;
            }
            let meta = std::fs::symlink_metadata(entry.path())?;
            if meta.file_type().is_symlink() {
                report.kept_unknown.push(format!("{rel}（符号链接，未处理）"));
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            if move_to_quarantine(layout, generation, &rel)? {
                report.quarantined.push(rel);
            }
        }
    }

    Ok(report)
}

// ---------------------------------------------------------------- 清理任务

/// 处理持久清理任务。只删当前活动代里、经过路径与身份校验的受管文件。
pub fn run_cleanup(
    conn: &mut Connection,
    layout: &Layout,
    active_generation: &str,
) -> AppResult<CleanupReport> {
    let rows: Vec<(String, String, String, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT id, generation, rel_path, attempts FROM cleanup_tasks
             WHERE state = 'pending' ORDER BY created_at",
        )?;
        let rows: Vec<(String, String, String, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };

    let mut report = CleanupReport::default();
    let now = timezone::now_timestamp();

    for (id, generation, rel_path, _attempts) in rows {
        // 代际必须匹配：旧代的清理任务绝不能动新活动代的文件。
        if generation != active_generation {
            report.skipped_stale += 1;
            continue;
        }
        if !is_managed_path(&rel_path) {
            conn.execute(
                "UPDATE cleanup_tasks SET state = 'failed', last_attempt_at = ?1,
                        attempts = attempts + 1 WHERE id = ?2",
                params![now, id],
            )?;
            report.refused += 1;
            report.notes.push(format!("{rel_path}：不是受管的附件路径，拒绝删除"));
            continue;
        }

        let path = match abs_path(layout, &generation, &rel_path) {
            Ok(p) => p,
            Err(_) => {
                conn.execute(
                    "UPDATE cleanup_tasks SET state = 'failed', last_attempt_at = ?1,
                            attempts = attempts + 1 WHERE id = ?2",
                    params![now, id],
                )?;
                report.refused += 1;
                report.notes.push(format!("{rel_path}：路径不合法，拒绝删除"));
                continue;
            }
        };

        if !path.exists() {
            conn.execute(
                "UPDATE cleanup_tasks SET state = 'done', last_attempt_at = ?1,
                        attempts = attempts + 1 WHERE id = ?2",
                params![now, id],
            )?;
            report.already_gone += 1;
            continue;
        }

        let meta = std::fs::symlink_metadata(&path)?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            conn.execute(
                "UPDATE cleanup_tasks SET state = 'failed', last_attempt_at = ?1,
                        attempts = attempts + 1 WHERE id = ?2",
                params![now, id],
            )?;
            report.refused += 1;
            report.notes.push(format!("{rel_path}：不是普通文件，拒绝删除"));
            continue;
        }

        // 仍被引用（同代内被别的行复用）就不删。
        let still_referenced: i64 = conn.query_row(
            "SELECT COUNT(*) FROM attachments WHERE rel_path = ?1 OR thumb_rel_path = ?1",
            [&rel_path],
            |r| r.get(0),
        )?;
        if still_referenced > 0 {
            conn.execute(
                "UPDATE cleanup_tasks SET state = 'failed', last_attempt_at = ?1,
                        attempts = attempts + 1 WHERE id = ?2",
                params![now, id],
            )?;
            report.refused += 1;
            report.notes.push(format!("{rel_path}：仍被引用，拒绝删除"));
            continue;
        }

        match std::fs::remove_file(&path) {
            Ok(()) => {
                conn.execute(
                    "UPDATE cleanup_tasks SET state = 'done', last_attempt_at = ?1,
                            attempts = attempts + 1 WHERE id = ?2",
                    params![now, id],
                )?;
                report.removed += 1;
            }
            Err(e) => {
                conn.execute(
                    "UPDATE cleanup_tasks SET state = 'failed', last_attempt_at = ?1,
                            attempts = attempts + 1 WHERE id = ?2",
                    params![now, id],
                )?;
                report.failed += 1;
                report.notes.push(format!("{rel_path}：删除失败 {e}"));
            }
        }
    }

    Ok(report)
}

/// 移除：事务内登记清理任务并删元数据，提交后立即尝试执行清理。
pub fn remove(
    conn: &mut Connection,
    layout: &Layout,
    generation: &str,
    attachment_id: &str,
) -> AppResult<()> {
    let view = read_view(conn, layout, generation, attachment_id)?;
    let now = timezone::now_timestamp();
    let original_rel = format!(
        "{DIR_ORIGINALS}/{}.{}",
        view.id,
        extension_of(&view.original_path)
    );
    let thumb_rel = media::thumb_rel_path(&view.id);

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for (index, rel) in [&original_rel, &thumb_rel].into_iter().enumerate() {
        tx.execute(
            "INSERT OR IGNORE INTO cleanup_tasks (id, generation, order_id, rel_path, reason, created_at)
             VALUES (?1, ?2, ?3, ?4, 'attachment_removed', ?5)",
            params![
                format!("cl-{}-{index}", view.id),
                generation,
                view.order_id,
                rel,
                now
            ],
        )?;
    }
    tx.execute("DELETE FROM attachments WHERE id = ?1", [attachment_id])?;
    tx.commit()?;

    // 提交后再动文件；失败会留下 pending 任务，由下次 run_cleanup 重试。
    let _ = run_cleanup(conn, layout, generation)?;
    Ok(())
}

// ---------------------------------------------------------------- 校验

/// 原图状态与缩略图缓存状态分开判定，互不混淆。
pub fn verify(
    conn: &mut Connection,
    layout: &Layout,
    generation: &str,
    order_id: &str,
) -> AppResult<VerifyReport> {
    let views = list(conn, layout, generation, order_id)?;
    let mut report = VerifyReport {
        ok: 0,
        missing: 0,
        corrupt: 0,
        thumbs_broken: 0,
        attachments: Vec::new(),
    };

    for view in views {
        let path = Path::new(&view.original_path);
        let next_state = if !path.is_file() {
            "missing"
        } else {
            match import::file_sha256(path)? {
                Some(hash) if hash.eq_ignore_ascii_case(&view.sha256) => "ok",
                _ => "corrupt",
            }
        };

        if next_state != view.state {
            conn.execute(
                "UPDATE attachments SET state = ?1 WHERE id = ?2",
                params![next_state, view.id],
            )?;
        }

        match next_state {
            "ok" => report.ok += 1,
            "missing" => report.missing += 1,
            _ => report.corrupt += 1,
        }
        if view.thumb_state != "ok" {
            report.thumbs_broken += 1;
        }

        let mut updated = view;
        updated.state = next_state.to_string();
        report.attachments.push(updated);
    }
    Ok(report)
}

/// 重建缩略图：已有且**可解码**的跳过；原图缺失或损坏的不伪造成功。
pub fn rebuild_thumbs(
    conn: &mut Connection,
    layout: &Layout,
    generation: &str,
    order_id: &str,
) -> AppResult<ThumbReport> {
    let views = list(conn, layout, generation, order_id)?;
    let mut report = ThumbReport {
        total: views.len(),
        rebuilt: 0,
        skipped: 0,
        failed: 0,
        failures: Vec::new(),
    };

    for view in views {
        let thumb_rel = media::thumb_rel_path(&view.id);
        let thumb_path = abs_path(layout, generation, &thumb_rel)?;

        if thumb::is_valid(&thumb_path) {
            if view.thumb_path.is_none() {
                conn.execute(
                    "UPDATE attachments SET thumb_rel_path = ?1 WHERE id = ?2",
                    params![thumb_rel, view.id],
                )?;
            }
            report.skipped += 1;
            continue;
        }

        let original = Path::new(&view.original_path);
        if !original.is_file() {
            report.failed += 1;
            report
                .failures
                .push(format!("{}：原图缺失，无法生成缩略图", view.original_name));
            continue;
        }

        match std::fs::read(original)
            .map_err(|e| AppError::io(format!("读取原图失败：{e}")))
            .and_then(|bytes| thumb::render_webp(&bytes))
        {
            Ok(bytes) => {
                write_atomic(&thumb_path, &bytes)?;
                conn.execute(
                    "UPDATE attachments SET thumb_rel_path = ?1 WHERE id = ?2",
                    params![thumb_rel, view.id],
                )?;
                report.rebuilt += 1;
            }
            Err(e) => {
                report.failed += 1;
                report.failures.push(format!("{}：{}", view.original_name, e.message));
            }
        }
    }
    Ok(report)
}

// ---------------------------------------------------------------- 元数据

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAttachmentMetaInput {
    pub attachment_id: String,
    pub display_name: Option<String>,
    pub note: Option<String>,
    pub tag: Option<String>,
}

fn clean_optional(raw: &Option<String>, max: usize, field: &str) -> AppResult<Option<String>> {
    match raw {
        None => Ok(None),
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            if trimmed.chars().count() > max {
                return Err(AppError::invalid(format!("{field}不能超过 {max} 字")));
            }
            Ok(Some(trimmed.to_string()))
        }
    }
}

pub fn update_meta(
    conn: &Connection,
    layout: &Layout,
    generation: &str,
    input: UpdateAttachmentMetaInput,
) -> AppResult<AttachmentView> {
    let display = clean_optional(&input.display_name, 120, "展示名称")?;
    let note = clean_optional(&input.note, 1000, "图片备注")?;
    let tag = clean_optional(&input.tag, 40, "分类标签")?;

    let changed = conn.execute(
        "UPDATE attachments SET display_name = ?1, note = ?2, tag = ?3 WHERE id = ?4",
        params![display, note, tag, input.attachment_id],
    )?;
    if changed != 1 {
        return Err(AppError::not_found("附件不存在"));
    }
    read_view(conn, layout, generation, &input.attachment_id)
}

/// 供测试：当前代际的附件目录。
pub fn generation_attachments_dir(layout: &Layout, generation: &str) -> PathBuf {
    layout.attachments_dir(generation)
}

pub fn kind_of(mime: &str) -> Option<ImageKind> {
    ImageKind::from_mime(mime)
}

// ---------------------------------------------------------------- 测试钩子

/// 仅供测试与探针使用：走到"文件已发布、元数据未写"这一步就返回，
/// 让子进程可以在确切的位置 abort，用来验证崩溃恢复。
#[doc(hidden)]
pub mod test_hooks {
    use super::*;

    /// 返回 (attachment_id, rel_path)。调用方负责在之后制造崩溃。
    pub fn import_until_publish(
        conn: &mut Connection,
        layout: &Layout,
        generation: &str,
        order_id: &str,
        source: &Path,
    ) -> AppResult<(String, String)> {
        order_exists(conn, order_id)?;
        let image = import::read_and_validate(source)?;
        let id = uuid::Uuid::new_v4().to_string();
        let rel = media::original_rel_path(&id, image.kind.extension());
        let thumb_rel = media::thumb_rel_path(&id);
        let original_path = abs_path(layout, generation, &rel)?;
        let thumb_path = abs_path(layout, generation, &thumb_rel)?;

        let _job = start_job(conn, "import", &id, generation, &rel, None, Some(&image.sha256), None)?;
        write_atomic(&original_path, &image.bytes)?;
        if let Ok(bytes) = thumb::render_webp(&image.bytes) {
            let _ = write_atomic(&thumb_path, &bytes);
        }
        Ok((id, rel))
    }

    /// 走到"原图已替换、元数据未更新"这一步就返回。
    pub fn repair_until_publish(
        conn: &mut Connection,
        layout: &Layout,
        generation: &str,
        attachment_id: &str,
        source: &Path,
    ) -> AppResult<()> {
        let current = read_view(conn, layout, generation, attachment_id)?;
        let image = import::read_and_validate(source)?;
        let ext = extension_of(&current.original_path);
        let rel = format!("{DIR_ORIGINALS}/{}.{ext}", current.id);
        let final_path = abs_path(layout, generation, &rel)?;
        let stage_rel = staging_rel(&current.id, image.kind.extension());
        let staging_path = abs_path(layout, generation, &stage_rel)?;
        let backup_path = abs_path(layout, generation, &backup_rel(&current.id, &ext))?;

        let _job = start_job(
            conn,
            "repair",
            &current.id,
            generation,
            &rel,
            Some(&stage_rel),
            Some(&image.sha256),
            None,
        )?;
        write_atomic(&staging_path, &image.bytes)?;
        if final_path.is_file() {
            if let Some(parent) = backup_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(&final_path, &backup_path)?;
        }
        std::fs::rename(&staging_path, &final_path)?;
        Ok(())
    }
}
