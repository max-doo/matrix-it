## 方案结论（最简洁、最稳定）
- 采用 `config.ui.table_columns.matrix.analysis.order: string[]` 作为“发送给大模型的字段顺序”的唯一来源，是当前代码结构下**改动最小、语义最清晰、稳定性最高**的方案。
- 这一字段后端已在分析链路中读取并用于排序（`preferred_order`），因此只需要让前端设置页把顺序写进去即可。

## 为什么不建议在 fields.analysis_fields 里加 id 来排序
- `analysis_fields` 的核心语义是“字段定义映射表（key → 定义）”，在其中再加 `id/position` 会带来额外一致性问题：
  - 需要保证 id 唯一、连续/可比较、重排时要批量更新多个字段
  - 删除/新增字段时容易出现重复/空洞/冲突
  - 还要决定 id 的类型与迁移策略（旧配置没有 id 怎么办）
- 反过来，一个独立的 `order` 数组天然就是“顺序”的单一真相（source of truth），不会污染字段定义结构，也更容易做兼容与回退。

## 最小落地方案（不增加复杂逻辑）
### 1) 前端：设置页“解析字段”的顺序写入 analysis.order
- 当用户在设置页调整“解析字段”列表顺序并保存 config 时：
  - 取当前列表的 key 顺序（例如 `['research_question','methods',...]`）
  - 写入 `config.ui.table_columns.matrix.analysis.order`
- 不改动现有表格列设置（`analysis.visible`），避免“展示顺序”和“LLM 顺序”纠缠。

### 2) 后端：继续使用已有 preferred_order 逻辑
- 后端目前读取 `config.ui.table_columns.matrix.analysis.order` 传入 `prompt_builder` 排序。
- 保持现状即可；不新增“先A后B”的额外规则，避免复杂性。

### 3) 兼容与稳定性（仅做最轻量的容错）
- `analysis.order` 中包含已删除字段 key：无影响（排序时会被忽略）。
- `analysis.order` 缺少新增字段 key：会自动落到末尾（当前排序实现已满足）。
- 若 `analysis.order` 不存在：按现有逻辑回退（字典 key 顺序/其他来源）。

## 验收标准
- 在设置页调整解析字段顺序并保存后：
  - `config.ui.table_columns.matrix.analysis.order` 的数组顺序与设置页一致
  - 触发一次分析，模型提示词中的 keys 列表顺序与该 order 一致
  - 输出写库字段的完整度随顺序变化可复现

## 实施范围（最小变更点）
- 只需要改动前端保存配置的合并逻辑，让其同步写入 `analysis.order`；后端不需要改动主逻辑。