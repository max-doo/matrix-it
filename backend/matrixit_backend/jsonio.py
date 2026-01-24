"""
JSON 文件读写封装。

集中处理编码与缩进格式，保证前端/后端生成的 JSON 可读且一致。
"""

import json
import os
from typing import Any


def read_json(path: str, default: Any) -> Any:
    """
    安全读取 JSON 文件。
    
    Args:
        path: 文件路径
        default: 当文件不存在时返回的默认值
        
    Returns:
        解析后的 Python 对象 (通常是 dict 或 list)
    """
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: str, data: Any) -> None:
    """
    将对象写入 JSON 文件。
    
    使用 UTF-8 编码，indent=2 格式化输出，并不转义非 ASCII 字符（保持中文可读）。
    
    Args:
        path: 目标文件路径
        data: 可序列化的 Python 对象
    """
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
