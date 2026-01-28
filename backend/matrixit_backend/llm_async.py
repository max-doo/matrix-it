from __future__ import annotations

"""
异步 LLM 调用封装（并行分析链路）。

设计目标：
- 使用 aiohttp 实现异步 HTTP 请求
- 使用 asyncio.Semaphore 控制并发数
- 支持实时进度输出（JSON Lines）
- 兼容现有 llm.py 的错误处理和 JSON 解析逻辑
"""

import asyncio
import base64
import json
import os
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

try:
    import aiohttp
    AIOHTTP_AVAILABLE = True
    AIOHTTP_ERROR: str | None = None
    AIOHTTP_VERSION = getattr(aiohttp, "__version__", None)
except Exception as e:
    AIOHTTP_AVAILABLE = False
    AIOHTTP_ERROR = f"{type(e).__name__}: {e}"
    AIOHTTP_VERSION = None

from matrixit_backend.llm import (
    LlmError,
    _chat_completions_url,
    _extract_json,
    _responses_extract_text,
    _responses_url,
    _safe_base_url,
    _safe_preview,
)

def _trace_enabled() -> bool:
    v = str(os.environ.get("MATRIXIT_LLM_TRACE") or "").strip().lower()
    if v in ("0", "false", "no", "off"):
        return False
    if v in ("1", "true", "yes", "on"):
        return True
    return True


def _trace_user_max_chars() -> int:
    raw = str(os.environ.get("MATRIXIT_LLM_TRACE_USER_MAX") or "").strip()
    try:
        n = int(raw)
        return max(0, n)
    except Exception:
        return 2000


def _truncate_user_messages(messages: List[dict], max_chars: int) -> tuple[List[dict], List[dict]]:
    if max_chars <= 0:
        max_chars = 0
    out: List[dict] = []
    meta: List[dict] = []
    for idx, msg in enumerate(messages or []):
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        content = msg.get("content")
        if role == "user" and isinstance(content, str):
            total = len(content)
            truncated = total > max_chars
            out_msg = dict(msg)
            out_msg["content"] = content if not truncated else content[:max_chars]
            out.append(out_msg)
            meta.append({"index": idx, "total_chars": total, "truncated": truncated})
        else:
            out.append(dict(msg))
    return out, meta


class AsyncLLMAnalyzer:
    """
    异步 LLM 分析器。
    
    使用 asyncio + aiohttp 实现并行 API 调用，
    通过 Semaphore 控制并发数以避免触发 API 限流。
    
    Attributes:
        parallel_count: 最大并发数
        timeout: 请求超时时间（秒）
    """
    
    def __init__(self, parallel_count: int = 3, timeout: int = 120):
        """
        初始化异步分析器。
        
        Args:
            parallel_count: 并行数量，默认 3
            timeout: 单个请求超时秒数，默认 120
        """
        if not AIOHTTP_AVAILABLE:
            raise ImportError("aiohttp 未安装，请运行: pip install aiohttp")
        self.parallel_count = max(1, min(parallel_count, 10))
        self.semaphore = asyncio.Semaphore(self.parallel_count)
        self.timeout = aiohttp.ClientTimeout(total=timeout)
    
    async def chat_json_async(
        self,
        session: aiohttp.ClientSession,
        llm_cfg: dict,
        messages: List[dict],
        item_key: str,
        debug: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> Dict[str, Any]:
        """
        异步调用 Chat Completions API。
        
        Args:
            session: aiohttp 客户端会话
            llm_cfg: LLM 配置字典
            messages: 消息列表
            item_key: 当前处理的条目 key（用于日志）
            debug: 调试回调
            
        Returns:
            解析后的 JSON 字典
            
        Raises:
            LlmError: 请求失败或解析失败时抛出
        """
        url = _chat_completions_url(str(llm_cfg["base_url"]))
        payload = {
            "model": llm_cfg["model"],
            "messages": messages,
            "temperature": llm_cfg.get("temperature", 0.2),
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {llm_cfg['api_key']}",
            "User-Agent": "MatrixIt/1.0.0",
        }

        trace_on = _trace_enabled()
        if debug:
            if trace_on:
                try:
                    user_max = _trace_user_max_chars()
                    truncated_messages, trunc_meta = _truncate_user_messages(messages, user_max)
                    safe_headers = {k: v for k, v in headers.items() if k.lower() != "authorization"}
                    debug(
                        {
                            "step": "request",
                            "api": "chat_completions_async",
                            "url": _safe_base_url(url),
                            "model": llm_cfg.get("model"),
                            "item_key": item_key,
                            "headers": safe_headers,
                            "payload": {**payload, "messages": truncated_messages},
                            "user_truncation": {
                                "max_chars": user_max,
                                "items": trunc_meta,
                            },
                        }
                    )
                except Exception:
                    pass
            else:
                try:
                    debug(
                        {
                            "api": "chat_completions_async",
                            "url": _safe_base_url(url),
                            "model": llm_cfg.get("model"),
                            "item_key": item_key,
                        }
                    )
                except Exception:
                    pass
        
        try:
            async with session.post(url, json=payload, headers=headers) as resp:
                status = resp.status
                body = await resp.text()
                
                if status >= 400:
                    raise LlmError("LLM_HTTP_ERROR", f"模型请求失败: HTTP {status} - {body[:200]}")
                
                if debug:
                    if trace_on:
                        try:
                            debug(
                                {
                                    "step": "response",
                                    "api": "chat_completions_async",
                                    "url": _safe_base_url(url),
                                    "model": llm_cfg.get("model"),
                                    "item_key": item_key,
                                    "status": status,
                                    "response_bytes": len(body),
                                    "response_text": body,
                                }
                            )
                        except Exception:
                            pass
                    else:
                        try:
                            debug({"status": status, "response_bytes": len(body), "item_key": item_key})
                        except Exception:
                            pass
        except aiohttp.ClientError as e:
            raise LlmError("LLM_NETWORK_ERROR", f"模型网络请求失败: {e}") from e
        except asyncio.TimeoutError:
            raise LlmError("LLM_TIMEOUT", "模型请求超时") from None
        
        try:
            obj = json.loads(body)
        except Exception as e:
            raise LlmError("LLM_RESPONSE_INVALID", "模型响应不是有效 JSON") from e
        
        try:
            content = obj["choices"][0]["message"]["content"]
        except Exception as e:
            raise LlmError("LLM_RESPONSE_MISSING", "模型响应缺少 choices/message/content") from e
        
        content_str = str(content)
        if debug and not trace_on:
            try:
                debug({"content_preview": _safe_preview(content_str), "content_chars": len(content_str), "item_key": item_key})
            except Exception:
                pass

        parsed = _extract_json(content_str)
        if debug:
            try:
                payload = {"parsed_keys": list(parsed.keys()), "item_key": item_key}
                if trace_on:
                    payload["step"] = "parsed"
                debug(payload)
            except Exception:
                pass
        
        return parsed

    async def responses_pdf_json_async(
        self,
        session: aiohttp.ClientSession,
        llm_cfg: dict,
        system_prompt: str,
        user_content: str,
        pdf_path: str,
        item_key: str,
        debug: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> Dict[str, Any]:
        max_bytes = int(llm_cfg.get("max_pdf_bytes", 8 * 1024 * 1024))
        p = Path(pdf_path)
        if not p.exists():
            raise LlmError("PDF_NOT_FOUND", "PDF 文件不存在")
        size = p.stat().st_size
        if size > max_bytes:
            raise LlmError("PDF_TOO_LARGE", f"PDF 文件过大: {size} bytes")

        pdf_b64 = await asyncio.to_thread(lambda: base64.b64encode(p.read_bytes()).decode("ascii"))
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
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {llm_cfg['api_key']}",
            "User-Agent": "MatrixIt/1.0.0",
        }

        if debug:
            trace_on = _trace_enabled()
            if trace_on:
                try:
                    safe_headers = {k: v for k, v in headers.items() if k.lower() != "authorization"}
                    user_max = _trace_user_max_chars()
                    safe_user = user_content if len(user_content) <= user_max else user_content[:user_max]
                    safe_payload = dict(payload)
                    safe_input = []
                    for part in payload.get("input", []):
                        if not isinstance(part, dict):
                            continue
                        if part.get("role") == "user":
                            safe_part = dict(part)
                            safe_content = []
                            for c in part.get("content", []):
                                if not isinstance(c, dict):
                                    continue
                                if c.get("type") == "input_file":
                                    safe_content.append(
                                        {
                                            "type": "input_file",
                                            "filename": p.name,
                                            "pdf_bytes": size,
                                            "file_data": "<<omitted>>",
                                        }
                                    )
                                elif c.get("type") == "input_text":
                                    safe_content.append({"type": "input_text", "text": safe_user})
                                else:
                                    safe_content.append(dict(c))
                            safe_part["content"] = safe_content
                            safe_input.append(safe_part)
                        else:
                            safe_input.append(dict(part))
                    safe_payload["input"] = safe_input
                    debug(
                        {
                            "step": "request",
                            "api": "responses_async",
                            "url": _safe_base_url(url),
                            "model": llm_cfg.get("model"),
                            "item_key": item_key,
                            "headers": safe_headers,
                            "payload": safe_payload,
                            "user_truncation": {
                                "max_chars": user_max,
                                "items": [{"total_chars": len(user_content), "truncated": len(user_content) > user_max}],
                            },
                        }
                    )
                except Exception:
                    pass
            else:
                try:
                    debug(
                        {
                            "api": "responses_async",
                            "url": _safe_base_url(url),
                            "model": llm_cfg.get("model"),
                            "item_key": item_key,
                            "pdf_bytes": size,
                        }
                    )
                except Exception:
                    pass

        try:
            async with session.post(url, json=payload, headers=headers) as resp:
                status = resp.status
                body = await resp.text()
                if status >= 400:
                    raise LlmError("LLM_HTTP_ERROR", f"模型请求失败: HTTP {status} - {body[:200]}")
                if debug:
                    trace_on = _trace_enabled()
                    if trace_on:
                        try:
                            debug(
                                {
                                    "step": "response",
                                    "api": "responses_async",
                                    "url": _safe_base_url(url),
                                    "model": llm_cfg.get("model"),
                                    "item_key": item_key,
                                    "status": status,
                                    "response_bytes": len(body),
                                    "response_text": body,
                                }
                            )
                        except Exception:
                            pass
                    else:
                        try:
                            debug({"status": status, "response_bytes": len(body), "item_key": item_key})
                        except Exception:
                            pass
        except aiohttp.ClientError as e:
            raise LlmError("LLM_NETWORK_ERROR", f"模型网络请求失败: {e}") from e
        except asyncio.TimeoutError:
            raise LlmError("LLM_TIMEOUT", "模型请求超时") from None

        try:
            obj = json.loads(body)
            if not isinstance(obj, dict):
                raise LlmError("LLM_RESPONSE_INVALID", "模型响应不是 JSON 对象")
        except LlmError:
            raise
        except Exception as e:
            raise LlmError("LLM_RESPONSE_INVALID", "模型响应不是有效 JSON") from e

        text = _responses_extract_text(obj)
        parsed = _extract_json(text)
        if debug:
            try:
                trace_on = _trace_enabled()
                if not trace_on:
                    debug({"content_preview": _safe_preview(text), "content_chars": len(text), "item_key": item_key})
                payload = {"parsed_keys": list(parsed.keys()), "item_key": item_key}
                if trace_on:
                    payload["step"] = "parsed"
                debug(payload)
            except Exception:
                pass
        return parsed
    
    async def analyze_single(
        self,
        session: aiohttp.ClientSession,
        item_key: str,
        llm_cfg: dict,
        messages: List[dict],
        debug: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> Dict[str, Any]:
        """
        分析单条文献（带信号量限流）。
        
        Args:
            session: aiohttp 客户端会话
            item_key: 条目 key
            llm_cfg: LLM 配置
            messages: 消息列表
            debug: 调试回调
            
        Returns:
            {
                "item_key": str,
                "success": bool,
                "result": dict (成功时),
                "error": str (失败时),
                "error_code": str (失败时)
            }
        """
        async with self.semaphore:
            try:
                result = await self.chat_json_async(session, llm_cfg, messages, item_key, debug)
                return {
                    "item_key": item_key,
                    "success": True,
                    "result": result,
                }
            except LlmError as e:
                return {
                    "item_key": item_key,
                    "success": False,
                    "error": e.message,
                    "error_code": e.code,
                }
            except Exception as e:
                return {
                    "item_key": item_key,
                    "success": False,
                    "error": str(e),
                    "error_code": "UNKNOWN_ERROR",
                }

    async def analyze_single_responses(
        self,
        session: aiohttp.ClientSession,
        item_key: str,
        llm_cfg: dict,
        system_prompt: str,
        user_content: str,
        pdf_path: str,
        debug: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> Dict[str, Any]:
        async with self.semaphore:
            try:
                result = await self.responses_pdf_json_async(
                    session, llm_cfg, system_prompt, user_content, pdf_path, item_key, debug
                )
                return {
                    "item_key": item_key,
                    "success": True,
                    "result": result,
                }
            except LlmError as e:
                return {
                    "item_key": item_key,
                    "success": False,
                    "error": e.message,
                    "error_code": e.code,
                }
            except Exception as e:
                return {
                    "item_key": item_key,
                    "success": False,
                    "error": str(e),
                    "error_code": "UNKNOWN_ERROR",
                }
    
    async def analyze_batch(
        self,
        tasks_data: List[Dict[str, Any]],
        llm_cfg: dict,
        on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
        debug: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> List[Dict[str, Any]]:
        """
        批量并行分析文献。
        
        Args:
            tasks_data: 任务数据列表，每项需包含 item_key 和 messages
            llm_cfg: LLM 配置
            on_progress: 进度回调，每完成一个任务时调用
            debug: 调试回调
            
        Returns:
            分析结果列表
        """
        connector = aiohttp.TCPConnector(limit_per_host=self.parallel_count + 2)
        timeout = aiohttp.ClientTimeout(total=int(llm_cfg.get("timeout_s", 120)))
        
        results: List[Dict[str, Any]] = []
        
        async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
            # 创建所有任务
            coros = [
                self.analyze_single(
                    session,
                    task["item_key"],
                    llm_cfg,
                    task["messages"],
                    debug,
                )
                for task in tasks_data
            ]
            
            # 使用 as_completed 实现实时进度
            for coro in asyncio.as_completed(coros):
                result = await coro
                results.append(result)
                if on_progress:
                    try:
                        on_progress(result)
                    except Exception:
                        pass
        
        return results

    async def analyze_batch_responses(
        self,
        tasks_data: List[Dict[str, Any]],
        llm_cfg: dict,
        on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
        debug: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> List[Dict[str, Any]]:
        connector = aiohttp.TCPConnector(limit_per_host=self.parallel_count + 2)
        timeout = aiohttp.ClientTimeout(total=int(llm_cfg.get("timeout_s", 120)))

        results: List[Dict[str, Any]] = []

        async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
            coros = [
                self.analyze_single_responses(
                    session,
                    task["item_key"],
                    llm_cfg,
                    task["system_prompt"],
                    task["user_content"],
                    task["pdf_path"],
                    debug,
                )
                for task in tasks_data
            ]

            for coro in asyncio.as_completed(coros):
                result = await coro
                results.append(result)
                if on_progress:
                    try:
                        on_progress(result)
                    except Exception:
                        pass

        return results


def is_async_available() -> bool:
    """检查异步模块是否可用"""
    return AIOHTTP_AVAILABLE


def get_async_diagnostic() -> Dict[str, Any]:
    return {
        "available": bool(AIOHTTP_AVAILABLE),
        "version": AIOHTTP_VERSION,
        "error": AIOHTTP_ERROR,
    }
