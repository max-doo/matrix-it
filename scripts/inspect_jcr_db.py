"""
临时脚本:查看 ShowJCR 数据库结构
"""
import sqlite3
import sys

db_path = r"D:\Project\ShowJCR-master\中科院分区表及JCR原始数据文件\jcr.db"

try:
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # 获取所有表名
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = cursor.fetchall()
    
    print("=== 数据库中的表 ===")
    for table in tables:
        print(f"- {table[0]}")
    
    print("\n=== JCR2024 表结构 ===")
    cursor.execute("PRAGMA table_info(JCR2024)")
    columns = cursor.fetchall()
    for col in columns:
        print(f"{col[1]:30s} {col[2]:15s}")
    
    print("\n=== JCR2024 示例数据(前3条) ===")
    cursor.execute("SELECT * FROM JCR2024 LIMIT 3")
    rows = cursor.fetchall()
    for row in rows:
        print(row)
    
    print("\n=== FQBJCR2025 表结构 ===")
    cursor.execute("PRAGMA table_info(FQBJCR2025)")
    columns = cursor.fetchall()
    for col in columns:
        print(f"{col[1]:30s} {col[2]:15s}")
    
    print("\n=== FQBJCR2025 示例数据(前3条) ===")
    cursor.execute("SELECT * FROM FQBJCR2025 LIMIT 3")
    rows = cursor.fetchall()
    for row in rows:
        print(row)
    
    conn.close()
    print("\n查询完成!")
    
except Exception as e:
    print(f"错误: {e}", file=sys.stderr)
    sys.exit(1)
