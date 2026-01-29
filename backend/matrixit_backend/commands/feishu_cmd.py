"""
Feishu 相关命令模块。

包含：sync_feishu, reconcile_feishu, delete_extracted_data
所有重型依赖（feishu, prompt_builder）均采用懒加载。
"""
import json
from typing import Dict, List, Optional


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
    # 懒加载重型依赖
    from matrixit_backend import feishu, storage
    from matrixit_backend.config import load_config
    
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
    """[IPC 命令] 校验飞书同步状态，重置已失效的记录。"""
    # 懒加载重型依赖
    from matrixit_backend import feishu, storage
    from matrixit_backend.config import load_config
    
    config = load_config(config_path)
    fc = feishu.get_feishu_config(config)
    cur_app_token = str(fc.get("app_token") or "").strip()
    cur_table_id = str(fc.get("table_id") or "").strip()
    cur_base_sig = f"{cur_app_token}:{cur_table_id}" if cur_app_token and cur_table_id else ""
    items_idx = storage.get_items_index(db_path)
    req_keys = [str(k).strip() for k in (keys or []) if str(k).strip()]
    targets: List[dict] = []
    reset_items: List[dict] = []
    record_ids: List[str] = []
    key_by_record_id: Dict[str, str] = {}
    reset_mismatch = 0

    for k, it in items_idx.items():
        if req_keys and str(k) not in req_keys:
            continue
        if not isinstance(it, dict):
            continue
        if it.get("processed_status") != "done":
            continue
        if it.get("sync_status") != "synced":
            continue
        it_sig = str(it.get("feishu_base_sig") or "").strip()
        it_app = str(it.get("feishu_app_token") or "").strip()
        it_tid = str(it.get("feishu_table_id") or "").strip()
        if cur_base_sig and ((it_sig and it_sig != cur_base_sig) or (it_app and it_app != cur_app_token) or (it_tid and it_tid != cur_table_id)):
            it["sync_status"] = "unsynced"
            it.pop("record_id", None)
            it.pop("feishu_base_sig", None)
            it.pop("feishu_app_token", None)
            it.pop("feishu_table_id", None)
            reset_mismatch += 1
            reset_items.append(it)
            continue
        rid = str(it.get("record_id") or "").strip()
        if not rid:
            continue
        targets.append(it)
        record_ids.append(rid)
        key_by_record_id[rid] = str(k)

    if reset_mismatch:
        try:
            storage.upsert_items(db_path, reset_items)
            storage.export_json(db_path, literature_json)
        except Exception:
            pass

    if not record_ids:
        return {"checked": 0, "missing_remote": 0, "marked_unsynced": int(reset_mismatch), "forbidden": 0}

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
        "marked_unsynced": marked + int(reset_mismatch),
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
    # 懒加载重型依赖
    from matrixit_backend import feishu, prompt_builder, storage
    from matrixit_backend.config import load_config
    
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
