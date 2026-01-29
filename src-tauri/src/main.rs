use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::Emitter;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri_plugin_opener::OpenerExt;

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

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SyncFeishuOptions {
  resync_synced: Option<bool>,
  skip_attachment_upload: Option<bool>,
}

struct ZoteroWatchState(Mutex<Option<RecommendedWatcher>>);

/// 分析任务状态管理
/// - child: 当前运行的 sidecar 子进程句柄
/// - pid: 子进程 PID（用于 taskkill 终止进程树）
/// - cancelled: 取消标志，用于通知事件循环停止处理
/// - pending_keys: 待处理的 item_keys（用于终止时识别未完成项）
struct AnalysisState {
    child: Mutex<Option<CommandChild>>,
    pid: Mutex<Option<u32>>,
    cancelled: AtomicBool,
    pending_keys: Mutex<HashSet<String>>,
}

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

fn extract_bitable_sig_from_url(url: &str) -> Option<String> {
  let u = url.trim();
  if u.is_empty() {
    return None;
  }
  let app_token = if let Some(idx) = u.find("/base/") {
    let rest = &u[idx + "/base/".len()..];
    rest
      .split(|c| c == '/' || c == '?' || c == '#')
      .next()
      .unwrap_or("")
      .trim()
      .to_string()
  } else {
    String::new()
  };
  let table_id = if let Some(idx) = u.find("table=") {
    let rest = &u[idx + "table=".len()..];
    rest
      .split(|c| c == '&' || c == '#')
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

fn extract_feishu_base_sig(v: &serde_json::Value) -> Option<String> {
  let feishu = v.get("feishu")?;
  let url = feishu.get("bitable_url").and_then(|x| x.as_str()).unwrap_or("");
  extract_bitable_sig_from_url(url)
}

fn reset_feishu_sync_state(root: &Path) -> Result<(), ApiError> {
  let data_dir = resolve_data_dir_path(root);
  let db_path = data_dir.join("matrixit.db");
  if let Some(parent) = db_path.parent() {
    let _ = std::fs::create_dir_all(parent);
  }
  if !db_path.exists() {
    return Ok(());
  }
  let mut conn = rusqlite::Connection::open(&db_path).map_err(|e| ApiError::new("DB_OPEN", e.to_string()))?;
  conn
    .execute("CREATE TABLE IF NOT EXISTS items (item_key TEXT PRIMARY KEY, json TEXT NOT NULL)", [])
    .map_err(|e| ApiError::new("DB_INIT", e.to_string()))?;
  let tx = conn.transaction().map_err(|e| ApiError::new("DB_TX", e.to_string()))?;
  let mut stmt = tx
    .prepare("SELECT item_key, json FROM items")
    .map_err(|e| ApiError::new("DB_QUERY", e.to_string()))?;
  let mut rows = stmt.query([]).map_err(|e| ApiError::new("DB_QUERY", e.to_string()))?;
  let mut updates: Vec<(String, String)> = Vec::new();
  while let Some(row) = rows.next().map_err(|e| ApiError::new("DB_QUERY", e.to_string()))? {
    let item_key: String = row.get(0).map_err(|e| ApiError::new("DB_ROW", e.to_string()))?;
    let json_str: String = row.get(1).map_err(|e| ApiError::new("DB_ROW", e.to_string()))?;
    let mut item: serde_json::Value = serde_json::from_str(&json_str).unwrap_or(serde_json::json!({}));
    let Some(obj) = item.as_object_mut() else { continue };
    let mut changed = false;
    if obj.remove("record_id").is_some() {
      changed = true;
    }
    if obj.remove("feishu_base_sig").is_some() {
      changed = true;
    }
    if obj.remove("feishu_app_token").is_some() {
      changed = true;
    }
    if obj.remove("feishu_table_id").is_some() {
      changed = true;
    }
    if obj.get("sync_status").and_then(|x| x.as_str()).unwrap_or("") != "unsynced" {
      obj.insert("sync_status".to_string(), serde_json::Value::String("unsynced".to_string()));
      changed = true;
    }
    if !changed {
      continue;
    }
    let next = serde_json::to_string(&item).map_err(|e| ApiError::new("JSON", e.to_string()))?;
    updates.push((item_key, next));
  }
  drop(rows);
  drop(stmt);
  for (item_key, next_json) in &updates {
    tx.execute(
      "UPDATE items SET json = ?1 WHERE item_key = ?2",
      rusqlite::params![next_json, item_key],
    )
    .map_err(|e| ApiError::new("DB_WRITE", e.to_string()))?;
  }
  tx.commit().map_err(|e| ApiError::new("DB_TX", e.to_string()))?;

  let literature_path = data_dir.join("literature.json");
  if let Ok(content) = std::fs::read_to_string(&literature_path) {
    if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&content) {
      if let Some(arr) = v.as_array_mut() {
        let mut changed_any = false;
        for it in arr.iter_mut() {
          let Some(obj) = it.as_object_mut() else { continue };
          let mut changed = false;
          if obj.remove("record_id").is_some() {
            changed = true;
          }
          if obj.remove("feishu_base_sig").is_some() {
            changed = true;
          }
          if obj.remove("feishu_app_token").is_some() {
            changed = true;
          }
          if obj.remove("feishu_table_id").is_some() {
            changed = true;
          }
          if obj.get("sync_status").and_then(|x| x.as_str()).unwrap_or("") != "unsynced" {
            obj.insert("sync_status".to_string(), serde_json::Value::String("unsynced".to_string()));
            changed = true;
          }
          if changed {
            changed_any = true;
          }
        }
        if changed_any {
          if let Ok(s) = serde_json::to_string_pretty(&v) {
            let _ = std::fs::write(&literature_path, s);
          }
        }
      }
    }
  }

  Ok(())
}

fn ensure_sidecar_env() {
  let root = find_project_root();
  let cfg = resolve_config_path(&root);
  std::env::set_var("MATRIXIT_WORKDIR", root.to_string_lossy().to_string());
  std::env::set_var("MATRIXIT_CONFIG", cfg.to_string_lossy().to_string());
}

fn resolve_data_dir_path(root: &Path) -> PathBuf {
  match std::env::var("MATRIXIT_DATA_DIR") {
    Ok(v) => {
      let p = PathBuf::from(v);
      if p.is_absolute() {
        p
      } else {
        root.join(p)
      }
    }
    Err(_) => root.join("data"),
  }
}

fn resolve_matrixit_db_path() -> PathBuf {
  let root = find_project_root();
  let data_dir = resolve_data_dir_path(&root);
  match std::env::var("MATRIXIT_DB") {
    Ok(v) => {
      let p = PathBuf::from(v);
      if p.is_absolute() {
        p
      } else {
        data_dir.join(p)
      }
    }
    Err(_) => data_dir.join("matrixit.db"),
  }
}

fn read_item_from_matrixit_db(db_path: &Path, item_key: &str) -> Option<serde_json::Value> {
  let conn = rusqlite::Connection::open(db_path).ok()?;
  let _ = conn.busy_timeout(std::time::Duration::from_millis(1000));
  let json_str: String = conn
    .query_row(
      "SELECT json FROM items WHERE item_key = ?",
      [&item_key],
      |row| row.get(0),
    )
    .ok()?;
  serde_json::from_str::<serde_json::Value>(&json_str).ok()
}

fn truncate_utf8_boundary(s: &mut String, max_len: usize) {
  if s.len() <= max_len {
    return;
  }
  let mut cut = max_len;
  while cut > 0 && !s.is_char_boundary(cut) {
    cut -= 1;
  }
  s.truncate(cut);
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

// 新增 LoadLibraryState 结构体（放到 AnalysisState 附近）
struct LoadLibraryState(Mutex<Option<CommandChild>>);

#[tauri::command]
async fn load_library(
  app: tauri::AppHandle,
  state: tauri::State<'_, LoadLibraryState>,
) -> Result<LoadLibraryResponse, ApiError> {
  ensure_sidecar_env();

  // 1. 终止之前的进程（如果存在）
  {
    let mut guard = state.0.lock().map_err(|_| ApiError::new("LOCK_POISONED", "State lock failed"))?;
    if let Some(child) = guard.take() {
      // 尝试终止旧进程。忽略错误（可能进程已结束）
      let _ = child.kill(); 
    }
  }

  // 2. 启动新进程
  let (mut rx, child) = app
    .shell()
    .sidecar("matrixit-sidecar")
    .map_err(|e| ApiError::new("SIDE_CAR_NOT_FOUND", e.to_string()))?
    .arg("load_library")
    .spawn()
    .map_err(|e| ApiError::new("SIDE_CAR_SPAWN_FAILED", e.to_string()))?;

  // 3. 保存新进程句柄
  {
    let mut guard = state.0.lock().map_err(|_| ApiError::new("LOCK_POISONED", "State lock failed"))?;
    *guard = Some(child);
  }

  // 4. 异步读取输出
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
         let mut guard = state.0.lock().unwrap(); // 这里 unwrap 安全，因为我们持有 state
         *guard = None;

         if !status.code.unwrap_or(0) == 0 {
             return Err(ApiError::new(
               "SIDE_CAR_NON_ZERO",
               String::from_utf8_lossy(&stderr_buf).to_string(),
             ));
         }
      }
      _ => {}
    }
  }

  // 5. 解析结果
  let stdout = String::from_utf8(stdout_buf).map_err(|e| ApiError::new("UTF8", e.to_string()))?;
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
struct GetItemsResponse {
  items: serde_json::Value,
}

#[tauri::command]
async fn get_items(app: tauri::AppHandle, item_keys: Vec<String>) -> Result<GetItemsResponse, ApiError> {
  ensure_sidecar_env();
  let output = app
    .shell()
    .sidecar("matrixit-sidecar")
    .map_err(|e| ApiError::new("SIDE_CAR_NOT_FOUND", e.to_string()))?
    .arg("get_items")
    .arg(
      serde_json::to_string(&item_keys).map_err(|e| ApiError::new("JSON", e.to_string()))?,
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

  let stdout = String::from_utf8(output.stdout).map_err(|e| ApiError::new("UTF8", e.to_string()))?;
  let v: serde_json::Value = serde_json::from_str(&stdout).map_err(|e| ApiError::new("JSON", e.to_string()))?;
  if let Some(err) = v.get("error") {
    let code = err.get("code").and_then(|x| x.as_str()).unwrap_or("GET_ITEMS_FAILED");
    let msg = err.get("message").and_then(|x| x.as_str()).unwrap_or("unknown");
    return Err(ApiError::new(code, msg));
  }

  Ok(GetItemsResponse {
    items: v.get("items").cloned().unwrap_or(serde_json::json!([])),
  })
}

#[tauri::command]
async fn resolve_pdf_path(item_key: String) -> Result<String, ApiError> {
  let root = find_project_root();
  let cfg_path = resolve_config_path(&root);
  let db_path = resolve_matrixit_db_path();
  let key = item_key.trim();
  if key.is_empty() {
    return Ok(String::new());
  }

  let item = read_item_from_matrixit_db(&db_path, key).unwrap_or(serde_json::json!({}));

  let zotero_dir = {
    let content = std::fs::read_to_string(cfg_path).unwrap_or_else(|_| String::new());
    let v: serde_json::Value = serde_json::from_str(&content).unwrap_or(serde_json::json!({}));
    let zotero = v.get("zotero").and_then(|x| x.as_object());
    let direct = zotero.and_then(|z| z.get("data_dir")).cloned().unwrap_or(serde_json::Value::Null);
    let mut out = direct.as_str().unwrap_or("").trim().to_string();
    if out.is_empty() {
      if let Some(obj) = direct.as_object() {
        out = obj
          .get("path")
          .and_then(|x| x.as_str())
          .or_else(|| obj.get("data_dir").and_then(|x| x.as_str()))
          .or_else(|| obj.get("dir").and_then(|x| x.as_str()))
          .unwrap_or("")
          .trim()
          .to_string();
      }
    }
    if out.is_empty() {
      let base = std::env::var("USERPROFILE").unwrap_or_else(|_| String::new());
      if base.trim().is_empty() {
        String::new()
      } else {
        format!("{}\\Zotero", base.trim_end_matches(['\\', '/']))
      }
    } else {
      out
    }
  };

  let normalize_path = |raw: String| -> String {
    #[cfg(windows)]
    {
      if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{}", rest);
      }
      if let Some(rest) = raw.strip_prefix(r"\\?\") {
        return rest.to_string();
      }
    }
    raw
  };

  let resolve_candidate = |p: &std::path::Path| -> Option<String> {
    if !p.exists() {
      return None;
    }
    let raw = std::fs::canonicalize(p)
      .ok()
      .map(|x| x.to_string_lossy().to_string())
      .unwrap_or_else(|| p.to_string_lossy().to_string());
    Some(normalize_path(raw))
  };

  if let Some(p) = item.get("pdf_path").and_then(|x| x.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty()) {
    let pb = std::path::PathBuf::from(p);
    if pb.is_absolute() {
      if let Some(found) = resolve_candidate(&pb) {
        return Ok(found);
      }
    } else {
      let joined = root.join(p);
      if let Some(found) = resolve_candidate(&joined) {
        return Ok(found);
      }
    }
  }

  let storage_root = if zotero_dir.trim().is_empty() {
    std::path::PathBuf::new()
  } else {
    std::path::PathBuf::from(zotero_dir).join("storage")
  };

  if let Some(atts) = item.get("attachments").and_then(|x| x.as_array()) {
    for att in atts {
      let key = att.get("key").and_then(|x| x.as_str()).map(|s| s.trim()).unwrap_or("");
      let filename = att.get("filename").and_then(|x| x.as_str()).map(|s| s.trim()).unwrap_or("");
      if !filename.is_empty() {
        let fp = std::path::PathBuf::from(filename);
        if fp.is_absolute() {
          if let Some(found) = resolve_candidate(&fp) {
            return Ok(found);
          }
        }
      }
      if !storage_root.as_os_str().is_empty() && !key.is_empty() && !filename.is_empty() {
        let p = storage_root.join(key).join(filename);
        if let Some(found) = resolve_candidate(&p) {
          return Ok(found);
        }
      }
      if !storage_root.as_os_str().is_empty() && !key.is_empty() {
        let pdir = storage_root.join(key);
        if pdir.exists() && pdir.is_dir() {
          let mut best: Option<(u64, std::path::PathBuf)> = None;
          if let Ok(rd) = std::fs::read_dir(&pdir) {
            for ent in rd.flatten() {
              let p = ent.path();
              let is_pdf = p
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| x.eq_ignore_ascii_case("pdf"))
                .unwrap_or(false);
              if !is_pdf {
                continue;
              }
              let size = ent.metadata().ok().map(|m| m.len()).unwrap_or(0);
              if best.as_ref().map(|(s, _)| size > *s).unwrap_or(true) {
                best = Some((size, p));
              }
            }
          }
          if let Some((_, p)) = best {
            if let Some(found) = resolve_candidate(&p) {
              return Ok(found);
            }
          }
        }
      }
    }
  }

  Ok(String::new())
}

#[tauri::command]
async fn open_pdf_in_browser(app: tauri::AppHandle, pdf_path: String) -> Result<(), ApiError> {
  let p = pdf_path.trim();
  if p.is_empty() {
    return Err(ApiError::new("PDF_PATH_EMPTY", "pdf path is empty"));
  }
  let pdf_abs = std::fs::canonicalize(p).unwrap_or_else(|_| std::path::PathBuf::from(p));
  if !pdf_abs.exists() {
    return Err(ApiError::new(
      "PDF_NOT_FOUND",
      format!("pdf not found: {}", pdf_abs.to_string_lossy()),
    ));
  }
  let pdf_url = match tauri::Url::from_file_path(&pdf_abs) {
    Ok(u) => u.to_string(),
    Err(_) => {
      return Err(ApiError::new(
        "PDF_URL",
        format!("failed to convert to file url: {}", pdf_abs.to_string_lossy()),
      ))
    }
  };

  let root = find_project_root();
  let data_dir = resolve_data_dir_path(&root);
  let _ = std::fs::create_dir_all(&data_dir);
  let html_path = data_dir.join("matrixit-open-pdf.html");
  let html = format!(
    r#"<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MatrixIt PDF</title>
    <style>html,body{{height:100%;margin:0}} embed{{width:100%;height:100%}}</style>
  </head>
  <body>
    <embed src="{src}" type="application/pdf" />
  </body>
</html>
"#,
    src = pdf_url
  );
  std::fs::write(&html_path, html).map_err(|e| ApiError::new("WRITE_HTML", e.to_string()))?;

  app
    .opener()
    .open_path(html_path.to_string_lossy().to_string(), None::<&str>)
    .map_err(|e| ApiError::new("OPEN_BROWSER", e.to_string()))?;
  Ok(())
}

#[tauri::command]
async fn open_path_debug(app: tauri::AppHandle, path: String) -> Result<(), ApiError> {
  let raw = path.trim().to_string();
  if raw.is_empty() {
    eprintln!("[MATRIXIT_OPEN_PATH] empty input");
    return Err(ApiError::new("PATH_EMPTY", "path is empty"));
  }

  let mut normalized = raw.clone();
  #[cfg(windows)]
  {
    if let Some(rest) = normalized.strip_prefix(r"\\?\UNC\") {
      normalized = format!(r"\\{}", rest);
    } else if let Some(rest) = normalized.strip_prefix(r"\\?\") {
      normalized = rest.to_string();
    }
  }

  let p = std::path::PathBuf::from(&normalized);
  let exists = p.exists();
  let meta = std::fs::metadata(&p).ok();
  let is_file = meta.as_ref().map(|m| m.is_file()).unwrap_or(false);
  let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);

  eprintln!(
    "[MATRIXIT_OPEN_PATH] {{\"raw\":{},\"normalized\":{},\"exists\":{},\"is_file\":{},\"size\":{}}}",
    serde_json::to_string(&raw).unwrap_or_else(|_| "\"\"".to_string()),
    serde_json::to_string(&normalized).unwrap_or_else(|_| "\"\"".to_string()),
    exists,
    is_file,
    size
  );

  if !exists {
    return Err(ApiError::new("PATH_NOT_FOUND", normalized));
  }

  app
    .opener()
    .open_path(normalized.clone(), None::<&str>)
    .map_err(|e| {
      eprintln!(
        "[MATRIXIT_OPEN_PATH] failed: {}",
        serde_json::to_string(&format!("{}", e)).unwrap_or_else(|_| "\"\"".to_string())
      );
      ApiError::new("OPEN_PATH_FAILED", e.to_string())
    })?;

  eprintln!("[MATRIXIT_OPEN_PATH] ok");
  Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "event", content = "data")]
enum AnalysisEvent {
  Started { item_key: String },
  Progress { item_key: String, current: u32, total: u32 },
  Finished { item_key: String, item: Option<serde_json::Value> },
  Failed { item_key: String, error: String },
  AllDone,
}

#[tauri::command]
async fn start_analysis(
  app: tauri::AppHandle,
  state: tauri::State<'_, AnalysisState>,
  item_keys: Vec<String>,
  on_event: Channel<AnalysisEvent>,
) -> Result<(), ApiError> {
  let started_at = Instant::now();
  // 重置取消标志
  state.cancelled.store(false, Ordering::SeqCst);
  
  // 记录待处理的 keys
  {
    let mut pending = state.pending_keys.lock().map_err(|_| ApiError::new("LOCK", "poisoned"))?;
    pending.clear();
    for k in &item_keys {
      pending.insert(k.clone());
    }
  }

  ensure_sidecar_env();
  let db_path = resolve_matrixit_db_path();
  let cmd = app
    .shell()
    .sidecar("matrixit-sidecar")
    .map_err(|e| ApiError::new("SIDE_CAR_NOT_FOUND", e.to_string()))?
    .arg("analyze")
    .arg(serde_json::to_string(&item_keys).map_err(|e| ApiError::new("JSON", e.to_string()))?);

  let (mut rx, child) = cmd
    .spawn()
    .map_err(|e| ApiError::new("SIDE_CAR_SPAWN_FAILED", e.to_string()))?;

  // 保存子进程句柄和 PID 以支持终止
  let child_pid = child.pid();
  {
    let mut guard = state.child.lock().map_err(|_| ApiError::new("LOCK", "poisoned"))?;
    *guard = Some(child);
  }
  {
    let mut pid_guard = state.pid.lock().map_err(|_| ApiError::new("LOCK", "poisoned"))?;
    *pid_guard = Some(child_pid);
  }

  let total = item_keys.len() as u32;
  let mut current: u32 = 0;
  let mut buf = String::new();
  let mut stderr_buf = String::new();
  let mut stderr_line_buf = String::new();
  let mut pending_json_buf: Option<String> = None;
  let max_pending_json_bytes: usize = 512 * 1024;
  let mut sidecar_diag: Option<serde_json::Value> = None;
  let mut finished: HashSet<String> = HashSet::new();
  let mut failed: HashSet<String> = HashSet::new();
  let mut terminated_code: Option<i32> = None;
  let mut last_error: Option<String> = None;
  let mut was_cancelled = false;

  let mut handle_json_line = |line: &str| {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
      if let Some(item_key) = v
        .get("item_key")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
      {
        if v.get("type").and_then(|x| x.as_str()) == Some("started") {
          let _ = on_event.send(AnalysisEvent::Started {
            item_key: item_key.clone(),
          });
        }
        if v.get("type").and_then(|x| x.as_str()) == Some("finished") {
          current += 1;
          finished.insert(item_key.clone());
          if let Ok(mut pending) = state.pending_keys.lock() {
            pending.remove(&item_key);
          }
          let _ = on_event.send(AnalysisEvent::Progress {
            item_key: item_key.clone(),
            current,
            total,
          });
          let item_from_db =
            read_item_from_matrixit_db(&db_path, &item_key).or_else(|| v.get("item").cloned());
          let _ = on_event.send(AnalysisEvent::Finished {
            item_key: item_key.clone(),
            item: item_from_db,
          });
        }
        if v.get("type").and_then(|x| x.as_str()) == Some("failed") {
          failed.insert(item_key.clone());
          if let Ok(mut pending) = state.pending_keys.lock() {
            pending.remove(&item_key);
          }
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
          let _ = on_event.send(AnalysisEvent::Failed {
            item_key: item_key.clone(),
            error: err,
          });
        }
        if v.get("type").and_then(|x| x.as_str()) == Some("debug") {
          eprintln!("[analysis][{}] {}", item_key, line);
        }
      }
    }
  };

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
          if let Some(acc) = pending_json_buf.as_mut() {
            acc.push('\n');
            acc.push_str(line);
            if acc.len() > max_pending_json_bytes {
              pending_json_buf = None;
              continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(acc) {
              let compact = serde_json::to_string(&v).unwrap_or_else(|_| acc.clone());
              pending_json_buf = None;
              handle_json_line(&compact);
            }
            continue;
          }
          if serde_json::from_str::<serde_json::Value>(line).is_ok() {
            handle_json_line(line);
            continue;
          }
          if line.starts_with('{') || line.starts_with('[') {
            pending_json_buf = Some(line.to_string());
          }
        }
      }
      tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
        let chunk = String::from_utf8_lossy(&line).to_string();
        // 实时打印 stderr 到控制台，方便调试
        eprint!("{}", chunk);
        stderr_line_buf.push_str(&chunk);
        while let Some(pos) = stderr_line_buf.find('\n') {
          let mut line = stderr_line_buf[..pos].to_string();
          stderr_line_buf = stderr_line_buf[pos + 1..].to_string();
          if line.ends_with('\r') {
            line.pop();
          }
          let trimmed = line.trim();
          if let Some(rest) = trimmed.strip_prefix("[MATRIXIT_ANALYZE_SUMMARY]") {
            let raw = rest.trim();
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
              sidecar_diag = Some(v);
            }
          }
        }
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
      }
      _ => {}
    }

    if state.cancelled.load(Ordering::SeqCst) {
      was_cancelled = true;
      break;
    }
  }

  let remaining = buf.trim();
  if !remaining.is_empty() {
    if let Some(acc) = pending_json_buf.as_mut() {
      acc.push('\n');
      acc.push_str(remaining);
      if acc.len() <= max_pending_json_bytes {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(acc) {
          let compact = serde_json::to_string(&v).unwrap_or_else(|_| acc.clone());
          handle_json_line(&compact);
        }
      }
    } else {
      handle_json_line(remaining);
    }
  }
  let remaining_err = stderr_line_buf.trim();
  if !remaining_err.is_empty() {
    let trimmed = remaining_err.trim();
    if let Some(rest) = trimmed.strip_prefix("[MATRIXIT_ANALYZE_SUMMARY]") {
      let raw = rest.trim();
      if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
        sidecar_diag = Some(v);
      }
    }
  }

  // 清理子进程句柄
  {
    let mut guard = state.child.lock().map_err(|_| ApiError::new("LOCK", "poisoned"))?;
    *guard = None;
  }

  // 如果被取消，为未完成的项发送 Cancelled 事件（复用 Failed 事件）
  if was_cancelled {
    let unresolved: Vec<String> = item_keys
      .iter()
      .filter(|k| !finished.contains(*k) && !failed.contains(*k))
      .cloned()
      .collect();
    for k in &unresolved {
      let _ = on_event.send(AnalysisEvent::Failed { item_key: k.clone(), error: "CANCELLED".to_string() });
    }
    // 清理 pending
    if let Ok(mut pending) = state.pending_keys.lock() {
      pending.clear();
    }
    let _ = on_event.send(AnalysisEvent::AllDone);
    eprintln!(
      "[analysis] done total={} finished={} failed={} cancelled=true dur_ms={}",
      total,
      finished.len(),
      failed.len(),
      started_at.elapsed().as_millis()
    );
    return Ok(());
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
    // 清理 pending
    if let Ok(mut pending) = state.pending_keys.lock() {
      pending.clear();
    }
    let _ = on_event.send(AnalysisEvent::AllDone);
    eprintln!(
      "[analysis] done total={} finished={} failed={} cancelled=false dur_ms={} err={}",
      total,
      finished.len(),
      failed.len(),
      started_at.elapsed().as_millis(),
      err.replace('\n', " | ")
    );
    return Err(ApiError::new("ANALYZE_FAILED", err));
  }
  
  // 清理 pending
  if let Ok(mut pending) = state.pending_keys.lock() {
    pending.clear();
  }
  let _ = on_event.send(AnalysisEvent::AllDone);
  if let Some(v) = sidecar_diag {
    eprintln!(
      "[analysis] done total={} finished={} failed={} cancelled=false dur_ms={} sidecar={}",
      total,
      finished.len(),
      failed.len(),
      started_at.elapsed().as_millis(),
      v
    );
  } else {
    eprintln!(
      "[analysis] done total={} finished={} failed={} cancelled=false dur_ms={}",
      total,
      finished.len(),
      failed.len(),
      started_at.elapsed().as_millis()
    );
  }
  Ok(())
}

/// 终止正在进行的分析任务
/// 只会终止分析中/待分析的任务，已完成的结果会保留
#[tauri::command]
fn stop_analysis(state: tauri::State<AnalysisState>) -> Result<serde_json::Value, ApiError> {
  // 设置取消标志
  state.cancelled.store(true, Ordering::SeqCst);
  
  // 获取 PID 用于 taskkill
  let pid_to_kill: Option<u32> = {
    let pid_guard = state.pid.lock().map_err(|_| ApiError::new("LOCK", "poisoned"))?;
    *pid_guard
  };
  
  // 使用 taskkill 终止进程树（Windows 上更可靠）
  if let Some(pid) = pid_to_kill {
    #[cfg(target_os = "windows")]
    {
      // taskkill /F /T /PID <pid> 强制终止进程树
      let _ = std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
      // Unix 系统使用 kill -9
      let _ = std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .output();
    }
  }
  
  // 同时调用 child.kill() 作为备选
  {
    let mut guard = state.child.lock().map_err(|_| ApiError::new("LOCK", "poisoned"))?;
    if let Some(child) = guard.take() {
      let _ = child.kill();
    }
  }
  
  // 清理 PID
  {
    let mut pid_guard = state.pid.lock().map_err(|_| ApiError::new("LOCK", "poisoned"))?;
    *pid_guard = None;
  }
  
  // 获取被取消的 keys 数量
  let cancelled_count = {
    if let Ok(pending) = state.pending_keys.lock() {
      pending.len()
    } else {
      0
    }
  };
  
  Ok(serde_json::json!({
    "stopped": true,
    "cancelled_count": cancelled_count
  }))
}
#[tauri::command]
async fn sync_feishu(
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

#[tauri::command]
async fn reconcile_feishu(app: tauri::AppHandle, item_keys: Vec<String>) -> Result<serde_json::Value, ApiError> {
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

/// 导出 Excel 文件
/// 仅导出 processed_status == 'done' 的条目
#[tauri::command]
async fn export_excel(
  app: tauri::AppHandle,
  output_path: String,
  filename: String,
  keys: Vec<String>,
) -> Result<serde_json::Value, ApiError> {
  ensure_sidecar_env();
  let payload = serde_json::json!({
    "output_path": output_path,
    "filename": filename,
    "keys": keys
  });
  let cmd = app
    .shell()
    .sidecar("matrixit-sidecar")
    .map_err(|e| ApiError::new("SIDE_CAR_NOT_FOUND", e.to_string()))?
    .arg("export_excel")
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

/// 导出 PDF 附件
/// 按集合树结构复制 PDF 到目标目录
#[tauri::command]
async fn export_pdfs(
  app: tauri::AppHandle,
  output_dir: String,
  keys: Vec<String>,
) -> Result<serde_json::Value, ApiError> {
  ensure_sidecar_env();
  let payload = serde_json::json!({
    "output_dir": output_dir,
    "keys": keys
  });
  let cmd = app
    .shell()
    .sidecar("matrixit-sidecar")
    .map_err(|e| ApiError::new("SIDE_CAR_NOT_FOUND", e.to_string()))?
    .arg("export_pdfs")
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
    item_key: String,
    patch: serde_json::Value,
) -> Result<serde_json::Value, ApiError> {
    // 性能优化：直接在 Rust 中操作 SQLite，绕过 Python sidecar 进程启动开销
    let root = find_project_root();
    let db_path = root.join("data").join("matrixit.db");
    
    // 确保 data 目录存在
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    
    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| ApiError::new("DB_OPEN", e.to_string()))?;
    
    // 确保表存在
    conn.execute(
        "CREATE TABLE IF NOT EXISTS items (item_key TEXT PRIMARY KEY, json TEXT NOT NULL)",
        [],
    )
    .map_err(|e| ApiError::new("DB_INIT", e.to_string()))?;
    
    // 1. 读取现有记录
    let existing: Option<String> = conn
        .query_row(
            "SELECT json FROM items WHERE item_key = ?",
            [&item_key],
            |row| row.get(0),
        )
        .ok();
    
    let mut item: serde_json::Value = match existing {
        Some(s) => serde_json::from_str(&s).unwrap_or(serde_json::json!({})),
        None => return Ok(serde_json::json!({"updated": false})),
    };
    
    // 2. 合并 patch（忽略关键字段）
    let protected = ["item_key", "attachments", "collections", "date_modified", "item_type"];
    if let Some(obj) = patch.as_object() {
        for (k, v) in obj {
            if protected.contains(&k.as_str()) { continue; }
            item[k] = v.clone();
        }
    }
    
    // 3. 写回数据库
    let json_str = serde_json::to_string(&item)
        .map_err(|e| ApiError::new("JSON", e.to_string()))?;
    conn.execute(
        "INSERT INTO items(item_key, json) VALUES(?1, ?2) ON CONFLICT(item_key) DO UPDATE SET json = excluded.json",
        rusqlite::params![&item_key, &json_str],
    )
    .map_err(|e| ApiError::new("DB_WRITE", e.to_string()))?;
    
    Ok(serde_json::json!({"updated": true}))
}

#[tauri::command]
async fn purge_item_field(field_key: String) -> Result<serde_json::Value, ApiError> {
    let key = field_key.trim();
    if key.is_empty() {
        return Ok(serde_json::json!({ "scanned": 0, "purged": 0 }));
    }

    let root = find_project_root();
    let db_path = root.join("data").join("matrixit.db");
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let mut conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| ApiError::new("DB_OPEN", e.to_string()))?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS items (item_key TEXT PRIMARY KEY, json TEXT NOT NULL)",
        [],
    )
    .map_err(|e| ApiError::new("DB_INIT", e.to_string()))?;

    let tx = conn.transaction().map_err(|e| ApiError::new("DB_TX", e.to_string()))?;
    let mut stmt = tx
        .prepare("SELECT item_key, json FROM items")
        .map_err(|e| ApiError::new("DB_QUERY", e.to_string()))?;

    let mut scanned: i64 = 0;
    let mut updates: Vec<(String, String)> = Vec::new();
    let mut rows = stmt.query([]).map_err(|e| ApiError::new("DB_QUERY", e.to_string()))?;
    while let Some(row) = rows.next().map_err(|e| ApiError::new("DB_QUERY", e.to_string()))? {
        scanned += 1;
        let item_key: String = row.get(0).map_err(|e| ApiError::new("DB_ROW", e.to_string()))?;
        let json_str: String = row.get(1).map_err(|e| ApiError::new("DB_ROW", e.to_string()))?;
        let mut item: serde_json::Value = serde_json::from_str(&json_str).unwrap_or(serde_json::json!({}));
        let Some(obj) = item.as_object_mut() else { continue };
        if obj.remove(key).is_none() {
            continue;
        }
        let next = serde_json::to_string(&item).map_err(|e| ApiError::new("JSON", e.to_string()))?;
        updates.push((item_key, next));
    }
    drop(rows);
    drop(stmt);

    for (item_key, next_json) in &updates {
        tx.execute(
            "UPDATE items SET json = ?1 WHERE item_key = ?2",
            rusqlite::params![next_json, item_key],
        )
        .map_err(|e| ApiError::new("DB_WRITE", e.to_string()))?;
    }

    tx.commit().map_err(|e| ApiError::new("DB_TX", e.to_string()))?;

    Ok(serde_json::json!({ "scanned": scanned, "purged": updates.len() }))
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
  let old_sig = {
    let path = resolve_config_path(&root);
    if let Ok(content) = std::fs::read_to_string(path) {
      if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
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
      let _ = reset_feishu_sync_state(&root);
    }
  }
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
    .manage(LoadLibraryState(Mutex::new(None)))
    .manage(AnalysisState {
      child: Mutex::new(None),
      pid: Mutex::new(None),
      cancelled: AtomicBool::new(false),
      pending_keys: Mutex::new(HashSet::new()),
    })
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![
      start_zotero_watch,
      stop_zotero_watch,
      load_library,
      get_items,
      resolve_pdf_path,
      open_pdf_in_browser,
      open_path_debug,
      format_citations,
      start_analysis,
      stop_analysis,
      sync_feishu,
      reconcile_feishu,
      export_excel,
      export_pdfs,
      delete_extracted_data,
      purge_item_field,
      update_item,
      read_config,
      save_config,
      read_fields,
      save_fields
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
