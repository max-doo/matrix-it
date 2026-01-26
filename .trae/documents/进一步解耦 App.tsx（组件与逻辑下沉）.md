## 现状（App.tsx 仍可继续解耦的点）
- 筛选项选项生成 + 过滤算法（collectionItems、filter*Options、filteredItems）
- 详情抽屉导航（filteredItemKeys/tableSortedKeys → prev/next）
- 引用预取与详情引用状态（两段 effect）
- 确认弹窗 JSX 分支（Mixed/Stop/Delete/Analyze）
- 详情保存（updateItemRpc + setLibrary）
- 顶部工具条（搜索/筛选/列配置/分析按钮）

## 目标
- App.tsx 只保留页面编排与最少 glue；复杂派生状态放 hooks；复杂 JSX 分支放 components。

## 调整后的解耦计划（按收益优先）
1) **提取筛选/选项/过滤到 hook**
   - 新建 `useFilteredItems`（或 `useWorkbenchFilter`）
   - 输出：filteredItems + filterYearOptions/filterTypeOptions/filterTagOptions/filterKeywordOptions/filterBibTypeOptions

2) **详情抽屉导航下沉**
   - 优先复用现有 `useDetailNavigation`（若覆盖不足则补齐其输入输出）
   - 让 hook 产出：detailNavKeys、activeIndex、canPrev/canNext、goPrev/goNext

3) **引用预取逻辑下沉到 hook**
   - 优先把“详情打开拉取 + 当前页预取”并入 `useCitationManager`（或新增 `useCitationPrefetch`）

4) **确认弹窗改为复用现成 ConfirmModal（按你的要求）**
   - 将 App.tsx 中的 `<Modal ...>` 替换为 `ui/components/ConfirmModal.tsx`
   - 通过 ConfirmModal 的 `title/content/type/loading/footer` 组合出：
     - stop：警示样式（content 用 Alert，type='danger'，confirmText='终止'）
     - delete：danger
     - analyze：primary
     - mixed_analyze：使用 `footer` 自定义按钮顺序与高亮（右侧“仅分析未完成”为 primary）

5) **抽离 WorkbenchToolbar 组件**
   - 组件仅负责顶部工具条渲染；App 传入状态与 handlers

6) **抽离详情保存逻辑**
   - 新建 `useItemUpdater` 暴露 `saveMatrixPatch(key, patch)`，内部做 updateItemRpc + setLibrary + message

## 验证方式
- 全量通过：TypeScript / ESLint / build。
- 回归：筛选结果一致、详情导航一致、引用预取一致、分析/终止/混合策略弹窗交互一致。

## 预期结果
- App.tsx 明显变薄；ConfirmModal 得到统一复用；hooks/components 边界更清晰，后续维护成本更低。