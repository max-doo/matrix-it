"""
测试 rating 和 progress 字段的保存与加载流程
"""
import sqlite3
import json
import sys
import os

# 添加 backend 到路径
sys.path.insert(0, os.path.abspath("backend"))

from matrixit_backend import storage

db_path = r"data\matrixit.db"
item_key = "NYKZQ6PT"

print("=" * 50)
print("1. 直接读取 SQLite 数据库")
print("=" * 50)

conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute("SELECT json FROM items WHERE item_key = ?", [item_key])
row = cur.fetchone()
conn.close()

if row:
    d = json.loads(row[0])
    print(f"  item_key: {item_key}")
    print(f"  rating: {d.get('rating')!r}")
    print(f"  progress: {d.get('progress')!r}")
else:
    print(f"  Item {item_key} not found")

print()
print("=" * 50)
print("2. 通过 storage.get_item 读取")
print("=" * 50)

item = storage.get_item(db_path, item_key)
if item:
    print(f"  item_key: {item_key}")
    print(f"  rating: {item.get('rating')!r}")
    print(f"  progress: {item.get('progress')!r}")
else:
    print(f"  Item {item_key} not found")

print()
print("=" * 50)
print("3. 测试更新 progress 字段")
print("=" * 50)

if item:
    item["progress"] = "Testing"
    storage.upsert_item(db_path, item)
    print("  已更新 progress 为 'Testing'")
    
    # 重新读取验证
    item2 = storage.get_item(db_path, item_key)
    print(f"  验证 - progress: {item2.get('progress')!r}")
    
    # 恢复原值
    item2["progress"] = None
    storage.upsert_item(db_path, item2)
    print("  已恢复 progress 为 None")
