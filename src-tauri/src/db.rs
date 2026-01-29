//! SQLite 数据库操作模块
//! 封装 matrixit.db 的读写操作，支持在 spawn_blocking 中安全调用

use crate::utils::{find_project_root, resolve_data_dir_path, resolve_matrixit_db_path};
use rusqlite::Connection;
use serde_json::Value;
use std::path::Path;

/// API 错误类型（与 main.rs 中的 ApiError 保持一致）
#[derive(Debug, serde::Serialize)]
pub struct DbError {
    pub code: String,
    pub message: String,
}

impl DbError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// 确保数据库表存在
pub fn ensure_items_table(conn: &Connection) -> Result<(), DbError> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS items (item_key TEXT PRIMARY KEY, json TEXT NOT NULL)",
        [],
    )
    .map_err(|e| DbError::new("DB_INIT", e.to_string()))?;
    Ok(())
}

/// 从数据库读取单条 item 记录
pub fn read_item_from_db(db_path: &Path, item_key: &str) -> Option<Value> {
    let conn = Connection::open(db_path).ok()?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(1000));
    let json_str: String = conn
        .query_row(
            "SELECT json FROM items WHERE item_key = ?",
            [&item_key],
            |row| row.get(0),
        )
        .ok()?;
    serde_json::from_str::<Value>(&json_str).ok()
}

/// 更新单条 item 记录（同步版本，需在 spawn_blocking 中调用）
pub fn update_item_sync(item_key: String, patch: Value) -> Result<Value, DbError> {
    let root = find_project_root();
    let db_path = root.join("data").join("matrixit.db");

    // 确保 data 目录存在
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let conn = Connection::open(&db_path).map_err(|e| DbError::new("DB_OPEN", e.to_string()))?;
    ensure_items_table(&conn)?;

    // 读取现有记录
    let existing: Option<String> = conn
        .query_row(
            "SELECT json FROM items WHERE item_key = ?",
            [&item_key],
            |row| row.get(0),
        )
        .ok();

    let mut item: Value = match existing {
        Some(s) => serde_json::from_str(&s).unwrap_or(serde_json::json!({})),
        None => return Ok(serde_json::json!({"updated": false})),
    };

    // 合并 patch（忽略保护字段）
    let protected = [
        "item_key",
        "attachments",
        "collections",
        "date_modified",
        "item_type",
    ];
    if let Some(obj) = patch.as_object() {
        for (k, v) in obj {
            if protected.contains(&k.as_str()) {
                continue;
            }
            item[k] = v.clone();
        }
    }

    // 写回数据库
    let json_str = serde_json::to_string(&item).map_err(|e| DbError::new("JSON", e.to_string()))?;
    conn.execute(
        "INSERT INTO items(item_key, json) VALUES(?1, ?2) ON CONFLICT(item_key) DO UPDATE SET json = excluded.json",
        rusqlite::params![&item_key, &json_str],
    )
    .map_err(|e| DbError::new("DB_WRITE", e.to_string()))?;

    Ok(serde_json::json!({"updated": true}))
}

/// 批量删除 item 的指定字段（同步版本，需在 spawn_blocking 中调用）
pub fn purge_item_field_sync(field_key: String) -> Result<Value, DbError> {
    let key = field_key.trim();
    if key.is_empty() {
        return Ok(serde_json::json!({ "scanned": 0, "purged": 0 }));
    }

    let root = find_project_root();
    let db_path = root.join("data").join("matrixit.db");
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let mut conn =
        Connection::open(&db_path).map_err(|e| DbError::new("DB_OPEN", e.to_string()))?;
    ensure_items_table(&conn)?;

    let tx = conn
        .transaction()
        .map_err(|e| DbError::new("DB_TX", e.to_string()))?;
    let mut stmt = tx
        .prepare("SELECT item_key, json FROM items")
        .map_err(|e| DbError::new("DB_QUERY", e.to_string()))?;

    let mut scanned: i64 = 0;
    let mut updates: Vec<(String, String)> = Vec::new();
    let mut rows = stmt
        .query([])
        .map_err(|e| DbError::new("DB_QUERY", e.to_string()))?;
    while let Some(row) = rows
        .next()
        .map_err(|e| DbError::new("DB_QUERY", e.to_string()))?
    {
        scanned += 1;
        let item_key: String = row.get(0).map_err(|e| DbError::new("DB_ROW", e.to_string()))?;
        let json_str: String = row.get(1).map_err(|e| DbError::new("DB_ROW", e.to_string()))?;
        let mut item: Value = serde_json::from_str(&json_str).unwrap_or(serde_json::json!({}));
        let Some(obj) = item.as_object_mut() else {
            continue;
        };
        if obj.remove(key).is_none() {
            continue;
        }
        let next =
            serde_json::to_string(&item).map_err(|e| DbError::new("JSON", e.to_string()))?;
        updates.push((item_key, next));
    }
    drop(rows);
    drop(stmt);

    for (item_key, next_json) in &updates {
        tx.execute(
            "UPDATE items SET json = ?1 WHERE item_key = ?2",
            rusqlite::params![next_json, item_key],
        )
        .map_err(|e| DbError::new("DB_WRITE", e.to_string()))?;
    }

    tx.commit()
        .map_err(|e| DbError::new("DB_TX", e.to_string()))?;

    Ok(serde_json::json!({ "scanned": scanned, "purged": updates.len() }))
}

/// 重置飞书同步状态（同步版本，需在 spawn_blocking 中调用）
pub fn reset_feishu_sync_state_sync(root: &Path) -> Result<(), DbError> {
    let data_dir = resolve_data_dir_path(root);
    let db_path = data_dir.join("matrixit.db");
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if !db_path.exists() {
        return Ok(());
    }

    let mut conn =
        Connection::open(&db_path).map_err(|e| DbError::new("DB_OPEN", e.to_string()))?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS items (item_key TEXT PRIMARY KEY, json TEXT NOT NULL)",
        [],
    )
    .map_err(|e| DbError::new("DB_INIT", e.to_string()))?;

    let tx = conn
        .transaction()
        .map_err(|e| DbError::new("DB_TX", e.to_string()))?;
    let mut stmt = tx
        .prepare("SELECT item_key, json FROM items")
        .map_err(|e| DbError::new("DB_QUERY", e.to_string()))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| DbError::new("DB_QUERY", e.to_string()))?;
    let mut updates: Vec<(String, String)> = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|e| DbError::new("DB_QUERY", e.to_string()))?
    {
        let item_key: String = row.get(0).map_err(|e| DbError::new("DB_ROW", e.to_string()))?;
        let json_str: String = row.get(1).map_err(|e| DbError::new("DB_ROW", e.to_string()))?;
        let mut item: Value = serde_json::from_str(&json_str).unwrap_or(serde_json::json!({}));
        let Some(obj) = item.as_object_mut() else {
            continue;
        };
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
        if obj
            .get("sync_status")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            != "unsynced"
        {
            obj.insert(
                "sync_status".to_string(),
                Value::String("unsynced".to_string()),
            );
            changed = true;
        }
        if !changed {
            continue;
        }
        let next =
            serde_json::to_string(&item).map_err(|e| DbError::new("JSON", e.to_string()))?;
        updates.push((item_key, next));
    }
    drop(rows);
    drop(stmt);
    for (item_key, next_json) in &updates {
        tx.execute(
            "UPDATE items SET json = ?1 WHERE item_key = ?2",
            rusqlite::params![next_json, item_key],
        )
        .map_err(|e| DbError::new("DB_WRITE", e.to_string()))?;
    }
    tx.commit()
        .map_err(|e| DbError::new("DB_TX", e.to_string()))?;

    // 同时更新 literature.json
    let literature_path = data_dir.join("literature.json");
    if let Ok(content) = std::fs::read_to_string(&literature_path) {
        if let Ok(mut v) = serde_json::from_str::<Value>(&content) {
            if let Some(arr) = v.as_array_mut() {
                let mut changed_any = false;
                for it in arr.iter_mut() {
                    let Some(obj) = it.as_object_mut() else {
                        continue;
                    };
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
                    if obj
                        .get("sync_status")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        != "unsynced"
                    {
                        obj.insert(
                            "sync_status".to_string(),
                            Value::String("unsynced".to_string()),
                        );
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
