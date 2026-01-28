## 需求拆解
- 点击“阅读原文”时：优先打开该文献的 PDF 附件（系统默认方式打开，通常为默认浏览器/默认 PDF 查看器）。
- 若无附件：打开 URL（现有逻辑：url 优先，其次 doi 拼接 https://doi.org/{doi}）。
- 若附件与 URL 都没有：按钮置灰不可点，并在按钮上悬浮 Tooltip 提示“没有附件”。

## 现状确认（已检索）
- “阅读原文”按钮在 [LiteratureDetailDrawer.tsx](file:///d:/Project/matrix-it/frontend/src/ui/components/LiteratureDetailDrawer.tsx#L245-L367)，目前仅按 url/doi 生成 originalHref 并调用 openExternal 打开。
- 前端 openExternal 仅允许 http/https/mailto/tel，不支持 file/path（见 [backend.ts](file:///d:/Project/matrix-it/frontend/src/lib/backend.ts#L50-L87)）。
- 后端 item 里有 attachments（仅 PDF）与 pdf_path 字段，但 load_library 当前不会填充可直接打开的绝对 PDF 路径。

## 技术方案（最小改动、按需解析 PDF 路径）
### 1) Sidecar 增加单条 PDF 路径解析命令
- 在 [sidecar.py](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py) 新增子命令 `resolve_pdf_path`：
  - 入参：`item_key`（argv[2]）。
  - 逻辑：从本地 SQLite（storage.get_item）取出条目 JSON（包含 attachments），用 `zotero.resolve_pdf_path(item, zotero_dir, base_dir=root_dir)` 解析绝对 PDF 路径。
  - 出参（stdout 单个 JSON）：`{ "pdf_path": "..." }`；失败/不存在返回空字符串，并可带 error（不让 sidecar 崩溃）。

### 2) Rust 增加 Tauri Command：resolve_pdf_path
- 在 [main.rs](file:///d:/Project/matrix-it/src-tauri/src/main.rs) 增加 `#[tauri::command] async fn resolve_pdf_path(app, item_key) -> Result<String, ApiError>`：
  - 调用 sidecar：`matrixit-sidecar resolve_pdf_path <item_key>`，解析 stdout JSON，返回 pdf_path 字符串。
  - 将该 command 注册到 invoke handler。

### 3) 前端补齐两个能力：解析 PDF 路径 + 打开本地路径
- 在 [backend.ts](file:///d:/Project/matrix-it/frontend/src/lib/backend.ts) 新增：
  - `resolvePdfPath(itemKey: string): Promise<string>`：封装 `invoke('resolve_pdf_path', { itemKey })`。
  - `openPath(rawPath: string): Promise<{ opened: boolean }>`：在 Tauri 环境调用 `invoke('plugin:shell|open', { path: rawPath })`，用于打开本地文件路径（不走 URL 协议校验）；浏览器环境兜底返回 opened=false 或尝试 window.open。

### 4) 修改 LiteratureDetailDrawer 的按钮行为与 Tooltip
- 在 [LiteratureDetailDrawer.tsx](file:///d:/Project/matrix-it/frontend/src/ui/components/LiteratureDetailDrawer.tsx) 调整“阅读原文”按钮：
  - 计算 `hasPdfAttachment`：优先看 `item.pdf_path` 非空；否则看 `attachments` 数组是否有元素（后端已保证 attachments 只含 PDF）。
  - disabled 条件：`!hasPdfAttachment && !originalHref`。
  - Tooltip：仅在 disabled 时显示 title="没有附件"（用 span 包裹 disabled Button 以保证 Tooltip 可触发）。
  - 点击逻辑：
    1) 若 `hasPdfAttachment`：调用 `resolvePdfPath(item.item_key)` 获取绝对路径，成功则 `openPath(pdfPath)`。
    2) 若解析失败或返回空：回退到 `openExternal(originalHref)`（若存在）。
    3) 若没有附件但有 originalHref：直接 `openExternal(originalHref)`。

## 验证方式
- 前端：确保 TypeScript 编译通过且无未使用 import。
- 运行一次前端 lint/build（按项目现有脚本）。
- Tauri：cargo check（或项目已有测试命令）确保新增 command 编译通过。
- 手动验证：
  - 有附件：点击打开 PDF。
  - 无附件但有 URL/DOI：点击打开链接。
  - 两者都无：按钮置灰，hover 提示“没有附件”。

## 影响评估
- 仅新增一个按需解析 PDF 路径的调用链，不会在 load_library 阶段对全库做磁盘扫描，避免性能风险。
- 不新增文件，仅修改既有 TS/Rust/Python 文件与文档。