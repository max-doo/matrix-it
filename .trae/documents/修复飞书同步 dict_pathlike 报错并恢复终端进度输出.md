## 目标
- 彻底解决“argument should be a str or an os.Pathlike object … not 'dict'”导致的同步失败。
- 确保在 `cargo tauri dev` 终端可实时看到飞书同步进度与 traceback，并在 UI 里返回可读错误。

## 现状复核（基于你给的上次修改日志）
- `feishu.py`：schema 缓存写入（config.local.json）改为尽力而为，失败只打印警告，不再中断同步。
- `main.rs`：`sync_feishu` 走 spawn 流式读取，并把 sidecar stderr eprint 到终端，便于观察进度。

## 仍需补齐的“最佳解”
### 1) 锁定 dict 进入 Path/open/os.path 的入口（根因修复）
- 在 `feishu.upload_items` 读取 fields 定义、解析 zotero_dir、解析 pdf_path 前增加类型防御：
  - 若 `fields_json` / `base_dir` / `config_path` / `zotero.data_dir` 非字符串/PathLike，输出清晰错误（指出字段名与实际类型），并走“单条失败/统计失败”，不让整次同步被无意义 TypeError 终止。
- 在 `zotero.get_zotero_dir` 增加兼容：`data_dir` 若为 `{path: "..."}` 自动提取；否则回退默认目录并给出警告。

### 2) sidecar 把完整 traceback 透传给前端（定位提效）
- `sidecar.py` 的 `sync_feishu` 命令异常捕获：在返回 JSON 的 `error` 内加入（截断后的）traceback 字段（例如 `trace`），同时保留原 `message`。
- 保持 stdout 仍为 JSON（Rust 侧解析不变），stderr 用于实时进度输出。

### 3) Rust 侧错误信息更可读（不丢上下文）
- `main.rs` 的 `sync_feishu`：对非 0 退出码或 JSON 解析失败时，把 stderr 缓冲与 stdout 片段拼进 ApiError（截断），避免 UI 只看到空信息。

## 验证
- 启动 `cargo tauri dev` 后触发一次同步：
  - 终端实时出现 `[FEISHU] 开始同步/进度/✓/✗/traceback`。
  - UI 错误提示包含明确“哪个字段是 dict”或包含 `trace`（截断）。
  - 同步不会因 schema 缓存写入失败而整体中断。

我将按 1→2→3 的顺序做最小改动实现，并在本地跑一遍同步链路验证。