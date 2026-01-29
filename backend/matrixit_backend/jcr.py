"""
JCR 期刊数据查询模块。

提供影响因子(Impact Factor)和期刊分区(JCR/中科院)的查询能力。
数据来源:ShowJCR 项目的 jcr.db 数据库。

核心功能:
- query_impact_factor: 查询 JCR 影响因子和分区
- query_cas_partition: 查询中科院分区
- query_journal_info: 综合查询期刊信息
"""

import os
import sqlite3
from pathlib import Path
from typing import Dict, Optional, Tuple


def get_jcr_db_path(config: dict) -> str:
    """
    获取 JCR 数据库路径。

    优先级:
    1. config["jcr"]["db_path"] (自定义路径)
    2. sidecar 同级 resources/jcr.db (打包后路径)
    3. 项目 data/jcr.db (开发环境默认路径)

    Args:
        config: 配置对象

    Returns:
        JCR 数据库的绝对路径
    """
    # 尝试从配置读取自定义路径
    jcr_config = config.get("jcr", {})
    if isinstance(jcr_config, dict):
        custom_path = jcr_config.get("db_path", "")
        if custom_path and Path(custom_path).exists():
            return str(Path(custom_path).resolve())

    # 打包后路径：sidecar 同级 resources/jcr.db
    # PyInstaller 打包后，__file__ 会指向临时目录，但可执行文件路径在 sys.executable
    import sys
    if getattr(sys, 'frozen', False):
        # 打包后：sidecar.exe 同级的 resources/jcr.db
        bundled_path = Path(sys.executable).parent / "resources" / "jcr.db"
        if bundled_path.exists():
            return str(bundled_path.resolve())

    # 开发环境默认路径：项目 data/jcr.db
    project_root = Path(__file__).parent.parent.parent  # backend/matrixit_backend -> project root
    default_path = project_root / "data" / "jcr.db"
    if default_path.exists():
        return str(default_path.resolve())

    # 开发环境回退路径（绝对路径）
    alt_path = Path("d:/Project/matrix-it/data/jcr.db")
    if alt_path.exists():
        return str(alt_path.resolve())

    return ""


def _normalize_journal_name(name: str) -> str:
    """
    标准化期刊名称,用于匹配。

    处理:
    - 去除首尾空格
    - 转换为大写
    - 移除常见变体符号

    Args:
        name: 原始期刊名称

    Returns:
        标准化后的名称
    """
    if not name:
        return ""
    # 基础清理
    normalized = name.strip().upper()
    # 移除 "THE " 前缀
    if normalized.startswith("THE "):
        normalized = normalized[4:]
    # 统一 & 和 AND
    normalized = normalized.replace(" & ", " AND ")
    return normalized


def _open_db_readonly(db_path: str) -> Optional[sqlite3.Connection]:
    """
    以只读模式打开 SQLite 数据库。

    Args:
        db_path: 数据库文件路径

    Returns:
        数据库连接,失败返回 None
    """
    if not db_path or not Path(db_path).exists():
        return None
    try:
        uri_path = Path(db_path).as_uri()
        conn = sqlite3.connect(f"{uri_path}?mode=ro", uri=True)
        return conn
    except Exception:
        return None


def query_impact_factor(
    journal_name: str,
    issn: Optional[str] = None,
    config: Optional[dict] = None,
) -> Optional[Dict]:
    """
    查询期刊的 JCR 影响因子和分区。

    匹配策略:
    1. 精确匹配期刊名称(不区分大小写)
    2. ISSN/eISSN 精确匹配
    3. 模糊匹配(相似度 > 90%)

    Args:
        journal_name: 期刊名称
        issn: ISSN 号(可选)
        config: 配置对象(可选)

    Returns:
        {
            "impact_factor": float,  # 影响因子
            "quartile": str,         # JCR 分区 (Q1/Q2/Q3/Q4)
            "rank": str,             # 排名 (如 "12/234")
            "category": str,         # 学科分类
            "year": int,             # 数据年份
        }
        未找到返回 None
    """
    if not journal_name and not issn:
        return None

    db_path = get_jcr_db_path(config or {})
    conn = _open_db_readonly(db_path)
    if not conn:
        return None

    try:
        cursor = conn.cursor()
        normalized_name = _normalize_journal_name(journal_name)

        # 策略1:精确匹配期刊名称
        cursor.execute(
            """
            SELECT Journal, "IF(2024)", "IF Quartile(2024)", "IF Rank(2024)", Category
            FROM JCR2024
            WHERE UPPER(Journal) = ?
            LIMIT 1
            """,
            (normalized_name,),
        )
        row = cursor.fetchone()

        # 策略2:ISSN 匹配
        if not row and issn:
            clean_issn = issn.strip().replace("-", "")
            cursor.execute(
                """
                SELECT Journal, "IF(2024)", "IF Quartile(2024)", "IF Rank(2024)", Category
                FROM JCR2024
                WHERE REPLACE(ISSN, '-', '') = ? OR REPLACE(eISSN, '-', '') = ?
                LIMIT 1
                """,
                (clean_issn, clean_issn),
            )
            row = cursor.fetchone()

        # 策略3:模糊匹配(LIKE)
        if not row and normalized_name:
            cursor.execute(
                """
                SELECT Journal, "IF(2024)", "IF Quartile(2024)", "IF Rank(2024)", Category
                FROM JCR2024
                WHERE UPPER(Journal) LIKE ?
                LIMIT 1
                """,
                (f"%{normalized_name}%",),
            )
            row = cursor.fetchone()

        if row:
            if_value = row[1]
            # 处理 IF 值(可能是字符串或数字)
            try:
                if_float = float(if_value) if if_value else 0.0
            except (ValueError, TypeError):
                if_float = 0.0

            return {
                "impact_factor": if_float,
                "quartile": str(row[2] or "").strip(),
                "rank": str(row[3] or "").strip(),
                "category": str(row[4] or "").strip(),
                "year": 2024,
            }

        return None

    except Exception:
        return None
    finally:
        conn.close()


def query_cas_partition(
    journal_name: str,
    issn: Optional[str] = None,
    config: Optional[dict] = None,
) -> Optional[Dict]:
    """
    查询期刊的中科院分区信息。

    Args:
        journal_name: 期刊名称
        issn: ISSN 号(可选)
        config: 配置对象(可选)

    Returns:
        {
            "category": str,         # 大类名称 (如 "工程技术")
            "partition": str,        # 大类分区 (如 "2区")
            "partition_raw": str,    # 原始分区信息 (如 "2 [45/234]")
            "top": bool,             # 是否 Top 期刊
            "sub_category": str,     # 小类名称
            "sub_partition": str,    # 小类分区
            "year": int,             # 数据年份
        }
        未找到返回 None
    """
    if not journal_name and not issn:
        return None

    db_path = get_jcr_db_path(config or {})
    conn = _open_db_readonly(db_path)
    if not conn:
        return None

    try:
        cursor = conn.cursor()
        normalized_name = _normalize_journal_name(journal_name)

        # 策略1:精确匹配期刊名称
        cursor.execute(
            """
            SELECT Journal, 大类, 大类分区, Top, 小类1, 小类1分区
            FROM FQBJCR2025
            WHERE UPPER(Journal) = ?
            LIMIT 1
            """,
            (normalized_name,),
        )
        row = cursor.fetchone()

        # 策略2:ISSN 匹配
        if not row and issn:
            clean_issn = issn.strip()
            cursor.execute(
                """
                SELECT Journal, 大类, 大类分区, Top, 小类1, 小类1分区
                FROM FQBJCR2025
                WHERE "ISSN/EISSN" LIKE ?
                LIMIT 1
                """,
                (f"%{clean_issn}%",),
            )
            row = cursor.fetchone()

        # 策略3:模糊匹配
        if not row and normalized_name:
            cursor.execute(
                """
                SELECT Journal, 大类, 大类分区, Top, 小类1, 小类1分区
                FROM FQBJCR2025
                WHERE UPPER(Journal) LIKE ?
                LIMIT 1
                """,
                (f"%{normalized_name}%",),
            )
            row = cursor.fetchone()

        if row:
            partition_raw = str(row[2] or "").strip()
            # 解析分区号 (如 "2 [45/234]" -> "2区")
            partition = ""
            if partition_raw:
                first_char = partition_raw[0]
                if first_char.isdigit():
                    partition = f"{first_char}区"

            is_top = str(row[3] or "").strip().lower() in ("是", "yes", "true", "1")

            return {
                "category": str(row[1] or "").strip(),
                "partition": partition,
                "partition_raw": partition_raw,
                "top": is_top,
                "sub_category": str(row[4] or "").strip(),
                "sub_partition": str(row[5] or "").strip(),
                "year": 2025,
            }

        return None

    except Exception:
        return None
    finally:
        conn.close()


def query_journal_info(
    journal_name: str,
    issn: Optional[str] = None,
    config: Optional[dict] = None,
) -> Tuple[Optional[Dict], Optional[Dict]]:
    """
    综合查询期刊信息(JCR + 中科院分区)。

    Args:
        journal_name: 期刊名称
        issn: ISSN 号(可选)
        config: 配置对象(可选)

    Returns:
        (jcr_data, cas_data) 元组
    """
    jcr_data = query_impact_factor(journal_name, issn, config)
    cas_data = query_cas_partition(journal_name, issn, config)
    return jcr_data, cas_data


# 模块自测
if __name__ == "__main__":
    import json

    test_journals = [
        "Nature",
        "Science",
        "PROCEEDINGS OF THE IEEE",
        "Automation in Construction",
        "Journal of Construction Engineering and Management",
    ]

    print("=== JCR 查询模块测试 ===\n")

    for journal in test_journals:
        print(f"期刊: {journal}")
        jcr, cas = query_journal_info(journal)
        if jcr:
            print(f"  JCR: IF={jcr['impact_factor']}, {jcr['quartile']}, Rank={jcr['rank']}")
        else:
            print("  JCR: 未找到")
        if cas:
            print(f"  中科院: {cas['category']} {cas['partition']}, Top={cas['top']}")
        else:
            print("  中科院: 未找到")
        print()
