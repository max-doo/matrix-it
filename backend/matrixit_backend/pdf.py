"""
PDF 相关工具模块。

当前仅提供“从 PDF 提取纯文本”的最小能力，供 sidecar 分析流程调用。

设计目标：
- 失败时返回空字符串，避免影响上层流程的容错与状态机推进
- 支持限制页数，降低耗时与内存占用
"""

import os
import sys
from typing import List, Optional

import pdfplumber


def extract_pdf_text(pdf_path: str, max_pages: Optional[int] = 8) -> str:
    """
    从 PDF 文件中提取纯文本。
    
    使用 pdfplumber 并不保证完美还原，仅用于 LLM 分析上下文。
    为防止超大文件导致内存溢出或处理超时，默认只读取前 8 页。
    
    Args:
        pdf_path: PDF 文件绝对路径
        max_pages: 最大提取页数 (None 表示读取全部)
        
    Returns:
        解析出的文本内容 (按页拼接)；若文件不存在或解析失败，返回空字符串。
    """
    if not pdf_path:
        return ""
    if not os.path.exists(pdf_path):
        return ""
    try:
        with pdfplumber.open(pdf_path) as pdf:
            parts: List[str] = []
            for i, page in enumerate(pdf.pages):
                if max_pages is not None and i >= max_pages:
                    break
                t = page.extract_text()
                if t:
                    parts.append(t)
            return "\n".join(parts)
    except Exception:
        return ""


def main() -> None:
    """命令行入口：输出提取到的文本到 stdout。"""
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: python backend/matrixit_backend/pdf.py <pdf_path> [max_pages]\n")
        sys.exit(1)

    pdf_path = sys.argv[1]
    max_pages: Optional[int] = 8
    if len(sys.argv) >= 3:
        arg = str(sys.argv[2]).strip().lower()
        if arg in {"none", "all"}:
            max_pages = None
        else:
            max_pages = int(arg)

    sys.stdout.write(extract_pdf_text(pdf_path, max_pages=max_pages))


if __name__ == "__main__":
    main()
