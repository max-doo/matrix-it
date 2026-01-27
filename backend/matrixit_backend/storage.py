"""
本地 SQLite 存储层。

职责：
- 在 literature.json 更新的同时，进行 SQLite 双写，便于后续查询与队列化扩展
- 数据以 JSON 形式存储在 items 表，主键为 item_key
"""

import json
import os
import sqlite3
from pathlib import Path
from typing import Dict, List, Optional


def get_db_path(base_dir: str) -> str:
    """
    获取或解析 SQLite 数据库绝对路径。
    
    优先从环境变量 MATRIXIT_DB 读取，否则默认使用项目根目录下的 data/matrixit.db。
    
    Args:
        base_dir: 项目根目录（用于解析相对路径）
    
    Returns:
        数据库文件的绝对路径
    """
    p = os.environ.get("MATRIXIT_DB", "")
    if p:
        pp = Path(p)
        return str(pp if pp.is_absolute() else (Path(base_dir) / pp).resolve())
    return str((Path(base_dir) / "matrixit.db").resolve())


def ensure_db(db_path: str) -> None:
    """
    初始化数据库表结构。
    
    若数据库文件不存在会自动创建。
    表结构：items(item_key PRIMARY KEY, json TEXT)
    
    Args:
        db_path: 数据库文件路径
    """
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS items (
              item_key TEXT PRIMARY KEY,
              json TEXT NOT NULL
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def count_items(db_path: str) -> int:
    """查询 items 表中的总记录数。"""
    ensure_db(db_path)
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(1) FROM items")
        row = cur.fetchone()
        return int(row[0] if row else 0)
    finally:
        conn.close()


def get_item(db_path: str, item_key: str, timeout_s: float = 5.0) -> Optional[dict]:
    """
    根据 item_key 获取单个条目内容。
    
    Returns:
        解析后的 JSON 字典或 None (未找到)
    """
    ensure_db(db_path)
    conn = sqlite3.connect(db_path, timeout=float(timeout_s))
    try:
        cur = conn.cursor()
        cur.execute("SELECT json FROM items WHERE item_key = ?", (str(item_key),))
        row = cur.fetchone()
        if not row:
            return None
        obj = json.loads(row[0])
        return obj if isinstance(obj, dict) else None
    finally:
        conn.close()


def get_items(db_path: str, keys: Optional[List[str]] = None, timeout_s: float = 5.0) -> List[dict]:
    """
    批量获取条目。
    
    Args:
        keys: 指定要查询的 key 列表；若为 None 则返回所有条目
        
    Returns:
        条目字典列表
    """
    ensure_db(db_path)
    conn = sqlite3.connect(db_path, timeout=float(timeout_s))
    try:
        cur = conn.cursor()
        if keys:
            qmarks = ",".join(["?"] * len(keys))
            cur.execute(f"SELECT json FROM items WHERE item_key IN ({qmarks})", tuple([str(k) for k in keys]))
        else:
            cur.execute("SELECT json FROM items")
        rows = cur.fetchall()
        out: List[dict] = []
        for (j,) in rows:
            try:
                obj = json.loads(j)
                if isinstance(obj, dict):
                    out.append(obj)
            except Exception:
                continue
        return out
    finally:
        conn.close()


def get_items_index(db_path: str) -> Dict[str, dict]:
    """获取所有条目并建立 {key: item} 索引。"""
    items = get_items(db_path)
    idx: Dict[str, dict] = {}
    for it in items:
        k = it.get("item_key")
        if k:
            idx[str(k)] = it
    return idx


def upsert_items(db_path: str, items: List[dict]) -> None:
    """
    批量插入或更新条目 (UPSERT)。
    
    Args:
        db_path: 数据库路径
        items: 条目列表 (必须包含 item_key)
    """
    if not items:
        return
    ensure_db(db_path)
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        for it in items:
            k = str(it.get("item_key") or "").strip()
            if not k:
                continue
            cur.execute(
                "INSERT INTO items(item_key, json) VALUES(?, ?) ON CONFLICT(item_key) DO UPDATE SET json=excluded.json",
                (k, json.dumps(it, ensure_ascii=False)),
            )
        conn.commit()
    finally:
        conn.close()


def upsert_item(db_path: str, item: dict) -> None:
    upsert_items(db_path, [item])


def import_json(db_path: str, json_path: str) -> int:
    """
    从 JSON 文件导入数据到 SQLite。
    
    Returns:
        int: 导入成功的条目数量
    """
    p = Path(json_path)
    if not p.exists():
        return 0
    try:
        items = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return 0
    if not isinstance(items, list):
        return 0
    upsert_items(db_path, [it for it in items if isinstance(it, dict)])
    return len(items)


def export_json(db_path: str, json_path: str, keys: Optional[List[str]] = None) -> int:
    """
    将 SQLite 中的数据导出为 JSON 文件。
    
    Args:
        keys: 仅导出指定 key 的条目；None 表示导出所有
    
    Returns:
        int: 导出的条目数量
    """
    items = get_items(db_path, keys=keys)
    p = Path(json_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(items)
