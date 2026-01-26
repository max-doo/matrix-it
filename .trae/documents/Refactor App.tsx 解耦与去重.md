## 目标
- 缩短 [App.tsx](file:///d:/Project/matrix-it/frontend/src/ui/App.tsx) 体积：把已存在于 `src/ui/hooks`、`src/ui/lib` 的重复逻辑替换为直接复用。
- 保持行为一致（筛选、列配置、设置页、引用生成、分析/删除等交互不倒退）。
- 为关键逻辑与导出函数补齐必要注释（遵循你要求）。
- **方案B约束**：不新建任何文件/目录（满足“新建需同意”要求），只在现有文件内重排/抽取。

## 现状（重复点定位）
- LocalStorage/缓存键/读写：App.tsx 内实现 ↔ [storage.ts](file:///d:/Project/matrix-it/frontend/src/ui/lib/storage.ts)
- collectCollectionKeys：App.tsx 内实现 ↔ [collectionUtils.ts](file:///d:/Project/matrix-it/frontend/src/ui/lib/collectionUtils.ts)
- readThemeToken/hexToRgb：App.tsx 内实现 ↔ [themeUtils.ts](file:///d:/Project/matrix-it/frontend/src/ui/lib/themeUtils.ts)
- 筛选/搜索/选项生成/过滤：App.tsx 内实现 ↔ [useFilterState.ts](file:///d:/Project/matrix-it/frontend/src/ui/hooks/useFilterState.ts)
- 列配置：App.tsx 内实现 ↔ [useColumnConfig.ts](file:///d:/Project/matrix-it/frontend/src/ui/hooks/useColumnConfig.ts)
- 设置页加载/保存/自动保存：App.tsx 内实现 ↔ [useAppConfig.ts](file:///d:/Project/matrix-it/frontend/src/ui/hooks/useAppConfig.ts)
- 文献库刷新/缓存/Zotero watch：App.tsx 内实现 ↔ [useLibraryState.ts](file:///d:/Project/matrix-it/frontend/src/ui/hooks/useLibraryState.ts)
- 引用生成/缓存：App.tsx 内实现 ↔ [useCitationManager.ts](file:///d:/Project/matrix-it/frontend/src/ui/hooks/useCitationManager.ts)
- 分析/删除提取数据：App.tsx 内实现与 [useAnalysisState.ts](file:///d:/Project/matrix-it/frontend/src/ui/hooks/useAnalysisState.ts) 重叠

## 改造步骤（按风险从低到高）
1. **去掉 lib 级重复实现（低风险）**
   - App.tsx 删除 `LIBRARY_CACHE_KEY/ACTIVE_*`、`readLibraryCache/writeLibraryCache/readString/writeString/deleteKey`、`collectCollectionKeys`、`readThemeToken`、`hexToRgb` 本地实现。
   - 改为 import：
     - `STORAGE_KEYS/readLibraryCache/writeLibraryCache/readString/writeString/deleteKey` from [storage.ts](file:///d:/Project/matrix-it/frontend/src/ui/lib/storage.ts)
     - `collectCollectionKeys` from [collectionUtils.ts](file:///d:/Project/matrix-it/frontend/src/ui/lib/collectionUtils.ts)
     - `readThemeToken/hexToRgb` from [themeUtils.ts](file:///d:/Project/matrix-it/frontend/src/ui/lib/themeUtils.ts)
   - 补充必要注释：说明缓存键含义、容错策略（只在 App.tsx 的调用点写，避免重复注释）。

2. **用 useAppTheme/useFilterState 替换零散状态（中低风险）**
   - 在 App.tsx 用 [useFilterState](file:///d:/Project/matrix-it/frontend/src/ui/hooks/useFilterState.ts) 接管：
     - `filterMode/zoteroFilterModeRef/filterPopoverOpen/searchQuery/normalizedSearchQuery/searchPopoverOpen/searchInputElRef`
     - 以及 `fieldFilter*` 一组状态改为 `fieldFilter` 对象。
   - 用 [useAppTheme](file:///d:/Project/matrix-it/frontend/src/ui/hooks/useAppTheme.ts) 接管 `themeToken` 与 `activeSearchButtonStyle`。
   - 保留你现有的“切换 view 时 zoteroFilterModeRef 保存/恢复”的行为（hook 已暴露 ref，可原样迁移）。
   - 补注释：说明 filter 状态与 view 的关系（matrix 默认 processed 等）。

3. **用 useAppConfig/useColumnConfig 接管设置页与列配置（中风险）**
   - App.tsx 改用 [useAppConfig](file:///d:/Project/matrix-it/frontend/src/ui/hooks/useAppConfig.ts) 获取：
     - `rawConfig/rawFields/configForm/fieldsForm/settingsSection/settingsLoading/settingsSaving/zoteroStatus/loadSettings/scheduleAutoSaveSettings/metaFieldDefs/analysisFieldDefs` 等。
   - App.tsx 改用 [useColumnConfig](file:///d:/Project/matrix-it/frontend/src/ui/hooks/useColumnConfig.ts) 获取：
     - `metaColumnPanel/analysisColumnPanel/matrixAnalysisOrder/tableMetaColumns/tableAnalysisColumns/citationColumnVisible` 与 apply 方法。
   - 删除 App.tsx 内对应的大段重复 useMemo/useCallback。
   - 补注释：说明列配置保存位置（config.ui.table_columns）以及 matrix 分析字段 order 的来源。

4. **用 useLibraryState/useZoteroWatch 接管库刷新与监听（中风险）**
   - App.tsx 创建/复用 `analysisInProgressRef`，并用 [useLibraryState](file:///d:/Project/matrix-it/frontend/src/ui/hooks/useLibraryState.ts) 替换：
     - `library/setLibrary/refreshingLibrary/refreshError/lastRefreshAt/refreshLibrary/handleRefresh`。
   - 在 App.tsx 调用 `useZoteroWatch(zoteroStatus, refreshLibrary)` 替换原本 tauri listen/start/stop 逻辑。
   - 保留 App.tsx 里“activeCollectionKey 合法性校验/回退”的那部分（它是 App 独有的 UI 规则）。
   - 补注释：解释为何分析中要保留 processing/reanalyzing 状态。

5. **用 useCitationManager 接管引用缓存（中风险）**
   - App.tsx 使用 [useCitationManager](file:///d:/Project/matrix-it/frontend/src/ui/hooks/useCitationManager.ts) 替换 `citationCacheRef/citationsInFlightRef/citationsTick/ensureCitations/detailCitationState` 等。
   - 保留你现有的“详情打开时按需拉引用 + 表格分页行预取引用”的两个 effect（只是改用 hook 暴露的字段）。
   - 补注释：解释 date_modified 命中缓存策略与分批请求（40/批）。

6. **分析/删除提取数据迁移到 useAnalysisState（中高风险，但显著缩短 App.tsx）**
   - App.tsx 采用 [useAnalysisState](file:///d:/Project/matrix-it/frontend/src/ui/hooks/useAnalysisState.ts) 统一：
     - `startAnalysis`、删除已提取数据、以及“混合已完成/未完成”时的确认流。
   - 在 App.tsx 增加一个通用确认 Modal 渲染（不新建组件文件），根据 `confirmModal.type` 选择文案/按钮与回调。
   - UI 上“开始分析/删除”按钮只调用 hook 的 request 方法。
   - 补注释：说明事件流处理（Finished/Failed/AllDone）以及取消时的状态恢复。

7. **组件级解耦：移动 SettingsSidebar（不新建文件）**
   - 将 App.tsx 里的 `SettingsSidebar` 移到现有 [AppSidebar.tsx](file:///d:/Project/matrix-it/frontend/src/ui/components/AppSidebar.tsx) 里作为 `export function SettingsSidebar`（不新增文件）。
   - App.tsx 改为从该文件 import。
   - 补注释：说明 SettingsSidebar 只负责导航，不持有业务状态。

## 验证方式（实现后执行）
- 前端静态检查：`npm run lint`（必须 0 error）。
- 构建验证：`npm run build`。
- 手工验收：
  - 切换 Zotero/Matrix 视图，筛选状态正确记忆。
  - 搜索/筛选弹层可用（Ctrl+F、Esc 关闭等）。
  - 设置页加载/自动保存/字段排序与列显示配置不丢失。
  - 引用列开启时分页预取正常、详情抽屉引用状态正常。
  - 分析/删除提取数据的确认流与结果提示正常。

## 预计改动文件
- 修改： [App.tsx](file:///d:/Project/matrix-it/frontend/src/ui/App.tsx)
- 修改： [AppSidebar.tsx](file:///d:/Project/matrix-it/frontend/src/ui/components/AppSidebar.tsx)
- 可能小改（如类型不匹配时）：hooks 文件的类型导出/注释补齐（不新增文件）。

如果你确认该方案，我会按上述顺序开始落地：先做 lib 去重与 hook 接入，最后迁移分析逻辑与 SettingsSidebar，并在每一步保持可编译。