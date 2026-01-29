"""
Analyze 相关命令模块。

包含：analyze 主函数及其辅助函数（_analyze_parallel 等）
所有重型依赖（llm, pdf, prompt_builder, llm_async）均采用懒加载。
"""
import json
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional


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


def _analysis_restore_status(original_status: str) -> str:
    """根据原始状态决定恢复目标：done -> done, 其他 -> unprocessed"""
    return "done" if original_status == "done" else "unprocessed"


def _analysis_build_messages(system_prompt: str, user_prompt: str, pdf_text: str, llm_cfg: dict) -> tuple:
    """构建 LLM 请求消息。"""
    max_chars = int(llm_cfg.get("max_input_chars", 12000))
    text_in = pdf_text if len(pdf_text) <= max_chars else pdf_text[:max_chars]
    user_content = user_prompt + "\n\n---\n\nPDF 正文：\n" + text_in
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]
    return messages, user_content, text_in, max_chars


def _analysis_apply_result(it: dict, item_key: str, result: object, analysis_fields: set, emit_debug) -> bool:
    """将 LLM 返回的结果应用到条目。"""
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
    storage,
    db_path: str,
    literature_json: str,
    it: dict,
    restore_status: str,
    export_snapshot: bool,
    payload: dict,
) -> None:
    """恢复条目状态并输出失败事件。"""
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
    """
    import asyncio
    import time
    from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
    
    # 懒加载重型依赖
    from matrixit_backend import llm, llm_async, pdf, storage, zotero
    
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
                storage=storage,
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
        
        original_status = it.get("processed_status", "unprocessed")
        restore_status = _analysis_restore_status(original_status)
        original_status_map[str(k)] = restore_status
        
        it["processed_status"] = "processing"
        try:
            storage.upsert_item(db_path, it)
        except Exception:
            pass
        print(json.dumps({"type": "started", "item_key": str(k)}, ensure_ascii=False), flush=True)

        resolved_pdf = zotero.resolve_pdf_path(it, zotero_dir, base_dir=base_dir) or ""
        if not resolved_pdf:
            _analysis_restore_and_emit_failed(
                storage=storage,
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
                    storage=storage,
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
                            "message": "模型未返回任何可写入字段",
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
            except Exception as e:
                error_code = getattr(e, "code", "LLM_REQUEST_FAILED")
                error_msg = getattr(e, "message", str(e))
                on_progress({"item_key": item_key, "success": False, "error": error_msg, "error_code": error_code})
    t_llm_end = time.monotonic()
    
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
    
    sys.stderr.write("[SIDECAR] ✅ 并行分析完成\n")
    sys.stderr.flush()


def analyze(literature_json: str, db_path: str, root_dir: str, config_path: str, fields_path: str, keys: List[str]) -> None:
    """
    [IPC 命令] 分析文献条目（LLM 提取）。
    
    针对选中的条目，依次执行：
    1. 查找并解析 PDF 附件。
    2. 构造 Prompt 调用 LLM (支持纯文本或多模态)。
    3. 解析返回的 JSON 并通过 stdout 流式输出进度事件。
    4. 更新本地数据库。
    
    注意：此函数不直接返回结果，而是将进度以 JSON Line 格式打印到 stdout 供前端消费。
    """
    import time
    
    # 懒加载重型依赖
    from matrixit_backend import llm, pdf, prompt_builder, storage, zotero
    from matrixit_backend.config import load_config
    
    base_dir = str(Path(root_dir).resolve())
    config = load_config(config_path)
    zotero_dir = zotero.get_zotero_dir(config)
    llm_cfg = llm.load_llm_config(config)
    t0 = time.monotonic()
    
    # 调试配置
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

    llm_trace = True
    if isinstance(debug_cfg.get("llm_trace"), bool):
        llm_trace = bool(debug_cfg.get("llm_trace"))
    env_llm_trace = str(os.environ.get("MATRIXIT_LLM_TRACE") or "").strip().lower()
    if env_llm_trace in ("1", "true", "yes", "on"):
        llm_trace = True
    if env_llm_trace in ("0", "false", "no", "off"):
        llm_trace = False

    llm_trace_user_max_chars = 1000
    if isinstance(debug_cfg.get("llm_trace_user_max_chars"), (int, float, str)):
        try:
            llm_trace_user_max_chars = int(debug_cfg.get("llm_trace_user_max_chars"))
        except Exception:
            llm_trace_user_max_chars = 1000
    env_llm_trace_user_max = str(os.environ.get("MATRIXIT_LLM_TRACE_USER_MAX") or "").strip()
    if env_llm_trace_user_max:
        try:
            llm_trace_user_max_chars = int(env_llm_trace_user_max)
        except Exception:
            pass
    if llm_trace_user_max_chars < 0:
        llm_trace_user_max_chars = 0

    if not debug_enabled:
        llm_trace = False

    os.environ["MATRIXIT_LLM_TRACE"] = "1" if llm_trace else "0"
    os.environ["MATRIXIT_LLM_TRACE_USER_MAX"] = str(llm_trace_user_max_chars)

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

    parallel_count = llm_cfg.get("parallel_count", 1) if llm_cfg else 1
    finished_count = 0
    failed_count = 0
    attempted_parallel = False
    parallel_fallback: str = ""
    
    # 并行模式
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
            parallel_fallback = str(e)
            sys.stderr.write(f"[SIDECAR] 并行模式不可用 ({e})，回退到串行模式\n")
            sys.stderr.flush()
        except Exception as e:
            parallel_fallback = str(e)
            sys.stderr.write(f"[SIDECAR] 并行模式出错 ({e})，回退到串行模式\n")
            sys.stderr.flush()

    # 串行模式
    for k in keys:
        it = idx.get(str(k))
        if not it:
            failed_count += 1
            print(
                json.dumps(
                    {"type": "failed", "item_key": str(k), "error": "ITEM_NOT_FOUND", "error_code": "ITEM_NOT_FOUND"},
                    ensure_ascii=False,
                ),
                flush=True,
            )
            continue

        original_status = it.get("processed_status", "unprocessed")
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

        resolved_pdf = zotero.resolve_pdf_path(it, zotero_dir, base_dir=base_dir) or ""
        text = ""
        if resolved_pdf:
            text = pdf.extract_pdf_text(resolved_pdf) or ""
        
        if not resolved_pdf:
            failed_count += 1
            _analysis_restore_and_emit_failed(
                storage=storage,
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
                storage=storage,
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
                storage=storage,
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
                storage=storage,
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
            except llm.LlmError:
                result = None
            except Exception:
                result = None
        try:
            if result is None:
                result = llm.chat_json(llm_cfg, messages, debug=lambda d: emit_debug(str(k), "llm", d))
        except llm.LlmError as e:
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
                ),
                flush=True,
            )
            failed_count += 1
            continue
        except Exception:
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
                ),
                flush=True,
            )
            failed_count += 1
            continue

        ok = _analysis_apply_result(it, str(k), result, analysis_fields, emit_debug)
        if not ok:
            returned_keys = []
            if isinstance(result, dict):
                returned_keys = [str(x) for x in list(result.keys())[:30]]
            failed_count += 1
            _analysis_restore_and_emit_failed(
                storage=storage,
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
