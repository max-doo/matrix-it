from __future__ import annotations

"""
Zotero 数据库访问层（只读）。

职责：
- 以只读方式打开 zotero.sqlite（避免 UI/导出过程误写数据库）。
- 提供集合列表、集合关联附件等查询能力。

注意：
- 本模块只负责 DB 读操作；导出逻辑在 app.core.export 中实现。
"""

import sqlite3
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Collection:
    """集合元信息（对应 Zotero 的 collections 表）。"""

    collection_id: int
    name: str
    parent_collection_id: int | None


@dataclass(frozen=True)
class Attachment:
    """附件元信息（用于定位 storage/ 或外部路径资源）。"""

    attachment_item_id: int
    parent_item_id: int | None
    attachment_key: str
    link_mode: int | None
    path: str | None
    content_type: str | None


class ZoteroDB:
    """zotero.sqlite 的只读访问封装。"""

    def __init__(self, zotero_db_path: Path) -> None:
        self.zotero_db_path = zotero_db_path
        self._conn = self._open_readonly(zotero_db_path)
        self._conn.row_factory = sqlite3.Row

    @staticmethod
    def _open_readonly(path: Path) -> sqlite3.Connection:
        """以 SQLite URI 方式只读打开数据库文件。"""
        uri = path.resolve().as_uri()
        if uri.startswith("file:/") and not uri.startswith("file:///"):
            uri = "file:///" + uri[len("file:/") :]
        ro_uri = f"{uri}?mode=ro"
        return sqlite3.connect(ro_uri, uri=True)

    def get_collections(self) -> list[Collection]:
        """读取所有集合（扁平列表，包含父集合 ID）。"""
        cur = self._conn.execute(
            """
            SELECT
              collectionID AS collection_id,
              collectionName AS name,
              parentCollectionID AS parent_collection_id
            FROM collections
            ORDER BY collectionName
            """
        )
        rows = cur.fetchall()
        collections: list[Collection] = []
        for r in rows:
            collections.append(
                Collection(
                    collection_id=int(r["collection_id"]),
                    name=str(r["name"]),
                    parent_collection_id=int(r["parent_collection_id"]) if r["parent_collection_id"] is not None else None,
                )
            )
        return collections

    def get_collection_attachments(self, collection_id: int) -> list[Attachment]:
        """读取指定集合的附件列表（仅返回附件条目，不解析具体文件路径）。"""
        cur = self._conn.execute(
            """
            SELECT
              ia.itemID AS attachment_item_id,
              ia.parentItemID AS parent_item_id,
              i.key AS attachment_key,
              ia.linkMode AS link_mode,
              ia.path AS path,
              ia.contentType AS content_type
            FROM collectionItems ci
            JOIN itemAttachments ia ON ia.parentItemID = ci.itemID
            JOIN items i ON i.itemID = ia.itemID
            WHERE ci.collectionID = ?
            ORDER BY ia.parentItemID, ia.itemID
            """,
            (int(collection_id),),
        )
        rows = cur.fetchall()
        attachments: list[Attachment] = []
        for r in rows:
            attachments.append(
                Attachment(
                    attachment_item_id=int(r["attachment_item_id"]),
                    parent_item_id=int(r["parent_item_id"]) if r["parent_item_id"] is not None else None,
                    attachment_key=str(r["attachment_key"]),
                    link_mode=int(r["link_mode"]) if r["link_mode"] is not None else None,
                    path=str(r["path"]) if r["path"] is not None else None,
                    content_type=str(r["content_type"]) if r["content_type"] is not None else None,
                )
            )
        return attachments

    def close(self) -> None:
        """关闭数据库连接（失败时忽略）。"""
        try:
            self._conn.close()
        except Exception:
            return None
