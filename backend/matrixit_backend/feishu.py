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
    UpdateAppTableRecordRequest,
)
from lark_oapi.api.drive.v1 import UploadAllMediaRequest, UploadAllMediaRequestBody

from matrixit_backend import zotero

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


def ensure_fields(client: lark.Client, app_token: str, table_id: str, fields_def: dict, mapping: Dict[str, str]) -> None:
    """
    确保 feishu_field 映射中定义的字段在多维表中真实存在。
    
    如果字段不存在，则根据 `fields.json` 中的类型定义自动创建。
    
    Args:
        client: 飞书客户端
        app_token: 多维表 App Token
        table_id: 数据表 ID
        fields_def: `fields.json` 的完整内容
        mapping: 字段映射字典 {json_key: feishu_field_name}
    """
    flat_defs = {}
    for section in ["meta_fields", "analysis_fields", "attachment_fields"]:
        if section in fields_def:
            flat_defs.update(fields_def[section])

    existing = get_existing_fields(client, app_token, table_id)

    for json_key, fs_name in mapping.items():
        if fs_name in existing:
            continue
        if json_key not in flat_defs:
            continue
        ftype = TYPE_MAPPING.get(flat_defs[json_key].get("type", "string"), FIELD_TYPE_TEXT)
        new_id = create_field(client, app_token, table_id, fs_name, ftype)
        if new_id:
            existing[fs_name] = {"id": new_id, "type": ftype}


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
    fields_json: str,
    keys: Optional[List[str]],
    skip_processed: bool,
    base_dir: str,
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

    fields_path = Path(fields_json)
    if not fields_path.is_absolute():
        fields_path = (Path(base_dir) / fields_path).resolve()

    with open(fields_path, "r", encoding="utf-8") as f:
        fields_def = json.load(f)

    mapping: Dict[str, str] = {}
    for section in ["meta_fields", "analysis_fields", "attachment_fields"]:
        for k, v in fields_def.get(section, {}).items():
            if "feishu_field" in v:
                mapping[k] = v["feishu_field"]

    client = create_client(fc["app_id"], fc["app_secret"])
    ensure_fields(client, fc["app_token"], fc["table_id"], fields_def, mapping)
    fields_info = get_existing_fields(client, fc["app_token"], fc["table_id"])

    zotero_dir = zotero.get_zotero_dir(config_dict)

    stats = {"uploaded": 0, "skipped": 0, "failed": 0}

    for item in items:
        if keys and item.get("item_key") not in keys:
            continue
        if skip_processed and (item.get("sync_status") == "synced" or item.get("processed") is True):
            stats["skipped"] += 1
            continue

        try:
            ftoken = None
            pdf_path = zotero.resolve_pdf_path(item, zotero_dir, base_dir=str(base_dir))
            if pdf_path and os.path.exists(pdf_path):
                ftoken = upload_file(client, pdf_path, fc["app_token"])

            fields = map_item(item, mapping, ftoken, fields_info)
            if not fields:
                stats["failed"] += 1
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
            else:
                stats["failed"] += 1
        except Exception:
            stats["failed"] += 1

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
