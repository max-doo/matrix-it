## 现象根因（基于当前代码结构）
### 1) Zotero 标签上传失败
- Zotero 导入时，标签被写在 `item.meta_extra.tags`（List[str]），而不是 `item.tags` 顶层字段：见 [zotero.py](file:///d:/Project/matrix-it/backend/matrixit_backend/zotero.py#L215-L263)。
- 飞书同步的 `map_item` 只会读取 `item[jk]`（顶层键），因此当你在字段配置里填了 `tags`（或 UI 里新增 key=tags），同步时会直接被跳过：见 [feishu.map_item](file:///d:/Project/matrix-it/backend/matrixit_backend/feishu.py#L319-L370)。

### 2) PDF 附件没有上传
- 飞书同步上传 PDF 的前置条件是 `resolve_pdf_path(...)` 能找到本地 PDF 路径，否则不会调用 `upload_file`：见 [feishu.upload_items](file:///d:/Project/matrix-it/backend/matrixit_backend/feishu.py#L498-L503)。
- 当前 Zotero 附件解析只保存 `attachments: [{key, filename}]`，并把 `storage:` 前缀剥离。随后 `get_storage_pdf_path` 只按 `zotero_dir/storage/<key>/<filename>` 拼路径：见 [zotero.py](file:///d:/Project/matrix-it/backend/matrixit_backend/zotero.py#L198-L214)、[get_storage_pdf_path](file:///d:/Project/matrix-it/backend/matrixit_backend/zotero.py#L515-L541)。
- 对“**链接附件**”（Zotero 里链接到外部路径的 PDF）或 Zotero 数据库里 `path` 不是 `storage:` 形式的情况，当前逻辑会拼出错误路径，导致找不到文件，从而 PDF 不会上传。

## 最佳实践方案（准确性 + 性能）
### A. 标签同步：支持嵌套字段与兼容 key=tags
- 支持 `fields` 配置里用 `meta_extra.tags` 作为源字段（推荐，表达清晰）。
- 同时做兼容：如果字段 key 仍是 `tags`，但 `item.tags` 不存在，则自动回退读取 `item.meta_extra.tags`。
- 多选字段按飞书 multi_select 规范传 List[str]（当前已有 multi_select 处理，缺的是取值方式）。

### B. PDF 同步：更鲁棒的 PDF 路径解析（不额外拷贝文件）
- 改造 `resolve_pdf_path / get_storage_pdf_path` 逻辑：
  - 遍历所有 `attachments`（而不是只取第 1 个）。
  - 若 `attachment.filename` 本身是绝对路径且文件存在 → 直接使用（适配链接附件）。
  - 否则按 `zotero_dir/storage/<key>/<filename>` 查找（适配存储附件）。
  - 若 `filename` 为空或不匹配（有些库里记录不规范）→ 额外做一次轻量 fallback：扫描 `zotero_dir/storage/<key>/` 下的 `*.pdf` 取第一个（或最大文件）。
- 这样不需要先执行 `extract_attachments`（避免大量复制文件带来的时间/空间成本）。

### C. 同步耗时优化（不牺牲一致性）
- **不重复上传 PDF**：为 item 增加 `feishu_file_token` 与 `pdf_mtime`（或 `pdf_size`）缓存。
  - 若本地 PDF 未变化且已有 file_token → 同步时直接复用 token，不再上传。
  - 只有首次同步或 PDF 变更时才上传。
- **更可观测**：在 `upload_file` 失败时输出明确 `code/msg/log_id`，并在 stats 里增加 `pdf_uploaded/pdf_skipped/pdf_failed`，便于定位是“找不到文件”还是“飞书权限/大小限制”。

## 具体落地改动（按最小风险顺序）
### 1) 后端：修复标签取值
- 修改 [feishu.py](file:///d:/Project/matrix-it/backend/matrixit_backend/feishu.py) 的 `map_item`：
  - 增加“点路径取值”函数（如 `meta_extra.tags`）。
  - 增加对 `tags` 的回退读取（`meta_extra.tags`）。

### 2) 后端：修复 PDF 路径解析
- 修改 [zotero.py](file:///d:/Project/matrix-it/backend/matrixit_backend/zotero.py) 的 `resolve_pdf_path/get_storage_pdf_path`：
  - 支持绝对路径附件、遍历多附件、storage 目录 fallback。

### 3) 后端：PDF 上传的可观测与缓存
- 修改 [feishu.py](file:///d:/Project/matrix-it/backend/matrixit_backend/feishu.py) 的 `upload_file/upload_items`：
  - 失败时带 `code/msg/log_id` 输出；stats 增加 PDF 计数。
  - 引入 `feishu_file_token/pdf_mtime` 缓存规则（不破坏旧数据，字段不存在则按首次处理）。

### 4) 验证方式
- 在终端打开飞书同步日志：
  - 选择一个有标签 + 有 PDF 的条目：确认 tags 字段进入 multi_select，且出现 “上传 PDF → 获得 file_token”。
  - 选择一个“链接附件”的条目：确认能直接识别绝对路径并上传。
  - 重复同步同一条目：确认 PDF 不再重复上传（pdf_skipped 增加）。

如果你同意，我将按上述 1→2→3→4 的顺序实现，并在完成后给出你需要在字段配置里使用的推荐 key（例如把标签字段配置成 `meta_extra.tags`，附件字段仍用 `attachment`）。