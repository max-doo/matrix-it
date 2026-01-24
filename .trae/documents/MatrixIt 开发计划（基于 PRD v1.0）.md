## 目标与范围

* **MVP（P0）**：完成“Zotero → 本地矩阵（可编辑）→ 一键批量分析 → 自动同步飞书多维表格（含PDF附件）”闭环。

* **P1**：Prompt 设置（系统提示词编辑 + 预设模板）、字段定义可视化编辑（导入/导出 JSON）。

* **明确不做/后置**：复杂 OCR（扫描件识别）、多模型路由高级策略、协作/多账号、云端存储。

## 技术架构（与 PRD 对齐）

* **桌面壳**：Tauri（Rust）作为主进程。

* **前端 UI**：Vite + React + TailwindCSS（PRD 推荐）。

* **后端逻辑**：Python Sidecar（复用现有 `literature_extraction` 脚本能力）。

* **通信**：前端 `invoke` 调 Rust command；Rust 通过 shell sidecar 运行 Python，并用 **Channel/事件** 向前端推送队列进度（Context7/Tauri 文档中有官方模式：invoke + Channel、sidecar output）。

## 数据模型与本地存储

* **本地为本**：引入 MatrixIt 本地 SQLite

* **核心状态字段（按 PRD）**：

  * `processed_status`: 未处理/处理中/已完成/失败

  * `sync_status`: 未同步/已同步/有更新待同步

  * `record_id`: 飞书 record\_id（用于更新而不是重复创建）

  * `updated_at` / `source_date_modified`（用于增量判断）

## Python Sidecar（复用与扩展）

* **Zotero 读取**（复用 `prep.py` 的安全复制只读模式）：

  * 输出 collections 树 + items 列表（含 attachments/pdf\_path）。

  * 保留 `date_modified` 以支持增量刷新。

* **PDF 读取与兜底**：

  * 首选：若未来接入支持 PDF 文件上传的模型，走“文件上传/多模态”。

  * 兜底：本地用 `pdfplumber` 逐页提取文本（Context7/pdfplumber 文档：`pdfplumber.open(...); page.extract_text(...)`，支持 password、laparams 等），失败则标记该条为失败但不阻塞队列。

* **LLM 抽取引擎**：

  * 以 `fields.json` 生成字段指令；将 `references/prompts.md` 作为默认系统提示词模板（规则A/B）。

  * 输出严格 JSON（字段与 `fields.json.analysis_fields` 对齐）。

* **同步飞书**（复用 `publish.py` 的字段创建、附件上传、记录写入逻辑，并改造为“upsert”）：

  * 若已存在 `record_id`：走 update；否则 create。

  * 同步结束回写 `sync_status`。

## Rust/Tauri 中间层（稳定边界）

* **命令接口**（前端唯一入口）：

  * `load_library(collection_id?)`：返回集合树与列表（带状态）。

  * `start_analysis(item_keys, options, onEvent: Channel)`：启动队列，逐条推送 `started/progress/finished/failed`。

  * `sync_feishu(item_keys?)`：同步已完成且未同步/有更新的数据。

  * `read_config/save_config`：配置读写（后续替换为系统安全存储）。

* **Sidecar 调用规范**：

  * 统一 JSON 入参/出参；stdout 仅输出 JSON 或事件行，便于解析。

  * 所有错误转为结构化错误码，前端可提示并允许重试。

## UI/UX（使用 UI 设计 skill 的规范化落地）

* **整体风格**：轻快、简约、高级（Minimal + 清晰留白）。

* **配色（PRD 约束）**：

  * 主色：Tiffany Blue `#0ABAB5`（主要按钮、选中状态、进度条）。

  * 背景：`#F5F7FA`（浅灰）+ 白色卡片。

  * 文本：深色（接近 slate-900）确保可读性；对比度遵循可访问性 4.5:1。

* **交互可用性（skill 关键规则）**：

  * 所有可点击元素 ≥ 44×44；按钮异步时禁用并展示加载态。

  * 明确 focus ring，键盘可导航；图标使用统一 SVG 图标集（避免 emoji 图标）。

  * 长列表使用虚拟滚动，避免 5000+ 条卡顿。

* **页面结构（PRD 左右分栏）**：

  * Sidebar（250px）：顶部设置按钮（抽屉）、中部集合树、底部状态栏。

  * Main：顶部筛选 Segmented Control（全部/未处理/已处理）+ 开始分析/手动同步；主体为文献列表 + 可切换表格视图（密集编辑）。

  * 状态指示：未处理/分析中/已完成/失败 + 已同步标识（用 SVG）。

## 配置与安全

* **敏感信息治理**：现有根目录 `config.json` 已包含 app\_secret 等敏感信息，需调整为：

  * 提供 `config.example.json` 模板；真实 `config.json` 加入 gitignore。

  * 应用内存储改为系统安全存储（后续落地）。

* **路径**：所有内部引用使用相对路径；Zotero 路径由用户配置。

## 打包与发布

* **Python**：PyInstaller 打包为单可执行 sidecar（按 PRD），随 Tauri 一起分发。

* **Tauri**：配置 sidecar 资源与平台差异（Windows/macOS/Linux）。

## 测试与验收（面向 PRD 指标）

* **离线可用**：无网也能浏览/编辑本地矩阵。

* **稳定性**：单条失败不阻塞队列；支持重试。

* **性能**：Zotero 读取 <3s（5000 条级别）；列表虚拟滚动流畅。

* **同步正确性**：字段自动创建、附件可上传、记录可更新不重复。

## 交付拆分（建议实现顺序）

1. 搭建 Tauri + 前端工程骨架 + 侧边栏/主列表 UI 框架。
2. 接入 Python sidecar：实现 Zotero 读取与列表渲染（含筛选/多选/状态）。
3. 实现分析队列：前端进度条 + Rust Channel 推送 + Python LLM 抽取（先文本兜底）。
4. 实现本地持久化与编辑：状态字段完整落地。
5. 飞书 upsert 同步 + 附件上传 + 状态回写。
6. 配置与安全收口（config 模板/忽略/安全存储）+ 打包发布流程。

