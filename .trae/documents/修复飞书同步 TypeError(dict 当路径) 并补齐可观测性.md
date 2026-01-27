## 现状核对（基于你提供的“上次修改日志”）
- `feishu.py` 里 schema 缓存写入已经是“尽力而为”且异常只写 stderr，不会中断同步主流程：这点在当前代码中已存在（`save_local_config_patch(...)` 有 try/except）：[feishu.py:L444-L453](file:///d:/Project/matrix-it/backend/matrixit_backend/feishu.py#L444-L453)。
- Rust/Tauri `sync_feishu` 已改为 spawn 流式读取 stdout/stderr 并 eprint stderr：当前代码也符合：[main.rs:L497-L540](file:///d:/Project/matrix-it/src-tauri/src/main.rs#L497-L540)。

## 结论（对“dict/pathlike 报错来源”的再评估）
- 既然 schema 缓存写入已被 try/except 包住，**它理论上不应再导致整次同步直接失败**。
- 如果你仍然在 UI 看到 `argument should be a str or an os.Pathlike object ... not 'dict'`，更可能是同步流程更早的位置把 dict 传给了 `Path(...)` / `open(...)` / `os.path.*`，例如：
  - 数据库路径：`Path(db_path)` / `sqlite3.connect(db_path)`：[storage.py:L35-L47](file:///d:/Project/matrix-it/backend/matrixit_backend/storage.py#L35-L47)
  - Zotero 路径：`Path(zotero_dir)`：[zotero.py:L511-L537](file:///d:/Project/matrix-it/backend/matrixit_backend/zotero.py#L511-L537)

## 计划（在不新增文件的前提下“一次性定位 + 修复 + 防回归”）
### 1) 把“真实堆栈”带回前端（你无需依赖终端）
- 修改 `sidecar.py` 的 `cmd == "sync_feishu"` 异常分支：除 `str(e)` 外，额外把 `traceback.format_exc()`（截断后）塞进返回 JSON（例如 `error.detail`），并附带关键变量的 `type()` 信息（`db_path/config_path/fields_path/zotero.data_dir`）。
- 这样即使是打包版没有终端，你也能在 UI 里直接看到**触发行号**，无需猜测“到底是哪一个 Path() 收到了 dict”。

### 2) 在路径入口做类型归一化（修复根因，而不是只改提示）
- 在 Python 侧增加一个小的“路径归一化”函数（不新建文件，直接放在现有模块里）：
  - 允许 `str` / `Path`；
  - 兼容常见错误形态 dict（例如 `{path: "..."}`）并自动提取；
  - 否则抛出带字段名的 ValueError。
- 将该归一化应用到：
  - `storage.ensure_db`/`storage.get_items` 的 `db_path`
  - `zotero.get_zotero_dir` 的 `data_dir`
  - `sidecar.py` 里 `_resolve_with_base` 的入参（作为最后一道保险）

### 3) Rust 侧阻断“配置被写坏”（可选但推荐）
- 在 `save_config` 命令写盘前校验/归一化 `zotero.data_dir`：
  - 若是字符串，直接写；
  - 若是对象且含 `path` 字段字符串，则自动转成字符串写；
  - 其他情况直接返回错误，避免把 dict 永久写进 `config/config.json`。

## 验证（实现后如何确认已解决）
- 触发一次“同步到飞书”：
  - dev 模式：确认终端能实时看到 `[FEISHU] ...` 进度；
  - 任意模式：若仍失败，UI 报错应包含 traceback（能精确指向是 `storage.py` / `zotero.py` / 其他模块的哪一行）。
- 根据 traceback 指向的唯一触发点，再做最小修复（大概率只需把某个 dict→str 归一化）。

这版计划会把“猜来源”变成“直接看到触发行”，并且把修复做成对异常输入的稳健处理，后续不会再出现同类 dict/pathlike 报错。