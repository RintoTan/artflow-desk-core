//! 订单参考图片：导入、列表、移除、校验、修复、缩略图重建。
//!
//! 一致性策略：
//! - 导入先落文件再写元数据；元数据写失败就删掉刚写的文件，不留孤立行。
//! - 移除先在事务里登记清理任务并删行，提交后再删文件；崩溃后任务可重试（FIX-05）。
//! - 缩略图只是缓存，任何缩略图问题都不影响原图与元数据。

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::media::import::{self, ValidatedImage};
use crate::media::thumb;
use crate::media::{self, ImageKind};
use crate::store::paths::Layout;
use crate::store::timezone;

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
    /// 绝对路径，供前端用 asset 协议预览。
    pub original_path: String,
    pub thumb_path: Option<String>,
    pub file_exists: bool,
    pub thumb_exists: bool,
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

fn generation_root(layout: &Layout, generation: &str) -> PathBuf {
    layout.generation_dir(generation)
}

fn abs_original(layout: &Layout, generation: &str, rel: &str) -> AppResult<PathBuf> {
    media::safe_join(&generation_root(layout, generation), rel)
}

fn order_exists(conn: &Connection, order_id: &str) -> AppResult<()> {
    let found: Option<i64> = conn
        .query_row("SELECT 1 FROM orders WHERE id = ?1", [order_id], |r| r.get(0))
        .optional()?;
    found.map(|_| ()).ok_or_else(|| AppError::not_found("订单不存在"))
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

    let original = abs_original(layout, generation, &row.6)?;
    let thumb_abs = match &row.7 {
        Some(rel) => Some(abs_original(layout, generation, rel)?),
        None => None,
    };

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
        file_exists: original.is_file(),
        thumb_exists: thumb_abs.as_ref().map(|p| p.is_file()).unwrap_or(false),
        original_path: original.to_string_lossy().to_string(),
        thumb_path: thumb_abs.map(|p| p.to_string_lossy().to_string()),
    })
}

pub fn list(
    conn: &Connection,
    layout: &Layout,
    generation: &str,
    order_id: &str,
) -> AppResult<Vec<AttachmentView>> {
    order_exists(conn, order_id)?;
    let mut stmt = conn.prepare(
        "SELECT id FROM attachments WHERE order_id = ?1 ORDER BY created_at, id",
    )?;
    let ids: Vec<String> = stmt
        .query_map([order_id], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    ids.iter()
        .map(|id| read_view(conn, layout, generation, id))
        .collect()
}

fn write_atomic(target: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temp = target.with_extension(format!(
        "{}.tmp-{}",
        target
            .extension()
            .map(|e| e.to_string_lossy().to_string())
            .unwrap_or_default(),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&temp, bytes)?;
    std::fs::rename(&temp, target).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        AppError::io(format!("写入附件失败：{e}"))
    })?;
    Ok(())
}

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
    let original_path = abs_original(layout, generation, &rel)?;
    let thumb_path = abs_original(layout, generation, &thumb_rel)?;

    write_atomic(&original_path, &image.bytes)?;

    // 缩略图失败不阻断导入：先记 NULL，之后再重建。
    let thumb_written = match thumb::render_webp(&image.bytes) {
        Ok(bytes) => match write_atomic(&thumb_path, &bytes) {
            Ok(()) => true,
            Err(_) => false,
        },
        Err(_) => false,
    };

    let now = timezone::now_timestamp();
    let inserted = conn.execute(
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
        // 元数据没写进去，就把刚落的文件删掉，避免孤立文件。
        let _ = std::fs::remove_file(&original_path);
        if thumb_written {
            let _ = std::fs::remove_file(&thumb_path);
        }
        return Err(e.into());
    }

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

/// 移除：事务内登记清理任务并删元数据，提交后再删文件。
pub fn remove(
    conn: &mut Connection,
    layout: &Layout,
    generation: &str,
    attachment_id: &str,
) -> AppResult<()> {
    let view = read_view(conn, layout, generation, attachment_id)?;
    let now = timezone::now_timestamp();

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for (index, rel) in [
        media::original_rel_path(&view.id, extension_of(&view.original_path)),
        media::thumb_rel_path(&view.id),
    ]
    .iter()
    .enumerate()
    {
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

    // 提交后再删文件；失败留下 pending 任务，下次启动可重试。
    let targets: Vec<Option<String>> = vec![Some(view.original_path.clone()), view.thumb_path.clone()];
    for (index, target) in targets.into_iter().enumerate() {
        let Some(path) = target else { continue };
        if Path::new(&path).exists() {
            let _ = std::fs::remove_file(&path);
        }
        let task_id = format!("cl-{}-{index}", view.id);
        conn.execute(
            "UPDATE cleanup_tasks SET state = 'done', last_attempt_at = ?1, attempts = attempts + 1
             WHERE id = ?2",
            params![now, task_id],
        )?;
    }
    Ok(())
}

fn extension_of(path: &str) -> &str {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub ok: usize,
    pub missing: usize,
    pub corrupt: usize,
    pub attachments: Vec<AttachmentView>,
}

/// 校验原图：存在性与 SHA-256，必要时更新 `state`。
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
        let mut updated = view;
        updated.state = next_state.to_string();
        report.attachments.push(updated);
    }
    Ok(report)
}

/// 重建缩略图：只读原图，已有且可用的直接跳过。
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
        let thumb_path = abs_original(layout, generation, &media::thumb_rel_path(&view.id))?;
        if thumb_path.is_file() && thumb_path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
            // 已有缓存且非空：补上数据库引用即可。
            if view.thumb_path.is_none() {
                conn.execute(
                    "UPDATE attachments SET thumb_rel_path = ?1 WHERE id = ?2",
                    params![media::thumb_rel_path(&view.id), view.id],
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
                    params![media::thumb_rel_path(&view.id), view.id],
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairInput {
    pub attachment_id: String,
    pub source_path: String,
}

/// 用一张新的有效图片修复原图：保持附件 ID 与相对路径不变，只换内容。
pub fn repair(
    conn: &mut Connection,
    layout: &Layout,
    generation: &str,
    input: RepairInput,
) -> AppResult<AttachmentView> {
    let current = read_view(conn, layout, generation, &input.attachment_id)?;
    let image = import::read_and_validate(Path::new(&input.source_path))?;

    let original_path = Path::new(&current.original_path);
    write_atomic(original_path, &image.bytes)?;

    let thumb_path = abs_original(layout, generation, &media::thumb_rel_path(&current.id))?;
    let thumb_written = match thumb::render_webp(&image.bytes) {
        Ok(bytes) => write_atomic(&thumb_path, &bytes).is_ok(),
        Err(_) => false,
    };

    conn.execute(
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
            if thumb_written { Some(media::thumb_rel_path(&current.id)) } else { None },
            current.id
        ],
    )?;

    read_view(conn, layout, generation, &current.id)
}

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
