## 关键结论（可行性 + 最佳实践）
- PDF 文本提取目前是串行瓶颈（即使开启 LLM 并行也先卡在 PDF 抽取），改为并行是可行且收益明确；最佳实践是在 Windows 上优先用进程池限制并发，避免 GIL 影响。[pdf.py](file:///d:/Project/matrix-it/backend/matrixit_backend/pdf.py#L18-L47)
- 多模态并行“技术上可行”，但因为每条请求需要读整份 PDF + base64 + 发送巨型 payload，**必须有配置级并发上限**，否则很容易出现内存峰值飙升、带宽拥塞、限流与失败率上升。[llm.py](file:///d:/Project/matrix-it/backend/matrixit_backend/llm.py#L331-L448)

## 配置层要求（你提出的“开启多模态必须限制最大并行数量”）
### 新增配置项（同时影响前端设置页与后端实际执行）
- llm.parallel_count_max：全局并行上限（防止用户把 parallel_count 拉到不合理值）。
- llm.multimodal_parallel_count_max：当 llm.multimodal=true 时额外的并发上限（建议默认 1–2）。

### 后端最终并发计算规则（强制生效）
- effective_parallel = min(llm.parallel_count, llm.parallel_count_max)
- 若 multimodal=true：effective_parallel = min(effective_parallel, llm.multimodal_parallel_count_max)
- 以上“上限”在后端强制执行，即便前端配置写错也不会突破。

## 实施计划（会改哪些文件、怎么改）
### 1) 配置读取与上限强制（后端）
- 修改 [llm.load_llm_config](file:///d:/Project/matrix-it/backend/matrixit_backend/llm.py#L33-L90)：解析 parallel_count_max / multimodal_parallel_count_max，应用上限规则并返回 effective_parallel。

### 2) 设置页补齐新配置项（前端）
- 修改 [SettingsPage.tsx](file:///d:/Project/matrix-it/frontend/src/ui/components/SettingsPage.tsx)：
  - 在「高级设置」区域新增两个 InputNumber：并行上限、（多模态）并行上限。
  - Provider 切换时把这两个字段也持久化到 profiles，并在新 provider 默认值里补齐。
  - 仍保持原有 parallel_count 的 UI（它表示“期望并行数”，上限由 *_max 约束）。

### 3) PDF 解析并行化（核心需求）
- 修改 [sidecar.py](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py)：
  - 将 analyze 的“PDF 抽文本阶段”改为并行：用 ProcessPoolExecutor + asyncio 的 run_in_executor/to_thread 形成 producer-consumer 流水线。
  - PDF 解析并发数与 effective_parallel 绑定，并再做 CPU 上限裁剪（如 <= cpu_count-1 且 <=4/6），避免开太多进程。
  - 保持 stdout JSONL 协议不变（started/finished/failed/debug 字段与语义不变），仅改变内部调度顺序。

### 4) 多模态并行实现（在上限约束下）
- 修改 [llm_async.py](file:///d:/Project/matrix-it/backend/matrixit_backend/llm_async.py)：
  - 修复 aiohttp 缺失时的可用性判断（避免类型注解导致的异常），保证 is_async_available() 可靠。
  - 新增 responses_pdf_json_async：用 aiohttp 异步 POST /responses；base64 编码放到 to_thread，避免阻塞事件循环。
- 修改 [sidecar.py](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py)：
  - 当 multimodal=true 且 aiohttp 可用：走 responses_pdf_json_async，并使用上面计算出的 effective_parallel（已被 multimodal_parallel_count_max 限制）。
  - 当 aiohttp 不可用：回退到现有 llm.responses_pdf_json 串行请求，但 PDF 解析仍可并行（满足“PDF 解析并行化”目标）。

### 5) 配置示例与文档同步（按项目规则）
- 更新 [config.local.example.json](file:///d:/Project/matrix-it/config/config.local.example.json)：加入 parallel_count_max / multimodal_parallel_count_max 示例值。
- 更新 README（或相关文档）说明：
  - parallel_count 是“期望并行数”；*_max 是“强制上限”。
  - 多模态模式建议的上限范围与原因（内存/带宽/限流）。

## 验证（执行阶段会做）
- 运行 sidecar 的 load_library / analyze：确保 stdout 输出仍为合法 JSON/JSONL。
- 人工验证并发上限：把 parallel_count 设很大，确认后端实际并发不超过 *_max；开启 multimodal 后不超过 multimodal_parallel_count_max。
- 性能验证：同一批 keys 下，开启 PDF 并行后“started→finished”整体耗时下降（尤其 keys>1 时）。