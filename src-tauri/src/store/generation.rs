//! 数据代际：活动指针、代际目录、以及"可清理性"判定。
//!
//! 代际是内部恢复机制，不是用户配置项（J-6）。清理只允许在
//! 文件身份、活动引用、回退需求与锁一致性全部确认后执行。

use std::fs;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::store::paths::Layout;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivePointer {
    pub generation: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryState {
    pub phase: String,
    pub previous_generation: String,
    pub target_generation: String,
    pub reason: String,
    pub written_at: String,
}

pub fn new_generation_id() -> String {
    format!("gen-{}", uuid::Uuid::new_v4().simple())
}

/// 原子写 JSON：先写临时文件并 fsync，再改名覆盖。
pub fn write_json_atomic(path: &Path, value: &impl Serialize) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::io("目标路径没有父目录"))?;
    fs::create_dir_all(parent)?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&tmp)?;
        let bytes = serde_json::to_vec_pretty(value)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

pub fn read_active(layout: &Layout) -> AppResult<Option<ActivePointer>> {
    let path = layout.active_pointer();
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)?;
    let pointer: ActivePointer = serde_json::from_str(&raw)
        .map_err(|e| AppError::env(format!("活动指针损坏，已阻止自动建库：{e}")))?;
    if pointer.generation.trim().is_empty() {
        return Err(AppError::env("活动指针为空，已阻止自动建库"));
    }
    Ok(Some(pointer))
}

pub fn write_active(layout: &Layout, generation: &str, now: &str) -> AppResult<()> {
    write_json_atomic(
        &layout.active_pointer(),
        &ActivePointer {
            generation: generation.to_string(),
            updated_at: now.to_string(),
        },
    )
}

pub fn read_recovery_state(layout: &Layout) -> Option<RecoveryState> {
    let raw = fs::read_to_string(layout.recovery_state()).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn clear_recovery_state(layout: &Layout) -> AppResult<()> {
    let path = layout.recovery_state();
    if path.exists() {
        fs::remove_file(&path)?;
    }
    Ok(())
}

/// `generations/` 下的普通目录名。
pub fn list_generations(layout: &Layout) -> AppResult<Vec<String>> {
    let dir = layout.generations_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir)?.flatten() {
        let meta = fs::symlink_metadata(entry.path())?;
        if meta.is_dir() && !meta.file_type().is_symlink() {
            if let Some(name) = entry.file_name().to_str() {
                out.push(name.to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationReport {
    pub active: String,
    pub total: usize,
    pub protected: Vec<String>,
    pub reclaimable: Vec<String>,
    /// 无法判断身份的项目（符号链接、缺库目录等），一律不删。
    pub unknown: Vec<String>,
}

/// dry-run：只判断，不删除。
pub fn plan_reclaim(layout: &Layout, active: &str) -> AppResult<GenerationReport> {
    let recovery = read_recovery_state(layout);
    let mut protected: Vec<String> = vec![active.to_string()];
    if let Some(state) = &recovery {
        protected.push(state.previous_generation.clone());
        protected.push(state.target_generation.clone());
    }

    let mut unknown = Vec::new();
    let mut candidates = Vec::new();
    let gens = layout.generations_dir();
    if gens.exists() {
        for entry in fs::read_dir(&gens)?.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let meta = fs::symlink_metadata(entry.path())?;
            if meta.file_type().is_symlink() || !meta.is_dir() {
                unknown.push(name);
                continue;
            }
            if protected.iter().any(|p| p == &name) {
                continue;
            }
            if !layout.generation_db(&name).exists() {
                unknown.push(name);
                continue;
            }
            candidates.push(name);
        }
    }

    // 有未完成恢复时，全部保留（回退需要）。
    let reclaimable = if recovery.is_some() {
        protected.extend(candidates);
        Vec::new()
    } else {
        candidates.sort();
        // 保留一个最近的历史代作为最后回退。
        let mut sorted = candidates.clone();
        sorted.sort_by_key(|id| {
            fs::metadata(layout.generation_db(id))
                .and_then(|m| m.modified())
                .ok()
        });
        if let Some(last) = sorted.last() {
            protected.push(last.clone());
        }
        candidates
            .into_iter()
            .filter(|id| !protected.iter().any(|p| p == id))
            .collect()
    };

    Ok(GenerationReport {
        active: active.to_string(),
        total: list_generations(layout)?.len(),
        protected,
        reclaimable,
        unknown,
    })
}

/// 真正删除：只删 `reclaimable`，且逐项复核目录身份。
pub fn apply_reclaim(layout: &Layout, active: &str) -> AppResult<Vec<String>> {
    let plan = plan_reclaim(layout, active)?;
    // 删除前重新确认活动代可用。
    let active_db = layout.generation_db(active);
    if !active_db.exists() {
        return Err(AppError::env("活动代数据库缺失，已停止清理"));
    }
    let mut removed = Vec::new();
    for id in plan.reclaimable {
        let dir = layout.generation_dir(&id);
        let meta = fs::symlink_metadata(&dir)
            .map_err(|e| AppError::io(format!("读取候选失败：{e}")))?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(AppError::invalid("候选不是普通目录，已停止清理"));
        }
        if dir.parent() != Some(layout.generations_dir().as_path()) {
            return Err(AppError::invalid("候选路径越界，已停止清理"));
        }
        fs::remove_dir_all(&dir)?;
        removed.push(id);
    }
    Ok(removed)
}
