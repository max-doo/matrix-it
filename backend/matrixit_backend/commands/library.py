"""
Library 相关命令模块。

包含：load_library, resolve_pdf_path, update_item, get_items
"""
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional


def _build_collection_key_chain(collections: Dict[int, dict], collection_id: Optional[int]) -> List[str]:
    """
    构建收藏夹的层级路径（key 链）。
    
    用于前端在树形结构中定位选中的收藏夹。
    
    Args:
        collections: 收藏夹 ID 到对象的映射
        collection_id: 当前收藏夹 ID
        
    Returns:
        List[str]: 从根节点到当前节点的 key 列表，如 ["root_key", "parent_key", "current_key"]
    """
    if collection_id is None:
        return []
    chain: List[str] = []
    current_id = collection_id
    visited = set()
    while current_id and current_id not in visited and current_id in collections:
        visited.add(current_id)
        chain.insert(0, str(collections[current_id]["key"]))
        current_id = collections[current_id]["parent_id"]
    return chain


def _collection_tree(collections: Dict[int, dict]) -> List[dict]:
    """
    将扁平的收藏夹列表转换为嵌套的树形结构。
    
    Args:
        collections: 收藏夹映射表 {id: collection_obj}
        
    Returns:
        List[dict]: 树形结构的根节点列表。
        每个节点包含: key, name, children[]
    """
    nodes: Dict[str, dict] = {}
    children_map: Dict[Optional[int], List[int]] = {}
    for cid, c in collections.items():
        children_map.setdefault(c["parent_id"], []).append(cid)
        nodes[str(c["key"])] = {"key": str(c["key"]), "name": c["name"], "children": []}

    roots: List[dict] = []

    def attach(parent_cid: Optional[int], parent_node: Optional[dict]) -> None:
        for child_cid in sorted(children_map.get(parent_cid, []), key=lambda x: collections[x]["name"]):
            c = collections[child_cid]
            node = nodes[str(c["key"])]
            if parent_node is None:
                roots.append(node)
            else:
                parent_node["children"].append(node)
            attach(child_cid, node)

    attach(None, None)
    if roots:
        return roots
    return [{"key": "root", "name": "全部", "children": []}]


def _load_fields_def(config: dict, fields_path: str) -> dict:
    """加载字段定义（优先从 config 读取，否则从 fields.json）。"""
    fields_def = {}
    if isinstance(config.get("fields"), dict):
        fields_def = config.get("fields", {})
    else:
        try:
            with open(fields_path, "r", encoding="utf-8") as f:
                fields_def = json.load(f)
        except Exception:
            fields_def = {}
    return fields_def


def load_library(literature_json: str, db_path: str, root_dir: str, config_path: str, fields_path: str) -> dict:
    """
    [IPC 命令] 加载 Zotero 资料库。
    
    核心逻辑：
    1. 复制并读取 Zotero SQLite 数据库，提取条目与收藏夹。
    2. 与本地数据库（matrixit.db）目前合并，保留本地特有的状态字段（如 process_status）。
    3. 构建收藏夹树形结构。
    4. 将合并后的最新数据写回本地 DB 与 JSON 快照。
    
    Args:
        literature_json: 导出 JSON 路径
        db_path: 本地 SQLite 路径
        root_dir: 项目根目录
        config_path: 配置文件路径
        fields_path: 字段定义路径
        
    Returns:
        Dict: {"collections": [...], "items": [...], "error": ...}
    """
    # 懒加载重型依赖
    from matrixit_backend import storage, zotero
    from matrixit_backend.config import load_config
    
    config = load_config(config_path)
    zotero_dir = zotero.get_zotero_dir(config)

    zotero_db_path = os.path.join(zotero_dir, "zotero.sqlite")
    if not os.path.exists(zotero_db_path):
        return {"collections": [], "items": [], "error": {"code": "ZOTERO_DB_NOT_FOUND", "message": zotero_db_path}}

    existing_idx = storage.get_items_index(db_path)

    items = zotero.read_zotero_database_safe(zotero_dir)

    merged: List[dict] = []
    for it in items:
        key = str(it.get("item_key"))
        existing = existing_idx.get(key, {})
        base = existing.copy()
        # 保留本地管理字段（这些字段不来自 Zotero，由 MatrixIt 管理）
        old_citation = existing.get("citation")
        old_rating = existing.get("rating")
        old_progress = existing.get("progress")
        base.update(it)
        # 恢复本地管理字段
        if isinstance(old_citation, str):
            base["citation"] = old_citation
        else:
            base["citation"] = ""
        if old_rating is not None:
            base["rating"] = old_rating
        if old_progress is not None:
            base["progress"] = old_progress
        base.setdefault("processed_status", "unprocessed")
        base.setdefault("sync_status", "unsynced")
        if base.get("processed") is True and base.get("sync_status") == "unsynced":
            base["sync_status"] = "synced"
        merged.append(base)

    collections_tree: List[dict] = []
    try:
        import sqlite3
        import tempfile
        import shutil

        # Zotero 运行时会锁库；复制到临时文件并以只读 URI 方式打开，避免"database is locked"。
        with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as tmp_db:
            tmp_db_path = tmp_db.name
        try:
            shutil.copy2(zotero_db_path, tmp_db_path)
            uri_path = Path(tmp_db_path).as_uri()
            conn = sqlite3.connect(f"{uri_path}?mode=ro", uri=True)
            try:
                collections = zotero.read_collections(conn)
            finally:
                conn.close()
        finally:
            if os.path.exists(tmp_db_path):
                try:
                    os.remove(tmp_db_path)
                except Exception:
                    pass

        collections_tree = _collection_tree(collections)

        for it in merged:
            cols = it.get("collections", [])
            for c in cols:
                cid = c.get("id")
                c["pathKeyChain"] = _build_collection_key_chain(collections, cid)
                c["key"] = str(collections.get(cid, {}).get("key") or c.get("key") or "")
    except Exception:
        collections_tree = []

    try:
        storage.upsert_items(db_path, merged)
        storage.export_json(db_path, literature_json)
    except Exception:
        pass

    return {"collections": collections_tree, "items": merged}


def resolve_pdf_path(db_path: str, root_dir: str, config_path: str, item_key: str) -> dict:
    """[IPC 命令] 解析 PDF 路径。"""
    # 懒加载重型依赖
    from matrixit_backend import storage, zotero
    from matrixit_backend.config import load_config
    
    config = load_config(config_path)
    zotero_dir = zotero.get_zotero_dir(config)
    it = storage.get_item(db_path, str(item_key))
    if not it:
        return {"pdf_path": "", "error": {"code": "ITEM_NOT_FOUND", "message": str(item_key)}}
    base_dir = str(Path(root_dir).resolve())
    try:
        resolved = zotero.resolve_pdf_path(it, zotero_dir, base_dir=base_dir) or ""
        return {"pdf_path": str(resolved)}
    except Exception as e:
        return {"pdf_path": "", "error": {"code": "RESOLVE_PDF_PATH_FAILED", "message": str(e)}}


def update_item(literature_json: str, db_path: str, item_key: str, patch: dict) -> dict:
    """
    [IPC 命令] 局部更新条目。
    
    用于前端手动修改条目字段后回写到后端数据库。
    会自动忽略关键字段 (key, attachments 等) 以防止数据损坏。
    
    Args:
        item_key: 目标条目 Key
        patch: 包含需要修改字段的字典
        
    Returns:
        Dict: {"updated": bool}
    """
    # 懒加载重型依赖
    from matrixit_backend import storage
    
    it = storage.get_item(db_path, str(item_key))
    if not it:
        return {"updated": False}
    for k, v in patch.items():
        if k in ["item_key", "attachments", "collections", "date_modified", "item_type"]:
            continue
        it[k] = v
    try:
        storage.upsert_item(db_path, it)
        # 性能优化：移除 export_json 调用，SQLite 已是主数据源
        # literature.json 将在 load_library 时统一导出
    except Exception:
        pass
    return {"updated": True}


def get_items(db_path: str, item_keys: List[str]) -> dict:
    """
    [IPC 命令] 批量读取条目（仅从本地 SQLite）。
    
    用于前端在分析 Finished 后快速拉取该条目的最新字段，
    避免等待 load_library（会读取/合并 Zotero DB，可能耗时较长）。
    
    Returns:
        Dict: {"items": [...]}
    """
    # 懒加载重型依赖
    from matrixit_backend import storage
    
    keys = [str(k).strip() for k in (item_keys or []) if str(k).strip()]
    if not keys:
        return {"items": []}
    items = storage.get_items(db_path, keys=keys, timeout_s=1.0)
    by_key = {str(it.get("item_key")): it for it in items if isinstance(it, dict) and it.get("item_key")}
    ordered = [by_key.get(k) for k in keys if k in by_key]
    return {"items": [it for it in ordered if isinstance(it, dict)]}
