//! DEV-0.1.1-05：自定义存储位置与完整数据根迁移（`DATA-LIFECYCLE §7`）。
//!
//! 迁移的是**整个数据环境**，不是"当前那个库"：
//! `environment.json`、`state/`、**全部代际**、`backups/`（含 `.tmp`）、
//! `recovery/failed-restore-*`、以及 QA 的 `.qa-root` 都要一起走。
//! 只搬当前代际等于把用户重置前的历史数据留在旧盘上，看起来像丢了。
//!
//! 不搬的东西同样明确：`logs/`（本来就不在数据根里）、`.write.lock`（到目标根重建）、
//! `root.json`（它是引导指针，不属于载荷）、`recovery/state.json`（存在即拒绝迁移）。
//!
//! 失败必须可回滚：指针只在数据与校验都通过之后才切换，切换后自检失败就把指针改回去。

use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::backup::create as backup_create;
use crate::error::{AppError, AppResult};
use crate::infra::lock::DirLock;
use crate::store::environment::{open_connection, Environment};
use crate::store::highwater::HighWater;
use crate::store::paths::Layout;
use crate::store::rootptr::{self, RootPointer};
use crate::store::timezone;

/// 迁移前必须为空的根内文件；它们会在目标根重新生成。
const NOT_PAYLOAD: [&str; 2] = [".write.lock", "root.json"];

/// 目标根至少要有载荷的 1.2 倍空间。
const SPACE_FACTOR: f64 = 1.2;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadEntry {
    /// 相对数据根的路径
    pub rel_path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigratePreview {
    pub source_root: String,
    pub target_root: String,
    pub files: u64,
    pub bytes: u64,
    /// 需要迁移的代际 ID（全部，不只是活动代际）
    pub generations: Vec<String>,
    pub has_backups: bool,
    pub has_quarantine_evidence: bool,
    pub available_bytes: u64,
    pub required_bytes: u64,
    pub fits: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateReport {
    pub source_root: String,
    pub target_root: String,
    pub files: u64,
    pub bytes: u64,
    pub generations: Vec<String>,
    pub copied_files: u64,
    pub verified_files: u64,
    pub snapshot_path: Option<String>,
    /// 已切换指针；需要重启才能使用新位置。
    pub switched: bool,
}

fn sha256_file(path: &Path) -> AppResult<String> {
    let mut file = File::open(path)
        .map_err(|e| AppError::io(format!("无法读取 {}：{e}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buf)?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// 收集载荷。符号链接一律拒绝——迁移里跟随链接会把盘外的东西卷进来。
fn walk(root: &Path, dir: &Path, out: &mut Vec<PayloadEntry>) -> AppResult<()> {
    let entries = fs::read_dir(dir)
        .map_err(|e| AppError::io(format!("无法读取 {}：{e}", dir.display())))?;
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path)?;
        if meta.file_type().is_symlink() {
            return Err(AppError::invalid(format!(
                "数据目录里存在符号链接，已停止迁移：{}",
                path.display()
            )));
        }
        if meta.is_dir() {
            walk(root, &path, out)?;
        } else if meta.is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(|_| AppError::io("无法计算相对路径"))?;
            out.push(PayloadEntry {
                rel_path: rel.to_string_lossy().replace('\\', "/"),
                bytes: meta.len(),
            });
        } else {
            return Err(AppError::invalid(format!(
                "数据目录里存在不支持的文件类型，已停止迁移：{}",
                path.display()
            )));
        }
    }
    Ok(())
}

fn collect(root: &Path) -> AppResult<Vec<PayloadEntry>> {
    let mut entries = Vec::new();
    for top in [
        "environment.json",
        "state",
        "generations",
        "backups",
        "recovery",
        ".qa-root",
    ] {
        let path = root.join(top);
        if !path.exists() {
            continue;
        }
        let meta = fs::symlink_metadata(&path)?;
        if meta.is_dir() {
            walk(root, &path, &mut entries)?;
        } else if meta.is_file() {
            entries.push(PayloadEntry {
                rel_path: top.to_string(),
                bytes: meta.len(),
            });
        }
    }

    entries.retain(|entry| {
        let name = entry.rel_path.rsplit('/').next().unwrap_or("");
        !NOT_PAYLOAD.contains(&name) && !entry.rel_path.starts_with("logs/")
    });
    entries.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(entries)
}

fn generations_of(entries: &[PayloadEntry]) -> Vec<String> {
    let mut ids = BTreeSet::new();
    for entry in entries {
        if let Some(rest) = entry.rel_path.strip_prefix("generations/") {
            if let Some(id) = rest.split('/').next() {
                if id.starts_with("gen-") {
                    ids.insert(id.to_string());
                }
            }
        }
    }
    ids.into_iter().collect()
}

fn total_bytes(entries: &[PayloadEntry]) -> u64 {
    entries.iter().map(|e| e.bytes).sum()
}

fn required_space(bytes: u64) -> u64 {
    (bytes as f64 * SPACE_FACTOR).ceil() as u64
}

/// 迁移前预览：载荷、代际列表、空间是否够。界面用它来确认，不直接开始搬。
pub fn preview(env: &Environment, target: &Path) -> AppResult<MigratePreview> {
    rootptr::check_target(env.root(), target)?;
    check_recovery_state(env.layout())?;

    let entries = collect(env.root())?;
    let bytes = total_bytes(&entries);
    let available = rootptr::available_space(target).unwrap_or(0);
    let required = required_space(bytes);

    Ok(MigratePreview {
        source_root: env.root().display().to_string(),
        target_root: target.display().to_string(),
        files: entries.len() as u64,
        bytes,
        generations: generations_of(&entries),
        has_backups: env.layout().backups_dir().exists(),
        has_quarantine_evidence: recovery_evidence(env.layout()).len() > 0,
        available_bytes: available,
        required_bytes: required,
        fits: available >= required,
    })
}

/// `recovery/state.json` 代表上一次恢复没走完。带着它迁移，新根会以为自己
/// 需要收拾一个根本不存在的半边代际，所以必须先把它做完。
fn check_recovery_state(layout: &Layout) -> AppResult<()> {
    if layout.recovery_dir().join("state.json").exists() {
        return Err(AppError::conflict(
            "上一次数据恢复尚未完成，请先完成或放弃该恢复，再迁移数据位置",
        ));
    }
    Ok(())
}

fn recovery_evidence(layout: &Layout) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if let Ok(entries) = fs::read_dir(layout.recovery_dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir()
                && path
                    .file_name()
                    .map(|n| n.to_string_lossy().starts_with("failed-restore-"))
                    .unwrap_or(false)
            {
                found.push(path);
            }
        }
    }
    found
}

fn verify_generation_dbs(target: &Path, entries: &[PayloadEntry]) -> AppResult<()> {
    for id in generations_of(entries) {
        let db = target
            .join("generations")
            .join(&id)
            .join("database.sqlite");
        if !db.exists() {
            return Err(AppError::db(format!("代际 {id} 的数据库没有复制过来")));
        }
        let conn = open_connection(&db)?;
        let integrity: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if integrity != "ok" {
            return Err(AppError::db(format!(
                "代际 {id} 的数据完整性检查失败：{integrity}"
            )));
        }
        let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
        let mut rows = stmt.query([])?;
        if rows.next()?.is_some() {
            return Err(AppError::db(format!("代际 {id} 存在孤立引用")));
        }
    }
    Ok(())
}

fn copy_payload(
    source: &Path,
    target: &Path,
    entries: &[PayloadEntry],
    hashes: &mut Vec<(String, String)>,
) -> AppResult<()> {
    for entry in entries {
        let from = source.join(entry.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        let to = target.join(entry.rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut reader = File::open(&from)
            .map_err(|e| AppError::io(format!("无法读取 {}：{e}", from.display())))?;
        let mut writer = File::create(&to)
            .map_err(|e| AppError::io(format!("无法写入 {}：{e}", to.display())))?;
        let mut hasher = Sha256::new();
        let mut buf = [0u8; 64 * 1024];
        loop {
            let read = reader.read(&mut buf)?;
            if read == 0 {
                break;
            }
            hasher.update(&buf[..read]);
            writer.write_all(&buf[..read])?;
        }
        writer.sync_all()?;
        let digest: String = hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        hashes.push((entry.rel_path.clone(), digest));
    }
    Ok(())
}

fn cleanup_target(target: &Path) {
    // 目标在开始前必须是空的，所以这里删掉的都是本次自己建出来的。
    for top in [
        "environment.json",
        "state",
        "generations",
        "backups",
        "recovery",
        ".qa-root",
        ".write.lock",
    ] {
        let path = target.join(top);
        if path.is_dir() {
            let _ = fs::remove_dir_all(&path);
        } else if path.exists() {
            let _ = fs::remove_file(&path);
        }
    }
}

fn is_empty_dir(path: &Path) -> bool {
    match fs::read_dir(path) {
        Ok(mut entries) => entries.next().is_none(),
        Err(_) => false,
    }
}

/// 执行迁移。`pointer_path` 是稳定引导位置上的指针文件。
pub fn run(
    env: &Environment,
    highwater: &HighWater,
    target: &Path,
    pointer_path: &Path,
) -> AppResult<MigrateReport> {
    let source_root = env.root().to_path_buf();
    let layout = env.layout().clone();

    rootptr::check_target(&source_root, target)?;
    check_recovery_state(&layout)?;
    if target.exists() && !is_empty_dir(target) {
        return Err(AppError::conflict(
            "目标目录不是空的，不会覆盖或合并其中已有的文件",
        ));
    }
    fs::create_dir_all(target)?;
    let target = fs::canonicalize(target)?;

    // 1) 载荷与空间
    let first_pass = collect(&source_root)?;
    let bytes_before = total_bytes(&first_pass);
    let available = rootptr::available_space(&target)
        .ok_or_else(|| AppError::env("无法读取目标位置剩余空间"))?;
    if available < required_space(bytes_before) {
        return Err(AppError::invalid(format!(
            "目标位置空间不足：需要约 {} MB，可用 {} MB",
            required_space(bytes_before) / 1_048_576,
            available / 1_048_576
        )));
    }

    // 2) 快照落在旧根；它也是载荷的一部分，所以之后要重算一次。
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let snapshot = layout.backups_dir().join(format!("pre-migrate-{stamp}.zip"));
    backup_create::create(env, highwater, &snapshot)?;

    let entries = collect(&source_root)?;
    let bytes = total_bytes(&entries);
    let available_again = rootptr::available_space(&target)
        .ok_or_else(|| AppError::env("无法读取目标位置剩余空间"))?;
    if available_again < required_space(bytes) {
        return Err(AppError::invalid(
            "生成安全快照后空间不足，已停止迁移（快照保留在旧目录）",
        ));
    }

    // 3) 复制 + 逐文件哈希
    let mut hashes = Vec::with_capacity(entries.len());
    if let Err(e) = copy_payload(&source_root, &target, &entries, &mut hashes) {
        cleanup_target(&target);
        return Err(e);
    }

    // 4) 校验：数量、字节、逐文件哈希、每个代际的库
    let copied = collect(&target).unwrap_or_default();
    let verify = (|| -> AppResult<()> {
        if copied.len() != entries.len() {
            return Err(AppError::db(format!(
                "复制后的文件数量不符：应 {} 个，实际 {} 个",
                entries.len(),
                copied.len()
            )));
        }
        if total_bytes(&copied) != bytes {
            return Err(AppError::db("复制后的总字节数不符"));
        }
        for (rel, expected) in &hashes {
            let path = target.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            let actual = sha256_file(&path)?;
            if &actual != expected {
                return Err(AppError::db(format!("文件内容校验失败：{rel}")));
            }
        }
        verify_generation_dbs(&target, &entries)?;
        Ok(())
    })();
    if let Err(e) = verify {
        cleanup_target(&target);
        return Err(e);
    }

    // 5) 目标根取锁 → 切指针 → 用同一把锁打开新环境做只读自检
    let lock = match DirLock::acquire(&target) {
        Ok(lock) => lock,
        Err(e) => {
            cleanup_target(&target);
            return Err(e);
        }
    };

    let previous = rootptr::read(pointer_path).ok().flatten();
    let pointer = RootPointer {
        data_root: target.display().to_string(),
        updated_at: timezone::now_timestamp(),
    };
    if let Err(e) = rootptr::write_atomic(pointer_path, &pointer) {
        drop(lock);
        cleanup_target(&target);
        return Err(e);
    }

    let opened = Environment::open_with_lock(
        target.clone(),
        lock,
        &crate::store::migrations::production(),
        crate::store::migrations::APP_SCHEMA_VERSION,
        None,
    );

    let verified = match opened {
        Ok(new_env) => self_check(&new_env),
        Err(e) => Err(AppError::db(format!("新位置无法打开：{}", e.message))),
    };

    if let Err(e) = verified {
        // 指针回滚：宁可回到旧位置，也不能留下一个指向坏数据的指针。
        match previous {
            Some(old) => {
                let _ = rootptr::write_atomic(pointer_path, &old);
            }
            None => {
                let _ = rootptr::clear(pointer_path);
            }
        }
        cleanup_target(&target);
        return Err(e);
    }

    Ok(MigrateReport {
        source_root: source_root.display().to_string(),
        target_root: target.display().to_string(),
        files: entries.len() as u64,
        bytes,
        generations: generations_of(&entries),
        copied_files: copied.len() as u64,
        verified_files: hashes.len() as u64,
        snapshot_path: Some(snapshot.display().to_string()),
        switched: true,
    })
}

/// 只读自检：结构、活动代际、以及**真的读一张附件**。
/// 只过 integrity_check 不算迁移成功——附件读不到，界面一样是裂图。
fn self_check(env: &Environment) -> AppResult<()> {
    let conn: Connection = env.open_db()?;
    let generation = env.active_generation();
    let orders: i64 = conn.query_row("SELECT COUNT(*) FROM orders_visible", [], |r| r.get(0))?;
    if orders < 0 {
        return Err(AppError::db("新位置的活动代际不可读"));
    }
    let attachment: Option<String> = conn
        .query_row(
            "SELECT rel_path FROM attachments WHERE state = 'ok' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok();
    if let Some(rel) = attachment {
        let path = env.layout().attachments_dir(&generation).join(rel);
        if !path.exists() {
            return Err(AppError::db(format!(
                "新位置缺少附件原图：{}",
                path.display()
            )));
        }
        let mut buf = [0u8; 16];
        let mut file = File::open(&path)
            .map_err(|e| AppError::db(format!("新位置附件无法打开：{e}")))?;
        let read = file.read(&mut buf)?;
        if read == 0 {
            return Err(AppError::db("新位置附件是空文件"));
        }
    }
    Ok(())
}
