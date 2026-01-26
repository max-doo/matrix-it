"""
LLM 调用封装（后端分析链路的最小实现）。

设计目标：
- 不引入额外依赖：使用标准库 urllib 发起 HTTP 请求
- 兼容 OpenAI-Style Chat Completions：POST {base_url}/chat/completions
- 只关注“返回 JSON 对象”这一能力：将模型输出解析为 dict，用于写回 literature.json
- 统一错误码：通过 LlmError(code,message) 供上层 sidecar 输出结构化失败事件
"""

import base64
import json
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class LlmError(RuntimeError):
    """
    LLM 调用相关的自定义异常。
    
    Attributes:
        code (str): 错误码 (如 "LLM_NETWORK_ERROR")
        message (str): 错误描述信息
    """
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def load_llm_config(config: dict) -> Optional[dict]:
    """
    从全局配置中提取并校验 LLM 相关配置。
    
    Args:
        config: 全局配置字典
        
    Returns:
        整理后的 LLM 配置字典，若关键字段缺失则返回 None。
        配置包含: api_key, base_url, model, timeout_s, temperature, max_input_chars 等。
    """
    llm_cfg = config.get("llm", {})
    if not isinstance(llm_cfg, dict):
        return None
    api_key = str(llm_cfg.get("api_key") or "").strip()
    base_url = str(llm_cfg.get("base_url") or "").strip()
    # model 可能是字符串或数组（前端 Select 组件存储为数组）
    model_raw = llm_cfg.get("model")
    if isinstance(model_raw, list):
        model = str(model_raw[0]).strip() if model_raw else ""
    else:
        model = str(model_raw or "").strip()
    if not api_key or not base_url or not model:
        return None
    timeout_s = llm_cfg.get("timeout_s", 60)
    try:
        timeout_s = int(timeout_s)
    except Exception:
        timeout_s = 60
    temperature = llm_cfg.get("temperature", 0.2)
    try:
        temperature = float(temperature)
    except Exception:
        temperature = 0.2
    max_input_chars = llm_cfg.get("max_input_chars", 12000)
    try:
        max_input_chars = int(max_input_chars)
    except Exception:
        max_input_chars = 12000
    multimodal = bool(llm_cfg.get("multimodal", False))
    api = str(llm_cfg.get("api") or "chat_completions").strip()
    max_pdf_bytes = llm_cfg.get("max_pdf_bytes", 8 * 1024 * 1024)
    try:
        max_pdf_bytes = int(max_pdf_bytes)
    except Exception:
        max_pdf_bytes = 8 * 1024 * 1024
    parallel_count_raw = llm_cfg.get("parallel_count") or 1
    try:
        parallel_count_raw = int(parallel_count_raw)
    except Exception:
        parallel_count_raw = 1
    parallel_count_max = llm_cfg.get("parallel_count_max", 10)
    try:
        parallel_count_max = int(parallel_count_max)
    except Exception:
        parallel_count_max = 10
    parallel_count_max = max(1, min(parallel_count_max, 10))
    multimodal_parallel_count_max = llm_cfg.get("multimodal_parallel_count_max", 2)
    try:
        multimodal_parallel_count_max = int(multimodal_parallel_count_max)
    except Exception:
        multimodal_parallel_count_max = 2
    multimodal_parallel_count_max = max(1, min(multimodal_parallel_count_max, parallel_count_max))
    parallel_count = max(1, min(parallel_count_raw, parallel_count_max))
    if multimodal:
        parallel_count = max(1, min(parallel_count, multimodal_parallel_count_max))
    return {
        "api_key": api_key,
        "base_url": base_url,
        "model": model,
        "timeout_s": timeout_s,
        "temperature": temperature,
        "max_input_chars": max_input_chars,
        "multimodal": multimodal,
        "api": api,
        "max_pdf_bytes": max_pdf_bytes,
        "parallel_count": parallel_count,
        "parallel_count_max": parallel_count_max,
        "multimodal_parallel_count_max": multimodal_parallel_count_max,
    }


def _chat_completions_url(base_url: str) -> str:
    u = base_url.rstrip("/")
    if u.endswith("/chat/completions"):
        return u
    return f"{u}/chat/completions"


def _responses_url(base_url: str) -> str:
    u = base_url.rstrip("/")
    if u.endswith("/responses"):
        return u
    return f"{u}/responses"


def _responses_extract_text(obj: dict) -> str:
    if isinstance(obj.get("output_text"), str):
        return obj["output_text"]
    out = obj.get("output")
    if isinstance(out, list):
        for block in out:
            if not isinstance(block, dict):
                continue
            content = block.get("content")
            if not isinstance(content, list):
                continue
            for part in content:
                if not isinstance(part, dict):
                    continue
                t = part.get("type")
                if t in ("output_text", "text") and isinstance(part.get("text"), str):
                    return part["text"]
    raise LlmError("LLM_RESPONSE_MISSING", "模型响应缺少可解析的输出文本")


def _extract_json(text: str) -> Dict[str, Any]:
    raw = (text or "").strip()
    try:
        obj = json.loads(raw)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass

    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        try:
            obj = json.loads(raw[start : end + 1])
            if isinstance(obj, dict):
                return obj
        except Exception:
            pass
    raise LlmError("LLM_INVALID_JSON", "模型返回内容不是有效的 JSON 对象")

def _safe_base_url(base_url: str) -> str:
    u = str(base_url or "").strip()
    if not u:
        return ""
    if "@" in u:
        u = u.split("@", 1)[1]
    if "://" in u:
        scheme, rest = u.split("://", 1)
        rest = rest.split("?", 1)[0]
        return f"{scheme}://{rest}"
    return u.split("?", 1)[0]


def _safe_preview(text: str, max_len: int = 220) -> str:
    s = str(text or "").replace("\r", "").replace("\n", " ").strip()
    if len(s) <= max_len:
        return s
    return s[: max_len - 1] + "…"


def chat_json(
    llm_cfg: dict,
    messages: List[dict],
    debug: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> Dict[str, Any]:
    """
    调用 OpenAI 格式的 Chat Completions API，并强制解析返回值为 JSON。
    
    Args:
        llm_cfg: LLM 配置字典
        messages: 消息列表 [{"role": "user", "content": "..."}, ...]
        debug: 调试回调函数，用于输出请求/响应详情
        
    Returns:
        解析后的 JSON 字典
        
    Raises:
        LlmError: 当请求失败或无法解析 JSON 时抛出
    """
    import sys
    
    url = _chat_completions_url(str(llm_cfg["base_url"]))
    payload = {
        "model": llm_cfg["model"],
        "messages": messages,
        "temperature": llm_cfg.get("temperature", 0.2),
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    
    # 详细日志：请求信息
    sys.stderr.write(f"\n{'='*60}\n")
    sys.stderr.write(f"[LLM] POST {url}\n")
    sys.stderr.write(f"[LLM] Model: {llm_cfg.get('model')}\n")
    sys.stderr.write(f"[LLM] Temperature: {llm_cfg.get('temperature')}\n")
    sys.stderr.write(f"[LLM] Timeout: {llm_cfg.get('timeout_s')}s\n")
    sys.stderr.write(f"[LLM] Request body size: {len(data)} bytes\n")
    
    # 打印请求体预览（截断 messages 中的 content）
    preview_payload = {
        "model": payload["model"],
        "temperature": payload["temperature"],
        "messages": []
    }
    for msg in payload.get("messages", []):
        preview_msg = {"role": msg.get("role", "")}
        content = msg.get("content", "")
        if len(content) > 500:
            preview_msg["content"] = content[:500] + f"... (truncated, total {len(content)} chars)"
        else:
            preview_msg["content"] = content
        preview_payload["messages"].append(preview_msg)
    sys.stderr.write(f"[LLM] Request body preview:\n{json.dumps(preview_payload, ensure_ascii=False, indent=2)}\n")
    sys.stderr.flush()
    
    if debug:
        try:
            debug(
                {
                    "api": "chat_completions",
                    "url": _safe_base_url(url),
                    "model": llm_cfg.get("model"),
                    "timeout_s": llm_cfg.get("timeout_s"),
                    "temperature": llm_cfg.get("temperature"),
                    "payload_bytes": len(data),
                }
            )
        except Exception:
            pass
    req = Request(
        url=url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {llm_cfg['api_key']}",
            "User-Agent": "MatrixIt/1.0.0",
        },
    )
    try:
        with urlopen(req, timeout=int(llm_cfg.get("timeout_s", 60))) as resp:
            raw = resp.read()
            body = raw.decode("utf-8", errors="replace")
            status = getattr(resp, "status", None) or getattr(resp, "getcode", lambda: None)()
            sys.stderr.write(f"[LLM] Response status: {status}\n")
            sys.stderr.write(f"[LLM] Response size: {len(raw)} bytes\n")
            sys.stderr.flush()
            if debug:
                try:
                    debug(
                        {
                            "status": status,
                            "response_bytes": len(raw),
                        }
                    )
                except Exception:
                    pass
    except HTTPError as e:
        # 读取错误响应体
        error_body = ""
        try:
            error_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        sys.stderr.write(f"[LLM] ❌ HTTP Error: {e.code}\n")
        sys.stderr.write(f"[LLM] Error response:\n{error_body[:2000]}\n")
        sys.stderr.write(f"{'='*60}\n")
        sys.stderr.flush()
        raise LlmError("LLM_HTTP_ERROR", f"模型请求失败: HTTP {e.code} - {error_body[:200]}") from e
    except URLError as e:
        sys.stderr.write(f"[LLM] ❌ Network Error: {e.reason}\n")
        sys.stderr.write(f"{'='*60}\n")
        sys.stderr.flush()
        raise LlmError("LLM_NETWORK_ERROR", f"模型网络请求失败: {e.reason}") from e
    except Exception as e:
        sys.stderr.write(f"[LLM] ❌ Request Error: {e}\n")
        sys.stderr.write(f"{'='*60}\n")
        sys.stderr.flush()
        raise LlmError("LLM_REQUEST_FAILED", f"模型请求失败: {e}") from e

    # 打印响应体预览
    sys.stderr.write(f"[LLM] Response body preview:\n{body[:1000]}{'...' if len(body) > 1000 else ''}\n")
    sys.stderr.flush()
    
    try:
        obj = json.loads(body)
    except Exception as e:
        sys.stderr.write(f"[LLM] ❌ JSON parse error: {e}\n")
        sys.stderr.write(f"{'='*60}\n")
        sys.stderr.flush()
        raise LlmError("LLM_RESPONSE_INVALID", "模型响应不是有效 JSON") from e

    try:
        content = obj["choices"][0]["message"]["content"]
    except Exception as e:
        sys.stderr.write(f"[LLM] ❌ Response structure error: missing choices/message/content\n")
        sys.stderr.write(f"[LLM] Full response: {json.dumps(obj, ensure_ascii=False)[:1000]}\n")
        sys.stderr.write(f"{'='*60}\n")
        sys.stderr.flush()
        raise LlmError("LLM_RESPONSE_MISSING", "模型响应缺少 choices/message/content") from e

    content_str = str(content)
    sys.stderr.write(f"[LLM] ✓ Content extracted: {len(content_str)} chars\n")
    sys.stderr.write(f"[LLM] Content preview: {_safe_preview(content_str, 300)}\n")
    
    if debug:
        try:
            debug({"content_preview": _safe_preview(content_str), "content_chars": len(content_str)})
        except Exception:
            pass
    parsed = _extract_json(content_str)
    
    sys.stderr.write(f"[LLM] ✓ JSON parsed, keys: {list(parsed.keys())}\n")
    sys.stderr.write(f"{'='*60}\n")
    sys.stderr.flush()
    
    if debug:
        try:
            debug({"parsed_keys": list(parsed.keys())})
        except Exception:
            pass
    return parsed



def responses_pdf_json(
    llm_cfg: dict,
    system_prompt: str,
    user_content: str,
    pdf_path: str,
    debug: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> Dict[str, Any]:
    """
    多模态 PDF 分析调用 (针对支持文件输入的 API)。
    
    将 PDF 文件转为 Base64 编码并与提示词一同发送给模型。
    
    Args:
        llm_cfg: LLM 配置
        system_prompt:系统提示词
        user_content: 用户提示词（问题）
        pdf_path: PDF 文件路径 (文件过大时会抛出异常)
        debug: 调试回调
        
    Returns:
        解析后的 JSON 字典
    """
    max_bytes = int(llm_cfg.get("max_pdf_bytes", 8 * 1024 * 1024))
    p = Path(pdf_path)
    if not p.exists():
        raise LlmError("PDF_NOT_FOUND", "PDF 文件不存在")
    size = p.stat().st_size
    if size > max_bytes:
        raise LlmError("PDF_TOO_LARGE", f"PDF 文件过大: {size} bytes")

    pdf_b64 = base64.b64encode(p.read_bytes()).decode("ascii")
    file_data = f"data:application/pdf;base64,{pdf_b64}"

    payload = {
        "model": llm_cfg["model"],
        "input": [
            {"role": "system", "content": [{"type": "input_text", "text": system_prompt}]},
            {
                "role": "user",
                "content": [
                    {"type": "input_file", "file_data": file_data, "filename": p.name},
                    {"type": "input_text", "text": user_content},
                ],
            },
        ],
        "temperature": llm_cfg.get("temperature", 0.2),
    }
    url = _responses_url(str(llm_cfg["base_url"]))
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if debug:
        try:
            debug(
                {
                    "api": "responses",
                    "url": _safe_base_url(url),
                    "model": llm_cfg.get("model"),
                    "timeout_s": llm_cfg.get("timeout_s"),
                    "temperature": llm_cfg.get("temperature"),
                    "payload_bytes": len(data),
                    "pdf_bytes": size,
                    "pdf_name": p.name,
                }
            )
        except Exception:
            pass
    req = Request(
        url=url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {llm_cfg['api_key']}",
            "User-Agent": "MatrixIt/1.0.0",
        },
    )
    try:
        with urlopen(req, timeout=int(llm_cfg.get("timeout_s", 60))) as resp:
            raw = resp.read()
            body = raw.decode("utf-8", errors="replace")
            if debug:
                try:
                    debug(
                        {
                            "status": getattr(resp, "status", None) or getattr(resp, "getcode", lambda: None)(),
                            "response_bytes": len(raw),
                        }
                    )
                except Exception:
                    pass
    except HTTPError as e:
        raise LlmError("LLM_HTTP_ERROR", f"模型请求失败: HTTP {e.code}") from e
    except URLError as e:
        raise LlmError("LLM_NETWORK_ERROR", "模型网络请求失败") from e
    except Exception as e:
        raise LlmError("LLM_REQUEST_FAILED", "模型请求失败") from e

    try:
        obj = json.loads(body)
        if not isinstance(obj, dict):
            raise LlmError("LLM_RESPONSE_INVALID", "模型响应不是 JSON 对象")
    except LlmError:
        raise
    except Exception as e:
        raise LlmError("LLM_RESPONSE_INVALID", "模型响应不是有效 JSON") from e

    text = _responses_extract_text(obj)
    if debug:
        try:
            debug({"content_preview": _safe_preview(text), "content_chars": len(text)})
        except Exception:
            pass
    parsed = _extract_json(text)
    if debug:
        try:
            debug({"parsed_keys": list(parsed.keys())})
        except Exception:
            pass
    return parsed

