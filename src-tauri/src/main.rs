//! MatrixIt Tauri 应用入口
//! 
//! 本文件已重构为轻量入口，所有业务逻辑已下沉至子模块：
//! - `commands/`: Tauri IPC 命令
//! - `db.rs`: SQLite 数据库操作
//! - `utils.rs`: 通用工具函数
//! - `error.rs`: 统一错误类型

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod db;
mod error;
mod utils;

use commands::analysis::AnalysisState;
use commands::library::LoadLibraryState;
use commands::zotero::ZoteroWatchState;
use std::collections::HashSet;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

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
            // Zotero
            commands::zotero::start_zotero_watch,
            commands::zotero::stop_zotero_watch,
            // Library
            commands::library::load_library,
            commands::library::get_items,
            commands::library::format_citations,
            commands::library::update_item,
            commands::library::purge_item_field,
            commands::library::delete_extracted_data,
            // Common
            commands::common::resolve_pdf_path,
            commands::common::open_pdf_in_browser,
            commands::common::open_path_debug,
            // Analysis
            commands::analysis::start_analysis,
            commands::analysis::stop_analysis,
            // Feishu
            commands::feishu::sync_feishu,
            commands::feishu::reconcile_feishu,
            // Export
            commands::export::export_excel,
            commands::export::export_pdfs,
            // Config
            commands::config::read_config,
            commands::config::save_config,
            commands::config::read_fields,
            commands::config::save_fields,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
