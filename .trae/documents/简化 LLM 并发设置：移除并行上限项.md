## 合理性评估
- 这两项（并行上限 / 多模态并行上限）本质是“安全阀”，对大多数用户来说属于系统保护而非业务参数；让用户同时理解 3 个并发相关概念会显著增加认知负担。
- 当前后端已在 [llm.py](file:///d:/Project/matrix-it/backend/matrixit_backend/llm.py#L33-L112) 做了裁剪逻辑：`parallel_count` 会被 `parallel_count_max(默认10)` 限制；开启多模态还会再被 `multimodal_parallel_count_max(默认2)` 限制。因此只保留“并行数量”一个输入，系统内部写死上限，既安全又更易懂。
- 另外 `config/config.json` 当前并未包含这两个 max 字段，说明默认用户并不依赖它们；移除 UI 入口对现有配置的影响很小。

## 实施方案
### 1) 前端：SettingsPage 简化表单
- 文件：[SettingsPage.tsx](file:///d:/Project/matrix-it/frontend/src/ui/components/SettingsPage.tsx)
- 删除两个 Form.Item：`llm.parallel_count_max`、`llm.multimodal_parallel_count_max`（对应你标的两个 label）。
- “并行数量”改为动态上限：
  - `multimodal=false` 时 `max=10`
  - `multimodal=true` 时 `max=2`
- 多模态开关打开时，若当前并行数量大于 2：
  - 自动回填为 2（避免用户“看起来填了 5，但实际后端跑 2”的认知落差），并用轻提示说明“多模态已限制并行为 2”。
- 同步清理与这两个字段相关的前端逻辑：
  - Provider 切换 profile 存档/加载时不再读写这两个字段
  - “还原默认”不再写这两个字段
  - Tooltip 文案改为：并行数量在多模态模式下会自动限制为 1-2

### 2) 后端：并发上限写死
- 文件：[llm.py](file:///d:/Project/matrix-it/backend/matrixit_backend/llm.py#L33-L112)
- 将 `parallel_count_max`、`multimodal_parallel_count_max` 改为常量（例如 10 和 2），不再从 config 读取。
- `parallel_count` 计算逻辑改为：
  - `parallel_count = clamp(parallel_count_raw, 1..10)`
  - 若 `multimodal=true`：`parallel_count = clamp(parallel_count, 1..2)`
- 仍可在返回的 llm_cfg 里带上这两个 max（用于诊断输出），但值固定。

### 3) 文档与示例配置同步
- 文件：[config.local.example.json](file:///d:/Project/matrix-it/config/config.local.example.json)、[README.md](file:///d:/Project/matrix-it/README.md)
- 删除/更新关于 `llm.parallel_count_max` 与 `llm.multimodal_parallel_count_max` 的说明，改为“系统强制上限：普通≤10，多模态≤2；用户只需配置 parallel_count”。

## 验证
- 前端：`npm run lint`、`npm run build`
- 后端：对 `llm.load_llm_config` 做一次最小用例验证（multimodal on/off 时并行值是否按预期裁剪），并确保 sidecar 并行路径不受影响。

如果你确认这个方向，我会按以上步骤开始改动代码与文档。