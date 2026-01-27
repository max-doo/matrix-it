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


def _analysis_restore_status(original_status: str) -> str:
    return "done" if original_status == "done" else "unprocessed"


def _analysis_resolve_pdf_and_text(it: dict, zotero_dir: str, base_dir: str) -> tuple[str, str]:
    resolved_pdf = zotero.resolve_pdf_path(it, zotero_dir, base_dir=base_dir) or ""
    if not resolved_pdf:
        return "", ""
    text = pdf.extract_pdf_text(resolved_pdf) or ""
    return str(resolved_pdf), text


def _analysis_build_messages(system_prompt: str, user_prompt: str, pdf_text: str, llm_cfg: dict) -> tuple[list, str, str, int]:
    max_chars = int(llm_cfg.get("max_input_chars", 12000))
    text_in = pdf_text if len(pdf_text) <= max_chars else pdf_text[:max_chars]
    user_content = user_prompt + "\n\n---\n\nPDF 正文：\n" + text_in
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]
    return messages, user_content, text_in, max_chars


def _analysis_apply_result(it: dict, item_key: str, result: object, analysis_fields: set, emit_debug) -> bool:
    if not isinstance(result, dict):
        return False
    accepted = {fk: fv for fk, fv in result.items() if fk in analysis_fields}
    try:
        emit_debug(
            item_key,
            "result",
            {
                "returned_keys": [str(x) for x in list(result.keys())[:60]],
                "accepted_keys": [str(x) for x in list(accepted.keys())[:60]],
            },
        )
    except Exception:
        pass
    if not accepted:
        return False
    for fk, fv in accepted.items():
        it[fk] = fv
    return True


def _analysis_restore_and_emit_failed(
    *,
    db_path: str,
    literature_json: str,
    it: dict,
    restore_status: str,
    export_snapshot: bool,
    payload: dict,
) -> None:
    it["processed_status"] = restore_status
    if "sync_status" not in it or not it.get("sync_status"):
        it["sync_status"] = "unsynced"
    try:
        storage.upsert_item(db_path, it)
        if export_snapshot:
            storage.export_json(db_path, literature_json)
    except Exception as e:
        try:
            sys.stderr.write(
                f"[SIDECAR] restore/export failed item={payload.get('item_key')} code={payload.get('error_code')}: {e}\n"
            )
            sys.stderr.flush()
        except Exception:
            pass
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def _analyze_parallel(
    keys: List[str],
    idx: Dict[str, dict],
    llm_cfg: dict,
    zotero_dir: str,
    base_dir: str,
    system_prompt: str,
    user_prompt: str,
    analysis_fields: set,
    db_path: str,
    literature_json: str,
    emit_debug,
    parallel_count: int,
) -> None:
    """
    并行分析文献条目（内部函数）。
    
    处理流程：
    1. 串行准备阶段：遍历所有 keys，解析 PDF、构建 messages
    2. 并行调用阶段：使用 AsyncLLMAnalyzer 并行调用 LLM API
    3. 结果处理阶段：更新数据库、输出进度
    
    Args:
        keys: 需要分析的 item_key 列表
        idx: 条目索引
        llm_cfg: LLM 配置
        ... (其他参数见 analyze 函数)
    """
    import asyncio
    import os
    import time
    import sys
    from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
    from matrixit_backend import llm_async
    
    t0 = time.monotonic()
    sys.stderr.write(f"[SIDECAR] 🚀 并行模式启动，并发数: {parallel_count}\n")
    sys.stderr.flush()
    
    tasks_data: List[dict] = []
    items_map: Dict[str, dict] = {}
    original_status_map: Dict[str, str] = {}
    pdf_path_map: Dict[str, str] = {}

    if not analysis_fields:
        for k in keys:
            it = idx.get(str(k))
            if not it:
                continue
            restore_status = _analysis_restore_status(it.get("processed_status", "unprocessed"))
            _analysis_restore_and_emit_failed(
                db_path=db_path,
                literature_json=literature_json,
                it=it,
                restore_status=restore_status,
                export_snapshot=False,
                payload={
                    "type": "failed",
                    "item_key": str(k),
                    "error": "FIELDS_DEF_INVALID",
                    "error_code": "FIELDS_DEF_INVALID",
                    "message": "fields.json 缺少 analysis_fields 定义",
                },
            )
        return

    for k in keys:
        it = idx.get(str(k))
        if not it:
            print(json.dumps({
                "type": "failed", "item_key": str(k),
                "error": "ITEM_NOT_FOUND", "error_code": "ITEM_NOT_FOUND"
            }, ensure_ascii=False), flush=True)
            continue
        
        # 记录原始状态
        original_status = it.get("processed_status", "unprocessed")
        restore_status = _analysis_restore_status(original_status)
        original_status_map[str(k)] = restore_status
        
        # 标记为处理中
        it["processed_status"] = "processing"
        try:
            storage.upsert_item(db_path, it)
        except Exception:
            pass
        print(json.dumps({"type": "started", "item_key": str(k)}, ensure_ascii=False), flush=True)

        resolved_pdf = zotero.resolve_pdf_path(it, zotero_dir, base_dir=base_dir) or ""
        if not resolved_pdf:
            _analysis_restore_and_emit_failed(
                db_path=db_path,
                literature_json=literature_json,
                it=it,
                restore_status=restore_status,
                export_snapshot=False,
                payload={"type": "failed", "item_key": str(k), "error": "PDF_NOT_FOUND", "error_code": "PDF_NOT_FOUND"},
            )
            continue

        items_map[str(k)] = it
        pdf_path_map[str(k)] = str(resolved_pdf)

    if not items_map:
        sys.stderr.write("[SIDECAR] 没有有效任务需要处理\n")
        sys.stderr.flush()
        return

    cpu = os.cpu_count() or 2
    pdf_workers = min(max(1, cpu - 1), max(1, min(int(parallel_count or 1), 6)))
    sys.stderr.write(f"[SIDECAR] PDF 解析并发数: {pdf_workers}\n")
    sys.stderr.flush()

    t_pdf_start = time.monotonic()
    futures_map = {}
    executor_cls = ThreadPoolExecutor if getattr(sys, "frozen", False) else ProcessPoolExecutor
    with executor_cls(max_workers=pdf_workers) as executor:
        for item_key, pdf_path in pdf_path_map.items():
            futures_map[executor.submit(pdf.extract_pdf_text, pdf_path)] = item_key

        for fut in as_completed(list(futures_map.keys())):
            item_key = futures_map.get(fut) or ""
            it = items_map.get(item_key)
            if not it:
                continue
            restore_status = original_status_map.get(item_key, "unprocessed")
            try:
                text = fut.result() or ""
            except Exception:
                text = ""
            if not text:
                _analysis_restore_and_emit_failed(
                    db_path=db_path,
                    literature_json=literature_json,
                    it=it,
                    restore_status=restore_status,
                    export_snapshot=False,
                    payload={"type": "failed", "item_key": item_key, "error": "PDF_TEXT_EMPTY", "error_code": "PDF_TEXT_EMPTY"},
                )
                items_map.pop(item_key, None)
                pdf_path_map.pop(item_key, None)
                continue

            it["tldr"] = text.strip().replace("\n", " ")[:300]
            messages, user_content, _, _ = _analysis_build_messages(system_prompt, user_prompt, text, llm_cfg)
            if llm_cfg.get("multimodal"):
                tasks_data.append(
                    {
                        "item_key": item_key,
                        "system_prompt": system_prompt,
                        "user_content": user_content,
                        "pdf_path": pdf_path_map.get(item_key, ""),
                    }
                )
            else:
                tasks_data.append({"item_key": item_key, "messages": messages})

    if not tasks_data:
        sys.stderr.write("[SIDECAR] 没有有效任务需要处理\n")
        sys.stderr.flush()
        return
    t_pdf_end = time.monotonic()
    
    sys.stderr.write(f"[SIDECAR] 准备完成，共 {len(tasks_data)} 个任务\n")
    sys.stderr.flush()
    
    # 阶段 2: 并行调用 LLM
    t_llm_start = time.monotonic()
    def on_progress(result: dict) -> None:
        """进度回调：每完成一个任务时调用"""
        item_key = result.get("item_key", "")
        it = items_map.get(item_key)
        if not it:
            return
        
        restore_status = original_status_map.get(item_key, "unprocessed")
        
        if result.get("success"):
            llm_result = result.get("result", {})
            ok = _analysis_apply_result(it, item_key, llm_result, analysis_fields, emit_debug)
            if not ok:
                it["processed_status"] = restore_status
                it["sync_status"] = "unsynced"
                try:
                    storage.upsert_item(db_path, it)
                except Exception:
                    pass
                print(
                    json.dumps(
                        {
                            "type": "failed",
                            "item_key": item_key,
                            "error": "LLM_EMPTY_RESULT",
                            "error_code": "LLM_EMPTY_RESULT",
                            "message": f"模型未返回任何可写入字段",
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                return
            
            it["processed_status"] = "done"
            it["sync_status"] = "unsynced"
            try:
                storage.upsert_item(db_path, it)
                storage.export_json(db_path, literature_json)
                sys.stderr.write(f"[SIDECAR] ✓ Item {item_key} saved\n")
                sys.stderr.flush()
            except Exception as e:
                sys.stderr.write(f"[SIDECAR] ❌ Failed to save {item_key}: {e}\n")
                sys.stderr.flush()
            print(json.dumps({"type": "finished", "item_key": item_key, "item": it}, ensure_ascii=False), flush=True)
        else:
            # 失败：恢复原始状态
            it["processed_status"] = restore_status
            it["sync_status"] = "unsynced"
            try:
                storage.upsert_item(db_path, it)
            except Exception:
                pass
            print(json.dumps({
                "type": "failed", "item_key": item_key,
                "error": result.get("error_code", "LLM_REQUEST_FAILED"),
                "error_code": result.get("error_code", "LLM_REQUEST_FAILED"),
                "message": result.get("error", ""),
            }, ensure_ascii=False), flush=True)
    
    if llm_async.is_async_available():
        analyzer = llm_async.AsyncLLMAnalyzer(
            parallel_count=parallel_count,
            timeout=int(llm_cfg.get("timeout_s", 120)),
        )
        if llm_cfg.get("multimodal"):
            asyncio.run(
                analyzer.analyze_batch_responses(
                    tasks_data=tasks_data,
                    llm_cfg=llm_cfg,
                    on_progress=on_progress,
                    debug=lambda d: emit_debug(d.get("item_key", ""), "llm_async", d),
                )
            )
        else:
            asyncio.run(
                analyzer.analyze_batch(
                    tasks_data=tasks_data,
                    llm_cfg=llm_cfg,
                    on_progress=on_progress,
                    debug=lambda d: emit_debug(d.get("item_key", ""), "llm_async", d),
                )
            )
    else:
        for task in tasks_data:
            item_key = str(task.get("item_key") or "")
            it = items_map.get(item_key)
            if not it:
                continue
            restore_status = original_status_map.get(item_key, "unprocessed")
            try:
                if llm_cfg.get("multimodal"):
                    pdf_path = str(task.get("pdf_path") or "")
                    user_content = str(task.get("user_content") or "")
                    llm_result = llm.responses_pdf_json(
                        llm_cfg, system_prompt, user_content, pdf_path, debug=lambda d: emit_debug(item_key, "llm", d)
                    )
                else:
                    messages = task.get("messages") or []
                    llm_result = llm.chat_json(llm_cfg, messages, debug=lambda d: emit_debug(item_key, "llm", d))
                on_progress({"item_key": item_key, "success": True, "result": llm_result})
            except llm.LlmError as e:
                on_progress({"item_key": item_key, "success": False, "error": e.message, "error_code": e.code})
            except Exception as e:
                on_progress({"item_key": item_key, "success": False, "error": str(e), "error_code": "LLM_REQUEST_FAILED"})
    t_llm_end = time.monotonic()
    
    # 最终导出 JSON
    t_export_start = time.monotonic()
    try:
        storage.export_json(db_path, literature_json)
    except Exception:
        pass
    t_export_end = time.monotonic()

    diag = {
        "parallel_count": int(parallel_count or 1),
        "pdf_workers": int(pdf_workers or 1),
        "async_available": bool(llm_async.is_async_available()),
        "aiohttp": llm_async.get_async_diagnostic(),
        "tasks_total": int(len(tasks_data)),
        "timing_ms": {
            "pdf_prepare": int((t_pdf_end - t_pdf_start) * 1000),
            "llm": int((t_llm_end - t_llm_start) * 1000),
            "export": int((t_export_end - t_export_start) * 1000),
            "total": int((t_export_end - t0) * 1000),
        },
    }
    try:
        sys.stderr.write("[MATRIXIT_ANALYZE_SUMMARY] " + json.dumps(diag, ensure_ascii=False) + "\n")
        sys.stderr.flush()
    except Exception:
        pass
    try:
        if keys:
            print(
                json.dumps({"type": "debug", "item_key": str(keys[0]), "stage": "summary", "data": diag}, ensure_ascii=False),
                flush=True,
            )
    except Exception:
        pass
    
    sys.stderr.write(f"[SIDECAR] ✅ 并行分析完成\n")
    sys.stderr.flush()


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
    import time
    t0 = time.monotonic()
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
    fields_def = _load_fields_def(config, fields_path)

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

    # 检查并行配置
    parallel_count = llm_cfg.get("parallel_count", 1) if llm_cfg else 1
    finished_count = 0
    failed_count = 0
    attempted_parallel = False
    parallel_fallback: str = ""
    
    # 并行模式：parallel_count > 1 时启用
    if parallel_count > 1 and llm_cfg:
        try:
            attempted_parallel = True
            _analyze_parallel(
                keys=keys,
                idx=idx,
                llm_cfg=llm_cfg,
                zotero_dir=zotero_dir,
                base_dir=base_dir,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                analysis_fields=analysis_fields,
                db_path=db_path,
                literature_json=literature_json,
                emit_debug=emit_debug,
                parallel_count=parallel_count,
            )
            return
        except ImportError as e:
            # aiohttp 未安装，回退到串行模式
            parallel_fallback = str(e)
            sys.stderr.write(f"[SIDECAR] 并行模式不可用 ({e})，回退到串行模式\n")
            sys.stderr.flush()
        except Exception as e:
            parallel_fallback = str(e)
            sys.stderr.write(f"[SIDECAR] 并行模式出错 ({e})，回退到串行模式\n")
            sys.stderr.flush()

    # 串行模式（原有逻辑）
    for k in keys:
        it = idx.get(str(k))
        if not it:
            failed_count += 1
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
        restore_status = _analysis_restore_status(original_status)
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

        resolved_pdf, text = _analysis_resolve_pdf_and_text(it, zotero_dir, base_dir)
        if not resolved_pdf:
            failed_count += 1
            _analysis_restore_and_emit_failed(
                db_path=db_path,
                literature_json=literature_json,
                it=it,
                restore_status=restore_status,
                export_snapshot=True,
                payload={"type": "failed", "item_key": str(k), "error": "PDF_NOT_FOUND", "error_code": "PDF_NOT_FOUND"},
            )
            continue
        emit_debug(str(k), "pdf_resolved", {"pdf_path": str(resolved_pdf)})
        if not text:
            failed_count += 1
            _analysis_restore_and_emit_failed(
                db_path=db_path,
                literature_json=literature_json,
                it=it,
                restore_status=restore_status,
                export_snapshot=True,
                payload={"type": "failed", "item_key": str(k), "error": "PDF_TEXT_EMPTY", "error_code": "PDF_TEXT_EMPTY"},
            )
            continue

        it["tldr"] = text.strip().replace("\n", " ")[:300]

        if not analysis_fields:
            failed_count += 1
            _analysis_restore_and_emit_failed(
                db_path=db_path,
                literature_json=literature_json,
                it=it,
                restore_status=restore_status,
                export_snapshot=True,
                payload={
                    "type": "failed",
                    "item_key": str(k),
                    "error": "FIELDS_DEF_INVALID",
                    "error_code": "FIELDS_DEF_INVALID",
                    "message": "fields.json 缺少 analysis_fields 定义",
                },
            )
            continue

        if not llm_cfg:
            failed_count += 1
            _analysis_restore_and_emit_failed(
                db_path=db_path,
                literature_json=literature_json,
                it=it,
                restore_status=restore_status,
                export_snapshot=True,
                payload={
                    "type": "failed",
                    "item_key": str(k),
                    "error": "LLM_CONFIG_MISSING",
                    "error_code": "LLM_CONFIG_MISSING",
                    "message": "LLM 配置不完整",
                },
            )
            continue

        messages, user_content, text_in, max_chars = _analysis_build_messages(system_prompt, user_prompt, text, llm_cfg)
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
            failed_count += 1
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
            failed_count += 1
            continue

        ok = _analysis_apply_result(it, str(k), result, analysis_fields, emit_debug)
        if not ok:
            returned_keys = []
            if isinstance(result, dict):
                returned_keys = [str(x) for x in list(result.keys())[:30]]
            failed_count += 1
            _analysis_restore_and_emit_failed(
                db_path=db_path,
                literature_json=literature_json,
                it=it,
                restore_status=restore_status,
                export_snapshot=True,
                payload={
                    "type": "failed",
                    "item_key": str(k),
                    "error": "LLM_EMPTY_RESULT",
                    "error_code": "LLM_EMPTY_RESULT",
                    "message": f"模型未返回任何可写入字段，返回键={returned_keys}",
                },
            )
            continue

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
        print(json.dumps({"type": "finished", "item_key": str(k), "item": it}, ensure_ascii=False), flush=True)
        finished_count += 1

    try:
        async_available = False
        aiohttp_diag = {"available": False, "version": None, "error": None}
        try:
            from matrixit_backend import llm_async
            async_available = bool(llm_async.is_async_available())
            aiohttp_diag = llm_async.get_async_diagnostic()
        except Exception:
            async_available = False
        diag = {
            "mode": "serial",
            "parallel_count": int(parallel_count or 1),
            "llm_cfg_present": bool(llm_cfg),
            "multimodal": bool(llm_cfg.get("multimodal")) if isinstance(llm_cfg, dict) else False,
            "async_available": async_available,
            "aiohttp": aiohttp_diag,
            "attempted_parallel": bool(attempted_parallel),
            "parallel_fallback": parallel_fallback,
            "items_total": int(len(keys)),
            "finished": int(finished_count),
            "failed": int(failed_count),
            "timing_ms": {"total": int((time.monotonic() - t0) * 1000)},
        }
        sys.stderr.write("[MATRIXIT_ANALYZE_SUMMARY] " + json.dumps(diag, ensure_ascii=False) + "\n")
        sys.stderr.flush()
        if keys:
            print(
                json.dumps({"type": "debug", "item_key": str(keys[0]), "stage": "summary", "data": diag}, ensure_ascii=False),
                flush=True,
            )
    except Exception:
        pass


def sync_feishu(
    literature_json: str,
    db_path: str,
    root_dir: str,
    config_path: str,
    fields_path: str,
    keys: List[str],
    options: Optional[dict] = None,
) -> dict:
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
    stats, updated_items = feishu.upload_items(
        items,
        config,
        fields_source,
        keys,
        skip_processed=False,
        base_dir=str(root_dir),
        config_path=config_path,
        options=options,
    )
    try:
        storage.upsert_items(db_path, updated_items)
        storage.export_json(db_path, literature_json)
    except Exception:
        pass
    return stats


def reconcile_feishu(
    literature_json: str,
    db_path: str,
    root_dir: str,
    config_path: str,
    keys: List[str],
) -> dict:
    config = load_config(config_path)
    items_idx = storage.get_items_index(db_path)
    req_keys = [str(k).strip() for k in (keys or []) if str(k).strip()]
    targets: List[dict] = []
    record_ids: List[str] = []
    key_by_record_id: Dict[str, str] = {}

    for k, it in items_idx.items():
        if req_keys and str(k) not in req_keys:
            continue
        if not isinstance(it, dict):
            continue
        if it.get("processed_status") != "done":
            continue
        rid = str(it.get("record_id") or "").strip()
        if not rid:
            continue
        if it.get("sync_status") != "synced":
            continue
        targets.append(it)
        record_ids.append(rid)
        key_by_record_id[rid] = str(k)

    if not record_ids:
        return {"checked": 0, "missing_remote": 0, "marked_unsynced": 0, "forbidden": 0}

    res = feishu.batch_get_records(config, record_ids)
    absent = set([str(x) for x in res.get("absent", []) if str(x).strip()])
    forbidden = set([str(x) for x in res.get("forbidden", []) if str(x).strip()])

    marked = 0
    for it in targets:
        rid = str(it.get("record_id") or "").strip()
        if not rid:
            continue
        if rid in absent:
            it["sync_status"] = "unsynced"
            it.pop("record_id", None)
            marked += 1

    if marked:
        try:
            storage.upsert_items(db_path, targets)
            storage.export_json(db_path, literature_json)
        except Exception:
            pass

    return {
        "checked": len(record_ids),
        "missing_remote": len(absent),
        "marked_unsynced": marked,
        "forbidden": len(forbidden),
    }


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

def get_items(db_path: str, item_keys: List[str]) -> dict:
    """
    [IPC 命令] 批量读取条目（仅从本地 SQLite）。
    
    用于前端在分析 Finished 后快速拉取该条目的最新字段，
    避免等待 load_library（会读取/合并 Zotero DB，可能耗时较长）。
    
    Returns:
        Dict: {"items": [...]}
    """
    keys = [str(k).strip() for k in (item_keys or []) if str(k).strip()]
    if not keys:
        return {"items": []}
    items = storage.get_items(db_path, keys=keys, timeout_s=1.0)
    by_key = {str(it.get("item_key")): it for it in items if isinstance(it, dict) and it.get("item_key")}
    ordered = [by_key.get(k) for k in keys if k in by_key]
    return {"items": [it for it in ordered if isinstance(it, dict)]}

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
    try:
        import multiprocessing
        multiprocessing.freeze_support()
    except Exception:
        pass

    if len(sys.argv) < 2:
        sys.stderr.write("usage: sidecar.py <diag|load_library|analyze|sync_feishu|update_item|get_items|delete_extracted_data|format_citations|clear_citations> [json_args]\n")
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

    if cmd == "diag":
        payload: dict = {"frozen": bool(getattr(sys, "frozen", False)), "python": sys.version}
        try:
            from matrixit_backend import llm_async

            payload["aiohttp"] = llm_async.get_async_diagnostic()
        except Exception as e:
            payload["aiohttp"] = {"available": False, "version": None, "error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(payload, ensure_ascii=False))
        return

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
            sys.stderr.write("sync_feishu requires a JSON argument\n")
            sys.exit(2)
        arg = json.loads(sys.argv[2])
        options: Optional[dict] = None
        keys: object = []
        if isinstance(arg, list):
            keys = arg
        elif isinstance(arg, dict):
            keys = arg.get("keys") or arg.get("item_keys") or arg.get("itemKeys") or []
            opt = arg.get("options")
            options = opt if isinstance(opt, dict) else None
        try:
            stats = sync_feishu(literature_json, db_path, str(root_dir), config_path, fields_path, [str(k) for k in keys], options=options)
            sys.stdout.write(json.dumps(stats, ensure_ascii=False))
        except Exception as e:
            import traceback
            trace = traceback.format_exc()
            if isinstance(trace, str) and len(trace) > 8000:
                trace = trace[:8000] + "\n...<truncated>"
            sys.stdout.write(
                json.dumps(
                    {
                        "error": {
                            "code": "SYNC_FEISHU_FAILED",
                            "message": str(e),
                            "type": type(e).__name__,
                            "trace": trace,
                        }
                    },
                    ensure_ascii=False,
                )
            )
        return

    if cmd == "reconcile_feishu":
        keys_arg = "[]"
        if len(sys.argv) >= 3:
            keys_arg = sys.argv[2]
        if keys_arg == "-":
            raw = (sys.stdin.read() or "[]").lstrip("\ufeff").strip()
            keys = json.loads(raw or "[]")
        else:
            keys = json.loads(keys_arg or "[]")
        try:
            stats = reconcile_feishu(literature_json, db_path, str(root_dir), config_path, [str(k) for k in keys])
            sys.stdout.write(json.dumps(stats, ensure_ascii=False))
        except Exception as e:
            import traceback
            trace = traceback.format_exc()
            if isinstance(trace, str) and len(trace) > 8000:
                trace = trace[:8000] + "\n...<truncated>"
            sys.stdout.write(
                json.dumps(
                    {
                        "error": {
                            "code": "RECONCILE_FEISHU_FAILED",
                            "message": str(e),
                            "type": type(e).__name__,
                            "trace": trace,
                        }
                    },
                    ensure_ascii=False,
                )
            )
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

    if cmd == "get_items":
        if len(sys.argv) < 3:
            sys.stderr.write("get_items requires item_keys JSON array or '-' from stdin\n")
            sys.exit(2)
        keys_arg = sys.argv[2]
        if keys_arg == "-":
            raw = (sys.stdin.read() or "[]").lstrip("\ufeff").strip()
            keys = json.loads(raw or "[]")
        else:
            keys = json.loads(keys_arg)
        try:
            payload = get_items(db_path, [str(k) for k in keys])
            sys.stdout.write(json.dumps(payload, ensure_ascii=False))
        except Exception as e:
            sys.stdout.write(json.dumps({"items": [], "error": {"code": "GET_ITEMS_FAILED", "message": str(e)}}, ensure_ascii=False))
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
