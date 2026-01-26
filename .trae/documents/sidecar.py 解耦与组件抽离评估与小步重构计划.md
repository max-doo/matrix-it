## 现状结论（是否有必要）
- sidecar.py 同时承担 CLI 分发、运行时路径/环境、SQLite 初始化/迁移、业务命令实现（load/analyze/sync/删除/引用）、并行调度、stdout 事件协议与“吞错”策略，属于明显的多职责单文件，维护成本和回归风险在增长。[sidecar.py](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py)
- 最值得动的点是 analyze 串行/并行两套实现的重复：同一业务规则（状态机、PDF 缺失、字段过滤、落库/导出、事件输出）目前要改两遍，最容易漏改导致行为漂移。[sidecar.py:L113-L309](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py#L113-L309) / [sidecar.py:L515-L776](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py#L515-L776)
- 不建议“大拆大改/重写”：stdout JSON/JSONL 协议已被 Rust/前端消费，且 load_library 有锁库规避等工程细节，推倒重来风险高。[main.rs](file:///d:/Project/matrix-it/src-tauri/src/main.rs)

## 可解耦的组件边界（不改外部协议前提）
- 运行时上下文：root_dir/data_dir/db_path/config_path/fields_path 的解析 + ensure_db + legacy import，集中成一个可复用对象/函数，减少 main() 与各命令的重复与隐式约定。[sidecar.py:L989-L1036](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py#L989-L1036)
- 输出/事件层：封装统一的 emit_event / emit_debug，保证所有 stdout 行都是合法 JSON（现在基本做到，但散落在多个位置），并把错误码/字段名集中定义，降低协议漂移风险。[sidecar.py:L438-L449](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py#L438-L449)
- 分析核心管线：抽出“单条分析”的纯逻辑（找 PDF→抽文本→截断→构造 messages→调用 LLM→过滤字段→合并回 item），把 IO（storage/export/print）放在薄封装里；并行/串行只负责调度，同用一套业务规则。
- fields/config 加载：抽出 load_fields_def(config, fields_path) 与 get_analysis_fields(...) 的组合，load_library/analyze/delete_extracted_data/sync_feishu 均可复用。

## 拟执行的最小改动重构（默认不新建文件）
1. 在 sidecar.py 内新增 3–5 个内聚 helper（仍保持单文件，避免跨文件风险）：
   - load_fields_def(...)：统一 config["fields"] vs fields.json 的读取逻辑。
   - build_prompts(...)：统一 system_prompt/user_prompt/ordered_keys 的构建与兜底。
   - analyze_one_item_prepare(...)：负责解析 PDF、构造 messages、计算 tldr、决定失败错误码。
   - apply_llm_result_to_item(...)：负责字段过滤与写回。
2. 重写 analyze 的并行/串行分叉：
   - 串行路径与 _analyze_parallel 共享同一套“单条准备/单条落库/单条事件”逻辑。
   - _analyze_parallel 只保留：批量 prepare → 并发请求 → on_progress 调用统一的“落库+事件”。
3. 清理明显的重复与潜在死代码：
   - 全仓检索 _index_existing 是否被引用；若确认未用再删除（遵循“最小改动”和删除前检索规则）。[sidecar.py:L35-L50](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py#L35-L50)
4. 不改变对外行为的可靠性增强（仍保持“吞错但可观测”）：
   - 保留 try/except 的容错策略，但把关键失败点补充为 stderr 诊断输出（不影响 stdout 协议）。

## 可选的“真正组件抽离”（需要你明确授权新建文件/目录）
- 如果你同意新建目录/文件，我会把上面 helper 按职责拆到：
  - matrixit_backend/sidecar_runtime.py（路径/DB 初始化）
  - matrixit_backend/sidecar_events.py（事件输出封装）
  - matrixit_backend/sidecar_analyze.py（分析管线与调度）
- sidecar.py 变成薄入口：只负责 CLI 解析与调用这些模块，外部接口保持不变。

## 风险与兼容性保证
- 保持 stdout JSON/JSONL schema 不变（type/字段名/错误码），避免 Rust 解析侧回归。
- 并行模式的回退逻辑保持不变（ImportError/异常→回退串行）。[sidecar.py:L486-L514](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py#L486-L514)
- 不触碰 Rust 侧已绕过 sidecar 的 update_item 现状，只在评估后给出后续“收敛入口”的建议，不在本轮强行改动跨语言链路。[main.rs:update_item](file:///d:/Project/matrix-it/src-tauri/src/main.rs#L526-L583)

## 验收与验证（按项目规则）
- 运行一次：python backend/matrixit_backend/sidecar.py load_library（确认输出 JSON 可解析、collections/items 正常）。
- 运行一次 analyze（串行与并行各一次，若环境缺 aiohttp 则验证回退串行）：确认 stdout 每行均为 JSON，且 started/finished/failed 行为与原一致。
- 回归 sync_feishu/delete_extracted_data/format_citations/clear_citations 的输出 JSON 与 DB 更新是否一致。
