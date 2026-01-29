//! 配置读写命令
//! 读取和保存 config.json 与 fields.json

use crate::db;
use crate::error::ApiError;
use crate::utils::{find_project_root, resolve_config_path, resolve_fields_path};
use serde_json::Value;

/// 从 URL 提取飞书多维表格签名
fn extract_bitable_sig_from_url(url: &str) -> Option<String> {
    let u = url.trim();
    if u.is_empty() {
        return None;
    }
    let app_token = if let Some(idx) = u.find("/base/") {
        let rest = &u[idx + "/base/".len()..];
        rest.split(|c| c == '/' || c == '?' || c == '#')
            .next()
            .unwrap_or("")
            .trim()
            .to_string()
    } else {
        String::new()
    };
    let table_id = if let Some(idx) = u.find("table=") {
        let rest = &u[idx + "table=".len()..];
        rest.split(|c| c == '&' || c == '#')
            .next()
            .unwrap_or("")
            .trim()
            .to_string()
    } else {
        String::new()
    };
    if app_token.is_empty() || table_id.is_empty() {
        return None;
    }
    Some(format!("{}:{}", app_token, table_id))
}

/// 从配置中提取飞书签名
fn extract_feishu_base_sig(v: &Value) -> Option<String> {
    let feishu = v.get("feishu")?;
    let url = feishu
        .get("bitable_url")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    extract_bitable_sig_from_url(url)
}

/// 读取配置文件
#[tauri::command]
pub async fn read_config() -> Result<Value, ApiError> {
    tauri::async_runtime::spawn_blocking(|| {
        let root = find_project_root();
        let path = resolve_config_path(&root);
        let content =
            std::fs::read_to_string(path).map_err(|e| ApiError::new("READ_CONFIG", e.to_string()))?;
        let v: Value =
            serde_json::from_str(&content).map_err(|e| ApiError::new("JSON", e.to_string()))?;
        Ok(v)
    })
    .await
    .map_err(|e| ApiError::new("SPAWN_BLOCKING", e.to_string()))?
}

/// 保存配置文件
#[tauri::command]
pub async fn save_config(next: Value) -> Result<(), ApiError> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = find_project_root();
        let old_sig = {
            let path = resolve_config_path(&root);
            if let Ok(content) = std::fs::read_to_string(path) {
                if let Ok(v) = serde_json::from_str::<Value>(&content) {
                    extract_feishu_base_sig(&v)
                } else {
                    None
                }
            } else {
                None
            }
        };
        let new_sig = extract_feishu_base_sig(&next);
        if let (Some(a), Some(b)) = (old_sig, new_sig) {
            if a != b {
                let _ = db::reset_feishu_sync_state_sync(&root);
            }
        }
        let new_path = root.join("config").join("config.json");
        if let Some(parent) = new_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| ApiError::new("MKDIR", e.to_string()))?;
        }
        let s = serde_json::to_string_pretty(&next)
            .map_err(|e| ApiError::new("JSON", e.to_string()))?;
        std::fs::write(new_path, s).map_err(|e| ApiError::new("WRITE_CONFIG", e.to_string()))?;
        Ok(())
    })
    .await
    .map_err(|e| ApiError::new("SPAWN_BLOCKING", e.to_string()))?
}

/// 读取字段配置
#[tauri::command]
pub async fn read_fields() -> Result<Value, ApiError> {
    tauri::async_runtime::spawn_blocking(|| {
        let root = find_project_root();
        let cfg_path = resolve_config_path(&root);
        if let Ok(content) = std::fs::read_to_string(&cfg_path) {
            if let Ok(v) = serde_json::from_str::<Value>(&content) {
                if let Some(fields) = v.get("fields") {
                    return Ok(fields.clone());
                }
            }
        }
        let legacy_path = resolve_fields_path(&root);
        let content = std::fs::read_to_string(legacy_path)
            .map_err(|e| ApiError::new("READ_FIELDS", e.to_string()))?;
        let v: Value =
            serde_json::from_str(&content).map_err(|e| ApiError::new("JSON", e.to_string()))?;
        Ok(v)
    })
    .await
    .map_err(|e| ApiError::new("SPAWN_BLOCKING", e.to_string()))?
}

/// 保存字段配置
#[tauri::command]
pub async fn save_fields(next: Value) -> Result<(), ApiError> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = find_project_root();
        let cfg_path = resolve_config_path(&root);
        let mut cfg_v = if let Ok(content) = std::fs::read_to_string(&cfg_path) {
            serde_json::from_str::<Value>(&content).unwrap_or(serde_json::json!({}))
        } else {
            serde_json::json!({})
        };
        if !cfg_v.is_object() {
            cfg_v = serde_json::json!({});
        }
        cfg_v["fields"] = next;
        let new_path = root.join("config").join("config.json");
        if let Some(parent) = new_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| ApiError::new("MKDIR", e.to_string()))?;
        }
        let s =
            serde_json::to_string_pretty(&cfg_v).map_err(|e| ApiError::new("JSON", e.to_string()))?;
        std::fs::write(new_path, s).map_err(|e| ApiError::new("WRITE_FIELDS", e.to_string()))?;
        Ok(())
    })
    .await
    .map_err(|e| ApiError::new("SPAWN_BLOCKING", e.to_string()))?
}
