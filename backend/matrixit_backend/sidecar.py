"""
MatrixIt 后端 sidecar 入口。

该脚本作为 Tauri sidecar 被调用，通过命令行参数执行不同能力，并以 JSON 输出结果/事件：
- load_library: 读取 Zotero 数据库并写入本地 DB，同时输出收藏夹树与条目列表
- analyze: 对指定条目读取 PDF 并调用 LLM 提取结构化字段，逐条输出事件并写回本地库
- sync_feishu: 将条目同步到飞书多维表格，写回同步状态
- update_item: 对本地库中指定条目做局部字段更新

约定：
- 尽量“吞错”并维持流程可继续推进（避免 sidecar 异常导致前端卡死）
- 数据以 SQLite 为主存，literature.json 为导出快照（便于前端加载、迁移与排障）
"""

import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional

if __package__ in (None, ""):
    _BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    if _BACKEND_DIR not in sys.path:
        sys.path.insert(0, _BACKEND_DIR)

from matrixit_backend import citation, feishu, llm, pdf, prompt_builder, storage, zotero
from matrixit_backend.config import load_config

LITERATURE_JSON_DEFAULT = "data/literature.json"
CONFIG_DEFAULT = "config/config.json"
FIELDS_DEFAULT = "fields.json"
LEGACY_LITERATURE_JSON_DEFAULT = "literature.json"


def _index_existing(items: List[dict]) -> Dict[str, dict]:
    """
    建立文献条目索引。
    
    Args:
        items: 文献条目列表
        
    Returns:
        Dict[item_key, item]: 以 item_key 为键的快速查找表
    """
    idx: Dict[str, dict] = {}
    for it in items:
        k = it.get("item_key")
        if k:
            idx[str(k)] = it
    return idx


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
        old_citation = existing.get("citation")
        base.update(it)
        if isinstance(old_citation, str):
            base["citation"] = old_citation
        else:
            base["citation"] = ""
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
        from pathlib import Path

        # Zotero 运行时会锁库；复制到临时文件并以只读 URI 方式打开，避免“database is locked”。
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


def analyze(literature_json: str, db_path: str, root_dir: str, config_path: str, fields_path: str, keys: List[str]) -> None:
    """
    [IPC 命令] 分析文献条目（LLM 提取）。
    
    针对选中的条目，依次执行：
    1. 查找并解析 PDF 附件。
    2. 构造 Prompt 调用 LLM (支持纯文本或多模态)。
    3. 解析返回的 JSON 并通过 stdout 流式输出进度事件。
    4. 更新本地数据库。
    
    注意：此函数不直接返回结果，而是将进度以 JSON Line 格式打印到 stdout 供前端消费。
    
    Args:
        keys: 需要分析的 item_key 列表
    """
    base_dir = str(Path(root_dir).resolve())
    config = load_config(config_path)
    zotero_dir = zotero.get_zotero_dir(config)
    llm_cfg = llm.load_llm_config(config)
    debug_cfg = config.get("debug", {}) if isinstance(config.get("debug", {}), dict) else {}
    default_debug = True
    debug_enabled = default_debug
    if isinstance(debug_cfg.get("enabled"), bool):
        debug_enabled = bool(debug_cfg.get("enabled"))
    env_debug = str(os.environ.get("MATRIXIT_DEBUG") or "").strip().lower()
    if env_debug in ("1", "true", "yes"):
        debug_enabled = True
    if env_debug in ("0", "false", "no", "off"):
        debug_enabled = False

    print_prompts = True
    if isinstance(debug_cfg.get("print_prompts"), bool):
        print_prompts = bool(debug_cfg.get("print_prompts"))

    def emit_debug(item_key: str, stage: str, data: dict) -> None:
        if not debug_enabled:
            return
        try:
            payload = {"type": "debug", "item_key": str(item_key), "stage": str(stage), "data": data}
            if os.environ.get("MATRIXIT_DEBUG_PRETTY") in ("1", "true", "yes"):
                print(json.dumps(payload, ensure_ascii=False, indent=2), flush=True)
            else:
                print(json.dumps(payload, ensure_ascii=False), flush=True)
        except Exception:
            return

    idx = storage.get_items_index(db_path)
    fields_def = {}
    if isinstance(config.get("fields"), dict):
        fields_def = config.get("fields", {})
    else:
        try:
            with open(fields_path, "r", encoding="utf-8") as f:
                fields_def = json.load(f)
        except Exception:
            fields_def = {}

    preferred_order = (
        config.get("ui", {})
        .get("table_columns", {})
        .get("matrix", {})
        .get("analysis", {})
        .get("order", [])
    )
    try:
        system_prompt = prompt_builder.load_default_system_prompt(
            fields_def, preferred_order if isinstance(preferred_order, list) else None
        )
    except Exception:
        system_prompt = "你是一名顶尖学者与极其严厉的同行评审专家。你的任务是从论文内容中提取信息并按要求输出 JSON。"
    try:
        user_prompt = "按照系统提示词解读论文，请严格输出一个 JSON 对象，不要输出 Markdown，不要输出多余说明。"
    except Exception:
        user_prompt = "按照系统提示词解读论文，请严格输出一个 JSON 对象，不要输出 Markdown，不要输出多余说明。"
    analysis_fields = set(prompt_builder.get_analysis_fields(fields_def).keys())
    try:
        ordered_keys, _ = prompt_builder.build_output_schema_hint(
            fields_def, preferred_order if isinstance(preferred_order, list) else None
        )
    except Exception:
        ordered_keys = []

    for k in keys:
        it = idx.get(str(k))
        if not it:
            print(
                json.dumps(
                    {"type": "failed", "item_key": str(k), "error": "ITEM_NOT_FOUND", "error_code": "ITEM_NOT_FOUND"},
                    ensure_ascii=False,
                )
            , flush=True)
            continue

        # 记录分析前的原始状态，用于失败时恢复
        original_status = it.get("processed_status", "unprocessed")
        # 根据原始状态决定恢复目标：done -> done, 其他 -> unprocessed
        restore_status = "done" if original_status == "done" else "unprocessed"
        it["processed_status"] = "processing"
        try:
            storage.upsert_item(db_path, it)
            storage.export_json(db_path, literature_json)
        except Exception:
            pass
        print(json.dumps({"type": "started", "item_key": str(k)}, ensure_ascii=False), flush=True)
        emit_debug(
            str(k),
            "prompt",
            {
                "ordered_keys": ordered_keys,
                "system_prompt_chars": len(system_prompt or ""),
                "user_prompt_chars": len(user_prompt or ""),
            },
        )
        if print_prompts:
            emit_debug(
                str(k),
                "prompt_text",
                {
                    "system_prompt": system_prompt,
                    "user_prompt": user_prompt,
                },
            )

        resolved_pdf = zotero.resolve_pdf_path(it, zotero_dir, base_dir=base_dir) or ""
        if not resolved_pdf:
            # 恢复原始状态，不写入 failed（failed 仅用于前端临时显示）
            it["processed_status"] = restore_status
            it["sync_status"] = it.get("sync_status") or "unsynced"
            try:
                storage.upsert_item(db_path, it)
                storage.export_json(db_path, literature_json)
            except Exception:
                pass
            print(
                json.dumps(
                    {
                        "type": "failed",
                        "item_key": str(k),
                        "error": "PDF_NOT_FOUND",
                        "error_code": "PDF_NOT_FOUND",
                    },
                    ensure_ascii=False,
                )
            , flush=True)
            continue
        emit_debug(str(k), "pdf_resolved", {"pdf_path": str(resolved_pdf)})
        text = pdf.extract_pdf_text(resolved_pdf)
        if not text:
            # 恢复原始状态，不写入 failed
            it["processed_status"] = restore_status
            it["sync_status"] = it.get("sync_status") or "unsynced"
            try:
                storage.upsert_item(db_path, it)
                storage.export_json(db_path, literature_json)
            except Exception:
                pass
            print(
                json.dumps(
                    {
                        "type": "failed",
                        "item_key": str(k),
                        "error": "PDF_TEXT_EMPTY",
                        "error_code": "PDF_TEXT_EMPTY",
                    },
                    ensure_ascii=False,
                )
            , flush=True)
            continue

        it["tldr"] = text.strip().replace("\n", " ")[:300]

        if not analysis_fields:
            # 恢复原始状态，不写入 failed
            it["processed_status"] = restore_status
            it["sync_status"] = "unsynced"
            try:
                storage.upsert_item(db_path, it)
                storage.export_json(db_path, literature_json)
            except Exception:
                pass
            print(
                json.dumps(
                    {
                        "type": "failed",
                        "item_key": str(k),
                        "error": "FIELDS_DEF_INVALID",
                        "error_code": "FIELDS_DEF_INVALID",
                        "message": "fields.json 缺少 analysis_fields 定义",
                    },
                    ensure_ascii=False,
                )
            , flush=True)
            continue

        if not llm_cfg:
            # 恢复原始状态，不写入 failed
            it["processed_status"] = restore_status
            it["sync_status"] = "unsynced"
            try:
                storage.upsert_item(db_path, it)
                storage.export_json(db_path, literature_json)
            except Exception:
                pass
            print(
                json.dumps(
                    {
                        "type": "failed",
                        "item_key": str(k),
                        "error": "LLM_CONFIG_MISSING",
                        "error_code": "LLM_CONFIG_MISSING",
                        "message": "LLM 配置不完整",
                    },
                    ensure_ascii=False,
                )
            , flush=True)
            continue

        max_chars = int(llm_cfg.get("max_input_chars", 12000))
        text_in = text if len(text) <= max_chars else text[:max_chars]
        user_content = user_prompt + "\n\n---\n\nPDF 正文：\n" + text_in
        emit_debug(
            str(k),
            "input",
            {
                "pdf_text_chars": len(text or ""),
                "sent_chars": len(text_in or ""),
                "max_input_chars": max_chars,
                "multimodal": bool(llm_cfg.get("multimodal")),
            },
        )
        result = None
        if llm_cfg.get("multimodal"):
            try:
                result = llm.responses_pdf_json(
                    llm_cfg, system_prompt, user_content, resolved_pdf, debug=lambda d: emit_debug(str(k), "llm", d)
                )
            except llm.LlmError as e:
                result = None
            except Exception:
                result = None
        if result is None:
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ]
        try:
            if result is None:
                result = llm.chat_json(llm_cfg, messages, debug=lambda d: emit_debug(str(k), "llm", d))
        except llm.LlmError as e:
            # 恢复原始状态，不写入 failed
            it["processed_status"] = restore_status
            it["sync_status"] = "unsynced"
            try:
                storage.upsert_item(db_path, it)
                storage.export_json(db_path, literature_json)
            except Exception:
                pass
            print(
                json.dumps(
                    {
                        "type": "failed",
                        "item_key": str(k),
                        "error": e.code,
                        "error_code": e.code,
                        "message": e.message,
                    },
                    ensure_ascii=False,
                )
            , flush=True)
            continue
        except Exception:
            # 恢复原始状态，不写入 failed
            it["processed_status"] = restore_status
            it["sync_status"] = "unsynced"
            try:
                storage.upsert_item(db_path, it)
                storage.export_json(db_path, literature_json)
            except Exception:
                pass
            print(
                json.dumps(
                    {
                        "type": "failed",
                        "item_key": str(k),
                        "error": "LLM_REQUEST_FAILED",
                        "error_code": "LLM_REQUEST_FAILED",
                    },
                    ensure_ascii=False,
                )
            , flush=True)
            continue

        if isinstance(result, dict):
            accepted = {fk: fv for fk, fv in result.items() if fk in analysis_fields}
            emit_debug(
                str(k),
                "result",
                {
                    "returned_keys": [str(x) for x in list(result.keys())[:60]],
                    "accepted_keys": [str(x) for x in list(accepted.keys())[:60]],
                },
            )
            if not accepted:
                # 恢复原始状态，不写入 failed
                it["processed_status"] = restore_status
                it["sync_status"] = "unsynced"
                try:
                    storage.upsert_item(db_path, it)
                    storage.export_json(db_path, literature_json)
                except Exception:
                    pass
                returned_keys = [str(k) for k in list(result.keys())[:30]]
                print(
                    json.dumps(
                        {
                            "type": "failed",
                            "item_key": str(k),
                            "error": "LLM_EMPTY_RESULT",
                            "error_code": "LLM_EMPTY_RESULT",
                            "message": f"模型未返回任何可写入字段，返回键={returned_keys}",
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                continue
            for fk, fv in accepted.items():
                if analysis_fields and fk not in analysis_fields:
                    continue
                it[fk] = fv

        it["processed_status"] = "done"
        it["sync_status"] = "unsynced"
        try:
            storage.upsert_item(db_path, it)
            storage.export_json(db_path, literature_json)
            sys.stderr.write(f"[SIDECAR] ✓ Item {k} saved to database and exported to JSON\n")
            sys.stderr.flush()
        except Exception as db_err:
            sys.stderr.write(f"[SIDECAR] ❌ Failed to save item {k}: {db_err}\n")
            sys.stderr.flush()
        print(json.dumps({"type": "finished", "item_key": str(k)}, ensure_ascii=False), flush=True)


def sync_feishu(literature_json: str, db_path: str, root_dir: str, config_path: str, fields_path: str, keys: List[str]) -> dict:
    """
    [IPC 命令] 同步到飞书多维表格。
    
    Args:
        keys: 需要同步的 item_key 列表
        
    Returns:
        Dict: 同步统计 {"uploaded": int, "skipped": int, "failed": int}
    """
    config = load_config(config_path)
    items = storage.get_items(db_path)
    fields_source: object = config.get("fields") if isinstance(config.get("fields"), dict) else fields_path
    stats, updated_items = feishu.upload_items(items, config, fields_source, keys, skip_processed=False, base_dir=str(root_dir))
    try:
        storage.upsert_items(db_path, updated_items)
        storage.export_json(db_path, literature_json)
    except Exception:
        pass
    return stats


def delete_extracted_data(
    literature_json: str,
    db_path: str,
    root_dir: str,
    config_path: str,
    fields_path: str,
    keys: List[str],
) -> dict:
    """
    [IPC 命令] 清除已提取的数据。
    
    1. 清空本地条目中的 analysis_fields 字段。
    2. 如果已同步到飞书，尝试删除对应的飞书记录。
    3. 重置处理状态 (processed=False, sync_status=unsynced)。
    
    Returns:
        Dict: 操作统计 {"cleared": int, "feishu": {...}}
    """
    items_idx = storage.get_items_index(db_path)

    fields_def = {}
    config = load_config(config_path)
    if isinstance(config.get("fields"), dict):
        fields_def = config.get("fields", {})
    else:
        try:
            with open(fields_path, "r", encoding="utf-8") as f:
                fields_def = json.load(f)
        except Exception:
            fields_def = {}

    analysis_fields = set(prompt_builder.get_analysis_fields(fields_def).keys())

    updated: List[dict] = []
    record_ids: List[str] = []
    key_by_record_id: Dict[str, str] = {}
    cleared = 0
    missing = 0

    for k in keys:
        kk = str(k)
        it = items_idx.get(kk)
        if not it:
            missing += 1
            continue
        for fk in analysis_fields:
            if fk in it:
                it.pop(fk, None)
        it["processed_status"] = "unprocessed"
        it["sync_status"] = "unsynced"
        if "processed" in it:
            it["processed"] = False
        rid = str(it.get("record_id") or "").strip()
        if rid:
            record_ids.append(rid)
            key_by_record_id[rid] = kk
        updated.append(it)
        cleared += 1

    feishu_stats = {"deleted": 0, "skipped": 0, "failed": 0, "results": {}}
    if record_ids:
        try:
            config = load_config(config_path)
            feishu_stats = feishu.delete_records(config, record_ids)
        except Exception:
            feishu_stats = {"deleted": 0, "skipped": 0, "failed": len(record_ids), "results": {rid: False for rid in record_ids}}

        results = feishu_stats.get("results", {})
        if isinstance(results, dict):
            for rid, ok in results.items():
                if ok is True:
                    k = key_by_record_id.get(str(rid))
                    if not k:
                        continue
                    it = items_idx.get(str(k))
                    if it and it.get("record_id") == rid:
                        it.pop("record_id", None)

    try:
        storage.upsert_items(db_path, updated)
        storage.export_json(db_path, literature_json)
    except Exception:
        pass

    return {
        "cleared": cleared,
        "missing": missing,
        "analysis_fields": len(analysis_fields),
        "feishu": {k: v for k, v in feishu_stats.items() if k != "results"},
    }


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

def format_citations(db_path: str, item_keys: List[str]) -> dict:
    """
    [IPC 命令] 生成参考文献引用。
    
    基于 item_keys 生成 GB/T 7714 格式的引用字符串。
    
    Returns:
        Dict: {"citations": {item_key: citation_str}}
    """
    keys = [str(k).strip() for k in (item_keys or []) if str(k).strip()]
    if not keys:
        return {"citations": {}}
    items = storage.get_items(db_path, keys=keys)
    by_key = {str(it.get("item_key")): it for it in items if isinstance(it, dict) and it.get("item_key")}
    ordered = [by_key.get(k) for k in keys if k in by_key]
    citations = citation.format_gbt7714_bibliography([it for it in ordered if isinstance(it, dict)])
    return {"citations": citations}

def clear_citations(literature_json: str, db_path: str) -> dict:
    """
    [IPC 命令] 清空所有条目的引用字段。
    
    用于重置引用状态。
    
    Returns:
        Dict: {"cleared": count}
    """
    items = storage.get_items(db_path, keys=None)
    changed = 0
    next_items: List[dict] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        k = str(it.get("item_key") or "").strip()
        if not k:
            continue
        v = it.get("citation")
        if isinstance(v, str) and v.strip():
            it["citation"] = ""
            changed += 1
        next_items.append(it)
    try:
        storage.upsert_items(db_path, next_items)
        storage.export_json(db_path, literature_json)
    except Exception:
        pass
    return {"cleared": changed}


 
def _resolve_with_base(path_str: str, base_dir: str) -> str:
    p = Path(path_str)
    if p.is_absolute():
        return str(p)
    return str((Path(base_dir) / p).resolve())


def _find_project_root(start: Path) -> Path:
    cur = start.resolve()
    for _ in range(12):
        if (cur / "config" / "config.json").exists():
            return cur
        if (cur / "fields.json").exists() and (cur / "config.json").exists():
            return cur
        cur = cur.parent
    return start.resolve()


def main() -> None:
    """
    CLI 主入口。
    
    根据命令行第一个参数 (子命令) 分发即执行相应逻辑。
    所有输出均确保为 JSON 格式（analyze 命令除外，为 JSON Lines）。
    """
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8")
        except Exception:
            pass
    if hasattr(sys.stderr, "reconfigure"):
        try:
            sys.stderr.reconfigure(encoding="utf-8")
        except Exception:
            pass

    if len(sys.argv) < 2:
        sys.stderr.write("usage: sidecar.py <load_library|analyze|sync_feishu|update_item|delete_extracted_data|format_citations|clear_citations> [json_args]\n")
        sys.exit(2)

    cmd = sys.argv[1]
    root_dir = _find_project_root(Path(os.environ.get("MATRIXIT_WORKDIR") or Path.cwd()))
    data_dir = Path(os.environ.get("MATRIXIT_DATA_DIR") or (root_dir / "data")).resolve()
    data_dir.mkdir(parents=True, exist_ok=True)

    literature_json_raw = os.environ.get("MATRIXIT_LITERATURE_JSON", str(data_dir / "literature.json"))
    literature_json = _resolve_with_base(literature_json_raw, str(data_dir))

    db_raw = os.environ.get("MATRIXIT_DB", str(data_dir / "matrixit.db"))
    db_path = _resolve_with_base(db_raw, str(data_dir))

    config_path = _resolve_with_base(os.environ.get("MATRIXIT_CONFIG", CONFIG_DEFAULT), str(root_dir))
    fields_path = _resolve_with_base(os.environ.get("MATRIXIT_FIELDS", FIELDS_DEFAULT), str(root_dir))

    try:
        storage.ensure_db(db_path)
    except Exception:
        pass
    try:
        if storage.count_items(db_path) == 0:
            legacy = _resolve_with_base(LEGACY_LITERATURE_JSON_DEFAULT, str(root_dir))
            storage.import_json(db_path, legacy)
            storage.export_json(db_path, literature_json)
    except Exception:
        pass

    if cmd == "load_library":
        try:
            payload = load_library(literature_json, db_path, str(root_dir), config_path, fields_path)
        except Exception as e:
            payload = {"collections": [], "items": [], "error": {"code": "LOAD_LIBRARY_FAILED", "message": str(e)}}
        sys.stdout.write(json.dumps(payload, ensure_ascii=False))
        return


    if cmd == "analyze":
        if len(sys.argv) < 3:
            sys.stderr.write("analyze requires a JSON array argument\n")
            sys.exit(2)
        keys_arg = sys.argv[2]
        if keys_arg == "-":
            raw = (sys.stdin.read() or "[]").lstrip("\ufeff").strip()
            keys = json.loads(raw or "[]")
        else:
            keys = json.loads(keys_arg)
        analyze(literature_json, db_path, str(root_dir), config_path, fields_path, [str(k) for k in keys])
        return

    if cmd == "sync_feishu":
        if len(sys.argv) < 3:
            sys.stderr.write("sync_feishu requires a JSON array argument\n")
            sys.exit(2)
        keys = json.loads(sys.argv[2])
        try:
            stats = sync_feishu(literature_json, db_path, str(root_dir), config_path, fields_path, [str(k) for k in keys])
            sys.stdout.write(json.dumps(stats, ensure_ascii=False))
        except Exception as e:
            sys.stdout.write(json.dumps({"error": {"code": "SYNC_FEISHU_FAILED", "message": str(e)}}, ensure_ascii=False))
        return

    if cmd == "delete_extracted_data":
        if len(sys.argv) < 3:
            sys.stderr.write("delete_extracted_data requires a JSON array argument\n")
            sys.exit(2)
        keys_arg = sys.argv[2]
        if keys_arg == "-":
            raw = (sys.stdin.read() or "[]").lstrip("\ufeff").strip()
            keys = json.loads(raw or "[]")
        else:
            keys = json.loads(keys_arg)
        try:
            stats = delete_extracted_data(literature_json, db_path, str(root_dir), config_path, fields_path, [str(k) for k in keys])
            sys.stdout.write(json.dumps(stats, ensure_ascii=False))
        except Exception as e:
            sys.stdout.write(json.dumps({"error": {"code": "DELETE_EXTRACTED_FAILED", "message": str(e)}}, ensure_ascii=False))
        return

    if cmd == "update_item":
        if len(sys.argv) < 4:
            sys.stderr.write("update_item requires: item_key patch_json\n")
            sys.exit(2)
        item_key = sys.argv[2]
        patch_arg = sys.argv[3]
        if patch_arg == "-":
            patch = json.loads(sys.stdin.read() or "{}")
        else:
            patch = json.loads(patch_arg)
        try:
            res = update_item(literature_json, db_path, item_key, patch)
            sys.stdout.write(json.dumps(res, ensure_ascii=False))
        except Exception as e:
            sys.stdout.write(json.dumps({"error": {"code": "UPDATE_ITEM_FAILED", "message": str(e)}}, ensure_ascii=False))
        return

    if cmd == "format_citations":
        if len(sys.argv) < 3:
            sys.stderr.write("format_citations requires item_keys JSON array or '-' from stdin\n")
            sys.exit(2)
        keys_arg = sys.argv[2]
        if keys_arg == "-":
            raw = (sys.stdin.read() or "[]").lstrip("\ufeff").strip()
            keys = json.loads(raw or "[]")
        else:
            keys = json.loads(keys_arg)
        try:
            norm_keys = [str(k) for k in keys]
            payload = format_citations(db_path, norm_keys)
            citations = payload.get("citations", {})
            if isinstance(citations, dict) and citations:
                items = storage.get_items(db_path, keys=norm_keys)
                by_key = {str(it.get("item_key")): it for it in items if isinstance(it, dict) and it.get("item_key")}
                updated: List[dict] = []
                for k, text in citations.items():
                    if not isinstance(text, str) or not text.strip():
                        continue
                    it = by_key.get(str(k))
                    if not it:
                        continue
                    it["citation"] = text
                    updated.append(it)
                if updated:
                    try:
                        storage.upsert_items(db_path, updated)
                        storage.export_json(db_path, literature_json)
                    except Exception:
                        pass
            sys.stdout.write(json.dumps({"citations": citations}, ensure_ascii=False))
        except Exception as e:
            sys.stdout.write(json.dumps({"error": {"code": "FORMAT_CITATIONS_FAILED", "message": str(e)}}, ensure_ascii=False))
        return

    if cmd == "clear_citations":
        try:
            payload = clear_citations(literature_json, db_path)
            sys.stdout.write(json.dumps(payload, ensure_ascii=False))
        except Exception as e:
            sys.stdout.write(json.dumps({"error": {"code": "CLEAR_CITATIONS_FAILED", "message": str(e)}}, ensure_ascii=False))
        return


    sys.stderr.write(f"unknown command: {cmd}\n")
    sys.exit(2)


if __name__ == "__main__":
    main()
