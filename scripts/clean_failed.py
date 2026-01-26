import sqlite3
import os
import time
import json

def clean_database():
    db_path = os.path.abspath(os.path.join("data", "matrixit.db"))
    print(f"Checking database at: {db_path}")

    if not os.path.exists(db_path):
        print("Error: Database file not found!")
        return

    try:
        conn = sqlite3.connect(db_path, timeout=10.0)
        cursor = conn.cursor()

        print("Connected to database.")

        # Get all items
        cursor.execute("SELECT item_key, json FROM items")
        rows = cursor.fetchall()

        updated_count = 0
        for item_key, json_str in rows:
            try:
                item = json.loads(json_str)
                if item.get("processed_status") == "failed":
                    print(f"Cleaning failed item: {item_key}")
                    item["processed_status"] = "unprocessed"
                    # Update the item in the database
                    new_json_str = json.dumps(item, ensure_ascii=False)
                    cursor.execute(
                        "UPDATE items SET json = ? WHERE item_key = ?",
                        (new_json_str, item_key)
                    )
                    updated_count += 1
            except json.JSONDecodeError:
                print(f"Error decoding JSON for item: {item_key}")
                continue

        if updated_count > 0:
            conn.commit()
            print(f"Successfully cleaned {updated_count} items.")
        else:
            print("No items with 'failed' status found.")

        conn.close()
        print("Done.")

    except sqlite3.OperationalError as e:
        print(f"Database error (locked?): {e}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    clean_database()
