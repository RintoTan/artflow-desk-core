//! 统一的结构化错误。
//!
//! 前端只按 `code` 分支，不解析 `message`；`message` 是给人看的中文说明。

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID", message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new("CONFLICT", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("NOT_FOUND", message)
    }

    pub fn denied(message: impl Into<String>) -> Self {
        Self::new("DENIED", message)
    }

    pub fn busy(message: impl Into<String>) -> Self {
        Self::new("BUSY", message)
    }

    pub fn db(message: impl Into<String>) -> Self {
        Self::new("DB", message)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new("IO", message)
    }

    pub fn zip(message: impl Into<String>) -> Self {
        Self::new("ZIP", message)
    }

    pub fn schema(message: impl Into<String>) -> Self {
        Self::new("SCHEMA", message)
    }

    pub fn env(message: impl Into<String>) -> Self {
        Self::new("ENV", message)
    }

    pub fn numbering(message: impl Into<String>) -> Self {
        Self::new("NUMBERING", message)
    }

    pub fn timezone(message: impl Into<String>) -> Self {
        Self::new("TIMEZONE", message)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        AppError::db(format!("数据库操作失败：{e}"))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::new("SERIALIZE", format!("数据结构解析失败：{e}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::io(format!("文件操作失败：{e}"))
    }
}

pub type AppResult<T> = Result<T, AppError>;
