import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = str((ROOT / "backend").resolve())
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)
os.environ.setdefault("PYTHONUTF8", "1")

from matrixit_backend import feishu, zotero


def main() -> None:
    tags_field = "标签"
    attach_field = "附件"
    fields_info = {tags_field: {"type": feishu.FIELD_TYPE_MULTI_SELECT}, attach_field: {"type": feishu.FIELD_TYPE_ATTACHMENT}}

    with tempfile.TemporaryDirectory() as td:
        tmp_dir = Path(td)
        linked_pdf = tmp_dir / "linked.pdf"
        linked_pdf.write_bytes(b"%PDF-1.4\n%...\n")

        item = {
            "item_key": "TEST",
            "title": "T",
            "collections": [{"name": "C"}],
            "meta_extra": {"tags": ["alpha", "beta"]},
            "attachments": [{"key": "ABCD1234", "filename": str(linked_pdf)}],
            "pdf_path": "",
        }

        p = zotero.resolve_pdf_path(item, zotero_dir=str(tmp_dir))
        assert p and Path(p).resolve() == linked_pdf.resolve()

        mapped = feishu.map_item(item, {"tags": tags_field, "attachment": attach_field}, file_token="tok", fields_info=fields_info)
        assert mapped[tags_field] == ["alpha", "beta"]
        assert mapped[attach_field] == [{"file_token": "tok"}]

        mapped2 = feishu.map_item(item, {"meta_extra.tags": tags_field}, file_token=None, fields_info=fields_info)
        assert mapped2[tags_field] == ["alpha", "beta"]

        storage_root = tmp_dir / "zotero"
        storage_pdf = storage_root / "storage" / "KEY00001" / "f.pdf"
        storage_pdf.parent.mkdir(parents=True, exist_ok=True)
        storage_pdf.write_bytes(b"%PDF-1.4\n%...\n")
        item2 = {"attachments": [{"key": "KEY00001", "filename": "f.pdf"}]}
        p2 = zotero.resolve_pdf_path(item2, zotero_dir=str(storage_root))
        assert p2 and Path(p2).resolve() == storage_pdf.resolve()

        item3 = {"attachments": [{"key": "KEY00001", "filename": "missing.pdf"}]}
        p3 = zotero.resolve_pdf_path(item3, zotero_dir=str(storage_root))
        assert p3 and Path(p3).resolve() == storage_pdf.resolve()

    print("OK")


if __name__ == "__main__":
    main()
