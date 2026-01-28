# MatrixIt 后端 Sidecar API 文档（v1）

对应实现： [sidecar.py](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py)（Python sidecar CLI，通过 stdout/stderr 与上层通信）

---

## 1. 总览

Sidecar 通过命令行子命令提供 5 类能力：

- `load_library`：读取 Zotero 数据库，写入本地 SQLite（主存），并返回收藏夹树 + 条目列表（同时导出 `data/literature.json` 快照）
- `resolve_pdf_path`：为单个 `item_key` 解析可用的 PDF 绝对路径（用于“打开附件”等按需场景）
- `analyze`：对指定 `item_key` 列表逐条分析（直接读取 Zotero storage 的 PDF → 提取文本 → 调用 LLM 输出结构化字段），并逐条输出事件
- `sync_feishu`：将指定 `item_key` 同步到飞书多维表（含字段自动创建、附件上传），并回写本地同步状态
- `update_item`：对本地条目执行字段级 patch 更新（保护部分核心字段不允许改）
- `get_items`：批量读取本地 SQLite 中的条目（不读 Zotero DB），用于分析 Finished 后即时回显矩阵字段
- `delete_extracted_data`：清除指定条目的“分析字段”（不删除元数据），并尝试删除飞书记录
- `format_citations`：用 CSL 引擎生成 GB/T 7714 引用（从条目 `meta_extra` 构造 CSL JSON）

---

## 2. 路径与环境变量约定

### 2.1 环境变量

| 变量名 | 含义 | 默认值 |
|---|---|---|
| `MATRIXIT_WORKDIR` | 项目根目录（用于解析 config/fields 相对路径） | `cwd` 自动探测 |
| `MATRIXIT_DATA_DIR` | 数据目录（DB/快照默认落这里） | `data/` |
| `MATRIXIT_DB` | SQLite 数据库路径 | `{data_dir}/matrixit.db` |
| `MATRIXIT_LITERATURE_JSON` | 导出快照路径 | `{data_dir}/literature.json` |
| `MATRIXIT_CONFIG` | 配置文件路径 | `{workdir}/config.json` |
| `MATRIXIT_FIELDS` | 字段定义文件路径 | `{workdir}/fields.json` |

实现细节：
- Sidecar 以 SQLite 为主存；`literature.json` 为导出快照（用于前端加载、迁移与排障）。
- 若 DB 为空且项目根目录存在旧版 `literature.json`，启动时会自动导入到 DB 并生成快照。

### 2.2 PDF 读取策略（你要求的“不导出”已落实）

分析/同步上传附件均通过 `resolve_pdf_path()` 定位 PDF：
1) 若条目有 `pdf_path` 且存在，则使用（相对路径按项目根目录解析）  
2) 否则从条目的 `attachments[0]` 推导 Zotero storage 路径：`{zotero_dir}/storage/{key}/{filename}`  
实现： [zotero.resolve_pdf_path](file:///d:/Project/matrix-it/backend/matrixit_backend/zotero.py#L105-L146)

---

## 3. 命令 API

以下命令均为：

```bash
python backend/matrixit_backend/sidecar.py <cmd> [args...]
```

### 3.1 `load_library`

**用途**：刷新本地库并返回收藏夹树 + 条目列表。

**请求**：
- `cmd = "load_library"`
- 无额外参数

**响应（stdout，单个 JSON）**：

成功：

```json
{
  "collections": [ { "key": "xxxx", "name": "集合名", "children": [] } ],
  "items": [ { "item_key": "...", "title": "...", "...": "..." } ]
}
```

失败（仍返回 JSON，不抛异常到上层）：

```json
{
  "collections": [],
  "items": [],
  "error": { "code": "ZOTERO_DB_NOT_FOUND", "message": "C:/.../zotero.sqlite" }
}
```

或：

```json
{
  "collections": [],
  "items": [],
  "error": { "code": "LOAD_LIBRARY_FAILED", "message": "..." }
}
```

实现： [load_library](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py#L93-L162)、main 分发 [sidecar.py](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py#L402-L408)

---

### 3.2 `resolve_pdf_path`

**用途**：为单个条目解析可用的 PDF 绝对路径（不扫描全库，按需调用）。

**请求**：
- `cmd = "resolve_pdf_path"`
- `argv[2]`：`item_key`

示例：

```bash
python backend/matrixit_backend/sidecar.py resolve_pdf_path "ABCD1234"
```

**响应（stdout，单个 JSON）**：

成功：

```json
{ "pdf_path": "C:/.../storage/XXXX/xxx.pdf" }
```

失败（或无附件）：

```json
{ "pdf_path": "", "error": { "code": "ITEM_NOT_FOUND", "message": "ABCD1234" } }
```

实现： [resolve_pdf_path](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py)

---

### 3.2 `analyze`

**用途**：对若干条目逐条分析，并以“事件流”形式输出进度/结果。

**请求**：
- `cmd = "analyze"`
- `argv[2]`：JSON 数组（item_key 列表）

示例：

```bash
python backend/matrixit_backend/sidecar.py analyze "[\"ABCD1234\",\"EFGH5678\"]"
```

**响应（stdout，多行 JSON 事件，每行一个对象）**：

- started 事件：

```json
{ "type": "started", "item_key": "ABCD1234" }
```

- finished 事件：

```json
{ "type": "finished", "item_key": "ABCD1234" }
```

- failed 事件（结构化错误码，部分情况带 message）：

```json
{
  "type": "failed",
  "item_key": "ABCD1234",
  "error": "PDF_NOT_FOUND",
  "error_code": "PDF_NOT_FOUND"
}
```

实现： [analyze](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py#L164-L339)、入口解析 [sidecar.py](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py#L410-L416)

**analyze 常见 error_code 列表**（当前实现）：
- `ITEM_NOT_FOUND`：本地库找不到该 item_key
- `PDF_NOT_FOUND`：无法从 `pdf_path`/`attachments` 推导到可读 PDF
- `PDF_TEXT_EMPTY`：PDF 可定位但提取文本为空（pdfplumber 返回空）
- `FIELDS_DEF_INVALID`：`fields.json` 缺少 `analysis_fields`
- `LLM_CONFIG_MISSING`：LLM 配置不完整
- `LLM_HTTP_ERROR` / `LLM_NETWORK_ERROR` / `LLM_REQUEST_FAILED`：模型请求失败
- `LLM_RESPONSE_INVALID` / `LLM_RESPONSE_MISSING` / `LLM_INVALID_JSON`：模型响应不符合预期

LLM 错误码来源： [llm.py](file:///d:/Project/matrix-it/backend/matrixit_backend/llm.py)

---

### 3.3 `sync_feishu`

**用途**：将指定条目同步至飞书多维表（含字段自动创建与附件上传），并写回 `record_id`、`sync_status`。

**请求**：
- `cmd = "sync_feishu"`
- `argv[2]`：JSON 数组（item_key 列表）

示例：

```bash
python backend/matrixit_backend/sidecar.py sync_feishu "[\"ABCD1234\"]"
```

**响应（stdout，单个 JSON）**：

成功：

```json
{ "uploaded": 1, "skipped": 0, "failed": 0 }
```

失败（main 层兜底，不让 sidecar 整体崩溃）：

```json
{ "error": { "code": "SYNC_FEISHU_FAILED", "message": "..." } }
```

实现： [sync_feishu](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py#L342-L345)、实际同步逻辑 [feishu.upload_literature](file:///d:/Project/matrix-it/backend/matrixit_backend/feishu.py#L223-L318)

---

### 3.4 `update_item`

**用途**：对单条条目做局部字段更新（patch）。

**请求**：
- `cmd = "update_item"`
- `argv[2]`：`item_key`
- `argv[3]`：patch JSON（字符串）；若为 `-` 则从 stdin 读取 JSON

示例：

```bash
python backend/matrixit_backend/sidecar.py update_item "ABCD1234" "{\"tldr\":\"...\"}"
```

**响应（stdout，单个 JSON）**：

成功：

```json
{ "updated": true }
```

失败：

```json
{ "error": { "code": "UPDATE_ITEM_FAILED", "message": "..." } }
```

实现： [update_item](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py#L348-L367)、入口分发 [sidecar.py](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py#L430-L445)

**保护字段（不会被 patch 覆盖）**：
- `item_key`, `attachments`, `collections`, `date_modified`, `item_type`

---

### 3.5 `get_items`

**用途**：批量读取条目（仅从本地 SQLite `matrixit.db`），用于前端在分析 Finished 后快速回填该条目的最新矩阵字段，避免等待 `load_library` 整库刷新。

**请求**：
- `cmd = "get_items"`
- `argv[2]`：JSON 数组（item_key 列表）；若为 `-` 则从 stdin 读取 JSON

示例（argv 传参）：

```bash
python backend/matrixit_backend/sidecar.py get_items "[\"ABCD1234\",\"EFGH5678\"]"
```

示例（stdin 传参）：

```bash
echo "[\"ABCD1234\",\"EFGH5678\"]" | python backend/matrixit_backend/sidecar.py get_items -
```

**响应（stdout，单个 JSON）**：

成功：

```json
{ "items": [ { "item_key": "ABCD1234", "...": "..." } ] }
```

失败兜底：

```json
{ "items": [], "error": { "code": "GET_ITEMS_FAILED", "message": "..." } }
```

实现： [sidecar.py](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py)（`get_items` 命令）

---

### 3.6 `delete_extracted_data`

**用途**：清除指定条目的“已提取/分析字段”（由 `fields.json` 的 `analysis_fields` 决定），不删除 Zotero 元数据；并尝试删除飞书多维表中对应记录（依赖条目上的 `record_id`）。

**请求**：
- `cmd = "delete_extracted_data"`
- `argv[2]`：JSON 数组（item_key 列表）

示例：

```bash
python backend/matrixit_backend/sidecar.py delete_extracted_data "[\"ABCD1234\"]"
```

**响应（stdout，单个 JSON）**：

```json
{
  "cleared": 1,
  "missing": 0,
  "analysis_fields": 10,
  "feishu": { "deleted": 1, "skipped": 0, "failed": 0 }
}
```

失败兜底：

```json
{ "error": { "code": "DELETE_EXTRACTED_FAILED", "message": "..." } }
```

实现： [delete_extracted_data](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py)、飞书删除 [delete_records](file:///d:/Project/matrix-it/backend/matrixit_backend/feishu.py)

---

### 3.7 `format_citations`

**用途**：对指定条目生成 GB/T 7714-2015（顺序编码）引用文本。

**请求**：
- `cmd = "format_citations"`
- `argv[2]`：JSON 数组（item_key 列表）；若为 `-` 则从 stdin 读取 JSON

示例（argv 传参）：

```bash
python backend/matrixit_backend/sidecar.py format_citations "[\"ABCD1234\",\"EFGH5678\"]"
```

示例（stdin 传参）：

```bash
echo "[\"ABCD1234\",\"EFGH5678\"]" | python backend/matrixit_backend/sidecar.py format_citations -
```

**响应（stdout，单个 JSON）**：

成功：

```json
{
  "citations": {
    "ABCD1234": "[1]作者. 题名[文献类型]. 期刊, 2024(1).",
    "EFGH5678": "[2]..."
  }
}
```

失败（main 层兜底，不让 sidecar 整体崩溃）：

```json
{ "error": { "code": "FORMAT_CITATIONS_FAILED", "message": "..." } }
```

**依赖说明（CSL 引擎）**：
**副作用（持久化责任在后端）**：
- 对成功生成的条目，后端会批量写入 SQLite（更新 `citation` 字段）并同步导出 `data/literature.json` 快照
- 返回体始终仅包含 `citations` 字典；持久化失败不会让命令崩溃，但可能导致某些条目未被写入（见日志/后续审计）
- 若某条目生成结果为空字符串或仅空白，将不会写入该条目的 `citation`

- 依赖 Python 包：`citeproc`、`citeproc-py-styles`（即 `citeproc_styles`）
- 若通过 PyInstaller 打包为 sidecar 可执行文件，需要确保 `citeproc` 的 `data/locales` 等资源文件被一并打包（否则会出现 locales.json 缺失错误）

实现： [citation.py](file:///d:/Project/matrix-it/backend/matrixit_backend/citation.py)、入口分发 [sidecar.py](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py)


## 4. 配置与数据结构

### 4.1 `config.json / config.local.json`（合并加载）

实现： [load_config](file:///d:/Project/matrix-it/backend/matrixit_backend/config.py#L22-L40)

- Zotero：

```json
{
  "zotero": { "data_dir": "C:/Users/<you>/Zotero" }
}
```

- 飞书：

```json
{
  "feishu": {
    "app_id": "...",
    "app_secret": "...",
    "bitable_url": "https://.../base/<app_token>/tblxxxx"
  }
}
```

也支持直接提供 `app_token`、`table_id`（若 `bitable_url` 可解析则会自动补齐）：[get_feishu_config](file:///d:/Project/matrix-it/backend/matrixit_backend/feishu.py#L56-L64)

- LLM（OpenAI-Style 接口；支持 Chat Completions 与 Responses）：

```json
{
  "llm": {
    "base_url": "https://example.com/v1",
    "model": "your-model",
    "api_key": "******",
    "timeout_s": 60,
    "temperature": 0.2,
    "max_input_chars": 12000,
    "multimodal": false,
    "api": "chat_completions",
    "max_pdf_bytes": 8388608
  }
}
```

字段说明：
- `llm.api`：
  - `chat_completions`：调用 `{base_url}/chat/completions`（文本模式）
  - `responses`：调用 `{base_url}/responses`（多模态 PDF 上传，使用 `input_file`）
- `llm.multimodal=true` 时，`analyze` 会优先尝试 `responses` 链路；失败自动回退到 `chat_completions`。
- `llm.max_pdf_bytes`：多模态上传时允许的最大 PDF 字节数（超过则直接走文本回退）。

解析逻辑： [load_llm_config](file:///d:/Project/matrix-it/backend/matrixit_backend/llm.py#L25-L55)

### 4.2 `fields.json`

用于两件事：
- 定义分析字段（`analysis_fields`）供 LLM 输出对齐
- 定义与飞书字段映射（`feishu_field`），并自动创建缺失字段

见：[fields.json](file:///d:/Project/matrix-it/fields.json)、字段保障逻辑 [ensure_fields](file:///d:/Project/matrix-it/backend/matrixit_backend/feishu.py#L132-L149)

---

## 5. 已知限制（与 PRD 对照）

已补齐：

- `analyze` 支持“多模态优先 + 文本回退”：
  - 当 `config.llm.multimodal` 为 `true` 时，优先通过多模态接口（OpenAI-Style Responses）将 PDF 以 base64 形式作为 `input_file` 上传，并与提示词一起分析；
  - 若多模态接口不可用/失败，则自动回退到“本地提取文本 + Chat Completions”链路；
  - OCR 回退暂不实现（按你的要求），仅限 PDF 文本提取失败时标记 `PDF_TEXT_EMPTY`。
- 引入本地 SQLite 双写：
  - SQLite 为主存：条目以 JSON 形式写入 `{data_dir}/matrixit.db`（可通过 `MATRIXIT_DB` 覆盖路径）；
  - `literature.json` 为导出快照：默认导出到 `{data_dir}/literature.json`（可通过 `MATRIXIT_LITERATURE_JSON` 覆盖路径）；
  - 目前提供基础 `items(item_key PRIMARY KEY, json TEXT)` 表结构，便于后续扩展队列/审计能力。
