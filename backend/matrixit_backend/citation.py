"""
CSL (Citation Style Language) 引用生成模块。

本模块负责将文献条目（JSON 格式）转换为 CSL JSON 格式，并利用 `citeproc` 库
按照 GB/T 7714-2015 标准生成参考文献格式的字符串。
"""

import re
from typing import Dict, List, Optional


def _parse_date_parts(date_str: str) -> Optional[List[int]]:
    """
    解析日期字符串为 CSL 要求的 [year, month, day] 列表。
    
    支持格式：YYYY, YYYY-MM, YYYY-MM-DD (分隔符支持 - / .)
    """
    s = (date_str or "").strip()
    if not s:
        return None
    m = re.search(r"(\d{4})(?:[-/\.](\d{1,2}))?(?:[-/\.](\d{1,2}))?", s)
    if not m:
        return None
    parts = [int(m.group(1))]
    if m.group(2):
        parts.append(int(m.group(2)))
    if m.group(3):
        parts.append(int(m.group(3)))
    return parts


def _to_csl_names(creators: List[dict], want_types: List[str]) -> List[dict]:
    """
    将 Zotero creators 列表转换为 CSL names 格式。
    
    Args:
        creators: Zotero 条目中的 creators 列表
        want_types: 需要提取的 creatorType 列表 (如 'author', 'editor')
        
    Returns:
        CSL 格式的姓名列表 [{"family": "...", "given": "..."}, ...]
    """
    out: List[dict] = []
    for c in creators:
        ctype = str(c.get("creatorType") or "")
        if ctype not in want_types:
            continue
        family = str(c.get("lastName") or "").strip()
        given = str(c.get("firstName") or "").strip()
        literal = str(c.get("name") or "").strip()
        if family or given:
            out.append({"family": family, "given": given})
        elif literal:
            out.append({"literal": literal})
    return out


def build_csl_item(item: dict) -> dict:
    """
    将本地存储的文献 item 转换为 standard CSL JSON item。
    
    主要完成字段映射，将 Zotero/MatrixIt 的字段转为 CSL 标准字段 (如 title, author, issued 等)。
    """
    item_key = str(item.get("item_key") or "")
    item_type = str(item.get("item_type") or item.get("type") or "")

    # Zotero 类型到 CSL 类型的映射
    type_map = {
        "journalArticle": "article-journal",
        "conferencePaper": "paper-conference",
        "thesis": "thesis",
        "report": "report",
        "book": "book",
        "webpage": "webpage",
    }
    csl_type = type_map.get(item_type, "article-journal")

    meta_extra = item.get("meta_extra") if isinstance(item.get("meta_extra"), dict) else {}
    creators = meta_extra.get("creators") if isinstance(meta_extra.get("creators"), list) else []

    title = str(item.get("title") or "")
    # 尝试从多个可能的字段中获取容器名称（如期刊名、会议名、书名等）
    container_title = (
        str(meta_extra.get("publicationTitle") or "")
        or str(meta_extra.get("proceedingsTitle") or "")
        or str(meta_extra.get("bookTitle") or "")
        or str(meta_extra.get("websiteTitle") or "")
        or str(item.get("publications") or "")
    )

    date_raw = str(meta_extra.get("date") or "") or str(item.get("year") or "")
    issued_parts = _parse_date_parts(date_raw)
    accessed_parts = _parse_date_parts(str(meta_extra.get("accessDate") or ""))

    csl: Dict[str, object] = {"id": item_key, "type": csl_type, "title": title}

    # 处理各类责任者
    author = _to_csl_names(creators, ["author"])
    if author:
        csl["author"] = author

    editor = _to_csl_names(creators, ["editor"])
    if editor:
        csl["editor"] = editor

    translator = _to_csl_names(creators, ["translator"])
    if translator:
        csl["translator"] = translator

    if issued_parts:
        csl["issued"] = {"date-parts": [issued_parts]}

    if accessed_parts:
        csl["accessed"] = {"date-parts": [accessed_parts]}

    if container_title:
        csl["container-title"] = container_title

    publisher = str(meta_extra.get("publisher") or "").strip()
    if publisher:
        csl["publisher"] = publisher

    place = str(meta_extra.get("place") or "").strip()
    if place:
        csl["publisher-place"] = place

    volume = str(meta_extra.get("volume") or "").strip()
    if volume:
        csl["volume"] = volume

    issue = str(meta_extra.get("issue") or "").strip()
    if issue:
        csl["issue"] = issue

    pages = str(meta_extra.get("pages") or "").strip()
    if pages:
        csl["page"] = pages

    doi = str(item.get("doi") or "").strip()
    if doi:
        csl["DOI"] = doi

    url = str(item.get("url") or "").strip()
    if url:
        csl["URL"] = url

    return csl


def format_gbt7714_bibliography(items: List[dict]) -> Dict[str, str]:
    """
    使用 citeproc 引擎将条目列表格式化为 GB/T 7714-2015 参考文献字符串。
    
    Returns:
        Dict[item_key, citation_string]
    """
    if not items:
        return {}

    try:
        from citeproc import Citation, CitationItem
        from citeproc import CitationStylesBibliography, CitationStylesStyle
        from citeproc.formatter import plain as plain_formatter
        from citeproc.source.json import CiteProcJSON
        from citeproc_styles import get_style_filepath
    except Exception as e:
        raise RuntimeError(f"CSL 引擎依赖不可用：{e}")

    style_path = get_style_filepath("china-national-standard-gb-t-7714-2015-numeric")

    csl_items = [build_csl_item(it) for it in items]
    source = CiteProcJSON(csl_items)
    style = CitationStylesStyle(style_path, validate=False)
    bibliography = CitationStylesBibliography(style, source, formatter=plain_formatter)

    out: Dict[str, str] = {}
    for it in items:
        item_id = str(it.get("item_key") or "")
        if not item_id:
            continue
        # 逐个注册并生成引用，确保得到单独的引用字符串
        bibliography.register(Citation([CitationItem(item_id)]))
        rendered = bibliography.bibliography()
        if not rendered:
            out[item_id] = ""
            continue
        # 只要最后一条，因为 bibliography() 会返回累计列表
        last = rendered[-1]
        out[item_id] = str(last).strip()

    return out