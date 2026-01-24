## 对照结论（PRD vs 现状）
- 已实现：Zotero 只读读取与锁库规避、收藏夹树构建、literature.json 本地库合并、PDF 文本提取（pdfplumber）、飞书多维表字段自动创建与记录创建/更新、update_item 局部更新、分析过程逐条事件输出（started/finished/failed）。
- 未实现（PRD 关键缺口）：LLM 分析与 Prompt 引擎（按 fields.json 生成结构化字段）、多模态优先+文本回退、可恢复的队列/重试策略、自建本地 SQLite 存储层。

## 你新增的约束
- PDF 不从 Zotero 导出到项目目录：不再生成/维护 `pdfs/`，而是**直接从 Zotero storage 读取原始 PDF**。

## 需要先修的问题（否则会影响体验/稳定性）
- 状态字段“双轨”：processed(bool) 与 processed_status/sync_status 并存，筛选口径容易不一致。
- 路径依赖 cwd：相对路径/字段文件在打包与桌面端容易误判。
- PDF 定位策略要统一：优先使用 Zotero storage 路径（由 zotero_dir + attachments 推导）。

## 建构计划（按你的要求全部执行）
### 1) 稳定性与一致性（不改对外命令协议）
- 统一“基准目录”：以 literature.json 所在目录作为 base_dir，解析 config/fields 等相对路径，避免 cwd 漂移。
- 统一状态来源：以 processed_status/sync_status 为准；processed 作为兼容字段（派生/同步写入）或逐步移除其业务含义。
- 输出事件补强：failed 事件带结构化 error_code/message，便于前端提示与重试。

### 2) PDF 直接读取（替代导出）
- 在分析/同步处统一实现 `resolve_pdf_path(item, zotero_dir)`：
  - 若 item.pdf_path 存在且可用则用；
  - 否则从 item.attachments[0] 推导 `zotero_dir/storage/<key>/<filename>` 并直接读取；
  - 不创建 pdfs/，不写回导出路径。
- 将现有 `zotero.extract_attachments()` 从 analyze 流程中移除/降级为可选（默认不调用）。

### 3) LLM 分析与 Prompt 引擎（实现 PRD“智能提取”核心）
- 读取 fields.json 的 analysis_fields：按字段 rule(A/B)+description 组装 prompt；默认系统提示词复用 backend/docs/prompts.md。
- 新增 llm 配置读取：config.json/config.local.json 中读取 llm.provider/base_url/model/api_key（不打印、不落盘密钥）。
- sidecar analyze：
  - 提取 PDF 文本（现有 pdfplumber）；
  - 调用 LLM 生成符合 fields.json 的 JSON；
  - merge 回对应 item，并维护 processed_status/sync_status 状态机。

### 4) 多模态 + 文本回退（阶段化交付）
- 先交付“文本模式 + 结构化字段提取”（满足 P0 的核心价值）。
- 多模态与 OCR 回退作为下一阶段：需要确定目标模型 API 与引入依赖（更新 requirements.txt）。

### 5) 队列化/本地 SQLite（阶段化交付）
- MVP 继续沿用 literature.json（满足“本地优先+可编辑”基础）。
- 若你确认必须做到“可恢复队列/审计/复杂筛选”，再引入自建 SQLite 与新增 sidecar 子命令。

## 涉及文件范围（预计）
- 必改：backend/matrixit_backend/sidecar.py（移除导出、统一 PDF 定位、LLM 分析、状态统一、错误码）、feishu.py（同步时用统一 PDF 定位）、zotero.py（保留附件信息但不再导出）、config.py（增加 llm 配置读取）、jsonio.py（如需写入更稳健）。
- 可能新增（需你同意）：backend/matrixit_backend/llm.py（HTTP 调用封装）、backend/matrixit_backend/prompt_builder.py（prompt 组装与 fields 映射）。若你不希望新增文件，我也可以把这两块先写在 sidecar.py 内（但可维护性较差）。

## 验证方式
- compileall + 最小烟测：对 sidecar load_library/analyze/sync_feishu 做参数与错误码/事件输出校验（不依赖真实密钥也能验证大部分逻辑）。

确认后我将按以上顺序开始实现；并在需要新增文件时先给出新增文件清单供你批准。