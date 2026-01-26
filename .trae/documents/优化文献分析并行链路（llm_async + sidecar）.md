## 现状结论（是否真的并行）
- 并行确实存在：`_analyze_parallel()` 先构造 `tasks_data`，随后调用 `AsyncLLMAnalyzer.analyze_batch()`；该函数把每条任务包装成 awaitable，并用 `asyncio.as_completed()` 让多个请求同时 in-flight；真正并发上限由 `asyncio.Semaphore(parallel_count)` 控制，所以同一时刻最多 `parallel_count` 个 LLM HTTP 请求并行。
- 但端到端并不是“全流程并行”：PDF 解析与 messages 构建是串行；另外 `on_progress`（落库/导出/打印）是同步执行，会阻塞事件循环，导致 aiohttp 的并发效率下降。

## 主要瓶颈（按影响从大到小）
1. 回调阻塞事件循环：`analyze_batch()` 在事件循环里直接执行 `on_progress(result)`；而 sidecar 的回调里包含 SQLite upsert + `export_json` + stdout 输出，I/O 较重，会让网络协程得不到调度。
2. 每条成功都导出一次 JSON：`storage.export_json(...)` 在每个 item 成功时执行一次，批量时会放大 I/O。
3. 串行准备阶段：PDF 解析/抽取文本在开始并发前一次性串行完成，增加总耗时与“首个结果”延迟。
4. llm_async 的 timeout 参数使用不一致：`AsyncLLMAnalyzer.__init__` 里设置的 `self.timeout` 未被实际使用（`analyze_batch` 又用 `llm_cfg.timeout_s` 创建 session timeout）。
5. 大批量任务内存与调度：一次性创建全部 coroutine（甚至 task）会在 keys 很多时增加内存与调度负担。

## 改动方案（最小改动优先，兼顾收益）
### 方案 A（优先做，收益大且改动小）
- 在 `llm_async.analyze_batch()` 内将 `on_progress` 的执行改为非阻塞事件循环：
  - 用 `await asyncio.to_thread(on_progress, result)`（仍保持逐条顺序回调，但不会卡住 event loop）。
  - 同步保持现有 sidecar 回调签名不变（无需改调用方）。
- 统一 timeout 来源：让 `AsyncLLMAnalyzer(timeout=...)` 的参数真正生效，session 复用该 timeout；避免同一配置被两处覆盖。
- 连接池参数小幅收敛：同时设置 `limit` + `limit_per_host`，减少不必要的连接扩张。

### 方案 B（可选，效率提升更明显，但涉及 sidecar）
- 删除/延后每条 item 的 `export_json`：成功时只 upsert；批处理结束后统一 export 一次（sidecar 已有最终导出）。
- 将 PDF 抽取与 LLM 调用做“流水线”：边准备边发请求，减少等待与峰值内存（可用 `asyncio.to_thread` 包装 PDF 抽取）。

## 验证方式（不改外部系统前提）
- 增加一个仅本地运行的简单压测/计时开关（不新增文件，直接用现有 debug 输出即可）：
  - 记录每个 item 的 started→finished 时长分布；观察并发数从 1→3/5 时总体耗时是否接近线性下降。
  - 观察 stdout 事件是否仍为合法 JSON Lines；Rust 侧是否仍能正常解析并更新进度。

## 具体实施步骤（用户确认后执行）
1. 修改 `backend/matrixit_backend/llm_async.py`：
   - `analyze_batch`：回调改为 `await asyncio.to_thread(...)`；清理/统一 timeout 与 connector 限制；必要时补充取消处理（cancel 时取消未完成 task）。
2. 修改 `backend/matrixit_backend/sidecar.py`（可选但推荐）：
   - 去掉成功分支里的逐条 `export_json`（保留最后一次导出）。
3. 运行后端最小链路验证：用小批量 keys 触发并行分析，确认事件流、DB 写入、前端进度展示正常，并对比耗时。

如果你希望本轮只限定修改 `llm_async.py`（不动 sidecar），我会只执行方案 A。