"""
飞书多维表格（Bitable）同步模块。

本模块负责与飞书开放平台进行交互，实现以下核心功能：
1. 配置解析：解析飞书 app_token, table_id 等配置信息。
2. 字段管理：根据本地 schema 自动在多维表中创建缺失的字段。
3. 数据同步：将本地文献条目（Literature Item）转换为多维表记录（Record），支持新增与更新。
4. 附件上传：将 PDF 附件上传至飞书云文档并关联到多维表。
"""

import json
import os
import re
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

import lark_oapi as lark
from lark_oapi.api.bitable.v1 import (
    AppTableField,
    AppTableRecord,
    CreateAppTableFieldRequest,
    CreateAppTableRecordRequest,
    DeleteAppTableRecordRequest,
    ListAppTableFieldRequest,
    UpdateAppTableFieldRequest,
    UpdateAppTableRecordRequest,
)
from lark_oapi.api.drive.v1 import UploadAllMediaRequest, UploadAllMediaRequestBody

from matrixit_backend import zotero
from matrixit_backend.config import save_local_config_patch

FIELD_TYPE_TEXT = 1
FIELD_TYPE_NUMBER = 2
FIELD_TYPE_SINGLE_SELECT = 3
FIELD_TYPE_MULTI_SELECT = 4
FIELD_TYPE_ATTACHMENT = 17

TYPE_MAPPING = {
    "string": FIELD_TYPE_TEXT,
    "number": FIELD_TYPE_NUMBER,
    "select": FIELD_TYPE_SINGLE_SELECT,
    "multi_select": FIELD_TYPE_MULTI_SELECT,
    "file": FIELD_TYPE_ATTACHMENT,
}


def parse_bitable_url(url: str) -> Tuple[Optional[str], Optional[str]]:
    """
    从飞书多维表链接中解析 app_token 与 table_id。
    
    Args:
        url: 飞书多维表的完整 URL
        
    Returns:
        Tuple[app_token, table_id]: 解析失败则返回 (None, None)
        
    Examples:
        - Path: .../base/<app_token>/<table_id>...
        - Query: ...?table=<table_id>
    """
    if not url:
        return None, None
    try:
        parsed = urlparse(url)
        path_parts = parsed.path.strip("/").split("/")
        app_token, table_id = None, None

        if len(path_parts) >= 2 and path_parts[0] == "base":
            app_token = path_parts[1]
            if len(path_parts) >= 3 and path_parts[2].startswith("tbl"):
                table_id = path_parts[2]

        if not table_id:
            qs = parse_qs(parsed.query)
            if "table" in qs:
                table_id = qs["table"][0]

        return app_token, table_id
    except Exception:
        return None, None


def get_feishu_config(config: dict) -> dict:
    """
    获取飞书配置字典。
    
    优先使用配置中的明确字段，若缺失则尝试从 `bitable_url` 推导 `app_token` 和 `table_id`。
    
    Args:
        config: 总配置字典
        
    Returns:
        包含飞书相关配置的字典
    """
    fc = config.get("feishu", {})
    if fc.get("bitable_url"):
        at, tid = parse_bitable_url(fc["bitable_url"])
        if at:
            fc["app_token"] = at
        if tid:
            fc["table_id"] = tid
    return fc


def create_client(app_id: str, app_secret: str) -> lark.Client:
    """
    创建并初始化飞书 SDK 客户端。
    
    Args:
        app_id: 飞书应用 App ID
        app_secret: 飞书应用 App Secret
        
    Returns:
        已初始化的 lark.Client 实例
    """
    return lark.Client.builder().app_id(app_id).app_secret(app_secret).build()


def upload_file(client: lark.Client, file_path: str, parent_token: str) -> Optional[str]:
    """
    上传文件到飞书云空间。
    
    指定 parent_type 为 "bitable_file" 以便在多维表附件字段中使用。
    
    Args:
        client: 飞书客户端
        file_path: 本地文件绝对路径
        parent_token: 上级节点 token (通常为 app_token)
        
    Returns:
        成功返回 file_token，失败返回 None
    """
    if not os.path.exists(file_path):
        return None
    size = os.path.getsize(file_path)
    with open(file_path, "rb") as f:
        content = f.read()

    req = UploadAllMediaRequest.builder().request_body(
        UploadAllMediaRequestBody.builder()
        .file_name(os.path.basename(file_path))
        .parent_type("bitable_file")
        .parent_node(parent_token)
        .size(size)
        .file(content)
        .build()
    ).build()

    resp = client.drive.v1.media.upload_all(req)
    if resp.success() and resp.data:
        return resp.data.file_token
    return None


def get_existing_fields(client: lark.Client, app_token: str, table_id: str) -> Dict[str, dict]:
    """
    获取多维表当前所有字段定义。
    
    Args:
        client: 飞书客户端
        app_token: 多维表 App Token
        table_id: 数据表 ID
        
    Returns:
        字典映射: {field_name: {"id": field_id, "type": field_type}}
    """
    fields: Dict[str, dict] = {}
    pt = ""
    while True:
        req = (
            ListAppTableFieldRequest.builder()
            .app_token(app_token)
            .table_id(table_id)
            .page_token(pt)
            .page_size(100)
            .build()
        )
        resp = client.bitable.v1.app_table_field.list(req)
        if not resp.success():
            break
        if resp.data and resp.data.items:
            for f in resp.data.items:
                fields[f.field_name] = {"id": f.field_id, "type": f.type}
        if not resp.data or not resp.data.has_more:
            break
        pt = resp.data.page_token
    return fields


def create_field(client: lark.Client, app_token: str, table_id: str, name: str, ftype: int) -> Optional[str]:
    """
    在多维表中创建新字段。
    
    Args:
        client: 飞书客户端
        app_token: 多维表 App Token
        table_id: 数据表 ID
        name: 字段名称
        ftype: 字段类型 (参考 lark_oapi 中的定义)
        
    Returns:
        成功返回 field_id，失败返回 None
    """
    req = (
        CreateAppTableFieldRequest.builder()
        .app_token(app_token)
        .table_id(table_id)
        .request_body(AppTableField.builder().field_name(name).type(ftype).build())
        .build()
    )
    resp = client.bitable.v1.app_table_field.create(req)
    if resp.success() and resp.data and resp.data.field:
        return resp.data.field.field_id
    return None


def update_field(client: lark.Client, app_token: str, table_id: str, field_id: str, name: str, ftype: int) -> bool:
    """
    更新多维表字段（用于字段重命名等）。
    """
    fid = str(field_id or "").strip()
    if not fid:
        return False
    req = (
        UpdateAppTableFieldRequest.builder()
        .app_token(app_token)
        .table_id(table_id)
        .field_id(fid)
        .request_body(AppTableField.builder().field_name(name).type(ftype).build())
        .build()
    )
    resp = client.bitable.v1.app_table_field.update(req)
    return bool(resp.success())


def ensure_fields(
    client: lark.Client,
    app_token: str,
    table_id: str,
    fields_def: dict,
    mapping: Dict[str, str],
    schema_fields: Optional[Dict[str, dict]] = None,
) -> Dict[str, dict]:
    """
    确保 mapping 中定义的字段在多维表中真实存在，并尽量保持字段名与类型一致。
    
    如果字段不存在，则根据 `fields` 中的类型定义自动创建；
    若本地 schema 缓存存在 field_id 且字段名变更，则尝试对飞书字段重命名。
    
    Args:
        client: 飞书客户端
        app_token: 多维表 App Token
        table_id: 数据表 ID
        fields_def: `fields.json` 的完整内容
        mapping: 字段映射字典 {json_key: feishu_field_name}
        schema_fields: 本地缓存字段映射 {json_key: {"field_id": "...", "name": "..."}}
    """
    flat_defs = {}
    for section in ["meta_fields", "analysis_fields", "attachment_fields"]:
        if section in fields_def:
            flat_defs.update(fields_def[section])

    existing = get_existing_fields(client, app_token, table_id)
    by_id: Dict[str, dict] = {}
    for n, info in existing.items():
        fid = str(info.get("id") or "").strip()
        if not fid:
            continue
        by_id[fid] = {"name": n, "type": info.get("type", 0)}

    schema: Dict[str, dict] = schema_fields if isinstance(schema_fields, dict) else {}
    next_schema: Dict[str, dict] = {str(k): (v if isinstance(v, dict) else {}) for k, v in schema.items()}

    for json_key, fs_name in mapping.items():
        if json_key not in flat_defs:
            continue
        expected_type = TYPE_MAPPING.get(flat_defs[json_key].get("type", "string"), FIELD_TYPE_TEXT)
        cached = next_schema.get(str(json_key)) if isinstance(next_schema.get(str(json_key)), dict) else {}
        cached_id = str((cached or {}).get("field_id") or (cached or {}).get("id") or "").strip()
        if cached_id and cached_id in by_id:
            cur = by_id[cached_id]
            cur_type = cur.get("type", 0)
            cur_name = str(cur.get("name") or "")
            if cur_type and int(cur_type) != int(expected_type):
                raise ValueError(f"飞书字段类型不匹配: {fs_name} (期望 {expected_type}, 实际 {cur_type})")
            if cur_name and cur_name != fs_name:
                ok = update_field(client, app_token, table_id, cached_id, fs_name, expected_type)
                if not ok:
                    raise ValueError(f"飞书字段重命名失败: {cur_name} -> {fs_name}")
                existing.pop(cur_name, None)
                existing[fs_name] = {"id": cached_id, "type": expected_type}
                by_id[cached_id] = {"name": fs_name, "type": expected_type}
            next_schema[str(json_key)] = {"field_id": cached_id, "name": fs_name}
            continue

        if fs_name in existing:
            actual_type = existing.get(fs_name, {}).get("type", 0)
            if actual_type and int(actual_type) != int(expected_type):
                raise ValueError(f"飞书字段类型不匹配: {fs_name} (期望 {expected_type}, 实际 {actual_type})")
            fid = str(existing.get(fs_name, {}).get("id") or "").strip()
            if fid:
                next_schema[str(json_key)] = {"field_id": fid, "name": fs_name}
            continue

        new_id = create_field(client, app_token, table_id, fs_name, expected_type)
        if not new_id:
            raise ValueError(f"飞书字段创建失败: {fs_name}")
        existing[fs_name] = {"id": new_id, "type": expected_type}
        by_id[str(new_id)] = {"name": fs_name, "type": expected_type}
        next_schema[str(json_key)] = {"field_id": str(new_id), "name": fs_name}

    return next_schema


def map_item(item: dict, mapping: Dict[str, str], file_token: Optional[str], fields_info: Dict[str, dict]) -> Dict[str, object]:
    """
    将本地文献条目转换为飞书多维表记录格式。
    
    处理逻辑：
    1. 根据 mapping 提取对应字段值。
    2. 类型转换：如将 list 转为 multi_select 字符串，year 转为 int。
    3. 特殊处理：附件字段 (attachment) 关联上传后的 file_token。
    
    Args:
        item: 本地文献条目字典
        mapping: 字段映射表
        file_token: 已上传的附件 token (可选)
        fields_info: 多维表字段元数据 (用于判断目标字段类型)
        
    Returns:
        构造好的飞书 record fields 字典
    """
    fields: Dict[str, object] = {}
    for jk, fk in mapping.items():
        if jk == "attachment":
            if file_token:
                fields[fk] = [{"file_token": file_token}]
            continue

        if jk not in item:
            continue

        val = item[jk]

        if jk == "collections" and isinstance(val, list):
            val = [c.get("name") for c in val if isinstance(c, dict) and c.get("name")]

        if val is None or val == "":
            continue

        ftype = fields_info.get(fk, {}).get("type", 0)
        if ftype == FIELD_TYPE_MULTI_SELECT:
            if isinstance(val, str):
                val = [p.strip() for p in re.split(r"[,，]", val) if p.strip()]
            elif not isinstance(val, list):
                val = [val]
        elif jk == "year" and isinstance(val, str):
            try:
                val = int(val) if val else None
            except Exception:
                val = None

        if val is not None:
            fields[fk] = val

    return fields


def upload_items(
    items: List[dict],
    config_dict: dict,
    fields_json: object,
    keys: Optional[List[str]],
    skip_processed: bool,
    base_dir: str,
    config_path: Optional[str] = None,
) -> Tuple[dict, List[dict]]:
    """
    批量同步条目到飞书多维表。
    
    流程：
    1. 读取并验证飞书配置。
    2. 检查并创建多维表字段。
    3. 遍历 items：
       - 若指定 keys 则仅处理匹配条目。
       - 若启用 skip_processed 则跳过已同步条目。
       - 上传 PDF 附件 (如有)。
       - 创建或更新多维表记录 (Create/Update Record)。
       - 更新本地条目状态 (sync_status, record_id)。
       
    Args:
        items: 文献条目列表
        config_dict: 配置字典
        fields_json: fields.json 文件路径或内容
        keys: 仅同步指定的 item_key 列表
        skip_processed: 是否跳过已标记为同步的条目
        base_dir: 项目根目录 (用于解析相对路径)
        
    Returns:
        (stats, updated_items): 统计信息与更新后的条目列表
    """
    fc = get_feishu_config(config_dict)
    if not all(k in fc for k in ["app_id", "app_secret", "app_token", "table_id"]):
        raise ValueError("飞书配置不完整")

    req_keys = [str(k).strip() for k in (keys or []) if str(k).strip()]

    fields_def: dict = {}
    if isinstance(fields_json, dict):
        fields_def = fields_json
    else:
        fields_path = Path(str(fields_json))
        if not fields_path.is_absolute():
            fields_path = (Path(base_dir) / fields_path).resolve()
        with open(fields_path, "r", encoding="utf-8") as f:
            fields_def = json.load(f)

    mapping: Dict[str, str] = {}
    used_names: Dict[str, str] = {}
    for section in ["meta_fields", "analysis_fields", "attachment_fields"]:
        defs = fields_def.get(section, {})
        if not isinstance(defs, dict):
            continue
        for k, v in defs.items():
            if not isinstance(v, dict):
                continue
            name = str(v.get("name") or "").strip()
            if not name:
                raise ValueError(f"字段缺少 name: {section}.{k}")
            if name in used_names and used_names[name] != str(k):
                raise ValueError(f"字段 name 重复: {name} ({used_names[name]} / {k})")
            used_names[name] = str(k)
            mapping[str(k)] = name

    schema_fields = {}
    fc_schema = fc.get("schema", {}) if isinstance(fc.get("schema", {}), dict) else {}
    if isinstance(fc_schema.get("fields"), dict):
        schema_fields = fc_schema.get("fields", {})

    client = create_client(fc["app_id"], fc["app_secret"])
    next_schema = ensure_fields(client, fc["app_token"], fc["table_id"], fields_def, mapping, schema_fields=schema_fields)
    if config_path and isinstance(next_schema, dict):
        try:
            save_local_config_patch(str(config_path), {"feishu": {"schema": {"fields": next_schema}}})
        except Exception as e:
            try:
                import sys
                sys.stderr.write(f"[FEISHU] ⚠ 写入 schema 缓存失败：{e}\n")
                sys.stderr.flush()
            except Exception:
                pass
    fields_info = get_existing_fields(client, fc["app_token"], fc["table_id"])

    zotero_dir = zotero.get_zotero_dir(config_dict)

    stats = {"uploaded": 0, "skipped": 0, "failed": 0}

    targets_total = 0
    for it in items:
        if req_keys and it.get("item_key") not in req_keys:
            continue
        if skip_processed and (it.get("sync_status") == "synced" or it.get("processed") is True):
            continue
        targets_total += 1

    try:
        import sys
        sys.stderr.write(f"[FEISHU] 开始同步：{targets_total} 条\n")
        sys.stderr.flush()
    except Exception:
        pass

    cur = 0
    for item in items:
        if req_keys and item.get("item_key") not in req_keys:
            continue
        if skip_processed and (item.get("sync_status") == "synced" or item.get("processed") is True):
            stats["skipped"] += 1
            continue

        try:
            cur += 1
            ik = str(item.get("item_key") or "").strip()
            try:
                import sys
                sys.stderr.write(f"[FEISHU] ({cur}/{targets_total}) {ik} ...\n")
                sys.stderr.flush()
            except Exception:
                pass
            ftoken = None
            pdf_path = zotero.resolve_pdf_path(item, zotero_dir, base_dir=str(base_dir))
            if pdf_path and os.path.exists(pdf_path):
                ftoken = upload_file(client, pdf_path, fc["app_token"])

            fields = map_item(item, mapping, ftoken, fields_info)
            if not fields:
                stats["failed"] += 1
                try:
                    import sys
                    sys.stderr.write(f"[FEISHU] ✗ {ik} 没有可写字段，跳过\n")
                    sys.stderr.flush()
                except Exception:
                    pass
                continue

            record_id = item.get("record_id")
            if record_id:
                req = (
                    UpdateAppTableRecordRequest.builder()
                    .app_token(fc["app_token"])
                    .table_id(fc["table_id"])
                    .record_id(record_id)
                    .request_body(AppTableRecord.builder().fields(fields).build())
                    .build()
                )
                resp = client.bitable.v1.app_table_record.update(req)
            else:
                req = (
                    CreateAppTableRecordRequest.builder()
                    .app_token(fc["app_token"])
                    .table_id(fc["table_id"])
                    .request_body(AppTableRecord.builder().fields(fields).build())
                    .build()
                )
                resp = client.bitable.v1.app_table_record.create(req)

            if resp.success():
                item["sync_status"] = "synced"
                item["processed"] = True
                if not record_id and resp.data and resp.data.record:
                    item["record_id"] = resp.data.record.record_id
                stats["uploaded"] += 1
                try:
                    import sys
                    sys.stderr.write(f"[FEISHU] ✓ {ik} 已同步\n")
                    sys.stderr.flush()
                except Exception:
                    pass
            else:
                stats["failed"] += 1
                try:
                    import sys
                    sys.stderr.write(f"[FEISHU] ✗ {ik} 同步失败\n")
                    sys.stderr.flush()
                except Exception:
                    pass
        except Exception:
            stats["failed"] += 1
            try:
                import sys, traceback
                sys.stderr.write(f"[FEISHU] ✗ {str(item.get('item_key') or '').strip()} 异常：\n")
                traceback.print_exc(file=sys.stderr)
                sys.stderr.flush()
            except Exception:
                pass

    return stats, items


def delete_records(config_dict: dict, record_ids: List[str]) -> dict:
    """
    批量删除飞书多维表中的记录。
    
    Args:
        config_dict: 配置字典
        record_ids: 待删除的 record_id 列表
        
    Returns:
        stats: 删除结果统计 {"deleted": int, "failed": int, ...}
    """
    fc = get_feishu_config(config_dict)
    if not all(k in fc for k in ["app_id", "app_secret", "app_token", "table_id"]):
        raise ValueError("飞书配置不完整")

    client = create_client(fc["app_id"], fc["app_secret"])

    stats = {"deleted": 0, "skipped": 0, "failed": 0, "results": {}}
    for rid in record_ids:
        rid = str(rid or "").strip()
        if not rid:
            stats["skipped"] += 1
            continue
        try:
            req = (
                DeleteAppTableRecordRequest.builder()
                .app_token(fc["app_token"])
                .table_id(fc["table_id"])
                .record_id(rid)
                .build()
            )
            resp = client.bitable.v1.app_table_record.delete(req)
            if resp.success():
                stats["deleted"] += 1
                stats["results"][rid] = True
            else:
                stats["failed"] += 1
                stats["results"][rid] = False
        except Exception:
            stats["failed"] += 1
            stats["results"][rid] = False

    return stats


def upload_literature(
    literature_json: str,
    config_dict: dict,
    fields_json: str,
    keys: Optional[List[str]],
    skip_processed: bool = True,
) -> dict:
    """
    封装的文件级同步函数。
    
    读取 literature.json，执行 upload_items 同步逻辑，并将更新后的状态写回文件。
    
    Args:
        literature_json: literature.json 文件路径
        config_dict: 配置字典
        fields_json: fields.json 文件路径
        keys: 指定同步的 keys
        skip_processed: 是否跳过已同步条目
        
    Returns:
        stats: 同步统计
    """
    literature_path = Path(literature_json).resolve()
    base_dir = str(literature_path.parent)
    with open(literature_path, "r", encoding="utf-8") as f:
        items = json.load(f)
    stats, updated_items = upload_items(items, config_dict, fields_json, keys, skip_processed, base_dir=base_dir)
    with open(literature_path, "w", encoding="utf-8") as f:
        json.dump(updated_items, f, ensure_ascii=False, indent=2)
    return stats
