## 结论（失败原因）
- 当前 capability 只启用了 `shell:default`（[default.json](file:///d:/Project/matrix-it/src-tauri/capabilities/default.json#L7-L37)），而 Shell 插件默认只允许打开 http/https/mailto/tel；对本地 PDF 路径会被拦截，所以 PDF 打不开。
- 点击后“隔很久才打开 URL”是因为先等待 `resolvePdfPath(item_key)`（会启动 Python sidecar，冷启动/读库导致延迟），再回退打开 URL。

## 采用的方案（按你的选择）
- 方案 B：引入 `tauri-plugin-opener`，用 `opener:allow-open-path` 打开本地文件路径；URL 仍用现有 shell open。
- “浏览器中打开 PDF”的默认实现：直接 openPath(绝对 pdf 路径)。系统若将 PDF 默认关联到浏览器，则会以默认浏览器打开。

## 具体改动
### 1) Rust：接入 Opener 插件
- 在 [Cargo.toml](file:///d:/Project/matrix-it/src-tauri/Cargo.toml) 增加依赖：`tauri-plugin-opener = "2.0.0"`。
- 在 [main.rs](file:///d:/Project/matrix-it/src-tauri/src/main.rs) 注册插件：`.plugin(tauri_plugin_opener::init())`。

### 2) Capability：放开 opener 的 open_path
- 在 [default.json](file:///d:/Project/matrix-it/src-tauri/capabilities/default.json) 增加权限：`opener:allow-open-path`（按 Context7 文档标识符）。

### 3) 前端：改用 Opener 打开本地路径
- 调整 [backend.ts](file:///d:/Project/matrix-it/frontend/src/lib/backend.ts)：
  - `openPath()` 在 Tauri 环境下改为调用 `plugin:opener|open_path`（而不是 `plugin:shell|open`）。
  - `openExternal()` 保持使用 `plugin:shell|open`（继续受 URL 白名单保护）。

### 4) 性能修复：resolve_pdf_path 改为纯 Rust（不启动 sidecar）
- 修改 Rust 的 `resolve_pdf_path` command：
  - 从 `data/matrixit.db` 读取 item JSON（Rust 里已有读库逻辑）。
  - 从 config.json 读取 `zotero.data_dir`。
  - 按后端同样规则推导 PDF 绝对路径（优先 item.pdf_path；否则用 attachments 推导 storage 路径/扫描目录找 pdf）。
  - 返回绝对路径给前端。

### 5) UI：保持“优先 PDF、否则 URL、都无置灰+Tooltip”
- 保留现有交互；仅让打开 PDF 的链路变成“可用且更快”。

## 验证
- 在 Tauri 环境点击“阅读原文”：
  - 有 PDF：应立即打开本地 PDF。
  - 无 PDF 但有 URL/DOI：应立即打开网页。
  - 都无：按钮置灰并 Tooltip 显示“没有附件”。
- 运行：前端 lint/build + `cargo check`。