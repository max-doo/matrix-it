use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::Emitter;
use tauri_plugin_shell::ShellExt;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};

#[derive(Debug, Serialize)]
struct ApiError {
  code: String,
  message: String,
}

impl ApiError {
  fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
    Self {
      code: code.into(),
      message: message.into(),
    }
  }
}

#[derive(Debug, Serialize, Deserialize)]
struct LoadLibraryResponse {
  collections: serde_json::Value,
  items: serde_json::Value,
}

struct ZoteroWatchState(Mutex<Option<RecommendedWatcher>>);

fn find_project_root() -> PathBuf {
  let mut cur = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
  for _ in 0..12 {
    if cur.join("config").join("config.json").exists() || cur.join("config.json").exists() {
      return cur;
    }
    if let Some(parent) = cur.parent() {
      cur = parent.to_path_buf();
    } else {
      break;
    }
  }
  std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn resolve_config_path(root: &Path) -> PathBuf {
  let new_path = root.join("config").join("config.json");
  if new_path.exists() {
    return new_path;
  }
  let legacy = root.join("config.json");
  if legacy.exists() {
    return legacy;
  }
  new_path
}

fn resolve_fields_path(root: &Path) -> PathBuf {
  root.join("fields.json")
}

fn ensure_sidecar_env() {
  let root = find_project_root();
  let cfg = resolve_config_path(&root);
  std::env::set_var("MATRIXIT_WORKDIR", root.to_string_lossy().to_string());
  std::env::set_var("MATRIXIT_CONFIG", cfg.to_string_lossy().to_string());
}

#[tauri::command]
fn start_zotero_watch(
  app: tauri::AppHandle,
  state: tauri::State<ZoteroWatchState>,
  data_dir: String,
) -> Result<(), ApiError> {
  let data_dir = data_dir.trim();
  if data_dir.is_empty() {
    return Err(ApiError::new("ZOTERO_DIR_EMPTY", "zotero data_dir is empty"));
  }

  let sqlite_path = PathBuf::from(data_dir).join("zotero.sqlite");
  if !sqlite_path.exists() {
    return Err(ApiError::new(
      "ZOTERO_SQLITE_NOT_FOUND",
      format!("zotero.sqlite not found at {}", sqlite_path.to_string_lossy()),
    ));
  }

  let app_handle = app.clone();
  let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
    if let Ok(event) = res {
      let kind = format!("{:?}", event.kind);
      let paths = event
        .paths
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>();
      let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
      let payload = serde_json::json!({
        "ts": ts,
        "kind": kind,
        "paths": paths
      });
      let _ = app_handle.emit("matrixit://zotero-changed", payload);
    }
  })
  .map_err(|e| ApiError::new("WATCHER_INIT", e.to_string()))?;

  watcher
    .watch(&sqlite_path, RecursiveMode::NonRecursive)
    .map_err(|e| ApiError::new("WATCHER_WATCH", e.to_string()))?;

  let mut guard = state.0.lock().map_err(|_| ApiError::new("WATCHER_LOCK", "poisoned"))?;
  *guard = Some(watcher);
  Ok(())
}

#[tauri::command]
fn stop_zotero_watch(state: tauri::State<ZoteroWatchState>) -> Result<(), ApiError> {
  let mut guard = state.0.lock().map_err(|_| ApiError::new("WATCHER_LOCK", "poisoned"))?;
  *guard = None;
  Ok(())
}

#[tauri::command]
async fn load_library(app: tauri::AppHandle) -> Result<LoadLibraryResponse, ApiError> {
  ensure_sidecar_env();
  let output = app
    .shell()
    .sidecar("matrixit-sidecar")
    .map_err(|e| ApiError::new("SIDE_CAR_NOT_FOUND", e.to_string()))?
    .arg("load_library")
    .output()
    .await
    .map_err(|e| ApiError::new("SIDE_CAR_EXEC_FAILED", e.to_string()))?;

  if !output.status.success() {
    return Err(ApiError::new(
      "SIDE_CAR_NON_ZERO",
      String::from_utf8_lossy(&output.stderr).to_string(),
    ));
  }

  let stdout = String::from_utf8(output.stdout).map_err(|e| ApiError::new("UTF8", e.to_string()))?;
  let v: serde_json::Value = serde_json::from_str(&stdout).map_err(|e| ApiError::new("JSON", e.to_string()))?;
  Ok(LoadLibraryResponse {
    collections: v.get("collections").cloned().unwrap_or(serde_json::json!([])),
    items: v.get("items").cloned().unwrap_or(serde_json::json!([])),
  })
}

#[tauri::command]
async fn format_citations(
  app: tauri::AppHandle,
  item_keys: Vec<String>,
) -> Result<serde_json::Value, ApiError> {
  ensure_sidecar_env();
  let output = app
    .shell()
    .sidecar("matrixit-sidecar")
    .map_err(|e| ApiError::new("SIDE_CAR_NOT_FOUND", e.to_string()))?
    .arg("format_citations")
    .arg(
      serde_json::to_string(&item_keys)
        .map_err(|e| ApiError::new("JSON", e.to_string()))?,
    )
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
    let code = err.get("code").and_then(|x| x.as_str()).unwrap_or("FORMAT_CITATIONS_FAILED");
    let msg = err.get("message").and_then(|x| x.as_str()).unwrap_or("unknown");
    return Err(ApiError::new(code, msg));
  }
  Ok(v)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "event", content = "data")]
enum AnalysisEvent {
  Started { item_key: String },
  Progress { item_key: String, current: u32, total: u32 },
  Finished { item_key: String },
  Failed { item_key: String, error: String },
  AllDone,
}

#[tauri::command]
async fn start_analysis(
  app: tauri::AppHandle,
  item_keys: Vec<String>,
  on_event: Channel<AnalysisEvent>,
) -> Result<(), ApiError> {
  ensure_sidecar_env();
  let cmd = app
    .shell()
    .sidecar("matrixit-sidecar")
    .map_err(|e| ApiError::new("SIDE_CAR_NOT_FOUND", e.to_string()))?
    .arg("analyze")
    .arg(serde_json::to_string(&item_keys).map_err(|e| ApiError::new("JSON", e.to_string()))?);

  let (mut rx, _child) = cmd
    .spawn()
    .map_err(|e| ApiError::new("SIDE_CAR_SPAWN_FAILED", e.to_string()))?;

  let total = item_keys.len() as u32;
  let mut current: u32 = 0;
  let mut buf = String::new();
  let mut stderr_buf = String::new();
  let mut finished: HashSet<String> = HashSet::new();
  let mut failed: HashSet<String> = HashSet::new();
  let mut terminated_code: Option<i32> = None;
  let mut last_error: Option<String> = None;

  while let Some(event) = rx.recv().await {
    match event {
      tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
        let chunk = String::from_utf8_lossy(&line).to_string();
        buf.push_str(&chunk);
        while let Some(pos) = buf.find('\n') {
          let mut line = buf[..pos].to_string();
          buf = buf[pos + 1..].to_string();
          if line.ends_with('\r') {
            line.pop();
          }
          let line = line.trim();
          if line.is_empty() {
            continue;
          }
          if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(item_key) = v.get("item_key").and_then(|x| x.as_str()).map(|s| s.to_string()) {
              if v.get("type").and_then(|x| x.as_str()) == Some("started") {
                let _ = on_event.send(AnalysisEvent::Started { item_key: item_key.clone() });
              }
              if v.get("type").and_then(|x| x.as_str()) == Some("finished") {
                current += 1;
                finished.insert(item_key.clone());
                let _ = on_event.send(AnalysisEvent::Progress { item_key: item_key.clone(), current, total });
                let _ = on_event.send(AnalysisEvent::Finished { item_key: item_key.clone() });
              }
              if v.get("type").and_then(|x| x.as_str()) == Some("failed") {
                failed.insert(item_key.clone());
                let code = v
                  .get("error_code")
                  .and_then(|x| x.as_str())
                  .or_else(|| v.get("error").and_then(|x| x.as_str()))
                  .unwrap_or("unknown");
                let msg = v.get("message").and_then(|x| x.as_str()).unwrap_or("").trim();
                let err = if msg.is_empty() {
                  code.to_string()
                } else {
                  format!("{}: {}", code, msg)
                };
                let _ = on_event.send(AnalysisEvent::Failed { item_key: item_key.clone(), error: err });
              }
              if v.get("type").and_then(|x| x.as_str()) == Some("debug") {
                println!("[analysis][{}] {}", item_key, line);
              }
            }
          }
        }
      }
      tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
        let chunk = String::from_utf8_lossy(&line).to_string();
        if stderr_buf.len() < 8000 {
          stderr_buf.push_str(&chunk);
          if stderr_buf.len() > 8000 {
            stderr_buf.truncate(8000);
          }
        }
      }
      tauri_plugin_shell::process::CommandEvent::Error(err) => {
        last_error = Some(err);
      }
      tauri_plugin_shell::process::CommandEvent::Terminated(payload) => {
        terminated_code = payload.code;
      }
      _ => {}
    }
  }

  let unresolved: Vec<String> = item_keys
    .iter()
    .filter(|k| !finished.contains(*k) && !failed.contains(*k))
    .cloned()
    .collect();
  let non_zero = terminated_code.unwrap_or(0) != 0;
  if non_zero || last_error.is_some() || (!stderr_buf.trim().is_empty() && !unresolved.is_empty()) {
    let mut err = String::new();
    if let Some(e) = last_error.clone() {
      err.push_str(&e);
    }
    if !stderr_buf.trim().is_empty() {
      if !err.is_empty() {
        err.push('\n');
      }
      err.push_str(stderr_buf.trim());
    }
    if err.trim().is_empty() {
      err = format!("sidecar exited with code {}", terminated_code.unwrap_or(0));
    }
    for k in unresolved {
      let _ = on_event.send(AnalysisEvent::Failed { item_key: k, error: err.clone() });
    }
    let _ = on_event.send(AnalysisEvent::AllDone);
    return Err(ApiError::new("ANALYZE_FAILED", err));
  }
  let _ = on_event.send(AnalysisEvent::AllDone);
  Ok(())
}

#[tauri::command]
async fn sync_feishu(app: tauri::AppHandle, item_keys: Vec<String>) -> Result<serde_json::Value, ApiError> {
  ensure_sidecar_env();
  let output = app
    .shell()
    .sidecar("matrixit-sidecar")
    .map_err(|e| ApiError::new("SIDE_CAR_NOT_FOUND", e.to_string()))?
    .arg("sync_feishu")
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

  let stdout = String::from_utf8(output.stdout).map_err(|e| ApiError::new("UTF8", e.to_string()))?;
  let v: serde_json::Value = serde_json::from_str(&stdout).map_err(|e| ApiError::new("JSON", e.to_string()))?;
  Ok(v)
}

#[tauri::command]
async fn delete_extracted_data(app: tauri::AppHandle, item_keys: Vec<String>) -> Result<serde_json::Value, ApiError> {
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

  let stdout = String::from_utf8(output.stdout).map_err(|e| ApiError::new("UTF8", e.to_string()))?;
  let v: serde_json::Value = serde_json::from_str(&stdout).map_err(|e| ApiError::new("JSON", e.to_string()))?;
  Ok(v)
}

#[tauri::command]
async fn update_item(
  app: tauri::AppHandle,
  item_key: String,
  patch: serde_json::Value,
) -> Result<serde_json::Value, ApiError> {
  ensure_sidecar_env();
  let output = app
    .shell()
    .sidecar("matrixit-sidecar")
    .map_err(|e| ApiError::new("SIDE_CAR_NOT_FOUND", e.to_string()))?
    .arg("update_item")
    .arg(item_key)
    .arg(serde_json::to_string(&patch).map_err(|e| ApiError::new("JSON", e.to_string()))?)
    .output()
    .await
    .map_err(|e| ApiError::new("SIDE_CAR_EXEC_FAILED", e.to_string()))?;

  if !output.status.success() {
    return Err(ApiError::new(
      "SIDE_CAR_NON_ZERO",
      String::from_utf8_lossy(&output.stderr).to_string(),
    ));
  }

  let stdout = String::from_utf8(output.stdout).map_err(|e| ApiError::new("UTF8", e.to_string()))?;
  let v: serde_json::Value = serde_json::from_str(&stdout).map_err(|e| ApiError::new("JSON", e.to_string()))?;
  Ok(v)
}

#[tauri::command]
async fn read_config() -> Result<serde_json::Value, ApiError> {
  let root = find_project_root();
  let path = resolve_config_path(&root);
  let content = std::fs::read_to_string(path).map_err(|e| ApiError::new("READ_CONFIG", e.to_string()))?;
  let v: serde_json::Value = serde_json::from_str(&content).map_err(|e| ApiError::new("JSON", e.to_string()))?;
  Ok(v)
}

#[tauri::command]
async fn save_config(next: serde_json::Value) -> Result<(), ApiError> {
  let root = find_project_root();
  let new_path = root.join("config").join("config.json");
  if let Some(parent) = new_path.parent() {
    std::fs::create_dir_all(parent).map_err(|e| ApiError::new("MKDIR", e.to_string()))?;
  }
  let s = serde_json::to_string_pretty(&next).map_err(|e| ApiError::new("JSON", e.to_string()))?;
  std::fs::write(new_path, s).map_err(|e| ApiError::new("WRITE_CONFIG", e.to_string()))?;
  Ok(())
}

#[tauri::command]
async fn read_fields() -> Result<serde_json::Value, ApiError> {
  let root = find_project_root();
  let cfg_path = resolve_config_path(&root);
  if let Ok(content) = std::fs::read_to_string(&cfg_path) {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
      if let Some(fields) = v.get("fields") {
        return Ok(fields.clone());
      }
    }
  }
  let legacy_path = resolve_fields_path(&root);
  let content = std::fs::read_to_string(legacy_path).map_err(|e| ApiError::new("READ_FIELDS", e.to_string()))?;
  let v: serde_json::Value = serde_json::from_str(&content).map_err(|e| ApiError::new("JSON", e.to_string()))?;
  Ok(v)
}

#[tauri::command]
async fn save_fields(next: serde_json::Value) -> Result<(), ApiError> {
  let root = find_project_root();
  let cfg_path = resolve_config_path(&root);
  let mut cfg_v = if let Ok(content) = std::fs::read_to_string(&cfg_path) {
    serde_json::from_str::<serde_json::Value>(&content).unwrap_or(serde_json::json!({}))
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
  let s = serde_json::to_string_pretty(&cfg_v).map_err(|e| ApiError::new("JSON", e.to_string()))?;
  std::fs::write(new_path, s).map_err(|e| ApiError::new("WRITE_FIELDS", e.to_string()))?;
  Ok(())
}

fn main() {
  tauri::Builder::default()
    .manage(ZoteroWatchState(Mutex::new(None)))
    .plugin(tauri_plugin_shell::init())
    .invoke_handler(tauri::generate_handler![
      start_zotero_watch,
      stop_zotero_watch,
      load_library,
      format_citations,
      start_analysis,
      sync_feishu,
      delete_extracted_data,
      update_item,
      read_config,
      save_config,
      read_fields,
      save_fields
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
