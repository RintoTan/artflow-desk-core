//! DEV-0.1.1-05：自定义数据位置。

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::domain::migrate::{self, MigratePreview, MigrateReport};
use crate::error::{AppError, AppResult};
use crate::infra::state::AppState;
use crate::store::rootptr;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStatus {
    pub root: String,
    pub default_root: String,
    pub pointer_path: String,
    pub custom: bool,
}

fn app_data(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|e| AppError::env(format!("无法解析应用数据目录：{e}")))
}

fn pointer_of(app: &AppHandle, state: &AppState) -> AppResult<PathBuf> {
    let data = app_data(app)?;
    Ok(rootptr::pointer_path(&data, state.qa_scenario()))
}

fn default_root(app: &AppHandle, state: &AppState) -> AppResult<PathBuf> {
    let data = app_data(app)?;
    Ok(match state.qa_scenario() {
        Some(name) => data.join(name),
        None => data,
    })
}

#[tauri::command]
pub fn storage_status(app: AppHandle, state: State<'_, AppState>) -> AppResult<StorageStatus> {
    let root = state.env.root().to_path_buf();
    let fallback = default_root(&app, &state)?;
    Ok(StorageStatus {
        custom: root != fallback,
        root: root.display().to_string(),
        default_root: fallback.display().to_string(),
        pointer_path: pointer_of(&app, &state)?.display().to_string(),
    })
}

/// 迁移前预览：只读，不做任何改动。
#[tauri::command]
pub fn storage_preview(
    state: State<'_, AppState>,
    target: String,
) -> AppResult<MigratePreview> {
    migrate::preview(&state.env, &PathBuf::from(target))
}

#[tauri::command]
pub fn storage_migrate(
    app: AppHandle,
    state: State<'_, AppState>,
    target: String,
) -> AppResult<MigrateReport> {
    let pointer = pointer_of(&app, &state)?;
    let report = migrate::run(&state.env, &state.highwater, &PathBuf::from(target), &pointer)?;
    crate::infra::diag::log(
        "migrate",
        &format!(
            "root moved to {} files={} bytes={} generations={}",
            report.target_root,
            report.files,
            report.bytes,
            report.generations.len()
        ),
    );
    Ok(report)
}

/// 切回默认位置：只删指针，不搬数据、不合并。
#[tauri::command]
pub fn storage_use_default(app: AppHandle, state: State<'_, AppState>) -> AppResult<()> {
    let pointer = pointer_of(&app, &state)?;
    rootptr::clear(&pointer)?;
    crate::infra::diag::log("migrate", "data root pointer cleared; restart to use the default root");
    Ok(())
}
