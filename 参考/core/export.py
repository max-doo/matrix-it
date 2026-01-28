from __future__ import annotations

"""
附件导出逻辑（业务层）。

职责：
- 根据用户选择的集合 ID，构建导出目录结构并复制附件文件/目录到目标目录。
- 支持解析 Zotero 附件路径形式：storage:、attachments:、绝对路径，以及 storage/ 自动探测。
- 提供可注入的 log/progress/is_cancelled 回调，便于 UI 层在后台线程运行并回显状态。
"""

import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from app.core.db import ZoteroDB
from app.core.zotero_path import read_base_attachment_path


@dataclass(frozen=True)
class ExportRequest:
    """导出请求参数（由 UI 组装）。"""

    zotero_data_dir: Path
    target_dir: Path
    selected_collection_ids: list[int]
    export_html: bool = False


@dataclass(frozen=True)
class ExportResult:
    """导出结果（用于 UI 展示与统计）。"""

    exported_files: int
    exported_directories: int
    failures: list[str]
    cancelled: bool


def _sanitize_component(name: str) -> str:
    """清洗路径片段，避免 Windows 文件名非法字符导致创建失败。"""
    illegal = '<>:"/\\|?*'
    out = "".join("_" if c in illegal else c for c in name)
    out = out.rstrip(" .")
    return out or "_"


def _normalize_attachment_path(value: str) -> str:
    """将 Zotero 记录中的路径统一成使用 / 的形式，便于前缀判断。"""
    return value.replace("\\", "/")


def _resolve_attachment_source(
    zotero_data_dir: Path,
    attachment_key: str,
    attachment_path: str | None,
    base_attachment_path: Path | None,
) -> tuple[Path | None, bool, str | None]:
    """
    解析附件的源路径。

    返回值：
    - Path | None：源文件/目录路径；None 表示无法解析
    - bool：是否为目录导出（某些 storage 下为目录/多文件）
    - str | None：错误信息（仅 src 为 None 时有意义）
    """
    storage_dir = zotero_data_dir / "storage" / attachment_key
    if attachment_path:
        norm = _normalize_attachment_path(attachment_path)
        if norm.startswith("storage:"):
            filename = norm[len("storage:") :]
            candidate = storage_dir / filename
            return candidate, False, None
        if norm.startswith("attachments:"):
            if not base_attachment_path:
                return None, False, "未配置 baseAttachmentPath，无法解析 attachments: 路径"
            rel = norm[len("attachments:") :]
            return (base_attachment_path / rel), False, None

        p = Path(attachment_path)
        if p.is_absolute():
            return p, False, None

    if not storage_dir.exists():
        return None, False, "storage 目录不存在"

    files = [p for p in storage_dir.iterdir() if p.is_file()]
    if len(files) == 1:
        return files[0], False, None
    if len(files) == 0:
        return None, False, "storage 目录下没有文件"
    return storage_dir, True, None


def _copy_file(src: Path, dst_dir: Path) -> tuple[bool, str | None]:
    """复制单文件到目标目录（保留元信息）。"""
    try:
        dst_dir.mkdir(parents=True, exist_ok=True)
        dst = dst_dir / src.name
        shutil.copy2(src, dst)
        return True, None
    except Exception as e:
        return False, str(e)


def _copy_directory(src_dir: Path, dst_dir: Path) -> tuple[bool, str | None]:
    """复制目录到目标目录（如已存在则先删除）。"""
    try:
        if dst_dir.exists():
            shutil.rmtree(dst_dir)
        shutil.copytree(src_dir, dst_dir)
        return True, None
    except Exception as e:
        return False, str(e)


def _build_collection_maps(db: ZoteroDB) -> tuple[dict[int, str], dict[int, int | None]]:
    """读取集合映射：id->name 与 id->parent_id。"""
    collections = db.get_collections()
    names: dict[int, str] = {}
    parents: dict[int, int | None] = {}
    for c in collections:
        names[c.collection_id] = c.name
        parents[c.collection_id] = c.parent_collection_id
    return names, parents


def _collection_has_selected_ancestor(cid: int, selected: set[int], parents: dict[int, int | None]) -> bool:
    """判断集合 cid 是否存在被选中的祖先集合（用于去重/裁剪导出根）。"""
    cur = parents.get(cid)
    while cur is not None:
        if cur in selected:
            return True
        cur = parents.get(cur)
    return False


def _export_relative_path(cid: int, names: dict[int, str], parents: dict[int, int | None]) -> Path:
    """将集合 ID 转成相对导出路径（按父链从根到叶构建）。"""
    parts: list[str] = []
    cur: int | None = cid
    while cur is not None:
        parts.append(_sanitize_component(names.get(cur, str(cur))))
        cur = parents.get(cur)
    parts.reverse()
    p = Path()
    for part in parts:
        p = p / part
    return p


def export_attachments(
    request: ExportRequest,
    log: Callable[[str], None],
    progress: Callable[[int, int], None],
    is_cancelled: Callable[[], bool],
) -> ExportResult:
    """
    执行导出。

    设计要点：
    - 只读打开 zotero.sqlite，按集合导出附件到 request.target_dir。
    - 支持在循环中多次检查 is_cancelled，确保 UI 可及时取消。
    - 通过 log/progress 回调将过程信息交由调用方（通常是 UI）展示。
    """
    failures: list[str] = []
    exported_files = 0
    exported_directories = 0

    zotero_db_path = request.zotero_data_dir / "zotero.sqlite"
    base_attachment_path = read_base_attachment_path(request.zotero_data_dir)
    if base_attachment_path and not base_attachment_path.exists():
        base_attachment_path = None

    db = ZoteroDB(zotero_db_path)
    try:
        names, parents = _build_collection_maps(db)
        selected_set = set(int(x) for x in request.selected_collection_ids)

        selected_ids = sorted(set(int(x) for x in request.selected_collection_ids))
        roots = [cid for cid in selected_ids if not _collection_has_selected_ancestor(cid, selected_set, parents)]

        total = len(selected_ids)
        done = 0
        progress(done, total)

        for root_cid in roots:
            if is_cancelled():
                return ExportResult(
                    exported_files=exported_files,
                    exported_directories=exported_directories,
                    failures=failures,
                    cancelled=True,
                )

            rel = _export_relative_path(root_cid, names, parents)
            root_dir = request.target_dir / rel
            log(f"导出集合: {names.get(root_cid, str(root_cid))} -> {root_dir}")

            if root_dir.exists():
                try:
                    shutil.rmtree(root_dir)
                except Exception as e:
                    failures.append(f"清空目录失败: {root_dir} ({e})")
                    continue

            try:
                root_dir.mkdir(parents=True, exist_ok=True)
            except Exception as e:
                failures.append(f"创建目录失败: {root_dir} ({e})")
                continue

            exported_directories += 1

            for cid in selected_ids:
                if cid != root_cid and not _collection_has_selected_ancestor(cid, {root_cid}, parents):
                    continue

                if is_cancelled():
                    return ExportResult(
                        exported_files=exported_files,
                        exported_directories=exported_directories,
                        failures=failures,
                        cancelled=True,
                    )

                if cid not in names:
                    failures.append(f"未知集合ID: {cid}")
                    done += 1
                    progress(done, total)
                    continue

                rel = _export_relative_path(cid, names, parents)
                collection_dir = request.target_dir / rel
                try:
                    collection_dir.mkdir(parents=True, exist_ok=True)
                except Exception as e:
                    failures.append(f"创建目录失败: {collection_dir} ({e})")
                    done += 1
                    progress(done, total)
                    continue

                if cid != root_cid:
                    exported_directories += 1

                attachments = db.get_collection_attachments(cid)
                attachments = sorted(attachments, key=lambda a: (a.parent_item_id or 0, a.attachment_item_id, a.attachment_key))
                if not attachments:
                    log(f"集合无附件: {names.get(cid, str(cid))}")
                    done += 1
                    progress(done, total)
                    continue

                for a in attachments:
                    if is_cancelled():
                        return ExportResult(
                            exported_files=exported_files,
                            exported_directories=exported_directories,
                            failures=failures,
                            cancelled=True,
                        )

                    if not request.export_html and (a.content_type or "").lower().startswith("text/html"):
                        log(f"跳过 HTML 附件: {a.attachment_key}")
                        continue

                    src, is_dir, err = _resolve_attachment_source(
                        request.zotero_data_dir,
                        a.attachment_key,
                        a.path,
                        base_attachment_path,
                    )
                    if src is None:
                        failures.append(f"附件解析失败: key={a.attachment_key} ({err or 'unknown'})")
                        continue

                    if is_dir:
                        dst_dir = collection_dir / a.attachment_key
                        ok, copy_err = _copy_directory(src, dst_dir)
                        if not ok:
                            failures.append(f"复制目录失败: {src} -> {dst_dir} ({copy_err})")
                            continue
                        exported_directories += 1
                        log(f"复制目录: {src} -> {dst_dir}")
                    else:
                        if not src.exists():
                            failures.append(f"源文件不存在: {src}")
                            continue
                        ok, copy_err = _copy_file(src, collection_dir)
                        if not ok:
                            failures.append(f"复制文件失败: {src} -> {collection_dir} ({copy_err})")
                            continue
                        exported_files += 1
                        log(f"复制文件: {src} -> {collection_dir}")

                done += 1
                progress(done, total)

        return ExportResult(
            exported_files=exported_files,
            exported_directories=exported_directories,
            failures=failures,
            cancelled=False,
        )
    finally:
        db.close()
