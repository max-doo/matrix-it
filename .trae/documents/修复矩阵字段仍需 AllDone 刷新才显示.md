## 问题判断
- 矩阵表格的值是直接读 `library.items` 上的同名顶层字段（如 `tldr/methods/key_findings/...`），不是等 refresh 才会重建列或换数据源：[LiteratureTable.tsx](file:///d:/Project/matrix-it/frontend/src/ui/components/LiteratureTable.tsx)。
- sidecar 的 `finished` 事件已经会携带完整 `item`，且在写库后再 `print`（理论上无需额外拉取）。但你现在的现象是“状态能变、字段值不变”，高度符合：前端用于回填的 `get_items` 拉取在分析进行中经常失败（SQLite 锁/竞争），错误被吞掉，所以一直没把字段 merge 进 state；等 AllDone 后自动 refresh（`closeAnalysis()`里必调）才一次性看到结果。

## 修复思路
- 让前端在 `Finished` 时优先用事件自带的 `evt.data.item` 直接回填（不碰 DB），仅在 `item` 缺失/为空时才走 `get_items`。
- 对 `get_items` 增加“重试+退避”，把 SQLite 临时锁导致的一次失败自动消化掉（例如最多重试 5 次，间隔 200ms→400ms→800ms…），且不要静默吞错。
- 进一步降低锁竞争：让 `get_items` 的 SQLite 读取支持更友好的 busy-timeout（避免瞬时锁直接报错）。

## 具体改动（不新增文件）
1) **前端 useAnalysisState**
- 在 `Finished` 分支：
  - 若 `evt.data.item` 存在：直接 merge 该 item（这一步应立即让矩阵字段显示）。
  - 只有当 `evt.data.item` 不存在/为空对象时，才把 key 入队走 `get_items`。
- 对队列 flush：实现重试（带 attempt 计数、退避时间），失败则把 keys 重新入队并 schedule 下一次 flush。

2) **前端 backend.getItems**
- 在 Tauri 环境下不要“吞掉错误返回空数组”，改为把错误抛给调用方（这样重试逻辑才能生效，也能在 raw log/消息里看到真实失败原因）。

3) **后端 get_items 抗锁**（二选一，优先 A）
- A. 在 Python sidecar 的 `get_items` 内部改为使用 `sqlite3.connect(db_path, timeout=2.0)` 做一次性查询（只影响该命令，不改全局 storage 行为）。
- B. 或者扩展 `storage.get_items/get_item` 支持可选 timeout，并仅在 `get_items` 路径传入更长 timeout（改动面稍大）。

## 验证方式
- 选多条文献并行/串行分析：每条 `Finished` 后矩阵列应立刻出现内容（不依赖 AllDone）。
- 打开“原始日志”：能看到 `Finished` event 的 `data.item` 至少包含一部分分析字段；若走 `get_items`，失败时应能看到重试而不是静默。
- 运行：`npm run lint`、`npm run build`、`cargo test`、Python `py_compile`。

确认后我就按以上步骤落地代码修改。