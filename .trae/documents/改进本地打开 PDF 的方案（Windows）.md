## 现状与推断原因（基于 Context7 + 现象）
- 你已经能“用浏览器打开 PDF”，这说明：PDF 路径本身可用、`file://` 形式也能被浏览器加载。
- 但“本地打开（系统默认关联打开 PDF）”仍失败，通常意味着：
  - Windows 没有为 .pdf 绑定默认打开程序，或默认程序异常；
  - 或 opener/shell 内部使用的系统打开方式在遇到特殊路径字符（空格、括号、&、中文、超长路径等）时失败。
- Context7 给出的官方推荐路径是 `@tauri-apps/plugin-opener` 的 `openPath()` 来打开本地文件；你当前已经走这条路，但仍失败，因此需要更底层、更贴近 Windows 的打开方式做兜底。

## 更优解决方案（目标：尽可能“本地打开”成功）
### 1) 增加一个“本地打开 PDF”的 Rust Command（绕开前端插件调用）
- 新增 `open_pdf_local(pdf_path)`：
  - 先 canonicalize 路径并检查文件存在
  - Windows 下优先用 `powershell Start-Process -FilePath <pdf>`（对带空格/特殊字符更稳）
  - 若失败，再 fallback 到 `app.opener().open_path(...)`
  - 返回结构化错误（包含尝试过的方案与错误信息）

### 2) 前端点击策略调整（本地优先，浏览器兜底）
- “阅读原文”流程：
  - `resolvePdfPath(item_key)` → 得到绝对路径
  - 先调用 `open_pdf_local(absPdf)`
  - 如果仍失败，自动调用现有的 `open_pdf_in_browser(absPdf)`（你已验证这条路可行）
  - 全程保留弹窗错误信息，便于定位“为什么本地打不开”（例如未关联默认 PDF 程序）

### 3) 额外兜底（用户体验）
- 若本地打开失败且浏览器兜底也失败：提供“在资源管理器中显示”能力（opener 的 reveal API），让用户至少能定位到文件手动打开。

## 验证
- `cargo check` + 前端 `npm run lint && npm run build`
- 在 Windows 上测试三种场景：
  - PDF 有默认打开程序：应本地打开
  - PDF 默认打开程序缺失/异常：应自动走浏览器兜底
  - 路径包含中文/空格/& 等字符：应仍可本地打开（Start-Process 更稳）