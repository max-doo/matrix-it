//! 飞书同步命令
//! 同步到飞书多维表格、校对飞书数据

use crate::error::ApiError;
use crate::utils::{ensure_sidecar_env, truncate_utf8_boundary};
use serde::{Deserialize, Serialize};
use tauri_plugin_shell::ShellExt;

/// 飞书同步选项
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncFeishuOptions {
    pub resync_synced: Option<bool>,
    pub skip_attachment_upload: Option<bool>,
}

/// 同步到飞书
#[tauri::command]
pub async fn sync_feishu(
    app: tauri::AppHandle,
    item_keys: Vec<String>,
    options: Option<SyncFeishuOptions>,
) -> Result<serde_json::Value, ApiError> {
    ensure_sidecar_env();
    let payload = serde_json::json!({
        "keys": item_keys,
        "options": options
    });
    let cmd = app
        .shell()
        .sidecar("matrixit-sidecar")
        .map_err(|e| ApiError::new("SIDE_CAR_NOT_FOUND", e.to_string()))?
        .arg("sync_feishu")
        .arg(serde_json::to_string(&payload).map_err(|e| ApiError::new("JSON", e.to_string()))?);

    let (mut rx, _child) = cmd
        .spawn()
        .map_err(|e| ApiError::new("SIDE_CAR_SPAWN_FAILED", e.to_string()))?;

    let mut out_buf: Vec<u8> = Vec::new();
    let mut stderr_buf = String::new();
    let mut terminated_code: Option<i32> = None;
    let mut last_error: Option<String> = None;

    while let Some(event) = rx.recv().await {
        match event {
            tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                out_buf.extend_from_slice(&line);
            }
            tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                let chunk = String::from_utf8_lossy(&line).to_string();
                eprint!("{}", chunk);
                if stderr_buf.len() < 8000 {
                    stderr_buf.push_str(&chunk);
                    if stderr_buf.len() > 8000 {
                        truncate_utf8_boundary(&mut stderr_buf, 8000);
                    }
                }
            }
            tauri_plugin_shell::process::CommandEvent::Error(err) => {
                last_error = Some(err);
            }
            tauri_plugin_shell::process::CommandEvent::Terminated(payload) => {
                terminated_code = payload.code;
                break;
            }
            _ => {}
        }
    }

    if let Some(err) = last_error {
        return Err(ApiError::new("SIDE_CAR_ERROR", err));
    }
    if let Some(code) = terminated_code {
        if code != 0 {
            let mut msg = stderr_buf.clone();
            if msg.trim().is_empty() {
                msg = String::from_utf8_lossy(&out_buf).to_string();
                if msg.len() > 2000 {
                    truncate_utf8_boundary(&mut msg, 2000);
                    msg.push_str("\n...<truncated>");
                }
            }
            return Err(ApiError::new("SIDE_CAR_NON_ZERO", msg));
        }
    }

    let stdout = String::from_utf8(out_buf).map_err(|e| {
        let mut msg = format!("{}", e);
        if !stderr_buf.trim().is_empty() {
            msg.push_str("\n--- stderr ---\n");
            msg.push_str(stderr_buf.trim());
        }
        ApiError::new("UTF8", msg)
    })?;

    let v: serde_json::Value = serde_json::from_str(&stdout).map_err(|e| {
        let mut out_preview = stdout.clone();
        if out_preview.len() > 2000 {
            truncate_utf8_boundary(&mut out_preview, 2000);
            out_preview.push_str("\n...<truncated>");
        }
        let mut msg = format!("{}", e);
        msg.push_str("\n--- stdout ---\n");
        msg.push_str(out_preview.trim());
        if !stderr_buf.trim().is_empty() {
            msg.push_str("\n--- stderr ---\n");
            msg.push_str(stderr_buf.trim());
        }
        ApiError::new("JSON", msg)
    })?;
    Ok(v)
}

/// 校对飞书数据
#[tauri::command]
pub async fn reconcile_feishu(
    app: tauri::AppHandle,
    item_keys: Vec<String>,
) -> Result<serde_json::Value, ApiError> {
    ensure_sidecar_env();
    let cmd = app
        .shell()
        .sidecar("matrixit-sidecar")
        .map_err(|e| ApiError::new("SIDE_CAR_NOT_FOUND", e.to_string()))?
        .arg("reconcile_feishu")
        .arg(serde_json::to_string(&item_keys).map_err(|e| ApiError::new("JSON", e.to_string()))?);

    let (mut rx, _child) = cmd
        .spawn()
        .map_err(|e| ApiError::new("SIDE_CAR_SPAWN_FAILED", e.to_string()))?;

    let mut out_buf: Vec<u8> = Vec::new();
    let mut stderr_buf = String::new();
    let mut terminated_code: Option<i32> = None;
    let mut last_error: Option<String> = None;

    while let Some(event) = rx.recv().await {
        match event {
            tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                out_buf.extend_from_slice(&line);
            }
            tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                let chunk = String::from_utf8_lossy(&line).to_string();
                eprint!("{}", chunk);
                if stderr_buf.len() < 8000 {
                    stderr_buf.push_str(&chunk);
                    if stderr_buf.len() > 8000 {
                        truncate_utf8_boundary(&mut stderr_buf, 8000);
                    }
                }
            }
            tauri_plugin_shell::process::CommandEvent::Error(err) => {
                last_error = Some(err);
            }
            tauri_plugin_shell::process::CommandEvent::Terminated(payload) => {
                terminated_code = payload.code;
                break;
            }
            _ => {}
        }
    }

    if let Some(err) = last_error {
        return Err(ApiError::new("SIDE_CAR_ERROR", err));
    }
    if let Some(code) = terminated_code {
        if code != 0 {
            let mut msg = stderr_buf.clone();
            if msg.trim().is_empty() {
                msg = String::from_utf8_lossy(&out_buf).to_string();
                if msg.len() > 2000 {
                    truncate_utf8_boundary(&mut msg, 2000);
                    msg.push_str("\n...<truncated>");
                }
            }
            return Err(ApiError::new("SIDE_CAR_NON_ZERO", msg));
        }
    }

    let stdout = String::from_utf8(out_buf).map_err(|e| {
        let mut msg = format!("{}", e);
        if !stderr_buf.trim().is_empty() {
            msg.push_str("\n--- stderr ---\n");
            msg.push_str(stderr_buf.trim());
        }
        ApiError::new("UTF8", msg)
    })?;

    let v: serde_json::Value = serde_json::from_str(&stdout).map_err(|e| {
        let mut out_preview = stdout.clone();
        if out_preview.len() > 2000 {
            truncate_utf8_boundary(&mut out_preview, 2000);
            out_preview.push_str("\n...<truncated>");
        }
        let mut msg = format!("{}", e);
        msg.push_str("\n--- stdout ---\n");
        msg.push_str(out_preview.trim());
        if !stderr_buf.trim().is_empty() {
            msg.push_str("\n--- stderr ---\n");
            msg.push_str(stderr_buf.trim());
        }
        ApiError::new("JSON", msg)
    })?;
    Ok(v)
}
