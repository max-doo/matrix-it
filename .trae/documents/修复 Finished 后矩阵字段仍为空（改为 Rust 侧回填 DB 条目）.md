## 现象复盘与判断
- 你看到“Finished 后行出现但分析字段为空，等 AllDone 刷新才有值”，说明前端在分析进行中拿到的 **Finished payload 并没有携带可用的分析字段值**，且前端的增量拉取/合并没有真正拿到“写库后的最终条目”。
- 由于 AllDone 时 `handleRefresh()` 会调用 `load_library`，而 `load_library` 合并的是本地 SQLite（已有分析字段）+ Zotero 元数据，所以最终能显示，说明 **分析字段实际上已写入本地 DB**。[sidecar.py](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py#L493-L583)

## 根因更可能在链路哪一段
- 即使 Python sidecar 的 `finished` 事件代码会尝试带上 `item`，[sidecar.py](file:///d:/Project/matrix-it/backend/matrixit_backend/sidecar.py#L894-L907)；但实际运行中前端仍拿不到/拿不全。
- 继续在前端做 get_items 拉取容易被“sidecar 未更新/命令不可用/读库失败被吞/路径不一致”这类因素干扰。

## 最稳的修复策略（把“取最终条目”放到 Rust 侧）
### 1) Rust：在收到每条 finished 后，直接从 SQLite 读取该条最新 JSON
- 在 `src-tauri/src/main.rs` 增加一个只读函数：按 `item_key` 从 `matrixit.db` 读取 `json` 字段并解析为 `serde_json::Value`。
- DB 路径解析与 sidecar 对齐：优先读环境变量 `MATRIXIT_DATA_DIR`/`MATRIXIT_DB`，否则用 `project_root/data/matrixit.db`。
- 设置 `busy_timeout`（例如 1000ms）避免短暂写锁导致读失败。

### 2) Rust：start_analysis 的 Finished 事件总是携带“DB 读到的条目”
- 在 `handle_json_line` 处理 `type==finished` 时：
  - 用 item_key 去 DB 读最新条目；读到就作为 `AnalysisEvent::Finished.item` 发送给前端（覆盖原始 stdout 里的 item）。
  - 若读不到，再回退为 stdout 里带的 `item`（保持兼容）。

### 3) 前端：保持现有逻辑，但会自动变成“只用 Finished.item 即刻回填”
- 现有 `useAnalysisState` 已在 Finished 时合并 `evt.data.item` 到 `library.items`，[useAnalysisState.ts](file:///d:/Project/matrix-it/frontend/src/ui/hooks/useAnalysisState.ts#L163-L196)
- Rust 侧保证 Finished.item 可用后，前端无需等待 AllDone 刷新即可显示矩阵字段。

## 验证方式
- 选多条文献分析：每条 Finished 后对应行的矩阵列立刻出现内容（无需等 AllDone）。
- 运行：`cargo test`、`npm run lint && npm run build`、Python `py_compile`。

我将按以上步骤落地修改（只改现有文件，不新增文件），并在前端保持兼容回退逻辑。