//! 统一错误类型模块
//! 用于 Tauri 命令的错误返回

use serde::Serialize;

/// API 错误类型
/// 用于 Tauri 命令返回前端可识别的错误信息
#[derive(Debug, Serialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

impl ApiError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<crate::db::DbError> for ApiError {
    fn from(e: crate::db::DbError) -> Self {
        ApiError {
            code: e.code,
            message: e.message,
        }
    }
}
