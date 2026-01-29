//! 库管理命令
//! 加载文献库、获取条目、更新条目、删除数据等

use crate::db;
use crate::error::ApiError;
use crate::utils::ensure_sidecar_env;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// 加载库响应结构
#[derive(Debug, Serialize, Deserialize)]
pub struct LoadLibraryResponse {
    pub collections: serde_json::Value,
    pub items: serde_json::Value,
}

/// 获取条目响应结构
#[derive(Debug, Serialize, Deserialize)]
pub struct GetItemsResponse {
    pub items: serde_json::Value,
}

/// 加载库状态（防止重复进程）
pub struct LoadLibraryState(pub Mutex<Option<CommandChild>>);

/// 加载文献库
#[tauri::command]
pub async fn load_library(
    app: tauri::AppHandle,
    state: tauri::State<'_, LoadLibraryState>,
) -> Result<LoadLibraryResponse, ApiError> {
    ensure_sidecar_env();

    // 终止之前的进程（如果存在）
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| ApiError::new("LOCK_POISONED", "State lock failed"))?;
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }

    // 启动新进程
    let (mut rx, child) = app
        .shell()
        .sidecar("matrixit-sidecar")
        .map_err(|e| ApiError::new("SIDE_CAR_NOT_FOUND", e.to_string()))?
        .arg("load_library")
        .spawn()
        .map_err(|e| ApiError::new("SIDE_CAR_SPAWN_FAILED", e.to_string()))?;

    // 保存新进程句柄
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| ApiError::new("LOCK_POISONED", "State lock failed"))?;
        *guard = Some(child);
    }

    // 异步读取输出
    let mut stdout_buf = Vec::new();
    let mut stderr_buf = Vec::new();

    use tauri_plugin_shell::process::CommandEvent;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(data) => stdout_buf.extend(data),
            CommandEvent::Stderr(data) => stderr_buf.extend(data),
            CommandEvent::Error(msg) => stderr_buf.extend(msg.as_bytes()),
            CommandEvent::Terminated(status) => {
                // 进程结束，清理句柄
                if let Ok(mut guard) = state.0.lock() {
                    *guard = None;
                }
                if status.code.unwrap_or(0) != 0 {
                    return Err(ApiError::new(
                        "SIDE_CAR_NON_ZERO",
                        String::from_utf8_lossy(&stderr_buf).to_string(),
                    ));
                }
            }
            _ => {}
        }
    }

    // 解析结果
    let stdout =
        String::from_utf8(stdout_buf).map_err(|e| ApiError::new("UTF8", e.to_string()))?;
    let v: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| ApiError::new("JSON", e.to_string()))?;
    Ok(LoadLibraryResponse {
        collections: v.get("collections").cloned().unwrap_or(serde_json::json!([])),
        items: v.get("items").cloned().unwrap_or(serde_json::json!([])),
    })
}

/// 获取指定条目
#[tauri::command]
pub async fn get_items(
    app: tauri::AppHandle,
    item_keys: Vec<String>,
) -> Result<GetItemsResponse, ApiError> {
    ensure_sidecar_env();
    let output = app
        .shell()
        .sidecar("matrixit-sidecar")
        .map_err(|e| ApiError::new("SIDE_CAR_NOT_FOUND", e.to_string()))?
        .arg("get_items")
        .arg(serde_json::to_string(&item_keys).map_err(|e| ApiError::new("JSON", e.to_string()))?)
        .output()
        .await
        .map_err(|e| ApiError::new("SIDE_CAR_EXEC_FAILED", e.to_string()))?;

    if !output.status.success() {
        return Err(ApiError::new(
            "SIDE_CAR_NON_ZERO",
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }

    let stdout =
        String::from_utf8(output.stdout).map_err(|e| ApiError::new("UTF8", e.to_string()))?;
    let v: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| ApiError::new("JSON", e.to_string()))?;
    if let Some(err) = v.get("error") {
        let code = err
            .get("code")
            .and_then(|x| x.as_str())
            .unwrap_or("GET_ITEMS_FAILED");
        let msg = err.get("message").and_then(|x| x.as_str()).unwrap_or("unknown");
        return Err(ApiError::new(code, msg));
    }

    Ok(GetItemsResponse {
        items: v.get("items").cloned().unwrap_or(serde_json::json!([])),
    })
}

/// 格式化引用
#[tauri::command]
pub async fn format_citations(
    app: tauri::AppHandle,
    item_keys: Vec<String>,
) -> Result<serde_json::Value, ApiError> {
    ensure_sidecar_env();
    let output = app
        .shell()
        .sidecar("matrixit-sidecar")
        .map_err(|e| ApiError::new("SIDE_CAR_NOT_FOUND", e.to_string()))?
        .arg("format_citations")
        .arg(serde_json::to_string(&item_keys).map_err(|e| ApiError::new("JSON", e.to_string()))?)
        .output()
        .await
        .map_err(|e| ApiError::new("SIDE_CAR_EXEC_FAILED", e.to_string()))?;

    if !output.status.success() {
        return Err(ApiError::new(
            "SIDE_CAR_NON_ZERO",
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }

    let stdout =
        String::from_utf8(output.stdout).map_err(|e| ApiError::new("UTF8", e.to_string()))?;
    let v: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| ApiError::new("JSON", e.to_string()))?;
    if let Some(err) = v.get("error") {
        let code = err
            .get("code")
            .and_then(|x| x.as_str())
            .unwrap_or("FORMAT_CITATIONS_FAILED");
        let msg = err.get("message").and_then(|x| x.as_str()).unwrap_or("unknown");
        return Err(ApiError::new(code, msg));
    }
    Ok(v)
}

/// 更新单条 item（使用 spawn_blocking 包装）
#[tauri::command]
pub async fn update_item(
    item_key: String,
    patch: serde_json::Value,
) -> Result<serde_json::Value, ApiError> {
    tauri::async_runtime::spawn_blocking(move || db::update_item_sync(item_key, patch))
        .await
        .map_err(|e| ApiError::new("SPAWN_BLOCKING", e.to_string()))?
        .map_err(ApiError::from)
}

/// 批量删除指定字段（使用 spawn_blocking 包装）
#[tauri::command]
pub async fn purge_item_field(field_key: String) -> Result<serde_json::Value, ApiError> {
    tauri::async_runtime::spawn_blocking(move || db::purge_item_field_sync(field_key))
        .await
        .map_err(|e| ApiError::new("SPAWN_BLOCKING", e.to_string()))?
        .map_err(ApiError::from)
}

/// 删除提取的数据
#[tauri::command]
pub async fn delete_extracted_data(
    app: tauri::AppHandle,
    item_keys: Vec<String>,
) -> Result<serde_json::Value, ApiError> {
    ensure_sidecar_env();
    let output = app
        .shell()
        .sidecar("matrixit-sidecar")
        .map_err(|e| ApiError::new("SIDE_CAR_NOT_FOUND", e.to_string()))?
        .arg("delete_extracted_data")
        .arg(serde_json::to_string(&item_keys).map_err(|e| ApiError::new("JSON", e.to_string()))?)
        .output()
        .await
        .map_err(|e| ApiError::new("SIDE_CAR_EXEC_FAILED", e.to_string()))?;

    if !output.status.success() {
        return Err(ApiError::new(
            "SIDE_CAR_NON_ZERO",
            String::from_utf8_lossy(&output.stderr).to_string(),
        ));
    }

    let stdout =
        String::from_utf8(output.stdout).map_err(|e| ApiError::new("UTF8", e.to_string()))?;
    let v: serde_json::Value =
        serde_json::from_str(&stdout).map_err(|e| ApiError::new("JSON", e.to_string()))?;
    Ok(v)
}
