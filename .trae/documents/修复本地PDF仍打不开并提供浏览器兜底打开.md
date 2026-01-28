## 现象复盘
- 现在点击“阅读原文”仍打不开 PDF，且最终会打开 URL。
- 这说明：PDF 打开链路（路径解析或真正 open）仍然失败，但前端把错误吞掉了，所以 UI 没有任何提示，导致看起来“什么都没发生”。

## 最可能原因（按概率排序）
1) **openPath 的调用方式不对**：目前前端是 `invoke('plugin:opener|open_path', { path })`，如果 command 名或参数形状与插件实际不一致，就会直接失败。
2) **传入了相对路径**：`item.pdf_path` 可能是 `pdfs/...` 相对路径，opener 对相对路径不一定能打开；应确保永远传绝对路径（靠 resolvePdfPath 输出）。
3) **真正的错误被吞掉**：LiteratureDetailDrawer 里多段 `catch {}` 让任何失败都静默发生，导致无法定位。

## 目标
- 让 PDF 能稳定打开（系统默认关联应用；若用户把 PDF 默认程序设为浏览器，则自然会在浏览器打开）。
- 同时提供一个“更容易成功”的浏览器兜底方案（不依赖 PDF 默认关联）。

## 具体改动（我会一起落地）
### 1) 前端改为使用官方 JS 绑定（避免命令名/参数不一致）
- 在 frontend 增加依赖 `@tauri-apps/plugin-opener`。
- 在 [backend.ts](file:///d:/Project/matrix-it/frontend/src/lib/backend.ts) 中，`openPath()` 改为调用 `@tauri-apps/plugin-opener` 的 `openPath(path)`（而不是手写 invoke）。
  - URL 仍然走现有 `openExternal()`（shell open + URL 白名单）。

### 2) 强制传绝对路径
- 在 [LiteratureDetailDrawer.tsx](file:///d:/Project/matrix-it/frontend/src/ui/components/LiteratureDetailDrawer.tsx) 调整点击逻辑：
  - 不再直接尝试 `openPath(item.pdf_path)`（因为可能是相对路径）。
  - 统一先调用 `resolvePdfPath(item_key)` 取绝对路径；拿到绝对路径后再 `openPath(absPath)`。

### 3) 增加可见错误提示，定位失败原因
- 把当前静默 `catch {}` 改成 `message.error(...)` 或 `modal.error(...)` 展示错误信息（至少包含 `Error.message`）。
- 这样就算最终回退打开 URL，也能看到“PDF 打开失败”的具体原因（比如：command not found / 权限不足 / 文件不存在）。

### 4) 浏览器兜底打开（更容易成功）
- 新增一个 Tauri command：`open_pdf_in_browser(pdf_path)`：
  - 生成一个临时 HTML（内容用 `<embed src="file:///...pdf" type="application/pdf">`），写到 `data/` 或系统 temp。
  - 使用 opener `open_path` 打开该 HTML（默认打开程序基本就是浏览器），从而在浏览器里展示 PDF。
- 前端策略：若 `openPath(absPdf)` 失败，则自动调用 `open_pdf_in_browser(absPdf)` 再试一次。

## 验证
- 运行 `npm run lint && npm run build`。
- 运行 `cargo check`。
- 手动点“阅读原文”：
  - 有 PDF：应打开（优先系统默认；失败则自动走浏览器兜底）。
  - 无 PDF：应立即打开 URL/DOI。
  - 都无：按钮置灰 + tooltip“没有附件”。