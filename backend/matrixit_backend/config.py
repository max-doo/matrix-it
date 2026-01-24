"""
配置加载模块。

本模块负责从 JSON 文件加载配置，并支持通过 `config.local.json` 进行本地覆盖。
这种机制允许开发者在保持 Git 仓库清洁的同时，使用个人化的配置（如密钥等）。
"""

import json
import os
from typing import Any, Dict


def load_json(path: str, default: Any) -> Any:
    """
    读取 JSON 文件内容。
    
    Args:
        path: 文件路径
        default: 文件不存在时返回的默认值
        
    Returns:
        解析后的 JSON 对象或默认值
    """
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_config(config_path: str) -> Dict[str, Any]:
    """
    加载并合并配置。
    
    读取指定的主配置文件 (config.json)，并检查同目录下是否存在 config.local.json。
    若存在，则将 local 配置合并到主配置中。
    
    合并策略：
    - 顶层键值对直接覆盖
    - 若值为字典，则进行 update 操作（浅层合并）
    
    Args:
        config_path: 主配置文件路径
        
    Returns:
        Dict[str, Any]: 合并后的配置字典
    """
    config: Dict[str, Any] = {}
    if os.path.exists(config_path):
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)

    base_dir = os.path.dirname(os.path.abspath(config_path))
    local_path = os.path.join(base_dir, "config.local.json")
    if os.path.exists(local_path):
        with open(local_path, "r", encoding="utf-8") as f:
            local_cfg = json.load(f)
        for k, v in local_cfg.items():
            if isinstance(v, dict) and isinstance(config.get(k), dict):
                config[k].update(v)
            else:
                config[k] = v

    return config
