//! 导出备份包：SQLite 一致性快照 + 附件 + Manifest + SHA-256 → ZIP。
//!
//! 两条硬约束：
//! 1. **不能在 WAL 还有未落盘内容时直接拷 `database.sqlite`**，用 `VACUUM INTO`
//!    让 SQLite 自己产出一份内部一致、含 WAL 已提交事务的快照；
//! 2. **写完必须自己再读一遍**（`zip_read::inspect`），校验不过就当没有产出，
//!    绝不把可疑 ZIP 当成功交给用户。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

use crate::backup::manifest;
use crate::backup::state as backup_state;
use crate::backup::zip_read::{self, ManifestFile};
use crate::error::{AppError, AppResult};
use crate::store::environment::{open_connection, Environment};
use crate::store::highwater::HighWater;
use crate::store::paths::Layout;
use crate::store::settings;
use crate::store::timezone;

/// 附件目录里需要进包的子目录（相对 generation 根）。
const ATTACHMENT_DIRS: &[&str] = &[
    "attachments/originals",
    "attachments/thumbs",
    "attachments/quarantine",
];

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub path: String,
    pub bytes: u64,
    pub files: usize,
    pub attachment_files: usize,
    pub database_bytes: u64,
    pub schema_version: i64,
    pub summary: manifest::DataSummary,
    pub created_at: String,
}

/// 默认导出位置：数据根下的 `backups/`，文件名带时间戳。
pub fn default_target(layout: &Layout, now: &chrono::DateTime<chrono::Local>) -> PathBuf {
    let stamp = now.format("%Y%m%d-%H%M%S");
    layout
        .backups_dir()
        .join(format!("artflow-backup-{stamp}.zip"))
}

/// 列出某代际内需要打包的附件文件（相对路径，已排序）。
pub fn attachment_files(layout: &Layout, generation: &str) -> AppResult<Vec<(String, PathBuf)>> {
    let mut out = Vec::new();
    for dir in ATTACHMENT_DIRS {
        let root = layout.generation_dir(generation).join(dir);
        if !root.exists() {
            continue;
        }
        let mut stack = vec![root.clone()];
        while let Some(current) = stack.pop() {
            for entry in fs::read_dir(&current)? {
                let entry = entry?;
                let meta = fs::symlink_metadata(entry.path())?;
                if meta.file_type().is_symlink() {
                    return Err(AppError::io(format!(
                        "附件目录里出现符号链接，拒绝备份：{}",
                        entry.path().display()
                    )));
                }
                if meta.is_dir() {
                    stack.push(entry.path());
                    continue;
                }
                if !meta.is_file() {
                    continue;
                }
                let rel = entry
                    .path()
                    .strip_prefix(layout.generation_dir(generation))
                    .map_err(|_| AppError::io("附件路径越界"))?
                    .to_string_lossy()
                    .replace('\\', "/");
                // 备份包只允许 ASCII 相对路径（与读取侧规则一致）。
                if let Some(reason) = zip_read::reject_reason(&rel) {
                    return Err(AppError::io(format!("附件路径不合规（{reason}）：{rel}")));
                }
                out.push((rel, entry.path()));
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

struct ZipWriter {
    inner: zip::ZipWriter<fs::File>,
    options: SimpleFileOptions,
}

impl ZipWriter {
    fn add_file(&mut self, name: &str, source: &Path) -> AppResult<(u64, String)> {
        use std::io::Read;
        self.inner
            .start_file(name, self.options)
            .map_err(|e| AppError::zip(format!("写入 ZIP 失败：{e}")))?;
        let mut file = fs::File::open(source)?;
        let mut hasher = sha2::Sha256::new();
        use sha2::Digest;
        let mut buffer = vec![0u8; 128 * 1024];
        let mut total = 0u64;
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            self.inner
                .write_all(&buffer[..read])
                .map_err(|e| AppError::zip(format!("写入 ZIP 失败：{e}")))?;
            total += read as u64;
        }
        let digest: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        Ok((total, digest))
    }

    fn add_bytes(&mut self, name: &str, bytes: &[u8]) -> AppResult<()> {
        use sha2::Digest;
        self.inner
            .start_file(name, self.options)
            .map_err(|e| AppError::zip(format!("写入 ZIP 失败：{e}")))?;
        self.inner
            .write_all(bytes)
            .map_err(|e| AppError::zip(format!("写入 ZIP 失败：{e}")))?;
        let _ = sha2::Sha256::digest(bytes);
        Ok(())
    }

    fn finish(self) -> AppResult<()> {
        self.inner
            .finish()
            .map_err(|e| AppError::zip(format!("ZIP 收尾失败：{e}")))?;
        Ok(())
    }
}

/// 在临时目录里完成打包 → 自检 → 才落到目标路径。
pub fn create(env: &Environment, highwater: &HighWater, target: &Path) -> AppResult<Created> {
    let layout = env.layout();
    let generation = env.active_generation().to_string();
    let now = timezone::now_timestamp();
    let local = chrono::Local::now();

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    if target.exists() {
        return Err(AppError::invalid(format!(
            "目标文件已存在，不会覆盖：{}",
            target.display()
        )));
    }

    // 临时工作区放在目标同目录，保证最终 rename 不跨卷。
    let work = target
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(".artflow-backup-{}.tmp", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&work)?;
    let temp_zip = work.join("package.zip");

    let result = (|| -> AppResult<Created> {
        // 1) 一致性数据库快照（含 WAL 已提交事务）。
        let snapshot = work.join("database.sqlite");
        {
            let conn = open_connection(&layout.generation_db(&generation))?;
            conn.execute(
                "VACUUM INTO ?1",
                [snapshot.to_string_lossy().to_string()],
            )
            .map_err(|e| AppError::io(format!("数据库快照失败：{e}")))?;
        }
        {
            // 快照自己能打开、结构完整，才允许继续。
            let conn = open_connection(&snapshot)?;
            let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
            if integrity != "ok" {
                return Err(AppError::io(format!("数据库快照校验失败：{integrity}")));
            }
        }

        let conn = open_connection(&snapshot)?;
        let summary = manifest::summarize(&conn)?;
        let tz = settings::working_timezone(&conn)?.name().to_string();
        drop(conn);

        let watermarks: Vec<zip_read::YearWatermark> = highwater
            .snapshot()?
            .into_iter()
            .map(|w| zip_read::YearWatermark {
                year: w.year,
                last_allocated: w.last_allocated,
            })
            .collect();

        // 2) 收集附件。
        let attachments = attachment_files(layout, &generation)?;

        // 3) 写包：数据库 → 附件 → manifest（manifest 最后写）。
        let file = fs::File::create(&temp_zip)?;
        let mut writer = ZipWriter {
            inner: zip::ZipWriter::new(file),
            options: SimpleFileOptions::default()
                .compression_method(CompressionMethod::Deflated)
                .unix_permissions(0o644),
        };

        let mut listed: Vec<ManifestFile> = Vec::with_capacity(attachments.len() + 1);
        let (db_bytes, db_sha) = writer.add_file(zip_read::DATABASE_NAME, &snapshot)?;
        listed.push(ManifestFile {
            path: zip_read::DATABASE_NAME.to_string(),
            bytes: db_bytes,
            sha256: db_sha,
        });
        for (rel, source) in &attachments {
            let (bytes, sha) = writer.add_file(rel, source)?;
            listed.push(ManifestFile {
                path: rel.clone(),
                bytes,
                sha256: sha,
            });
        }

        let manifest = manifest::build(
            env!("CARGO_PKG_VERSION"),
            env.outcome().schema_version,
            &now,
            &tz,
            &watermarks,
            listed,
        );
        let raw = serde_json::to_vec_pretty(&manifest)?;
        writer.add_bytes(zip_read::MANIFEST_NAME, &raw)?;
        writer.finish()?;

        // 4) 自检：读回、逐文件 SHA-256、路径安全。不通过就当没产出。
        let inspection = zip_read::inspect(&temp_zip)?;

        // 5) 原子落位。
        fs::rename(&temp_zip, target)?;
        let bytes = fs::metadata(target)?.len();

        backup_state::record_success(layout, &now, target)?;

        Ok(Created {
            path: target.to_string_lossy().to_string(),
            bytes,
            files: inspection.entries,
            attachment_files: inspection.attachment_files,
            database_bytes: inspection.database_bytes,
            schema_version: manifest.schema_version,
            summary,
            created_at: local.to_rfc3339(),
        })
    })();

    if result.is_err() {
        let _ = fs::remove_dir_all(&work);
        // 失败绝不能留下"看起来是备份"的文件。
        let _ = fs::remove_file(target);
    } else {
        let _ = fs::remove_dir_all(&work);
    }
    result
}
