//! 客户参考图：属于客户的图片，与订单附件分开存表。
//!
//! 为什么不复用 `attachments`：那一条记录的归属是订单，订单删了它就该消失；
//! 客户参考图的归属是客户，和订单生命周期无关。把两种归属塞进一张表，
//! 之后每个查询都要先问"这条到底属于谁"，删除与备份也会跟着变复杂。
//!
//! 文件仍写在受管的 `attachments/` 目录树内（`originals/clients/<客户>/`），
//! 备份、恢复、完整性校验和隔离区这些通道因此天然覆盖它，不需要各改一遍。

use std::path::PathBuf;

use rusqlite::{params, Connection, TransactionBehavior};
use serde::Serialize;

use crate::domain::attachments::{abs_path, gen_root, published_path, write_atomic, DIR_ORIGINALS, DIR_THUMBS};
use crate::error::{AppError, AppResult};
use crate::media::import::{self as image_import, ValidatedImage};
use crate::media::thumb;
use crate::store::paths::Layout;
use crate::store::timezone;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientRefView {
    pub id: String,
    pub client_id: String,
    pub original_name: String,
    pub mime_type: String,
    pub byte_size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub state: String,
    pub created_at: String,
    /// 可发布路径；空串表示文件不在，界面应显示占位而不是坏图。
    pub original_path: String,
    pub thumb_path: Option<String>,
    pub file_exists: bool,
    pub thumb_exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientRefOutcome {
    pub source_name: String,
    pub ok: bool,
    pub attachment: Option<ClientRefView>,
    pub error: Option<String>,
}

fn client_exists(conn: &Connection, client_id: &str) -> AppResult<()> {
    // 走可见性守卫：回收站里的客户不该还能往上面加参考图。
    crate::store::visibility::require_visible_client(conn, client_id)
}

fn rel_for(client_id: &str, id: &str, ext: &str) -> String {
    format!("{DIR_ORIGINALS}/clients/{client_id}/{id}.{ext}")
}

fn thumb_rel_for(client_id: &str, id: &str) -> String {
    format!("{DIR_THUMBS}/clients/{client_id}/{id}.webp")
}

fn read_view(
    conn: &Connection,
    layout: &Layout,
    generation: &str,
    id: &str,
) -> AppResult<ClientRefView> {
    let row = conn
        .query_row(
            "SELECT id, client_id, original_name, rel_path, thumb_rel_path, mime_type,
                    byte_size, width, height, state, created_at
             FROM client_attachments WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, Option<i64>>(7)?,
                    r.get::<_, Option<i64>>(8)?,
                    r.get::<_, String>(9)?,
                    r.get::<_, String>(10)?,
                ))
            },
        )
        .optional_err()?;

    let root = gen_root(layout, generation);
    let original = abs_path(layout, generation, &row.3)?;
    let thumb_abs = match &row.4 {
        Some(rel) => Some(abs_path(layout, generation, rel)?),
        None => None,
    };
    let thumb_published = thumb_abs
        .as_ref()
        .filter(|p| p.is_file())
        .map(|p| published_path(&root, p))
        .filter(|s| !s.is_empty());

    Ok(ClientRefView {
        id: row.0,
        client_id: row.1,
        original_name: row.2,
        mime_type: row.5,
        byte_size: row.6,
        width: row.7,
        height: row.8,
        state: row.9,
        created_at: row.10,
        file_exists: original.is_file(),
        thumb_exists: thumb_published.is_some(),
        original_path: published_path(&root, &original),
        thumb_path: thumb_published,
    })
}

/// 小工具：把 `query_row` 的「没有这一行」转成明确的 404。
trait OptionalErr<T> {
    fn optional_err(self) -> AppResult<T>;
}

impl<T> OptionalErr<T> for rusqlite::Result<T> {
    fn optional_err(self) -> AppResult<T> {
        match self {
            Ok(value) => Ok(value),
            Err(rusqlite::Error::QueryReturnedNoRows) => Err(AppError::not_found("参考图不存在")),
            Err(e) => Err(e.into()),
        }
    }
}

pub fn list(
    conn: &Connection,
    layout: &Layout,
    generation: &str,
    client_id: &str,
) -> AppResult<Vec<ClientRefView>> {
    client_exists(conn, client_id)?;
    let mut stmt = conn.prepare(
        "SELECT id FROM client_attachments WHERE client_id = ?1 ORDER BY created_at DESC, id DESC",
    )?;
    let ids: Vec<String> = stmt
        .query_map([client_id], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    ids.iter()
        .map(|id| read_view(conn, layout, generation, id))
        .collect()
}

/// 导入一张参考图。
///
/// 顺序刻意是「先插一行 state=missing → 写文件 → 改回 ok」：
/// 中途崩溃时库里留下一条看得见的未完成记录，而不是磁盘上一个没人知道的孤儿文件。
fn insert_one(
    conn: &mut Connection,
    layout: &Layout,
    generation: &str,
    client_id: &str,
    image: &ValidatedImage,
) -> AppResult<ClientRefView> {
    let id = uuid::Uuid::new_v4().to_string();
    let rel = rel_for(client_id, &id, image.kind.extension());
    let thumb_rel = thumb_rel_for(client_id, &id);
    let original_path = abs_path(layout, generation, &rel)?;
    let thumb_path = abs_path(layout, generation, &thumb_rel)?;
    let now = timezone::now_timestamp();

    {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO client_attachments (
                id, client_id, original_name, rel_path, thumb_rel_path,
                mime_type, byte_size, sha256, width, height, state, created_at
             ) VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, 'missing', ?10)",
            params![
                id,
                client_id,
                image.original_name,
                rel,
                image.kind.mime(),
                image.bytes.len() as i64,
                image.sha256,
                image.width as i64,
                image.height as i64,
                now
            ],
        )?;
        tx.commit()?;
    }

    write_atomic(&original_path, &image.bytes)?;
    // 缩略图失败不影响这张图能用：列表会退回原图。
    let thumb_written = match thumb::render_webp(&image.bytes) {
        Ok(bytes) => write_atomic(&thumb_path, &bytes).is_ok(),
        Err(_) => false,
    };

    conn.execute(
        "UPDATE client_attachments SET state = 'ok', thumb_rel_path = ?1 WHERE id = ?2",
        params![if thumb_written { Some(thumb_rel) } else { None }, id],
    )?;

    read_view(conn, layout, generation, &id)
}

pub fn import(
    conn: &mut Connection,
    layout: &Layout,
    generation: &str,
    client_id: &str,
    sources: &[PathBuf],
) -> AppResult<Vec<ClientRefOutcome>> {
    client_exists(conn, client_id)?;
    if sources.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::with_capacity(sources.len());
    for source in sources {
        let name = source
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| source.to_string_lossy().to_string());
        match image_import::read_and_validate(source) {
            Ok(image) => match insert_one(conn, layout, generation, client_id, &image) {
                Ok(view) => out.push(ClientRefOutcome {
                    source_name: name,
                    ok: true,
                    attachment: Some(view),
                    error: None,
                }),
                Err(e) => out.push(ClientRefOutcome {
                    source_name: name,
                    ok: false,
                    attachment: None,
                    error: Some(e.message),
                }),
            },
            Err(e) => out.push(ClientRefOutcome {
                source_name: name,
                ok: false,
                attachment: None,
                error: Some(e.message),
            }),
        }
    }
    Ok(out)
}

/// 删除一张参考图：登记文件清理任务，再删行。
///
/// 先登记后删行：反过来的话，一旦在两步之间崩溃，文件就永远没人认领了。
pub fn remove(
    conn: &mut Connection,
    layout: &Layout,
    generation: &str,
    client_id: &str,
    id: &str,
) -> AppResult<()> {
    let (owner, rel, thumb_rel): (String, String, Option<String>) = conn
        .query_row(
            "SELECT client_id, rel_path, thumb_rel_path FROM client_attachments WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional_err()?;
    if owner != client_id {
        // 跨客户删除一律按"不存在"处理：不泄露别的客户有没有这张图。
        return Err(AppError::not_found("参考图不存在"));
    }

    let now = timezone::now_timestamp();
    let paths: Vec<String> = [Some(rel.clone()), thumb_rel.clone()]
        .into_iter()
        .flatten()
        .collect();
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for path in &paths {
        tx.execute(
            "INSERT OR IGNORE INTO cleanup_tasks (id, generation, order_id, rel_path, reason, created_at)
             VALUES (?1, ?2, NULL, ?3, 'client_attachment_removed', ?4)",
            params![uuid::Uuid::new_v4().to_string(), generation, path, now],
        )?;
    }
    tx.execute("DELETE FROM client_attachments WHERE id = ?1", [id])?;
    tx.commit()?;

    // 尽量当场删掉；删不掉就留给清理任务，不把失败当成删除失败。
    for rel in &paths {
        if let Ok(path) = abs_path(layout, generation, rel) {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}

/// 客户被永久删除前调用：把该客户所有参考图的文件登记进清理队列。
///
/// 表的行由 `ON DELETE CASCADE` 带走，文件不会——所以必须先登记再删客户。
pub fn enqueue_all_for_client(
    conn: &Connection,
    generation: &str,
    client_id: &str,
) -> AppResult<usize> {
    let mut stmt =
        conn.prepare("SELECT rel_path, thumb_rel_path FROM client_attachments WHERE client_id = ?1")?;
    let rows: Vec<(String, Option<String>)> = stmt
        .query_map([client_id], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    let now = timezone::now_timestamp();
    let mut queued = 0usize;
    for (rel, thumb_rel) in rows {
        for path in [Some(rel), thumb_rel].into_iter().flatten() {
            conn.execute(
                "INSERT OR IGNORE INTO cleanup_tasks (id, generation, order_id, rel_path, reason, created_at)
                 VALUES (?1, ?2, NULL, ?3, 'client_removed', ?4)",
                params![uuid::Uuid::new_v4().to_string(), generation, path, now],
            )?;
            queued += 1;
        }
    }
    Ok(queued)
}

/// 客户参考图的图片数与字节数，供备份摘要与状态页展示。
pub fn summary(conn: &Connection) -> AppResult<(i64, i64)> {
    Ok(conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(byte_size), 0) FROM client_attachments",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
}


/// 客户列表封面：每个客户取最近导入的一张参考图。
///
/// 与订单封面同样的取舍：文件不在就跳过这一张、继续找下一张，
/// 而不是把一个坏路径交给界面去显示成裂图。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCover {
    pub client_id: String,
    pub attachment_id: String,
    pub thumb_path: Option<String>,
    pub original_path: String,
}

pub fn covers(
    conn: &Connection,
    layout: &Layout,
    generation: &str,
    client_ids: &[String],
) -> AppResult<Vec<ClientCover>> {
    if client_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = vec!["?"; client_ids.len()].join(",");
    let sql = format!(
        "SELECT id, client_id, rel_path, thumb_rel_path
         FROM client_attachments
         WHERE state = 'ok' AND client_id IN ({placeholders})
         ORDER BY client_id, created_at DESC, id DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::ToSql> = client_ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
    let rows = stmt.query_map(params.as_slice(), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    })?;

    let root = gen_root(layout, generation);
    let mut out: Vec<ClientCover> = Vec::new();
    let mut taken: std::collections::HashSet<String> = std::collections::HashSet::new();
    for row in rows {
        let (id, client_id, rel_path, thumb_rel) = row?;
        if taken.contains(&client_id) {
            continue;
        }
        let original = abs_path(layout, generation, &rel_path)?;
        if !original.is_file() {
            continue;
        }
        let thumb = match &thumb_rel {
            Some(rel) => {
                let abs = abs_path(layout, generation, rel)?;
                if abs.is_file() {
                    let published = published_path(&root, &abs);
                    if published.is_empty() { None } else { Some(published) }
                } else {
                    None
                }
            }
            None => None,
        };
        taken.insert(client_id.clone());
        out.push(ClientCover {
            client_id,
            attachment_id: id,
            thumb_path: thumb,
            original_path: published_path(&root, &original),
        });
    }
    Ok(out)
}
