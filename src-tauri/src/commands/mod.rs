//! Tauri 命令模块
//! 按领域拆分的 Tauri IPC 命令

pub mod analysis;
pub mod common;
pub mod config;
pub mod export;
pub mod feishu;
pub mod library;
pub mod zotero;

// 重新导出所有命令，便于在 main.rs 中注册
pub use analysis::{start_analysis, stop_analysis};
pub use common::{open_path_debug, open_pdf_in_browser, resolve_pdf_path};
pub use config::{read_config, read_fields, save_config, save_fields};
pub use export::{export_excel, export_pdfs};
pub use feishu::{reconcile_feishu, sync_feishu};
pub use library::{
    delete_extracted_data, format_citations, get_items, load_library, purge_item_field, update_item,
};
pub use zotero::{start_zotero_watch, stop_zotero_watch};
