## 关键判断（为什么浏览器能开、但本地 opener 打不开）
- 你已确认系统 PDF 关联正常（Adobe）。同时“浏览器兜底”能打开，说明 **PDF 文件真实存在且可访问**。
- 因此失败更可能在“传给 opener 的路径字符串格式”上。
- 目前 Rust 的 `resolve_pdf_path` 会优先 `std::fs::canonicalize()`，在 Windows 上这常返回 `\\?\C:\...`（扩展长度前缀）。很多“系统默认打开/第三方打开器”对这种前缀兼容不好，导致 `openPath()` 失败。
- Context7 的 opener 文档示例里 `openPath('/path/to/file')` 都是普通路径字符串，并未提及 `\\?\` 前缀，这也侧面说明应优先传“普通路径”。

## 更优解决方案（最小改动、命中根因）
### 1) 让 resolve_pdf_path 返回“普通 Windows 路径”
- 修改 [main.rs](file:///d:/Project/matrix-it/src-tauri/src/main.rs) 里 `resolve_pdf_path`：
  - 不再把 `canonicalize()` 的结果直接返回；改为：
    - 仍然用 `exists()` 检查文件存在
    - 返回 `PathBuf` 的普通显示字符串（不带 `\\?\`）
  - 或者：若必须 canonicalize，则在返回前做一次 **去前缀规范化**：
    - `\\?\C:\...` → `C:\...`
    - `\\?\UNC\server\share\...` → `\\server\share\...`

### 2) 双保险：openPath 调用前做路径清洗
- 修改前端 [backend.ts](file:///d:/Project/matrix-it/frontend/src/lib/backend.ts) 的 `openPath()`：
  - 在调用 `@tauri-apps/plugin-opener` 之前，先对入参做一次同样的前缀清洗（防止未来其他入口传入 `\\?\`）。

### 3) 验证与回归
- 构建验证：`npm run lint && npm run build`，`cargo check`。
- 手动验证：
  - 有 PDF：点击“阅读原文”应直接用 Adobe 打开（无需走浏览器兜底）。
  - 路径包含中文/空格：仍能打开。
  - 若仍失败：弹窗会给出具体错误信息（已存在），再针对错误继续修。

## 不采用的方案（原因）
- 用 PowerShell/`cmd start` 强开：属于执行任意命令，和项目规则（Rust 禁执行任意命令）相冲突，优先不走。