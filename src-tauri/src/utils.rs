//! 通用工具函数模块
//! 包含项目路径解析、配置文件路径定位等基础工具

use std::path::{Path, PathBuf};

/// 从当前工作目录向上查找项目根目录
/// 项目根目录的标识是存在 `config/config.json` 或 `config.json` 文件
pub fn find_project_root() -> PathBuf {
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

/// 解析配置文件路径
/// 优先使用用户配置 `config/config.json`，不存在时尝试从打包资源恢复
/// 恢复优先级：1. 用户配置 2. 从默认配置复制恢复 3. 直接读默认配置 4. 旧路径
pub fn resolve_config_path(root: &Path) -> PathBuf {
    // 1. 优先：用户配置 config/config.json
    let user_path = root.join("config").join("config.json");
    if user_path.exists() {
        return user_path;
    }

    // 2. 用户配置不存在时，尝试从默认配置复制恢复
    let default_path = root.join("resources").join("config.default.json");
    if default_path.exists() {
        if let Some(parent) = user_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::copy(&default_path, &user_path).is_ok() && user_path.exists() {
            return user_path;
        }
        // 复制失败则直接读默认配置
        return default_path;
    }

    // 3. 回退：旧路径 config.json
    let legacy = root.join("config.json");
    if legacy.exists() {
        return legacy;
    }

    // 4. 都不存在，返回用户配置路径供后续创建
    user_path
}

/// 解析旧版 fields.json 路径
pub fn resolve_fields_path(root: &Path) -> PathBuf {
    root.join("fields.json")
}

/// 解析数据目录路径
/// 支持通过环境变量 `MATRIXIT_DATA_DIR` 覆盖，默认为 `data/`
pub fn resolve_data_dir_path(root: &Path) -> PathBuf {
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

/// 解析 matrixit.db 数据库文件路径
/// 支持通过环境变量 `MATRIXIT_DB` 覆盖
pub fn resolve_matrixit_db_path() -> PathBuf {
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

/// 设置 sidecar 环境变量
/// 确保 Python sidecar 能够正确定位工作目录和配置文件
pub fn ensure_sidecar_env() {
    let root = find_project_root();
    let cfg = resolve_config_path(&root);
    std::env::set_var("MATRIXIT_WORKDIR", root.to_string_lossy().to_string());
    std::env::set_var("MATRIXIT_CONFIG", cfg.to_string_lossy().to_string());
}

/// 安全截断 UTF-8 字符串到指定最大长度
/// 确保不会在多字节字符中间截断
pub fn truncate_utf8_boundary(s: &mut String, max_len: usize) {
    if s.len() <= max_len {
        return;
    }
    let mut cut = max_len;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s.truncate(cut);
}
