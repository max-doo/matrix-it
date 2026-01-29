//! Zotero 文件监控命令
//! 监听 zotero.sqlite 文件变更，通知前端刷新

use crate::error::ApiError;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

/// Zotero 监控状态
pub struct ZoteroWatchState(pub Mutex<Option<RecommendedWatcher>>);

/// 启动 Zotero 文件监控
#[tauri::command]
pub fn start_zotero_watch(
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
            format!(
                "zotero.sqlite not found at {}",
                sqlite_path.to_string_lossy()
            ),
        ));
    }

    let app_handle = app.clone();
    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
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

    let mut guard = state
        .0
        .lock()
        .map_err(|_| ApiError::new("WATCHER_LOCK", "poisoned"))?;
    *guard = Some(watcher);
    Ok(())
}

/// 停止 Zotero 文件监控
#[tauri::command]
pub fn stop_zotero_watch(state: tauri::State<ZoteroWatchState>) -> Result<(), ApiError> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| ApiError::new("WATCHER_LOCK", "poisoned"))?;
    *guard = None;
    Ok(())
}
