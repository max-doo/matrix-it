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

import pymupdf4llm


def extract_pdf_text(pdf_path: str, max_pages: Optional[int] = 100) -> str:
    """
    从 PDF 文件中提取 Markdown 格式文本。
    
    使用 pymupdf4llm 将 PDF 转换为结构化 Markdown，保留标题、表格和格式，
    更利于大模型理解文献内容。
    为防止超大文件导致内存溢出或处理超时，默认只读取前 100 页。
    
    Args:
        pdf_path: PDF 文件绝对路径
        max_pages: 最大提取页数 (None 表示读取全部)
        
    Returns:
        解析出的 Markdown 文本；若文件不存在或解析失败，返回空字符串。
    """
    if not pdf_path:
        return ""
    if not os.path.exists(pdf_path):
        return ""
    try:
        import pymupdf  # fitz
        
        # 先获取文档总页数，避免请求超出范围的页码
        doc = pymupdf.open(pdf_path)
        total_pages = doc.page_count
        doc.close()
        
        # 构造有效的 pages 参数: 0-indexed 页码列表
        pages_arg: Optional[List[int]] = None
        if max_pages is not None:
            actual_pages = min(max_pages, total_pages)
            pages_arg = list(range(actual_pages))
        
        md_text: str = pymupdf4llm.to_markdown(pdf_path, pages=pages_arg)
        return md_text if md_text else ""
    except Exception as e:
        sys.stderr.write(f"[PDF] extract_pdf_text error: {type(e).__name__}: {e}\n")
        sys.stderr.flush()
        return ""


def main() -> None:
    """命令行入口：输出提取到的文本到 stdout。"""
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: python backend/matrixit_backend/pdf.py <pdf_path> [max_pages]\n")
        sys.exit(1)

    pdf_path = sys.argv[1]
    max_pages: Optional[int] = 100
    if len(sys.argv) >= 3:
        arg = str(sys.argv[2]).strip().lower()
        if arg in {"none", "all"}:
            max_pages = None
        else:
            max_pages = int(arg)

    sys.stdout.write(extract_pdf_text(pdf_path, max_pages=max_pages))


if __name__ == "__main__":
    main()
