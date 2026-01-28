from __future__ import annotations

"""
Zotero 数据目录识别与路径解析。

职责：
- 校验某路径是否为有效 Zotero 数据目录（需要 zotero.sqlite 与 storage/）。
- 在常见 Windows 位置猜测 Zotero 数据目录，降低首次使用门槛。
- 从 prefs.js 读取 baseAttachmentPath，用于解析 attachments: 前缀的附件路径。
"""

import os
import re
from pathlib import Path


def is_valid_zotero_data_dir(path: Path) -> bool:
    """判断是否为有效 Zotero 数据目录。"""
    if not path.exists():
        return False
    if not (path / "zotero.sqlite").exists():
        return False
    if not (path / "storage").exists():
        return False
    return True


def find_zotero_profiles(root: Path) -> list[Path]:
    """查找 root/Profiles 下的有效 Zotero profile 目录。"""
    profiles_dir = root / "Profiles"
    if not profiles_dir.exists():
        return []
    if not profiles_dir.is_dir():
        return []

    profiles: list[Path] = []
    for child in profiles_dir.iterdir():
        if not child.is_dir():
            continue
        if is_valid_zotero_data_dir(child):
            profiles.append(child)
    return profiles


def guess_zotero_data_dir() -> Path | None:
    """从常见路径猜测 Zotero 数据目录（优先返回第一个匹配项）。"""
    candidates: list[Path] = []

    appdata = os.environ.get("APPDATA")
    userprofile = os.environ.get("USERPROFILE")

    if appdata:
        candidates.append(Path(appdata) / "Zotero" / "Zotero")
        candidates.append(Path(appdata) / "Zotero")
    if userprofile:
        candidates.append(Path(userprofile) / "Zotero")

    for base in candidates:
        if is_valid_zotero_data_dir(base):
            return base
        for profile in find_zotero_profiles(base):
            return profile

    return None


def read_base_attachment_path(zotero_data_dir: Path) -> Path | None:
    """从 prefs.js 中提取 baseAttachmentPath（用于解析 attachments: 路径）。"""
    prefs_path = zotero_data_dir / "prefs.js"
    if not prefs_path.exists():
        return None

    try:
        text = prefs_path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return None

    patterns = [
        r'user_pref\("extensions\.zotero\.baseAttachmentPath",\s*"(?P<path>[^"]*)"\s*\)\s*;',
        r'user_pref\("extensions\.zotero\.baseAttachmentPath",\s*\'(?P<path>[^\']*)\'\s*\)\s*;',
    ]

    for pattern in patterns:
        match = re.search(pattern, text)
        if not match:
            continue
        raw = match.group("path")
        if not raw:
            continue
        try:
            p = Path(raw)
        except Exception:
            return None
        return p

    return None
