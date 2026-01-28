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
import shutil
import tempfile
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

import lark_oapi as lark
from lark_oapi.api.bitable.v1 import (
    AppTableField,
    AppTableRecord,
    BatchGetAppTableRecordRequest,
    BatchGetAppTableRecordRequestBody,
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

FEISHU_META_DEFAULT_ORDER = ["title", "author", "year", "type", "publications", "abstract", "tags", "collections", "url", "doi"]
FEISHU_META_FIXED_KEYS = {"title", "author", "year", "publications"}

LITERATURE_TYPE_LABELS_ZH: Dict[str, str] = {
    "journalArticle": "期刊文章",
    "thesis": "学位论文",
    "conferencePaper": "会议论文",
    "book": "图书",
    "bookSection": "图书章节",
    "report": "报告",
    "webpage": "网页",
    "preprint": "预印本",
    "patent": "专利",
    "blogPost": "博客",
    "videoRecording": "视频",
    "podcast": "播客",
    "presentation": "演示文稿",
    "statute": "法规",
    "newspaperArticle": "报纸文章",
}


def map_literature_type_to_zh(value: object) -> object:
    if not isinstance(value, str):
        return value
    key = value.strip()
    if not key:
        return value
    return LITERATURE_TYPE_LABELS_ZH.get(key) or value


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


def _copy_to_temp_with_stability(file_path: str) -> Tuple[Optional[tempfile.TemporaryDirectory], bool]:
    p = str(file_path or "").strip()
    if not p or not os.path.exists(p):
        return None, False

    def _stat_sig(path: str) -> Optional[Tuple[int, int]]:
        try:
            st = os.stat(path)
            return int(st.st_size), int(st.st_mtime_ns)
        except Exception:
            return None

    stable = False
    for _ in range(3):
        s1 = _stat_sig(p)
        time.sleep(0.2)
        s2 = _stat_sig(p)
        if s1 and s2 and s1 == s2 and s1[0] > 0:
            stable = True
            break
    td = tempfile.TemporaryDirectory(prefix="matrixit_feishu_upload_")
    dst = os.path.join(td.name, os.path.basename(p))
    shutil.copy2(p, dst)
    return td, stable


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
    file_path = str(file_path)
    td: Optional[tempfile.TemporaryDirectory] = None
    stable = False
    snapshot_path = file_path
    try:
        td, stable = _copy_to_temp_with_stability(file_path)
        if td:
            snapshot_path = os.path.join(td.name, os.path.basename(file_path))
            try:
                import sys

                if stable:
                    sys.stderr.write(f"[FEISHU] 使用临时快照上传: {file_path} -> {snapshot_path}\n")
                else:
                    sys.stderr.write(f"[FEISHU] ⚠ PDF 可能仍在写入，仍将使用临时快照上传: {file_path} -> {snapshot_path}\n")
                sys.stderr.flush()
            except Exception:
                pass

        with open(snapshot_path, "rb") as f:
            size = os.path.getsize(snapshot_path)
            req = UploadAllMediaRequest.builder().request_body(
                UploadAllMediaRequestBody.builder()
                .file_name(os.path.basename(file_path))
                .parent_type("bitable_file")
                .parent_node(parent_token)
                .size(size)
                .file((os.path.basename(file_path), f))
                .build()
            ).build()

            resp = client.drive.v1.media.upload_all(req)
        if resp.success() and resp.data:
            return resp.data.file_token
        try:
            import sys

            code = getattr(resp, "code", None)
            msg = getattr(resp, "msg", None)
            log_id = resp.get_log_id() if hasattr(resp, "get_log_id") else None
            sys.stderr.write(f"[FEISHU] 上传附件失败 code={code} msg={msg} log_id={log_id} size={size}\n")
            sys.stderr.flush()
        except Exception:
            pass
        return None
    finally:
        if td:
            try:
                td.cleanup()
            except Exception:
                pass


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
    code = getattr(resp, "code", None)
    msg = getattr(resp, "msg", None)
    log_id = resp.get_log_id() if hasattr(resp, "get_log_id") else None
    raise RuntimeError(f"create_field failed: name={name} type={ftype} code={code} msg={msg} log_id={log_id}")


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
    ordered_json_keys: Optional[List[str]] = None,
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

    iter_keys: List[str] = [str(k) for k in ordered_json_keys] if isinstance(ordered_json_keys, list) else list(mapping.keys())
    for json_key in iter_keys:
        fs_name = mapping.get(json_key)
        if not fs_name:
            continue
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

        try:
            new_id = create_field(client, app_token, table_id, fs_name, expected_type)
        except Exception as e:
            if int(expected_type) == int(FIELD_TYPE_ATTACHMENT):
                try:
                    import sys
                    sys.stderr.write(f"[FEISHU] ⚠ 附件字段无法自动创建，将跳过附件同步：{e}\n")
                    sys.stderr.flush()
                except Exception:
                    pass
                mapping.pop(str(json_key), None)
                next_schema.pop(str(json_key), None)
                continue
            raise
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
    def _get_by_path(obj: object, path: str) -> object:
        cur: object = obj
        for part in str(path).split("."):
            if not isinstance(cur, dict):
                return None
            cur = cur.get(part)
        return cur

    fields: Dict[str, object] = {}
    for jk, fk in mapping.items():
        if jk == "attachment":
            if file_token:
                fields[fk] = [{"file_token": file_token}]
            continue

        val: object = None
        if "." in jk:
            val = _get_by_path(item, jk)
        elif jk in item:
            val = item.get(jk)
        elif jk == "tags":
            meta = item.get("meta_extra") if isinstance(item.get("meta_extra"), dict) else {}
            val = meta.get("tags") if isinstance(meta, dict) else None
        else:
            continue

        if jk == "collections" and isinstance(val, list):
            val = [c.get("name") for c in val if isinstance(c, dict) and c.get("name")]

        if val is None or val == "":
            continue

        if jk == "type":
            val = map_literature_type_to_zh(val)

        ftype = fields_info.get(fk, {}).get("type", 0)
        if ftype == FIELD_TYPE_MULTI_SELECT:
            if isinstance(val, str):
                val = [p.strip() for p in re.split(r"[,，]", val) if p.strip()]
            elif not isinstance(val, list):
                val = [val]
            val = [str(x).strip() for x in (val or []) if str(x).strip()]
        elif jk == "year" and isinstance(val, str):
            try:
                val = int(val) if val else None
            except Exception:
                val = None
        elif ftype == FIELD_TYPE_TEXT:
            if isinstance(val, (list, tuple, set)):
                val = ", ".join([str(x).strip() for x in val if str(x).strip()])
            elif isinstance(val, dict):
                val = json.dumps(val, ensure_ascii=False)
            elif not isinstance(val, str):
                val = str(val)

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
    options: Optional[dict] = None,
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
    base_sig = f"{str(fc.get('app_token') or '').strip()}:{str(fc.get('table_id') or '').strip()}"

    req_keys = [str(k).strip() for k in (keys or []) if str(k).strip()]
    if not isinstance(base_dir, str):
        base_dir = str(base_dir)
    if config_path is not None and not isinstance(config_path, str):
        config_path = str(config_path)

    opt: dict = options if isinstance(options, dict) else {}

    def _opt_bool(*names: str) -> bool:
        for n in names:
            v = opt.get(n)
            if isinstance(v, bool):
                return v
            if isinstance(v, (int, float)):
                return bool(v)
            if isinstance(v, str):
                s = v.strip().lower()
                if s in ("1", "true", "yes", "y", "on"):
                    return True
                if s in ("0", "false", "no", "n", "off"):
                    return False
        return False

    resync_synced = _opt_bool("resync_synced", "resyncSynced")
    skip_attachment_upload = _opt_bool("skip_attachment_upload", "skipAttachmentUpload")

    fields_def: dict = {}
    if isinstance(fields_json, dict):
        fields_def = fields_json
    else:
        if not isinstance(fields_json, (str, os.PathLike, Path)):
            raise TypeError(f"fields_json must be a path string or dict, got {type(fields_json).__name__}")
        fields_path = Path(fields_json)
        if not fields_path.is_absolute():
            fields_path = (Path(base_dir) / fields_path).resolve()
        with open(fields_path, "r", encoding="utf-8") as f:
            fields_def = json.load(f)

    def _unique_keep_order(seq: List[str]) -> List[str]:
        seen = set()
        out: List[str] = []
        for x in seq:
            s = str(x or "").strip()
            if not s or s in seen:
                continue
            seen.add(s)
            out.append(s)
        return out

    meta_sync_raw = fc.get("meta_sync")
    if not isinstance(meta_sync_raw, list):
        meta_sync_raw = fc.get("metaSync") if isinstance(fc.get("metaSync"), list) else None
    enabled_meta: set = set()
    if isinstance(meta_sync_raw, list):
        enabled_meta = set([str(x).strip() for x in meta_sync_raw if str(x).strip()])
    else:
        enabled_meta = set([k for k in FEISHU_META_DEFAULT_ORDER if k != "doi"])

    def _should_sync_meta_key(k: str) -> bool:
        if k in FEISHU_META_FIXED_KEYS:
            return True
        return k in enabled_meta

    ui_cfg = config_dict.get("ui", {}) if isinstance(config_dict.get("ui", {}), dict) else {}
    tc = ui_cfg.get("table_columns", {}) if isinstance(ui_cfg.get("table_columns", {}), dict) else {}
    matrix = tc.get("matrix", {}) if isinstance(tc.get("matrix", {}), dict) else {}
    analysis_ui = matrix.get("analysis", {}) if isinstance(matrix.get("analysis", {}), dict) else {}
    analysis_order_raw = analysis_ui.get("order")
    analysis_order = _unique_keep_order(analysis_order_raw if isinstance(analysis_order_raw, list) else [])

    mapping: Dict[str, str] = {}
    used_names: Dict[str, str] = {}

    def _add_mapping(section: str, key: str, v: dict) -> None:
        name = str(v.get("name") or "").strip()
        if not name:
            raise ValueError(f"字段缺少 name: {section}.{key}")
        if name in used_names and used_names[name] != str(key):
            raise ValueError(f"字段 name 重复: {name} ({used_names[name]} / {key})")
        used_names[name] = str(key)
        mapping[str(key)] = name

    meta_defs = fields_def.get("meta_fields", {}) if isinstance(fields_def.get("meta_fields", {}), dict) else {}
    analysis_defs = fields_def.get("analysis_fields", {}) if isinstance(fields_def.get("analysis_fields", {}), dict) else {}
    attachment_defs = fields_def.get("attachment_fields", {}) if isinstance(fields_def.get("attachment_fields", {}), dict) else {}
    attachment_sync_raw = fc.get("attachment_sync")
    if attachment_sync_raw is None:
        attachment_sync_raw = fc.get("attachmentSync")
    attachment_enabled = True
    if isinstance(attachment_sync_raw, bool):
        attachment_enabled = attachment_sync_raw
    elif isinstance(attachment_sync_raw, (int, float)):
        attachment_enabled = bool(attachment_sync_raw)
    elif isinstance(attachment_sync_raw, str):
        s = attachment_sync_raw.strip().lower()
        if s in ("0", "false", "no", "n", "off"):
            attachment_enabled = False

    meta_keys_ordered = _unique_keep_order(FEISHU_META_DEFAULT_ORDER + list(meta_defs.keys()))
    for k in meta_keys_ordered:
        if k not in meta_defs:
            continue
        if not _should_sync_meta_key(k):
            continue
        v = meta_defs.get(k)
        if isinstance(v, dict):
            _add_mapping("meta_fields", k, v)

    analysis_keys_ordered = _unique_keep_order(analysis_order + list(analysis_defs.keys()))
    for k in analysis_keys_ordered:
        if k not in analysis_defs:
            continue
        v = analysis_defs.get(k)
        if isinstance(v, dict):
            _add_mapping("analysis_fields", k, v)

    if attachment_enabled:
        for k, v in attachment_defs.items():
            if isinstance(k, str) and isinstance(v, dict):
                _add_mapping("attachment_fields", k, v)

    ordered_json_keys: List[str] = []
    seen_keys = set()
    for k in meta_keys_ordered:
        if k in mapping and k not in seen_keys:
            ordered_json_keys.append(k)
            seen_keys.add(k)
    for k in analysis_keys_ordered:
        if k in mapping and k not in seen_keys:
            ordered_json_keys.append(k)
            seen_keys.add(k)
    if attachment_enabled:
        for k in attachment_defs.keys():
            ks = str(k or "").strip()
            if ks in mapping and ks not in seen_keys:
                ordered_json_keys.append(ks)
                seen_keys.add(ks)

    schema_fields = {}
    fc_schema = fc.get("schema", {}) if isinstance(fc.get("schema", {}), dict) else {}
    cached_base_sig = str(fc_schema.get("base_sig") or "").strip()
    if cached_base_sig and cached_base_sig != base_sig:
        fc_schema = {}
    if isinstance(fc_schema.get("fields"), dict):
        schema_fields = fc_schema.get("fields", {})

    client = create_client(fc["app_id"], fc["app_secret"])
    next_schema = ensure_fields(client, fc["app_token"], fc["table_id"], fields_def, mapping, schema_fields=schema_fields, ordered_json_keys=ordered_json_keys)
    if config_path and isinstance(next_schema, dict):
        try:
            save_local_config_patch(str(config_path), {"feishu": {"schema": {"base_sig": base_sig, "fields": next_schema}}})
        except Exception as e:
            try:
                import sys
                sys.stderr.write(f"[FEISHU] ⚠ 写入 schema 缓存失败：{e}\n")
                sys.stderr.flush()
            except Exception:
                pass
    fields_info = get_existing_fields(client, fc["app_token"], fc["table_id"])
    if "attachment" not in mapping:
        candidates = [name for name, info in fields_info.items() if int(info.get("type", 0) or 0) == FIELD_TYPE_ATTACHMENT]
        chosen: Optional[str] = None
        if len(candidates) == 1:
            chosen = candidates[0]
        elif len(candidates) > 1:
            preferred = ["附件", "PDF", "pdf", "PDF附件", "附件(PDF)"]
            for p in preferred:
                for name in candidates:
                    if p in name:
                        chosen = name
                        break
                if chosen:
                    break
            if not chosen:
                chosen = sorted(candidates)[0]
        else:
            try:
                new_id = create_field(client, fc["app_token"], fc["table_id"], "附件", FIELD_TYPE_ATTACHMENT)
                if new_id:
                    fields_info = get_existing_fields(client, fc["app_token"], fc["table_id"])
                    chosen = "附件" if "附件" in fields_info else None
            except Exception:
                chosen = None

        if chosen:
            mapping["attachment"] = chosen
            try:
                import sys
                sys.stderr.write(f"[FEISHU] 附件字段自动映射：attachment -> {chosen}\n")
                sys.stderr.flush()
            except Exception:
                pass

    zotero_dir = zotero.get_zotero_dir(config_dict)

    stats = {"uploaded": 0, "skipped": 0, "failed": 0, "pdf_uploaded": 0, "pdf_skipped": 0, "pdf_failed": 0, "pdf_missing": 0}

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
            is_resync_item = bool(resync_synced and item.get("sync_status") == "synced")
            ftoken = None
            used_cached_token = False
            pending_file_token: Optional[str] = None
            pending_pdf_mtime: Optional[int] = None
            if "attachment" in mapping:
                pdf_path = zotero.resolve_pdf_path(item, zotero_dir, base_dir=str(base_dir))
                if pdf_path and os.path.exists(pdf_path):
                    mtime = None
                    try:
                        mtime = int(os.path.getmtime(pdf_path))
                    except Exception:
                        mtime = None
                    cached_token = item.get("feishu_file_token")
                    cached_mtime = item.get("pdf_mtime")
                    if cached_token and mtime is not None and int(cached_mtime or -1) == mtime:
                        ftoken = str(cached_token)
                        stats["pdf_skipped"] += 1
                        used_cached_token = True
                    elif is_resync_item and skip_attachment_upload:
                        stats["pdf_skipped"] += 1
                    else:
                        try:
                            ftoken = upload_file(client, pdf_path, fc["app_token"])
                        except Exception as e:
                            ftoken = None
                            try:
                                import sys
                                sys.stderr.write(f"[FEISHU] ⚠ {ik} 附件上传异常（将继续同步其他字段）：{e}\n")
                                sys.stderr.flush()
                            except Exception:
                                pass
                        if ftoken:
                            pending_file_token = ftoken
                            if mtime is not None:
                                pending_pdf_mtime = mtime
                            stats["pdf_uploaded"] += 1
                        else:
                            stats["pdf_failed"] += 1
                else:
                    stats["pdf_missing"] += 1
                    try:
                        import sys
                        sys.stderr.write(f"[FEISHU] ⚠ {ik} 未找到 PDF（无法上传附件）\n")
                        sys.stderr.flush()
                    except Exception:
                        pass

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
            op = "update" if record_id else "create"
            if record_id:
                fields_for_update: Dict[str, object] = fields
                if is_resync_item and skip_attachment_upload and "attachment" in mapping:
                    attachment_field_name = str(mapping.get("attachment") or "").strip()
                    if attachment_field_name:
                        fields_for_update = dict(fields)
                        fields_for_update.pop(attachment_field_name, None)
                req = (
                    UpdateAppTableRecordRequest.builder()
                    .app_token(fc["app_token"])
                    .table_id(fc["table_id"])
                    .record_id(record_id)
                    .request_body(AppTableRecord.builder().fields(fields_for_update).build())
                    .build()
                )
                resp = client.bitable.v1.app_table_record.update(req)
                code = getattr(resp, "code", None)
                msg = getattr(resp, "msg", None)
                if not resp.success() and (code in (2001254043, 1254043) or str(msg or "") == "RecordIdNotFound"):
                    item.pop("record_id", None)
                    item["sync_status"] = "unsynced"
                    record_id = None
                    op = "create(rebuild)"
                    req = (
                        CreateAppTableRecordRequest.builder()
                        .app_token(fc["app_token"])
                        .table_id(fc["table_id"])
                        .request_body(AppTableRecord.builder().fields(fields).build())
                        .build()
                    )
                    resp = client.bitable.v1.app_table_record.create(req)
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
                item["feishu_app_token"] = str(fc.get("app_token") or "").strip() or None
                item["feishu_table_id"] = str(fc.get("table_id") or "").strip() or None
                item["feishu_base_sig"] = base_sig
                if not record_id and resp.data and resp.data.record:
                    item["record_id"] = resp.data.record.record_id
                if pending_file_token:
                    item["feishu_file_token"] = pending_file_token
                    if pending_pdf_mtime is not None:
                        item["pdf_mtime"] = pending_pdf_mtime
                stats["uploaded"] += 1
                try:
                    import sys
                    sys.stderr.write(f"[FEISHU] ✓ {ik} 已同步\n")
                    sys.stderr.flush()
                except Exception:
                    pass
            else:
                stats["failed"] += 1
                if used_cached_token:
                    item.pop("feishu_file_token", None)
                    item.pop("pdf_mtime", None)
                try:
                    import sys
                    code = getattr(resp, "code", None)
                    msg = getattr(resp, "msg", None)
                    log_id = resp.get_log_id() if hasattr(resp, "get_log_id") else None
                    extra = ""
                    if "attachment" in mapping:
                        extra = f" attachment={'1' if ftoken else '0'} cached={'1' if used_cached_token else '0'}"
                    sys.stderr.write(f"[FEISHU] ✗ {ik} 同步失败 op={op} code={code} msg={msg} log_id={log_id}{extra}\n")
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


def batch_get_records(config_dict: dict, record_ids: List[str]) -> dict:
    fc = get_feishu_config(config_dict)
    if not all(k in fc for k in ["app_id", "app_secret", "app_token", "table_id"]):
        raise ValueError("飞书配置不完整")
    ids = [str(rid or "").strip() for rid in (record_ids or []) if str(rid or "").strip()]
    if not ids:
        return {"present": [], "absent": [], "forbidden": []}

    client = create_client(fc["app_id"], fc["app_secret"])
    present: List[str] = []
    absent: List[str] = []
    forbidden: List[str] = []

    chunk_size = 200
    for i in range(0, len(ids), chunk_size):
        chunk = ids[i : i + chunk_size]
        req = (
            BatchGetAppTableRecordRequest.builder()
            .app_token(fc["app_token"])
            .table_id(fc["table_id"])
            .request_body(BatchGetAppTableRecordRequestBody.builder().record_ids(chunk).build())
            .build()
        )
        resp = client.bitable.v1.app_table_record.batch_get(req)
        if not resp.success():
            code = getattr(resp, "code", None)
            msg = getattr(resp, "msg", None)
            if str(msg or "") == "RolePermNotAllow" or int(code or 0) in (1254302, 2001254302):
                raise RuntimeError(
                    f"batch_get failed: code={code} msg={msg}（新多维表格未授予应用权限：请在飞书中将应用添加为协作者/授予编辑权限，或检查高级权限角色）"
                )
            raise RuntimeError(f"batch_get failed: code={code} msg={msg}")
        data = getattr(resp, "data", None)
        if data and getattr(data, "records", None):
            for r in data.records:
                rid = getattr(r, "record_id", None)
                if isinstance(rid, str) and rid.strip():
                    present.append(rid.strip())
        if data and getattr(data, "absent_record_ids", None):
            absent.extend([str(x).strip() for x in data.absent_record_ids if str(x).strip()])
        if data and getattr(data, "forbidden_record_ids", None):
            forbidden.extend([str(x).strip() for x in data.forbidden_record_ids if str(x).strip()])

    return {"present": present, "absent": absent, "forbidden": forbidden}


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
