## 调整后的目标（按你最新要求）
- **LLM trace 默认开启**（在 debug.enabled=true 的前提下），终端默认能看到完整请求体与完整 response。
- **请求体必须包含完整请求参数**（model/temperature/所有发送字段都要展示），同时仍遵循你原始约束：system 提示词不截断、user 提示词按阈值截断（仅日志截断，不影响真实请求）。
- **response 不截断**（记录原始 HTTP response 文本）。
- **调试信息保持简洁**：trace 模式下把“多条零碎事件”合并成少量关键事件；非 trace 时保持当前输出不变。

## 原因复盘（为什么现在看不到完整流程）
- 并行模式走 `llm_async`，不会走 `llm.py` 的 `[LLM] POST ... Request body preview ...`，因此终端只看到 `llm_async` 输出的少量 debug 字段与 `content_preview` 截断。对应：[_analyze_parallel](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py#L407-L429)、[chat_json_async](file:///d:/Project/matrix-it/backend/matrixit_backend/llm_async.py#L67-L155)、[llm.py 的详细 stderr 打印](file:///d:/Project/matrix-it/backend/matrixit_backend/llm.py#L251-L275)。

## 实施方案（最小改动、默认 trace 开启、输出更简洁）
### 1) Trace 开关策略（默认开启，但可关闭）
- 以 `debug.enabled` 为总开关（现有逻辑不变）。
- 新增可选配置（不写也能用）：
  - `debug.llm_trace`：缺省视为 **true**（满足“默认开启”）；显式写 `false` 才关闭。
  - `debug.llm_trace_user_max_chars`：用户提示词日志截断阈值（缺省 2000）。
- 环境变量优先级最高（便于临时排查）：
  - `MATRIXIT_LLM_TRACE=1|0`
  - `MATRIXIT_LLM_TRACE_USER_MAX=...`
- 同步更新：`config/config.local.example.json` + README 对应章节。

### 2) 并行链路：llm_async 输出“完整请求体/完整响应体”（并合并事件保持简洁）
修改 [llm_async.py](file:///d:/Project/matrix-it/backend/matrixit_backend/llm_async.py)：
- 在 trace 模式下，将当前零碎的 debug 事件合并为 **3 类**（减少重复与噪音）：
  1) `step=request`：输出 **完整请求体（含完整请求参数）**
     - `request_url`（脱敏 base_url）
     - `headers`（不含 Authorization）
     - `payload`：与实际发送 payload 同结构同字段；其中 messages：
       - system content：全量
       - user content：按阈值截断，并附 `user_total_chars/user_truncated/user_max_chars`
  2) `step=response`：输出 **完整 HTTP response 文本**（不截断） + `status/response_bytes`
  3) `step=parsed`：输出 `parsed_keys`（用于快速判断结构是否完整）
- 非 trace 模式：保持现有输出（api/url/model + status/bytes + content_preview + parsed_keys）。
- 多模态 `responses_pdf_json_async`：
  - `payload` 中不输出 `file_data` base64（否则会巨量且不安全）；改为在 payload 的对应位置写占位元信息（filename/pdf_bytes），其余参数字段保持真实。

### 3) 串行链路：llm.py 补齐同样 trace 事件（不改变既有 stderr 输出）
修改 [llm.py](file:///d:/Project/matrix-it/backend/matrixit_backend/llm.py)：
- 不动现有 `[LLM] ...` stderr 打印，避免影响既有排查习惯。
- 仅通过 `debug(...)` 回调在 trace 模式下增加与 llm_async 同结构的 `step=request/response/parsed` 事件（同样：system 不截断、user 仅日志截断、response 不截断）。

### 4) 解决“写了 debug 但终端不显示”：Rust 侧支持多行 JSON 拼接（兼容 pretty）
修改 [main.rs](file:///d:/Project/matrix-it/src-tauri/src/main.rs#L513-L588)：
- 为 stdout 增加 `pending_json_buf`：当某行 JSON parse 失败但像 JSON 起始（例如以 `{` 开头）时开始累计，拼接后续行直到 parse 成功。
- 加最大累计长度（例如 512KB）防止异常输出撑爆内存。
- 结果：即使启用 `MATRIXIT_DEBUG_PRETTY=1`（多行 JSON），终端也能稳定看到 debug（不再“写了但不显示”）。

## 验收/验证（实现后我会做）
- 默认（debug.enabled=true，未显式关闭 llm_trace）：终端能看到每个 item 的 `step=request/response/parsed`；request payload 含完整参数；system 全量；user 截断；response_text 全量。
- 显式关闭（debug.llm_trace=false 或 MATRIXIT_LLM_TRACE=0）：输出回到当前行为（不新增任何 LLM trace 行）。
- 打开 `MATRIXIT_DEBUG_PRETTY=1`：终端仍能看到 debug（Rust 拼接生效）。
- 确认不输出 API Key/Authorization，不输出 PDF base64。

## 涉及文件（不新增文件）
- `backend/matrixit_backend/llm_async.py`
- `backend/matrixit_backend/llm.py`
- `backend/matrixit_backend/sidecar.py`（仅用于读取 debug.llm_trace 默认值与 user_max，并传给 llm_* 判定；不改现有事件协议）
- `src-tauri/src/main.rs`
- `README.md`
- `config/config.local.example.json`
