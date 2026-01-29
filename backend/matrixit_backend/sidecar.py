"""
MatrixIt 后端 sidecar 入口。

该脚本作为 Tauri sidecar 被调用，通过命令行参数执行不同能力，并以 JSON 输出结果/事件：
- load_library: 读取 Zotero 数据库并写入本地 DB，同时输出收藏夹树与条目列表
- analyze: 对指定条目读取 PDF 并调用 LLM 提取结构化字段，逐条输出事件并写回本地库
- sync_feishu: 将条目同步到飞书多维表格，写回同步状态
- update_item: 对本地库中指定条目做局部字段更新

约定：
- 尽量"吞错"并维持流程可继续推进（避免 sidecar 异常导致前端卡死）
- 数据以 SQLite 为主存，literature.json 为导出快照（便于前端加载、迁移与排障）

重构说明：
- 此文件经过模块化重构，业务逻辑已拆分至 commands/ 子目录
- 各命令模块使用懒加载以提升启动性能
"""

import json
import os
import sys
from pathlib import Path
from typing import List, Optional

if __package__ in (None, ""):
    _BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    if _BACKEND_DIR not in sys.path:
        sys.path.insert(0, _BACKEND_DIR)

# 常量定义
LITERATURE_JSON_DEFAULT = "data/literature.json"
CONFIG_DEFAULT = "config/config.json"
FIELDS_DEFAULT = "fields.json"
LEGACY_LITERATURE_JSON_DEFAULT = "literature.json"


def _resolve_with_base(path_str: str, base_dir: str) -> str:
    """解析路径，相对路径基于 base_dir 解析。"""
    p = Path(path_str)
    if p.is_absolute():
        return str(p)
    return str((Path(base_dir) / p).resolve())


def _find_project_root(start: Path) -> Path:
    """从起始路径向上查找项目根目录。"""
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
    # 配置 UTF-8 输出
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
        sys.stderr.write("usage: sidecar.py <diag|load_library|resolve_pdf_path|analyze|sync_feishu|update_item|get_items|delete_extracted_data|format_citations|clear_citations|export_excel|export_pdfs> [json_args]\n")
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

    # 懒加载 storage 模块用于初始化数据库
    from matrixit_backend import storage
    
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

    # ============ diag 命令 ============
    if cmd == "diag":
        payload: dict = {"frozen": bool(getattr(sys, "frozen", False)), "python": sys.version}
        try:
            from matrixit_backend import llm_async
            payload["aiohttp"] = llm_async.get_async_diagnostic()
        except Exception as e:
            payload["aiohttp"] = {"available": False, "version": None, "error": f"{type(e).__name__}: {e}"}
        sys.stdout.write(json.dumps(payload, ensure_ascii=False))
        return

    # ============ load_library 命令 ============
    if cmd == "load_library":
        from matrixit_backend.commands.library import load_library
        try:
            payload = load_library(literature_json, db_path, str(root_dir), config_path, fields_path)
        except Exception as e:
            payload = {"collections": [], "items": [], "error": {"code": "LOAD_LIBRARY_FAILED", "message": str(e)}}
        sys.stdout.write(json.dumps(payload, ensure_ascii=False))
        return

    # ============ resolve_pdf_path 命令 ============
    if cmd == "resolve_pdf_path":
        if len(sys.argv) < 3:
            sys.stderr.write("resolve_pdf_path requires: item_key\n")
            sys.exit(2)
        from matrixit_backend.commands.library import resolve_pdf_path
        item_key = str(sys.argv[2] or "").strip()
        try:
            payload = resolve_pdf_path(db_path, str(root_dir), config_path, item_key)
        except Exception as e:
            payload = {"pdf_path": "", "error": {"code": "RESOLVE_PDF_PATH_FAILED", "message": str(e)}}
        sys.stdout.write(json.dumps(payload, ensure_ascii=False))
        return

    # ============ analyze 命令 ============
    if cmd == "analyze":
        if len(sys.argv) < 3:
            sys.stderr.write("analyze requires a JSON array argument\n")
            sys.exit(2)
        from matrixit_backend.commands.analyze import analyze
        keys_arg = sys.argv[2]
        if keys_arg == "-":
            raw = (sys.stdin.read() or "[]").lstrip("\ufeff").strip()
            keys = json.loads(raw or "[]")
        else:
            keys = json.loads(keys_arg)
        analyze(literature_json, db_path, str(root_dir), config_path, fields_path, [str(k) for k in keys])
        return

    # ============ sync_feishu 命令 ============
    if cmd == "sync_feishu":
        if len(sys.argv) < 3:
            sys.stderr.write("sync_feishu requires a JSON argument\n")
            sys.exit(2)
        from matrixit_backend.commands.feishu_cmd import sync_feishu
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

    # ============ reconcile_feishu 命令 ============
    if cmd == "reconcile_feishu":
        from matrixit_backend.commands.feishu_cmd import reconcile_feishu
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

    # ============ delete_extracted_data 命令 ============
    if cmd == "delete_extracted_data":
        if len(sys.argv) < 3:
            sys.stderr.write("delete_extracted_data requires a JSON array argument\n")
            sys.exit(2)
        from matrixit_backend.commands.feishu_cmd import delete_extracted_data
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

    # ============ update_item 命令 ============
    if cmd == "update_item":
        if len(sys.argv) < 4:
            sys.stderr.write("update_item requires: item_key patch_json\n")
            sys.exit(2)
        from matrixit_backend.commands.library import update_item
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

    # ============ get_items 命令 ============
    if cmd == "get_items":
        if len(sys.argv) < 3:
            sys.stderr.write("get_items requires item_keys JSON array or '-' from stdin\n")
            sys.exit(2)
        from matrixit_backend.commands.library import get_items
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

    # ============ format_citations 命令 ============
    if cmd == "format_citations":
        if len(sys.argv) < 3:
            sys.stderr.write("format_citations requires item_keys JSON array or '-' from stdin\n")
            sys.exit(2)
        from matrixit_backend.commands.citation_cmd import format_citations
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

    # ============ clear_citations 命令 ============
    if cmd == "clear_citations":
        from matrixit_backend.commands.citation_cmd import clear_citations
        try:
            payload = clear_citations(literature_json, db_path)
            sys.stdout.write(json.dumps(payload, ensure_ascii=False))
        except Exception as e:
            sys.stdout.write(json.dumps({"error": {"code": "CLEAR_CITATIONS_FAILED", "message": str(e)}}, ensure_ascii=False))
        return

    # ============ export_excel 命令 ============
    if cmd == "export_excel":
        if len(sys.argv) < 3:
            sys.stderr.write("export_excel requires a JSON argument\n")
            sys.exit(2)
        from matrixit_backend.commands.export import export_excel
        arg = json.loads(sys.argv[2])
        keys = arg.get("keys") or arg.get("item_keys") or arg.get("itemKeys") or []
        output_path = str(arg.get("output_path") or arg.get("outputPath") or "").strip()
        filename = str(arg.get("filename") or "").strip() or "导出文献.xlsx"
        if not output_path:
            sys.stdout.write(json.dumps({"error": {"code": "EXPORT_EXCEL_FAILED", "message": "output_path 不能为空"}}, ensure_ascii=False))
            return
        try:
            payload = export_excel(
                db_path=db_path,
                root_dir=str(root_dir),
                config_path=config_path,
                fields_path=fields_path,
                keys=[str(k) for k in keys],
                output_path=output_path,
                filename=filename,
            )
            sys.stdout.write(json.dumps(payload, ensure_ascii=False))
        except Exception as e:
            import traceback
            trace = traceback.format_exc()
            if isinstance(trace, str) and len(trace) > 8000:
                trace = trace[:8000] + "\n...<truncated>"
            sys.stdout.write(json.dumps({"error": {"code": "EXPORT_EXCEL_FAILED", "message": str(e), "trace": trace}}, ensure_ascii=False))
        return

    # ============ export_pdfs 命令 ============
    if cmd == "export_pdfs":
        if len(sys.argv) < 3:
            sys.stderr.write("export_pdfs requires a JSON argument\n")
            sys.exit(2)
        from matrixit_backend.commands.export import export_pdfs
        arg = json.loads(sys.argv[2])
        keys = arg.get("keys") or arg.get("item_keys") or arg.get("itemKeys") or []
        output_dir = str(arg.get("output_dir") or arg.get("outputDir") or "").strip()
        if not output_dir:
            sys.stdout.write(json.dumps({"error": {"code": "EXPORT_PDFS_FAILED", "message": "output_dir 不能为空"}}, ensure_ascii=False))
            return
        try:
            payload = export_pdfs(
                db_path=db_path,
                root_dir=str(root_dir),
                config_path=config_path,
                keys=[str(k) for k in keys],
                output_dir=output_dir,
            )
            sys.stdout.write(json.dumps(payload, ensure_ascii=False))
        except Exception as e:
            import traceback
            trace = traceback.format_exc()
            if isinstance(trace, str) and len(trace) > 8000:
                trace = trace[:8000] + "\n...<truncated>"
            sys.stdout.write(json.dumps({"error": {"code": "EXPORT_PDFS_FAILED", "message": str(e), "trace": trace}}, ensure_ascii=False))
        return

    sys.stderr.write(f"unknown command: {cmd}\n")
    sys.exit(2)


if __name__ == "__main__":
    main()
