//! Configuration read/write commands.
//! Public settings live in `config.json`; machine-specific secrets live in
//! `config.local.json`, which is merged at read time.

use crate::db;
use crate::error::ApiError;
use crate::utils::{find_project_root, resolve_config_path, resolve_fields_path};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

/// Extract a Feishu base signature from a bitable URL.
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

/// Extract a Feishu signature from config JSON.
fn extract_feishu_base_sig(v: &Value) -> Option<String> {
    let feishu = v.get("feishu")?;
    let url = feishu
        .get("bitable_url")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    extract_bitable_sig_from_url(url)
}

fn read_json_file(path: &Path) -> Result<Value, ApiError> {
    let content =
        std::fs::read_to_string(path).map_err(|e| ApiError::new("READ_CONFIG", e.to_string()))?;
    serde_json::from_str(&content).map_err(|e| ApiError::new("JSON", e.to_string()))
}

fn deep_merge_value(dst: &mut Value, src: &Value) {
    match (dst, src) {
        (Value::Object(dst_map), Value::Object(src_map)) => {
            for (key, value) in src_map {
                match dst_map.get_mut(key) {
                    Some(existing) => deep_merge_value(existing, value),
                    None => {
                        dst_map.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (dst_value, src_value) => *dst_value = src_value.clone(),
    }
}

fn ensure_object(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    match value {
        Value::Object(map) => map,
        _ => unreachable!(),
    }
}

fn set_nested_value(target: &mut Value, path: &[&str], value: Value) {
    if path.is_empty() {
        *target = value;
        return;
    }

    let mut current = target;
    for key in &path[..path.len() - 1] {
        let map = ensure_object(current);
        current = map
            .entry((*key).to_string())
            .or_insert_with(|| Value::Object(Map::new()));
    }

    let map = ensure_object(current);
    map.insert(path[path.len() - 1].to_string(), value);
}

fn get_nested_string(source: &Value, path: &[&str]) -> Option<String> {
    let mut current = source;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(|s| s.to_string())
}

fn config_paths(root: &Path) -> (PathBuf, PathBuf) {
    let public_path = resolve_config_path(root);
    let base_dir = public_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| root.join("config"));
    let local_path = base_dir.join("config.local.json");
    (public_path, local_path)
}

fn read_merged_config(root: &Path) -> Result<Value, ApiError> {
    let (public_path, local_path) = config_paths(root);

    let mut merged = if public_path.exists() {
        read_json_file(&public_path)?
    } else {
        Value::Object(Map::new())
    };

    if local_path.exists() {
        let local = read_json_file(&local_path)?;
        deep_merge_value(&mut merged, &local);
    }

    if !merged.is_object() {
        merged = Value::Object(Map::new());
    }
    Ok(merged)
}

fn move_local_string_field(source: &Value, public_cfg: &mut Value, local_cfg: &mut Value, path: &[&str]) {
    if let Some(value) = get_nested_string(source, path) {
        set_nested_value(local_cfg, path, Value::String(value.clone()));
        set_nested_value(public_cfg, path, Value::String(String::new()));
    }
}

fn split_public_and_local_config(next: &Value) -> (Value, Value) {
    let mut public_cfg = next.clone();
    let mut local_cfg = Value::Object(Map::new());

    for path in [
        &["llm", "api_key"][..],
        &["feishu", "app_id"][..],
        &["feishu", "app_secret"][..],
        &["feishu", "bitable_url"][..],
        &["feishu", "app_token"][..],
        &["feishu", "table_id"][..],
        &["zotero", "data_dir"][..],
    ] {
        move_local_string_field(next, &mut public_cfg, &mut local_cfg, path);
    }

    if let Some(profiles) = next
        .get("llm")
        .and_then(|llm| llm.get("profiles"))
        .and_then(Value::as_object)
    {
        for (provider, profile) in profiles {
            if let Some(api_key) = profile.get("api_key").and_then(Value::as_str) {
                set_nested_value(
                    &mut local_cfg,
                    &["llm", "profiles", provider.as_str(), "api_key"],
                    Value::String(api_key.to_string()),
                );
                set_nested_value(
                    &mut public_cfg,
                    &["llm", "profiles", provider.as_str(), "api_key"],
                    Value::String(String::new()),
                );
            }
        }
    }

    (public_cfg, local_cfg)
}

/// Read merged configuration.
#[tauri::command]
pub async fn read_config() -> Result<Value, ApiError> {
    tauri::async_runtime::spawn_blocking(|| {
        let root = find_project_root();
        read_merged_config(&root)
    })
    .await
    .map_err(|e| ApiError::new("SPAWN_BLOCKING", e.to_string()))?
}

/// Save configuration while splitting local-only values into config.local.json.
#[tauri::command]
pub async fn save_config(next: Value) -> Result<(), ApiError> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = find_project_root();
        let old_sig = read_merged_config(&root)
            .ok()
            .and_then(|cfg| extract_feishu_base_sig(&cfg));
        let new_sig = extract_feishu_base_sig(&next);

        if let (Some(old_value), Some(new_value)) = (old_sig, new_sig) {
            if old_value != new_value {
                let _ = db::reset_feishu_sync_state_sync(&root);
            }
        }

        let (public_cfg, local_cfg) = split_public_and_local_config(&next);
        let (public_path, local_path) = config_paths(&root);

        if let Some(parent) = public_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| ApiError::new("MKDIR", e.to_string()))?;
        }

        let public_str = serde_json::to_string_pretty(&public_cfg)
            .map_err(|e| ApiError::new("JSON", e.to_string()))?;
        std::fs::write(&public_path, public_str)
            .map_err(|e| ApiError::new("WRITE_CONFIG", e.to_string()))?;

        let local_str = serde_json::to_string_pretty(&local_cfg)
            .map_err(|e| ApiError::new("JSON", e.to_string()))?;
        std::fs::write(&local_path, local_str)
            .map_err(|e| ApiError::new("WRITE_CONFIG_LOCAL", e.to_string()))?;

        Ok(())
    })
    .await
    .map_err(|e| ApiError::new("SPAWN_BLOCKING", e.to_string()))?
}

/// Read field configuration.
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

/// Save field configuration.
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
