"""
Zotero 数据读取与 PDF 定位。

核心点：
- Zotero 运行时会锁定 zotero.sqlite；读取时先复制到临时文件并以只读模式打开
- 将条目、作者、收藏夹与 PDF 附件信息合并为前端可用的结构
- 优先直接从 Zotero storage 定位并读取 PDF（不导出、不复制）
- extract_attachments 属于可选的历史能力（如需导出到项目目录）
"""

import json
import os
import shutil
import sqlite3
import tempfile
import urllib.request
import gzip
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional


def get_default_zotero_dir() -> str:
    """默认 Zotero 数据目录（Windows：%USERPROFILE%\\Zotero）。"""
    return os.path.join(os.environ.get("USERPROFILE", ""), "Zotero")


def get_zotero_dir(config: dict) -> str:
    """从配置读取 Zotero data_dir，未配置则使用默认目录。"""
    zotero_dir = config.get("zotero", {}).get("data_dir", "")
    if zotero_dir:
        return zotero_dir
    return get_default_zotero_dir()


def read_collections(conn: sqlite3.Connection) -> Dict[int, dict]:
    """
    从 Zotero 数据库读取 collections 表。
    
    Args:
        conn: SQLite 连接对象
        
    Returns:
        Dict[collectionID, {name, parent_id, key}]
    """
    cursor = conn.cursor()
    cursor.execute("SELECT collectionID, collectionName, parentCollectionID, key FROM collections")
    collections: Dict[int, dict] = {}
    for row in cursor.fetchall():
        collections[row[0]] = {"name": row[1], "parent_id": row[2], "key": row[3]}
    return collections


def get_collection_path(collections: Dict[int, dict], collection_id: Optional[int]) -> str:
    """
    递归构建收藏夹的全路径名称。
    
    例如: "父收藏夹/子收藏夹/孙收藏夹"
    
    Args:
        collections: 收藏夹映射表
        collection_id: 当前收藏夹 ID
        
    Returns:
        路径字符串 (使用 / 分隔)
    """
    if collection_id is None:
        return ""
    path_parts: List[str] = []
    current_id = collection_id
    visited = set()
    while current_id and current_id not in visited:
        visited.add(current_id)
        if current_id in collections:
            path_parts.insert(0, collections[current_id]["name"])
            current_id = collections[current_id]["parent_id"]
        else:
            break
    return "/".join(path_parts)


def read_items(conn: sqlite3.Connection, collections: Dict[int, dict]) -> List[dict]:
    """
    读取并组装 Zotero 条目数据。
    
    查询逻辑：
    1. 筛选非 attachment/note 类型的顶层条目。
    2. 批量查询关联的 Tags。
    3. 逐条查询元数据字段 (itemData)。
    4. 关联作者 (Creators)、所属收藏夹 (Collections) 和附件 (Attachments)。
    5. 组装为前端所需的扁平化结构。
    
    Args:
        conn: 数据库连接
        collections: 收藏夹映射表 (用于解析条目的所属收藏夹路径)
        
    Returns:
        完整的条目列表
    """
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT i.itemID, i.key, it.typeName, i.dateModified
        FROM items i
        JOIN itemTypes it ON i.itemTypeID = it.itemTypeID
        WHERE it.typeName NOT IN ('attachment', 'note')
        AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
        """
    )
    items_data = cursor.fetchall()

    items: List[dict] = []
    item_ids: List[int] = [int(r[0]) for r in items_data if r and r[0] is not None]

    tags_by_item_id: Dict[int, List[str]] = {}
    if item_ids:
        for i in range(0, len(item_ids), 800):
            chunk = item_ids[i : i + 800]
            qmarks = ",".join(["?"] * len(chunk))
            try:
                cursor.execute(
                    f"""
                    SELECT it.itemID, t.name
                    FROM itemTags it
                    JOIN tags t ON it.tagID = t.tagID
                    WHERE it.itemID IN ({qmarks})
                    """,
                    tuple(chunk),
                )
                for item_id, tag_name in cursor.fetchall():
                    if item_id is None:
                        continue
                    name = str(tag_name or "").strip()
                    if not name:
                        continue
                    tags_by_item_id.setdefault(int(item_id), []).append(name)
            except Exception:
                continue

    for item_row in items_data:
        item_id, item_key, item_type, date_modified = item_row

        cursor.execute(
            """
            SELECT f.fieldName, idv.value
            FROM itemData id
            JOIN itemDataValues idv ON id.valueID = idv.valueID
            JOIN fields f ON id.fieldID = f.fieldID
            WHERE id.itemID = ?
            """,
            (item_id,),
        )
        metadata = {row[0]: row[1] for row in cursor.fetchall()}

        cursor.execute(
            """
            SELECT c.firstName, c.lastName, ict.creatorType
            FROM itemCreators ic
            JOIN creators c ON ic.creatorID = c.creatorID
            JOIN creatorTypes ict ON ic.creatorTypeID = ict.creatorTypeID
            WHERE ic.itemID = ?
            ORDER BY ic.orderIndex
            """,
            (item_id,),
        )
        creators_rows = cursor.fetchall()
        creators = []
        creators_struct = []
        for first, last, ctype in creators_rows:
            name = f"{last}{first}" if first and last else (last or first or "")
            creators.append({"name": name, "type": ctype})
            full = f"{last}{first}" if first and last else (last or first or "")
            row: dict = {"creatorType": str(ctype or "").strip()}
            if full:
                row["name"] = full
            if first:
                row["firstName"] = first
            if last:
                row["lastName"] = last
            creators_struct.append(row)

        cursor.execute("SELECT collectionID FROM collectionItems WHERE itemID = ?", (item_id,))
        item_collections = []
        for (coll_id,) in cursor.fetchall():
            if coll_id in collections:
                item_collections.append(
                    {
                        "id": coll_id,
                        "name": collections[coll_id]["name"],
                        "path": get_collection_path(collections, coll_id),
                    }
                )

        cursor.execute(
            """
            SELECT ia.path, ia.itemID, i.key
            FROM itemAttachments ia
            JOIN items i ON ia.itemID = i.itemID
            WHERE ia.parentItemID = ?
            AND ia.contentType = 'application/pdf'
            """,
            (item_id,),
        )
        attachments = []
        for att_path, _att_id, att_key in cursor.fetchall():
            if att_path:
                if att_path.startswith("storage:"):
                    att_path = att_path[8:]
                attachments.append({"key": att_key, "filename": att_path})

        meta_extra = {
            "date": metadata.get("date", ""),
            "volume": metadata.get("volume", ""),
            "issue": metadata.get("issue", ""),
            "pages": metadata.get("pages", ""),
            "publisher": metadata.get("publisher", ""),
            "place": metadata.get("place", ""),
            "publicationTitle": metadata.get("publicationTitle", ""),
            "bookTitle": metadata.get("bookTitle", ""),
            "proceedingsTitle": metadata.get("proceedingsTitle", ""),
            "conferenceName": metadata.get("conferenceName", ""),
            "websiteTitle": metadata.get("websiteTitle", ""),
            "accessDate": metadata.get("accessDate", ""),
            "edition": metadata.get("edition", ""),
            "ISBN": metadata.get("ISBN", ""),
            "ISSN": metadata.get("ISSN", ""),
            "journalAbbreviation": metadata.get("journalAbbreviation", ""),
            "language": metadata.get("language", ""),
            "rights": metadata.get("rights", ""),
            "extra": metadata.get("extra", ""),
            "citationKey": metadata.get("citationKey", ""),
            "shortTitle": metadata.get("shortTitle", ""),
            "creators": creators_struct,
            "tags": tags_by_item_id.get(int(item_id), []),
        }

        items.append(
            {
                "item_key": item_key,
                "item_type": item_type,
                "date_modified": date_modified,
                "title": metadata.get("title", ""),
                "author": ", ".join([c["name"] for c in creators if c["type"] == "author"]),
                "year": metadata.get("date", "")[:4] if metadata.get("date") else "",
                "type": item_type,
                "publications": metadata.get("publicationTitle", "")
                or metadata.get("proceedingsTitle", "")
                or metadata.get("bookTitle", ""),
                "citation": "",
                "abstract": metadata.get("abstractNote", ""),
                "doi": metadata.get("DOI", ""),
                "url": metadata.get("url", ""),
                "collections": item_collections,
                "attachments": attachments,
                "meta_extra": meta_extra,
                "pdf_path": "",
                "processed": False,
            }
        )
    return items


def read_zotero_database_safe(zotero_dir: str) -> List[dict]:
    """
    安全读取 Zotero 数据库。
    
    原理：
    Zotero 运行时会锁定 zotero.sqlite。为避免读取失败，
    本函数先将数据库文件复制到临时目录，并以只读 URI 模式打开连接。
    读取完成后自动清理临时文件。
    
    Args:
        zotero_dir: Zotero 数据目录路径
        
    Returns:
        解析后的条目列表
    """
    db_path = os.path.join(zotero_dir, "zotero.sqlite")
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"Zotero数据库不存在: {db_path}")

    with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as tmp_db:
        tmp_db_path = tmp_db.name

    try:
        shutil.copy2(db_path, tmp_db_path)
        uri_path = Path(tmp_db_path).as_uri()
        conn = sqlite3.connect(f"{uri_path}?mode=ro", uri=True)
        try:
            collections = read_collections(conn)
            items = read_items(conn, collections)
            return items
        finally:
            conn.close()
    finally:
        if os.path.exists(tmp_db_path):
            try:
                os.remove(tmp_db_path)
            except Exception:
                pass


def _read_zotero_schema_from_sqlite(zotero_dir: str) -> dict:
    """
    [内部函数] 从本地 SQLite 读取 Schema 信息 (字段定义、类型定义等)。
    用于生成 fields.json 的辅助信息。
    """
    db_path = os.path.join(zotero_dir, "zotero.sqlite")
    if not os.path.exists(db_path):
        raise FileNotFoundError(f"Zotero数据库不存在: {db_path}")

    with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as tmp_db:
        tmp_db_path = tmp_db.name

    try:
        shutil.copy2(db_path, tmp_db_path)
        uri_path = Path(tmp_db_path).as_uri()
        conn = sqlite3.connect(f"{uri_path}?mode=ro", uri=True)
        try:
            cur = conn.cursor()
            cur.execute("SELECT itemTypeID, typeName FROM itemTypes")
            item_types = [{"itemTypeID": int(r[0]), "itemType": str(r[1])} for r in cur.fetchall()]

            cur.execute("SELECT fieldID, fieldName FROM fields")
            fields = [{"fieldID": int(r[0]), "field": str(r[1])} for r in cur.fetchall()]

            item_type_fields: List[dict] = []
            try:
                cur.execute("SELECT itemTypeID, fieldID FROM itemTypeFields")
                item_type_fields = [{"itemTypeID": int(r[0]), "fieldID": int(r[1])} for r in cur.fetchall()]
            except Exception:
                item_type_fields = []

            creator_types: List[dict] = []
            try:
                cur.execute("SELECT creatorTypeID, creatorType FROM creatorTypes")
                creator_types = [{"creatorTypeID": int(r[0]), "creatorType": str(r[1])} for r in cur.fetchall()]
            except Exception:
                creator_types = []

            item_type_creator_types: List[dict] = []
            try:
                cur.execute("SELECT itemTypeID, creatorTypeID FROM itemTypeCreatorTypes")
                item_type_creator_types = [{"itemTypeID": int(r[0]), "creatorTypeID": int(r[1])} for r in cur.fetchall()]
            except Exception:
                item_type_creator_types = []
        finally:
            conn.close()
    finally:
        if os.path.exists(tmp_db_path):
            try:
                os.remove(tmp_db_path)
            except Exception:
                pass

    field_by_id = {f["fieldID"]: f["field"] for f in fields}
    item_type_by_id = {t["itemTypeID"]: t["itemType"] for t in item_types}
    creator_by_id = {c["creatorTypeID"]: c["creatorType"] for c in creator_types}

    item_type_to_fields: Dict[str, List[str]] = {}
    for itf in item_type_fields:
        it = item_type_by_id.get(itf["itemTypeID"])
        f = field_by_id.get(itf["fieldID"])
        if not it or not f:
            continue
        item_type_to_fields.setdefault(it, []).append(f)

    item_type_to_creators: Dict[str, List[str]] = {}
    for itc in item_type_creator_types:
        it = item_type_by_id.get(itc["itemTypeID"])
        c = creator_by_id.get(itc["creatorTypeID"])
        if not it or not c:
            continue
        item_type_to_creators.setdefault(it, []).append(c)

    all_fields = sorted({f["field"] for f in fields})
    all_creator_types = sorted({c["creatorType"] for c in creator_types})

    for it, fs in item_type_to_fields.items():
        item_type_to_fields[it] = sorted(set(fs))
    for it, cs in item_type_to_creators.items():
        item_type_to_creators[it] = sorted(set(cs))

    return {
        "source": "zotero.sqlite",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "fields": all_fields,
        "creatorTypes": all_creator_types,
        "itemTypes": {
            it: {
                "fields": item_type_to_fields.get(it, []),
                "creatorTypes": item_type_to_creators.get(it, []),
            }
            for it in sorted({t["itemType"] for t in item_types})
        },
    }


def _fetch_zotero_schema_from_api(url: str = "https://api.zotero.org/schema", timeout_s: int = 30) -> dict:
    req = urllib.request.Request(url, headers={"Accept-Encoding": "gzip", "User-Agent": "matrix-it"})
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        raw = resp.read()
        enc = (resp.headers.get("Content-Encoding") or "").lower()
        if enc == "gzip":
            raw = gzip.decompress(raw)
        return json.loads(raw.decode("utf-8"))


def build_zotero_metadata_schema(config: dict, prefer_local_sqlite: bool = True) -> dict:
    """
    构建 Zotero 元数据 Schema。
    
    优先尝试从本地数据库读取，失败则回退到 Zotero Web API 抓取。
    此 Schema 用于前端展示字段选择器或后端校验。
    """
    zotero_dir = get_zotero_dir(config)
    if prefer_local_sqlite:
        try:
            return _read_zotero_schema_from_sqlite(zotero_dir)
        except Exception:
            pass

    schema = _fetch_zotero_schema_from_api()
    item_types_raw = schema.get("itemTypes", [])
    fields_raw = schema.get("fields", {})
    creator_types_raw = schema.get("creatorTypes", {})

    all_fields: List[str] = []
    if isinstance(fields_raw, dict):
        all_fields = sorted([str(k) for k in fields_raw.keys()])
    elif isinstance(fields_raw, list):
        for f in fields_raw:
            if isinstance(f, str):
                all_fields.append(f)
            elif isinstance(f, dict) and "field" in f:
                all_fields.append(str(f["field"]))
        all_fields = sorted(set(all_fields))

    all_creator_types: List[str] = []
    if isinstance(creator_types_raw, dict):
        all_creator_types = sorted([str(k) for k in creator_types_raw.keys()])
    elif isinstance(creator_types_raw, list):
        for c in creator_types_raw:
            if isinstance(c, str):
                all_creator_types.append(c)
            elif isinstance(c, dict) and "creatorType" in c:
                all_creator_types.append(str(c["creatorType"]))
        all_creator_types = sorted(set(all_creator_types))

    item_types: Dict[str, dict] = {}
    if isinstance(item_types_raw, list):
        for it in item_types_raw:
            if not isinstance(it, dict):
                continue
            it_name = it.get("itemType") or it.get("typeName")
            if not it_name:
                continue
            fs: List[str] = []
            for f in it.get("fields", []) or []:
                if isinstance(f, str):
                    fs.append(f)
                elif isinstance(f, dict):
                    if "field" in f:
                        fs.append(str(f["field"]))
                    elif "baseField" in f:
                        fs.append(str(f["baseField"]))
            cs: List[str] = []
            for c in it.get("creatorTypes", []) or []:
                if isinstance(c, str):
                    cs.append(c)
                elif isinstance(c, dict) and "creatorType" in c:
                    cs.append(str(c["creatorType"]))
            item_types[str(it_name)] = {"fields": sorted(set(fs)), "creatorTypes": sorted(set(cs))}
    elif isinstance(item_types_raw, dict):
        for it_name, it in item_types_raw.items():
            if not isinstance(it, dict):
                continue
            fs: List[str] = []
            for f in it.get("fields", []) or []:
                if isinstance(f, str):
                    fs.append(f)
                elif isinstance(f, dict) and "field" in f:
                    fs.append(str(f["field"]))
            cs: List[str] = []
            for c in it.get("creatorTypes", []) or []:
                if isinstance(c, str):
                    cs.append(c)
                elif isinstance(c, dict) and "creatorType" in c:
                    cs.append(str(c["creatorType"]))
            item_types[str(it_name)] = {"fields": sorted(set(fs)), "creatorTypes": sorted(set(cs))}

    return {
        "source": "https://api.zotero.org/schema",
        "schema_version": schema.get("version"),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "fields": all_fields,
        "creatorTypes": all_creator_types,
        "itemTypes": {k: item_types[k] for k in sorted(item_types.keys())},
    }


def _resolve_path_with_base(path_str: str, base_dir: Optional[str]) -> str:
    p = Path(path_str)
    if p.is_absolute():
        return str(p)
    if base_dir:
        return str((Path(base_dir) / p).resolve())
    return str(p.resolve())


def get_storage_pdf_path(item: dict, zotero_dir: str) -> Optional[str]:
    """
    推导 Zotero storage 目录下的 PDF 真实路径。
    
    Zotero 默认存储结构为: <DataDir>/storage/<ItemKey>/<Filename>
    
    Args:
        item: 条目对象
        zotero_dir: Zotero 数据目录
    
    Returns:
        文件的绝对路径，若文件不存在则返回 None
    """
    atts = item.get("attachments", [])
    if not isinstance(atts, list) or not atts:
        return None
    att0 = atts[0] if isinstance(atts[0], dict) else None
    if not att0:
        return None
    att_key = str(att0.get("key") or "").strip()
    att_filename = str(att0.get("filename") or "").strip()
    if not att_key or not att_filename:
        return None
    p = Path(zotero_dir) / "storage" / att_key / att_filename
    if p.exists():
        return str(p.resolve())
    return None


def resolve_pdf_path(item: dict, zotero_dir: str, base_dir: Optional[str] = None) -> Optional[str]:
    """
    解析并获取条目的最佳可用 PDF 路径。
    
    优先级：
    1. item["pdf_path"] (如果已被手动导出或修改，且文件存在)。
    2. Zotero Storage 默认路径。
    
    Args:
        item: 文献条目
        zotero_dir: Zotero 数据目录
        base_dir: 相对路径的基准目录
        
    Returns:
        PDF 绝对路径或 None
    """
    pdf_path = item.get("pdf_path") or ""
    if isinstance(pdf_path, str) and pdf_path.strip():
        resolved = _resolve_path_with_base(pdf_path.strip(), base_dir)
        if Path(resolved).exists():
            return str(Path(resolved).resolve())
    return get_storage_pdf_path(item, zotero_dir)


def sanitize_filename(name: str) -> str:
    """替换 Windows 不允许的文件名字符，避免导出时失败。"""
    illegal_chars = '<>:"/\\|?*'
    for char in illegal_chars:
        name = name.replace(char, "_")
    return name.strip()


def extract_attachments(
    literature_json_path: str,
    config: dict,
    item_keys: Optional[List[str]] = None,
    collection_path: Optional[str] = None,
    force: bool = False,
) -> int:
    """
    [可选功能] 导出 PDF 附件到项目目录。
    
    将 PDF 从 Zotero 封闭的 storage 目录复制到项目的 pdfs/ 文件夹下，
    并更新 literature.json 中的 pdf_path 字段。
    
    Args:
        literature_json_path: literature.json 路径
        config: 配置对象
        item_keys: 仅导出指定条目
        collection_path: 仅导出特定收藏夹下的条目
        force: 是否强制覆盖已存在的文件
        
    Returns:
        成功导出的文件数量
    """
    with open(literature_json_path, "r", encoding="utf-8") as f:
        items = json.load(f)

    zotero_dir = get_zotero_dir(config)
    storage_dir = os.path.join(zotero_dir, "storage")
    pdfs_dir = "pdfs"

    count = 0
    for item in items:
        if item_keys and item.get("item_key") not in item_keys:
            continue
        if collection_path:
            match = any(c.get("path", "").startswith(collection_path) for c in item.get("collections", []))
            if not match:
                continue

        if not force and item.get("pdf_path") and os.path.exists(item.get("pdf_path")):
            continue

        atts = item.get("attachments", [])
        if not atts:
            continue

        colls = item.get("collections", [])
        c_path = "未分类"
        if colls:
            c_path = "/".join([sanitize_filename(p) for p in colls[0].get("path", "").split("/")])

        target_dir = os.path.join(pdfs_dir, c_path)
        os.makedirs(target_dir, exist_ok=True)

        att = atts[0]
        src_path = os.path.join(storage_dir, att.get("key"), att.get("filename"))
        if not os.path.exists(src_path):
            continue

        title = item.get("title", "")
        fname = f"{sanitize_filename(title)}.pdf" if title else att.get("filename")
        if len(fname) > 100:
            fname = fname[:100] + ".pdf"

        dst_path = os.path.join(target_dir, fname)
        shutil.copy2(src_path, dst_path)

        # 写回相对路径并统一使用正斜杠，便于前端与跨平台处理。
        item["pdf_path"] = f"pdfs/{c_path}/{fname}".replace("\\", "/")
        count += 1

    with open(literature_json_path, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)

    return count
