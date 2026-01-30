"""
Prompt 组装工具。

职责：
- 从 backend/docs/prompts.md 读取默认 System Prompt（并替换占位符）
- 从 fields.json 的 analysis_fields 生成“输出键集合 + 字段要求说明”
- 生成 User Prompt：强制模型输出与 analysis_fields 对齐的 JSON 对象
"""

import json
from pathlib import Path
from typing import Dict, List, Optional, Tuple
import sys


def load_default_system_prompt(fields_def: Optional[dict] = None, preferred_order: Optional[List[str]] = None) -> str:
    """
    加载默认 System Prompt 并根据字段定义进行动态渲染。
    
    会读取 `docs/prompts.md` 模板，并替换其中的 `{{rule_a_fields}}` (A类规则字段)、
    `{{rule_b_fields}}` (B类规则字段) 以及 `{{analysis_fields}}` (详细字段说明)。
    
    Args:
        fields_def: 字段定义字典 (通常来自 fields.json)
        preferred_order: 字段排序偏好
        
    Returns:
        渲染后的完整 System Prompt 字符串
    """
    docs_path = Path(__file__).resolve().parents[1] / "docs" / "prompts.md"
    if not docs_path.exists():
        meipass = getattr(sys, "_MEIPASS", "")
        if meipass:
            alt = Path(meipass) / "docs" / "prompts.md"
            if alt.exists():
                docs_path = alt
    text = docs_path.read_text(encoding="utf-8")
    fields_def = fields_def if isinstance(fields_def, dict) else {}

    af = get_analysis_fields(fields_def)
    keys, _ = build_output_schema_hint(fields_def, preferred_order=preferred_order)
    rule_by_key = {k: str((af.get(k) or {}).get("rule") or "").strip().upper() for k in keys}
    rule_a = [k for k in keys if rule_by_key.get(k) == "A"]
    rule_b = [k for k in keys if rule_by_key.get(k) == "B"]

    analysis_fields_obj: Dict[str, str] = {}
    for k in keys:
        v = af.get(k)
        if not isinstance(v, dict):
            continue
        desc = str(v.get("description") or "").strip()
        rule = rule_by_key.get(k) or ""
        analysis_fields_obj[k] = desc.strip()
    analysis_fields_block = json.dumps(analysis_fields_obj, ensure_ascii=False, indent=2)

    replacements = {
        "{{rule_a_fields}}": json.dumps(rule_a, ensure_ascii=False),
        "{{rule_b_fields}}": json.dumps(rule_b, ensure_ascii=False),
        "{{analysis_fields}}": analysis_fields_block,
    }
    for k, v in replacements.items():
        text = text.replace(k, v)
    return text


def get_analysis_fields(fields_def: dict) -> Dict[str, dict]:
    """快捷获取 analysis_fields 部分的配置。"""
    af = fields_def.get("analysis_fields", {})
    if isinstance(af, dict):
        return af
    return {}


def build_output_schema_hint(fields_def: dict, preferred_order: Optional[List[str]] = None) -> Tuple[List[str], str]:
    """
    构建输出 Schema 的提示信息。
    
    Args:
        fields_def: 字段定义
        preferred_order: 排序偏好
        
    Returns:
        Tuple[keys, schema_desc]: 键列表和 Schema 描述字符串
    """
    af = get_analysis_fields(fields_def)
    keys = list(af.keys())
    if preferred_order:
        order_idx = {k: i for i, k in enumerate(preferred_order)}
        keys = sorted(keys, key=lambda k: (order_idx.get(k, 10**9), k))
    parts: List[str] = []
    for k in keys:
        v = af.get(k)
        if not isinstance(v, dict):
            continue
        desc = str(v.get("description") or "").strip()
        rule = str(v.get("rule") or "").strip()
        ftype = str(v.get("type") or "").strip()
        parts.append(f'- "{k}": {desc}（rule={rule or "-"}, type={ftype or "-"}）')
    schema = "\n".join(parts)
    return keys, schema


def build_user_prompt(fields_def: dict, preferred_order: Optional[List[str]] = None) -> str:
    keys, schema = build_output_schema_hint(fields_def, preferred_order=preferred_order)
    keys_json = json.dumps(keys, ensure_ascii=False)
    return "\n".join(
        [
            "请严格输出一个 JSON 对象，不要输出 Markdown，不要输出多余说明。",
            f"JSON 只能包含这些键：{keys_json}",
            "字段要求如下（逐项遵循其 description 与 rule 规则；需要引用的字段必须紧跟引用）：",
            schema,
        ]
    ).strip()
