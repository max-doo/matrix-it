"""
Citation 相关命令模块。

包含：format_citations, clear_citations
"""
from typing import List


def format_citations(db_path: str, item_keys: List[str]) -> dict:
    """
    [IPC 命令] 生成参考文献引用。
    
    基于 item_keys 生成 GB/T 7714 格式的引用字符串。
    
    Returns:
        Dict: {"citations": {item_key: citation_str}}
    """
    # 懒加载重型依赖
    from matrixit_backend import citation, storage
    
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
    # 懒加载重型依赖
    from matrixit_backend import storage
    
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
