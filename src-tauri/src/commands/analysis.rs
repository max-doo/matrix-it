//! 分析任务命令
//! 启动和停止 LLM 分析任务

use crate::db::read_item_from_db;
use crate::error::ApiError;
use crate::utils::{ensure_sidecar_env, resolve_matrixit_db_path, truncate_utf8_boundary};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use tauri::ipc::Channel;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// 分析事件（发送到前端）
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "event", content = "data")]
pub enum AnalysisEvent {
    Started { item_key: String },
    Progress { item_key: String, current: u32, total: u32 },
    Finished { item_key: String, item: Option<serde_json::Value> },
    Failed { item_key: String, error: String },
    AllDone,
}

/// 分析任务状态管理
pub struct AnalysisState {
    pub child: Mutex<Option<CommandChild>>,
    pub pid: Mutex<Option<u32>>,
    pub cancelled: AtomicBool,
    pub pending_keys: Mutex<HashSet<String>>,
}

/// 启动分析任务
#[tauri::command]
pub async fn start_analysis(
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
        let mut pending = state
            .pending_keys
            .lock()
            .map_err(|_| ApiError::new("LOCK", "poisoned"))?;
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
        let mut guard = state
            .child
            .lock()
            .map_err(|_| ApiError::new("LOCK", "poisoned"))?;
        *guard = Some(child);
    }
    {
        let mut pid_guard = state
            .pid
            .lock()
            .map_err(|_| ApiError::new("LOCK", "poisoned"))?;
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

    let handle_json_line = |line: &str,
                                 state: &tauri::State<'_, AnalysisState>,
                                 on_event: &Channel<AnalysisEvent>,
                                 db_path: &std::path::Path,
                                 current: &mut u32,
                                 total: u32,
                                 finished: &mut HashSet<String>,
                                 failed: &mut HashSet<String>| {
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
                    *current += 1;
                    finished.insert(item_key.clone());
                    if let Ok(mut pending) = state.pending_keys.lock() {
                        pending.remove(&item_key);
                    }
                    let _ = on_event.send(AnalysisEvent::Progress {
                        item_key: item_key.clone(),
                        current: *current,
                        total,
                    });
                    let item_from_db =
                        read_item_from_db(db_path, &item_key).or_else(|| v.get("item").cloned());
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
                            handle_json_line(
                                &compact, &state, &on_event, &db_path, &mut current, total,
                                &mut finished, &mut failed,
                            );
                        }
                        continue;
                    }
                    if serde_json::from_str::<serde_json::Value>(line).is_ok() {
                        handle_json_line(
                            line, &state, &on_event, &db_path, &mut current, total, &mut finished,
                            &mut failed,
                        );
                        continue;
                    }
                    if line.starts_with('{') || line.starts_with('[') {
                        pending_json_buf = Some(line.to_string());
                    }
                }
            }
            tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                let chunk = String::from_utf8_lossy(&line).to_string();
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

    // 处理剩余缓冲区
    let remaining = buf.trim();
    if !remaining.is_empty() {
        if let Some(acc) = pending_json_buf.as_mut() {
            acc.push('\n');
            acc.push_str(remaining);
            if acc.len() <= max_pending_json_bytes {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(acc) {
                    let compact = serde_json::to_string(&v).unwrap_or_else(|_| acc.clone());
                    handle_json_line(
                        &compact, &state, &on_event, &db_path, &mut current, total, &mut finished,
                        &mut failed,
                    );
                }
            }
        } else {
            handle_json_line(
                remaining, &state, &on_event, &db_path, &mut current, total, &mut finished,
                &mut failed,
            );
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
        let mut guard = state
            .child
            .lock()
            .map_err(|_| ApiError::new("LOCK", "poisoned"))?;
        *guard = None;
    }

    // 如果被取消，为未完成的项发送 Cancelled 事件
    if was_cancelled {
        let unresolved: Vec<String> = item_keys
            .iter()
            .filter(|k| !finished.contains(*k) && !failed.contains(*k))
            .cloned()
            .collect();
        for k in &unresolved {
            let _ = on_event.send(AnalysisEvent::Failed {
                item_key: k.clone(),
                error: "CANCELLED".to_string(),
            });
        }
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
    if non_zero || last_error.is_some() || (!stderr_buf.trim().is_empty() && !unresolved.is_empty())
    {
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
            let _ = on_event.send(AnalysisEvent::Failed {
                item_key: k,
                error: err.clone(),
            });
        }
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
#[tauri::command]
pub fn stop_analysis(state: tauri::State<AnalysisState>) -> Result<serde_json::Value, ApiError> {
    // 设置取消标志
    state.cancelled.store(true, Ordering::SeqCst);

    // 获取 PID 用于 taskkill
    let pid_to_kill: Option<u32> = {
        let pid_guard = state
            .pid
            .lock()
            .map_err(|_| ApiError::new("LOCK", "poisoned"))?;
        *pid_guard
    };

    // 使用 taskkill 终止进程树（Windows 上更可靠）
    if let Some(pid) = pid_to_kill {
        #[cfg(target_os = "windows")]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output();
        }
    }

    // 同时调用 child.kill() 作为备选
    {
        let mut guard = state
            .child
            .lock()
            .map_err(|_| ApiError::new("LOCK", "poisoned"))?;
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }

    // 清理 PID
    {
        let mut pid_guard = state
            .pid
            .lock()
            .map_err(|_| ApiError::new("LOCK", "poisoned"))?;
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
