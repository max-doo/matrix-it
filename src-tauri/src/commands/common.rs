//! 通用工具命令
//! PDF 路径解析、打开路径等

use crate::db::read_item_from_db;
use crate::error::ApiError;
use crate::utils::{find_project_root, resolve_config_path, resolve_data_dir_path, resolve_matrixit_db_path};
use serde_json::Value;
use std::path::PathBuf;
use tauri_plugin_opener::OpenerExt;

/// 解析 PDF 文件路径
#[tauri::command]
pub async fn resolve_pdf_path(item_key: String) -> Result<String, ApiError> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = find_project_root();
        let cfg_path = resolve_config_path(&root);
        let db_path = resolve_matrixit_db_path();
        let key = item_key.trim();
        if key.is_empty() {
            return Ok(String::new());
        }

        let item = read_item_from_db(&db_path, key).unwrap_or(serde_json::json!({}));

        let zotero_dir = {
            let content = std::fs::read_to_string(cfg_path).unwrap_or_default();
            let v: Value = serde_json::from_str(&content).unwrap_or(serde_json::json!({}));
            let zotero = v.get("zotero").and_then(|x| x.as_object());
            let direct = zotero
                .and_then(|z| z.get("data_dir"))
                .cloned()
                .unwrap_or(Value::Null);
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
                let base = std::env::var("USERPROFILE").unwrap_or_default();
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

        if let Some(p) = item
            .get("pdf_path")
            .and_then(|x| x.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            let pb = PathBuf::from(p);
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
            PathBuf::new()
        } else {
            PathBuf::from(zotero_dir).join("storage")
        };

        if let Some(atts) = item.get("attachments").and_then(|x| x.as_array()) {
            for att in atts {
                let key = att
                    .get("key")
                    .and_then(|x| x.as_str())
                    .map(|s| s.trim())
                    .unwrap_or("");
                let filename = att
                    .get("filename")
                    .and_then(|x| x.as_str())
                    .map(|s| s.trim())
                    .unwrap_or("");
                if !filename.is_empty() {
                    let fp = PathBuf::from(filename);
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
                        let mut best: Option<(u64, PathBuf)> = None;
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
    })
    .await
    .map_err(|e| ApiError::new("SPAWN_BLOCKING", e.to_string()))?
}

/// 在浏览器中打开 PDF
#[tauri::command]
pub async fn open_pdf_in_browser(app: tauri::AppHandle, pdf_path: String) -> Result<(), ApiError> {
    let p = pdf_path.trim().to_string(); // Convert to owned String
    if p.is_empty() {
        return Err(ApiError::new("PDF_PATH_EMPTY", "pdf path is empty"));
    }
    
    let (html_path, _pdf_url) = tauri::async_runtime::spawn_blocking(move || {
        let pdf_abs = std::fs::canonicalize(&p).unwrap_or_else(|_| PathBuf::from(&p));
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
                    format!(
                        "failed to convert to file url: {}",
                        pdf_abs.to_string_lossy()
                    ),
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
        std::fs::write(&html_path, html)
            .map_err(|e| ApiError::new("WRITE_HTML", e.to_string()))?;
        Ok((html_path, pdf_url))
    })
    .await
    .map_err(|e| ApiError::new("SPAWN_BLOCKING", e.to_string()))??;

    app.opener()
        .open_path(html_path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| ApiError::new("OPEN_BROWSER", e.to_string()))?;
    Ok(())
}

/// 调试用：打开指定路径
#[tauri::command]
pub async fn open_path_debug(app: tauri::AppHandle, path: String) -> Result<(), ApiError> {
    let raw = path.trim().to_string();
    if raw.is_empty() {
        eprintln!("[MATRIXIT_OPEN_PATH] empty input");
        return Err(ApiError::new("PATH_EMPTY", "path is empty"));
    }

    let normalized = tauri::async_runtime::spawn_blocking(move || {
        let mut normalized = raw.clone();
        #[cfg(windows)]
        {
            if let Some(rest) = normalized.strip_prefix(r"\\?\UNC\") {
                normalized = format!(r"\\{}", rest);
            } else if let Some(rest) = normalized.strip_prefix(r"\\?\") {
                normalized = rest.to_string();
            }
        }

        let p = PathBuf::from(&normalized);
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
        Ok(normalized)
    })
    .await
    .map_err(|e| ApiError::new("SPAWN_BLOCKING", e.to_string()))??;

    app.opener()
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
