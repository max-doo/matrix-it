/**
 * 模块名称: 主应用组件
 * 功能描述: 整个 React 应用的根组件，负责布局结构（Layout）、路由/视图切换、状态管理（文献库、配置、筛选）
 *           以及核心业务逻辑的协调（如加载文献库、调用分析、同步设置、定时刷新等）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react'
import {
  ConfigProvider,
  Layout,
  Button,
  Popover,
  Input,
  Space,
  App as AntApp,
  Segmented,
  Modal,
  message,
  Form,
  Menu,
} from 'antd'
import {
  PlayCircleOutlined,
  HomeOutlined,
  SearchOutlined,
  DeleteOutlined,
  StopOutlined,
} from '@ant-design/icons'
import { homeDir } from '@tauri-apps/api/path'

import zhCN from 'antd/locale/zh_CN'

import type { AnalysisFieldRow, CollectionNode, FilterMode, LiteratureItem } from '../types'
import {
  updateItem as updateItemRpc,
  readConfig,
  saveConfig,
} from '../lib/backend'
import { AppSidebar, ZoteroStatusFooter } from './components/AppSidebar'
import { LiteratureTable, type LiteratureTableColumnOption, type LiteratureTableView } from './components/LiteratureTable'
import { TitleBar } from './components/TitleBar'
import { SettingsPage, type SettingsScrollApi, type SettingsSectionKey } from './components/SettingsPage'
import { ColumnSettingsPopover } from './components/ColumnSettingsPopover'
import { LiteratureFilterPopover } from './components/LiteratureFilterPopover'
import { LiteratureDetailDrawer, type LiteratureDetailDrawerMode } from './components/LiteratureDetailDrawer'
import { ConfirmModal } from './components/ConfirmModal'

// --- Filter Hooks: 筛选状态管理 ---
import { useFilterState, useCollectionItems, useFilteredItems, useFilterOptions } from './hooks/useFilterState'

// --- Citation Hooks: 引用生成与管理 ---
import { useCitationManager } from './hooks/useCitationManager'

// --- Column Hooks: 表格列配置管理 ---
import { useColumnConfig } from './hooks/useColumnConfig'

// --- Analysis Hooks: AI 分析流程状态 ---
import { useAnalysisState } from './hooks/useAnalysisState'

// --- Library Hooks: 文献库核心数据 ---
import { useLibraryState, useZoteroWatch } from './hooks/useLibraryState'

// --- Theme Hooks: 主题样式 ---
import { useAppTheme } from './hooks/useAppTheme'

// --- Config Hooks: 应用配置与表单 ---
import { useAppConfig } from './hooks/useAppConfig'

// --- Navigation Hooks: 详情页导航 ---
import { useDetailNavigation } from './hooks/useDetailNavigation'

const { Sider, Content } = Layout

const LIBRARY_CACHE_KEY = 'matrixit.library.cache.v1'
const ACTIVE_COLLECTION_KEY = 'matrixit.ui.activeCollectionKey'
const ACTIVE_VIEW_KEY = 'matrixit.ui.activeView'

const isTauriRuntime = () => {
  const w = window as unknown as Record<string, unknown>
  return !!(w && (w.__TAURI_INTERNALS__ || w.__TAURI__))
}

type LibraryCachePayload = {
  savedAt: number
  collections: CollectionNode[]
  items: LiteratureItem[]
}

const readLibraryCache = (): LibraryCachePayload | null => {
  try {
    const raw = localStorage.getItem(LIBRARY_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LibraryCachePayload>
    if (!parsed || !Array.isArray(parsed.collections) || !Array.isArray(parsed.items)) return null
    return {
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      collections: parsed.collections as CollectionNode[],
      items: parsed.items as LiteratureItem[],
    }
  } catch {
    return null
  }
}

const writeLibraryCache = (payload: LibraryCachePayload) => {
  try {
    localStorage.setItem(LIBRARY_CACHE_KEY, JSON.stringify(payload))
  } catch {
    return
  }
}

const readString = (key: string): string | null => {
  try {
    const v = localStorage.getItem(key)
    return v && v.trim().length > 0 ? v : null
  } catch {
    return null
  }
}

const writeString = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    return
  }
}

const deleteKey = (key: string) => {
  try {
    localStorage.removeItem(key)
  } catch {
    return
  }
}

const collectCollectionKeys = (nodes: CollectionNode[]): Set<string> => {
  const out = new Set<string>()
  const stack = [...nodes]
  while (stack.length) {
    const n = stack.pop()
    if (!n) continue
    out.add(n.key)
    if (Array.isArray(n.children) && n.children.length) stack.push(...n.children)
  }
  return out
}





export default function App() {
  // --- Refs ---
  // 用于在不触发重渲染的情况下在不同 Hooks 间共享分析状态
  const analysisInProgressRef = useRef(false)

  // --- Core State: 文献库 ---
  // 管理核心的文献列表、集合结构以及加载/刷新逻辑
  const {
    library,
    setLibrary,
    refreshingLibrary,
    refreshError,
    lastRefreshAt,
    handleRefresh, // 触发刷新的主函数
    refreshLibrary // 暴露给副作用使用的刷新函数
  } = useLibraryState(analysisInProgressRef)

  // --- UI State: 视图与选择 ---
  // 控制当前视图（Zotero列表 vs 矩阵视图）以及各视图下的选中项
  const [activeView, setActiveView] = useState(() => readString(ACTIVE_VIEW_KEY) ?? 'zotero')
  const [zoteroSelectedRowKeys, setZoteroSelectedRowKeys] = useState<React.Key[]>([])
  const [matrixSelectedRowKeys, setMatrixSelectedRowKeys] = useState<React.Key[]>([])

  // 计算当前视图下的选中项
  const selectedRowKeys = useMemo(() => {
    return activeView === 'matrix' ? matrixSelectedRowKeys : zoteroSelectedRowKeys
  }, [activeView, matrixSelectedRowKeys, zoteroSelectedRowKeys])

  // 更新选中项的包装函数
  const setSelectedRowKeys = useCallback((keys: React.Key[]) => {
    if (activeView === 'matrix') {
      setMatrixSelectedRowKeys(keys)
    } else {
      setZoteroSelectedRowKeys(keys)
    }
  }, [activeView])

  const [activeCollectionKey, setActiveCollectionKey] = useState<string | null>(() => readString(ACTIVE_COLLECTION_KEY))
  const [columnsPopoverOpen, setColumnsPopoverOpen] = useState(false)

  // --- Filter State: 筛选与搜索 ---
  // 管理侧边栏筛选、顶部搜索框以及高级筛选面板的状态
  const {
    filterMode,
    setFilterMode,
    zoteroFilterModeRef,
    filterPopoverOpen,
    setFilterPopoverOpen,
    fieldFilter,
    setFieldFilter,
    searchQuery,
    setSearchQuery,
    normalizedSearchQuery,
    searchPopoverOpen,
    setSearchPopoverOpen,
    searchInputElRef,
  } = useFilterState(activeView)

  const [mode, setMode] = useState<'workbench' | 'settings'>('workbench')

  // --- Config State: 配置管理 ---
  // 负责应用配置的读取、保存、表单绑定以及设置页面的各个部分
  const {
    rawConfig,
    setRawConfig,
    configForm,
    fieldsForm,
    settingsScrollApiRef,
    zoteroStatus,
    settingsSection,
    setSettingsSection,
    settingsLoading,
    settingsSaving,
    scheduleAutoSaveSettings,
    loadSettings,
    metaFieldDefs,
    analysisFieldDefs
  } = useAppConfig(mode)

  // --- Theme State: 主题 ---
  // 根据搜索状态动态调整主题样式（如搜索激活时的高亮）
  const { themeToken, activeSearchButtonStyle } = useAppTheme(normalizedSearchQuery)

  const [currentPageRows, setCurrentPageRows] = useState<LiteratureItem[]>([])
  const [detailMode, setDetailMode] = useState<LiteratureDetailDrawerMode>(() => (readString(ACTIVE_VIEW_KEY) ?? 'zotero') === 'matrix' ? 'matrix' : 'zotero')

  // --- Citation State: 引用生成 ---
  // 管理文献引用的异步生成、缓存及状态更新
  const {
    citationsTick,
    detailCitationState,
    setDetailCitationState,
    citationCacheRef,
    citationsInFlightRef,
    ensureCitations,
  } = useCitationManager(library, setLibrary)

  // --- Computed Data: 筛选与排序结果 ---

  // 1. 根据当前选中的集合（Collection）获取基础文献列表
  const collectionItems = useCollectionItems(library, activeCollectionKey)

  // 2. 根据当前列表内容生成可用的筛选项（如存在的年份、标签等）
  const {
    filterYearOptions,
    filterTypeOptions,
    filterTagOptions,
    filterKeywordOptions,
    filterBibTypeOptions
  } = useFilterOptions(collectionItems)

  // 3. 应用所有筛选条件（状态、字段、搜索关键词）得到最终展示列表
  const filteredItems = useFilteredItems(
    collectionItems,
    filterMode,
    fieldFilter,
    normalizedSearchQuery
  )

  // 4. 维护排序后的列表，用于详情页的前后条目导航
  const [sortedItems, setSortedItems] = useState<LiteratureItem[]>([])
  const navigationItems = sortedItems.length > 0 ? sortedItems : filteredItems

  // --- Detail Navigation: 详情页控制 ---
  // 处理详情抽屉的打开/关闭以及条目切换逻辑
  const {
    activeItemKey,
    setActiveItemKey,
    activeItem,
    canPrevDetail,
    canNextDetail,
    goPrevDetail,
    goNextDetail
  } = useDetailNavigation(library, navigationItems)

  // --- Columns Config: 列显示配置 ---
  // 计算表格需要显示的列（元数据列 + 分析字段列）
  const {
    metaColumnPanel,
    analysisColumnPanel,
    tableMetaColumns,
    tableAnalysisColumns,
    applyMetaPanelChange,
    applyAnalysisPanelChange,
    matrixAnalysisOrder,
    getFieldName,
  } = useColumnConfig(
    rawConfig,
    setRawConfig,
    metaFieldDefs,
    analysisFieldDefs,
    activeView
  )

  const citationColumnVisible = useMemo(() => tableMetaColumns.some((c) => c.key === 'citation'), [tableMetaColumns])

  // --- Watcher: 外部状态监听 ---
  // 监听 Zotero 数据库变化并自动刷新
  useZoteroWatch(zoteroStatus, refreshLibrary)

  // --- Analysis Logic: 分析执行 ---
  // 处理“开始分析”、“停止分析”、“删除分析结果”等核心业务逻辑
  const {
    analysisInProgress,
    stoppingAnalysis,
    deletingExtracted,
    confirmModal,
    setConfirmModal,
    startAnalysis,
    handleAnalysisRequest,
    handleStopAnalysisRequest,
    handleConfirmStopAnalysis,
    handleConfirmAnalysis,
    handleDeleteRequest,
    handleConfirmDelete,
  } = useAnalysisState(
    library,
    setLibrary,
    selectedRowKeys,
    setSelectedRowKeys,
    handleRefresh,
    analysisInProgressRef
  )

  const handleSelectCollection = useCallback((key: string) => {
    setActiveCollectionKey(key)
    writeString(ACTIVE_COLLECTION_KEY, key)
  }, [])

  // --- Effects: 副作用管理 ---

  // 1. 持久化当前视图模式（Zotero/Matrix）
  useEffect(() => {
    writeString(ACTIVE_VIEW_KEY, activeView)
  }, [activeView])

  const lastDetailItemKeyRef = useRef<string | null>(null)

  // 2. 管理详情抽屉的模式（编辑模式/查看模式）
  // 规则：初次打开时根据主视图跟随（Matrix视图->Matrix模式），之后保持用户选择
  useEffect(() => {
    const wasOpen = lastDetailItemKeyRef.current !== null
    const isOpen = activeItemKey !== null

    if (!isOpen) {
      lastDetailItemKeyRef.current = null
      return
    }

    if (!wasOpen && isOpen) {
      setDetailMode(activeView === 'matrix' ? 'matrix' : 'zotero')
    }
    lastDetailItemKeyRef.current = activeItemKey
  }, [activeItemKey, activeView])

  // 3. 校验集合有效性：如果 activeCollectionKey 为空，清理本地存储
  useEffect(() => {
    if (!activeCollectionKey) deleteKey(ACTIVE_COLLECTION_KEY)
  }, [activeCollectionKey])

  // 4. 当离开工作台模式时，关闭所有浮层（搜索框、筛选器）
  useEffect(() => {
    if (mode !== 'workbench') {
      setSearchPopoverOpen(false)
      setFilterPopoverOpen(false)
    }
  }, [mode])

  // 5. 全局快捷键：Ctrl+F 唤起搜索
  useEffect(() => {
    if (mode !== 'workbench') return

    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
      if (key !== 'f') return
      e.preventDefault()
      setSearchPopoverOpen(true)
      window.setTimeout(() => searchInputElRef.current?.focus(), 0)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mode])

  // 6. 详情页引用自动生成
  // 当打开详情页时，自动检查并生成该条目的引用信息
  useEffect(() => {
    if (!activeItemKey) {
      setDetailCitationState({ loading: false, error: null })
      return
    }

    const key = activeItemKey
    const it = library.items.find((x) => x.item_key === key) as unknown as Record<string, unknown> | undefined
    const dm = it?.date_modified
    const cached = citationCacheRef.current.get(key)
    const inFlight = citationsInFlightRef.current.has(key)
    const needFetch = !inFlight && !(cached && cached.text && cached.dateModified === dm)

    setDetailCitationState({ loading: inFlight || needFetch, error: null })
    if (!needFetch) return

    let canceled = false
    void ensureCitations([key]).then((ok) => {
      if (canceled) return
      if (ok) setDetailCitationState({ loading: false, error: null })
      else setDetailCitationState({ loading: false, error: '引用生成失败' })
    })

    return () => {
      canceled = true
    }
  }, [activeItemKey, citationsTick, ensureCitations, library.items])

  // 7. 列表中引用自动生成
  // 当引用列可见时，批量生成当前页所有条目的引用
  useEffect(() => {
    if (!citationColumnVisible) return
    const keys = currentPageRows.map((it) => it.item_key).filter(Boolean)
    if (keys.length === 0) return
    void ensureCitations(keys)
  }, [citationColumnVisible, currentPageRows, ensureCitations])

  const segmentedOptions: { label: string; value: string }[] = [
    { label: 'Zotero库', value: 'zotero' },
    { label: '文献矩阵', value: 'matrix' },
  ]

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: themeToken.colorPrimary,
          borderRadius: themeToken.borderRadius,
          fontSize: themeToken.fontSize,
          colorText: themeToken.colorText,
          colorTextSecondary: themeToken.colorTextSecondary,
        },
        components: {
          Layout: {
            bodyBg: themeToken.bodyBg,
            siderBg: themeToken.siderBg,
          },
          Segmented: {
            itemSelectedBg: '#ffffff',
            itemSelectedColor: themeToken.colorPrimary,
            trackBg: themeToken.segmentedTrackBg,
            itemColor: themeToken.colorTextSecondary,
          }
        },
      }}
    >
      <AntApp>
        <div className="flex h-screen w-screen overflow-hidden bg-[var(--app-bg)]">
          {/* 自定义标题栏 */}
          <TitleBar />
          <Layout className="w-full h-full bg-transparent">
            {/* 左侧侧边栏：根据模式显示 文献库目录 或 设置菜单 */}
            <Sider width={280} theme="light" className="border-r border-slate-200 !bg-[var(--app-bg)]">
              {mode === 'workbench' ? (
                <AppSidebar
                  collections={library.collections}
                  activeKey={activeCollectionKey}
                  onSelect={handleSelectCollection}
                  zoteroStatus={zoteroStatus}
                  refreshState={{
                    refreshing: refreshingLibrary,
                    error: refreshError,
                    lastUpdatedAt: lastRefreshAt,
                  }}
                  onRefresh={handleRefresh}
                  onSettings={() => {
                    setMode('settings')
                    setSettingsSection('zotero')
                  }}
                />
              ) : (
                <SettingsSidebar
                  activeKey={settingsSection}
                  onSelect={(k) => {
                    setSettingsSection(k)
                    settingsScrollApiRef.current?.scrollToSection(k)
                  }}
                  onGoHome={() => setMode('workbench')}
                  zoteroStatus={zoteroStatus}
                />
              )}
            </Sider>
            {/* 主要内容区域 */}
            <Content className="flex flex-col overflow-hidden min-h-0 relative p-4 pt-10 gap-4">
              {/* 顶部拖拽区域：避开右上角窗口控制按钮 (约140px宽)，防止点击穿透 */}
              <div data-tauri-drag-region className="absolute top-0 left-0 right-36 h-10" />
              {mode === 'workbench' ? (
                <div className="flex-1 min-h-0 bg-white rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-slate-100 overflow-hidden flex flex-col relative">
                  {/* 工具栏：整体禁用拖拽，用户可通过顶部专用区域拖动窗口 */}
                  <div
                    data-tauri-drag-region="false"
                    className="flex justify-between items-center shrink-0 px-4 py-3 border-b border-slate-100"
                  >
                    <div>
                      <Segmented
                        value={activeView}
                        onChange={(value) => {
                          const next = value as string
                          setActiveView(next)
                          if (next === 'matrix') {
                            zoteroFilterModeRef.current = filterMode
                            setFilterMode('processed')
                            return
                          }
                          setFilterMode(zoteroFilterModeRef.current)
                        }}
                        options={segmentedOptions}
                        className="matrixit-segmented"
                      />
                    </div>

                    <div className="flex items-center gap-3">
                      <span className="text-xs secondary-color">已选 {selectedRowKeys.length} 条</span>

                      <Space size={8}>
                        <Popover
                          trigger="click"
                          placement="bottomRight"
                          open={searchPopoverOpen}
                          onOpenChange={(open) => {
                            setSearchPopoverOpen(open)
                            if (open) window.setTimeout(() => searchInputElRef.current?.focus(), 0)
                          }}
                          content={
                            <div data-tauri-drag-region="false" className="w-80">
                              <div className="text-xs secondary-color mb-2">搜索当前集合</div>
                              <Input
                                placeholder="搜索标题/作者"
                                allowClear
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    setSearchPopoverOpen(false)
                                  }
                                }}
                                ref={(node) => {
                                  searchInputElRef.current = (node as unknown as { input?: HTMLInputElement } | null)?.input ?? null
                                }}
                              />
                              <div className="mt-2 text-[11px] secondary-color">
                                {normalizedSearchQuery ? `匹配 ${filteredItems.length} 条（标题/作者模糊）` : '支持模糊搜索：标题、作者'}
                              </div>
                            </div>
                          }
                        >
                          <Button
                            key="search"
                            icon={<SearchOutlined />}
                            aria-label="搜索当前集合"
                            title="搜索当前集合（Ctrl+F）"
                            style={activeSearchButtonStyle}
                          />
                        </Popover>
                        <LiteratureFilterPopover
                          open={filterPopoverOpen}
                          onOpenChange={setFilterPopoverOpen}
                          disabled={false}
                          hideStatus={activeView === 'matrix'}
                          themePrimaryColor={themeToken.colorPrimary}
                          value={{
                            statusMode: filterMode,
                            match: fieldFilter.match,
                            yearOp: fieldFilter.yearOp,
                            year: fieldFilter.year,
                            type: fieldFilter.type,
                            publications: fieldFilter.publications,
                            tags: fieldFilter.tags,
                            keywords: fieldFilter.keywords,
                            bibType: fieldFilter.bibType,
                          }}
                          onChange={(next) => {
                            // 使用单次状态更新减少重渲染
                            setFilterMode(next.statusMode)
                            setFieldFilter({
                              match: next.match,
                              yearOp: next.yearOp,
                              year: next.year,
                              type: next.type,
                              publications: next.publications,
                              tags: next.tags || [],
                              keywords: next.keywords || [],
                              bibType: next.bibType || '',
                            })
                          }}
                          yearOptions={filterYearOptions}
                          typeOptions={filterTypeOptions}
                          tagOptions={filterTagOptions}
                          keywordOptions={filterKeywordOptions}
                          bibTypeOptions={filterBibTypeOptions}
                        />
                        <ColumnSettingsPopover
                          open={columnsPopoverOpen}
                          onOpenChange={setColumnsPopoverOpen}
                          activeView={activeView as LiteratureTableView}
                          metaPanel={metaColumnPanel}
                          analysisPanel={analysisColumnPanel}
                          metaFieldDefs={metaFieldDefs}
                          analysisFieldDefs={analysisFieldDefs}
                          getFieldName={getFieldName}
                          applyMetaPanelChange={applyMetaPanelChange}
                          applyAnalysisPanelChange={applyAnalysisPanelChange}
                        />
                        {analysisInProgress ? (
                          <Button
                            key="stop_analyze"
                            danger
                            icon={<StopOutlined />}
                            onClick={handleStopAnalysisRequest}
                            loading={stoppingAnalysis}
                          >
                            {stoppingAnalysis ? '终止中' : '终止分析'}
                          </Button>
                        ) : (
                          <Button
                            key="analyze"
                            type="primary"
                            icon={<PlayCircleOutlined />}
                            onClick={handleAnalysisRequest}
                            disabled={selectedRowKeys.length === 0}
                          >
                            {library.items.some((it) => selectedRowKeys.includes(it.item_key) && it.processed_status === 'done')
                              ? '重新分析'
                              : '开始分析'}
                          </Button>
                        )}
                        {activeView === 'matrix' ? (
                          <Button
                            key="delete_extracted"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={handleDeleteRequest}
                            disabled={
                              selectedRowKeys.length === 0 ||
                              deletingExtracted ||
                              library.items.some((it) => selectedRowKeys.includes(it.item_key) && it.processed_status === 'reanalyzing')
                            }
                            title={
                              library.items.some((it) => selectedRowKeys.includes(it.item_key) && it.processed_status === 'reanalyzing')
                                ? '重新分析中的条目无法删除'
                                : undefined
                            }
                          >
                          </Button>
                        ) : null}
                      </Space>
                    </div>
                  </div>

                  <div className="flex-1 min-h-0 overflow-hidden relative flex flex-col">
                    <LiteratureTable
                      data={filteredItems}
                      view={activeView as LiteratureTableView}
                      metaColumns={tableMetaColumns}
                      analysisColumns={tableAnalysisColumns}
                      selectedRowKeys={selectedRowKeys}
                      onSelectedRowKeysChange={setSelectedRowKeys}
                      onOpenDetail={(key) => setActiveItemKey(key)}
                      onRefresh={handleRefresh}
                      onPageRowsChange={setCurrentPageRows}
                      activeItemKey={activeItemKey}
                      onSortedDataChange={setSortedItems}
                    />
                  </div>
                </div>
              ) : (
                <SettingsPage
                  configForm={configForm}
                  fieldsForm={fieldsForm}
                  loading={settingsLoading}
                  saving={settingsSaving}
                  activeSection={settingsSection}
                  scrollApiRef={settingsScrollApiRef}
                  onActiveSectionChange={setSettingsSection}
                  onGoHome={() => setMode('workbench')}
                  onReload={loadSettings}
                  onAutoSave={scheduleAutoSaveSettings}
                />
              )}
            </Content>
          </Layout>

          {/* 详情页抽屉：显示文献详情、编辑分析结果 */}
          {mode === 'workbench' ? (
            <LiteratureDetailDrawer
              item={activeItem}
              mode={detailMode}
              analysisFieldDefs={analysisFieldDefs}
              analysisOrder={matrixAnalysisOrder}
              onSwitchMode={setDetailMode}
              citationState={activeItemKey ? detailCitationState : undefined}
              onClose={() => setActiveItemKey(null)}
              onPrev={goPrevDetail}
              onNext={goNextDetail}
              canPrev={canPrevDetail}
              canNext={canNextDetail}
              onSave={
                detailMode === 'matrix'
                  ? async (key, patch) => {
                    try {
                      await updateItemRpc(key, patch)
                      setLibrary((prev) => ({
                        ...prev,
                        items: prev.items.map((it) => (it.item_key === key ? { ...it, ...patch } : it)),
                      }))
                    } catch (e) {
                      const msg = e instanceof Error ? e.message : '保存失败'
                      message.error(msg)
                      throw e instanceof Error ? e : new Error(msg)
                    }
                  }
                  : undefined
              }
            />
          ) : null}

          {/* 确认模态框：处理高风险操作的二次确认 */}
          <ConfirmModal
            open={confirmModal.open}
            onCancel={() => setConfirmModal((prev) => ({ ...prev, open: false }))}
            onConfirm={
              confirmModal.type === 'delete'
                ? handleConfirmDelete
                : confirmModal.type === 'stop'
                  ? handleConfirmStopAnalysis
                  : handleConfirmAnalysis
            }
            title={
              confirmModal.type === 'delete'
                ? '确认删除分析与矩阵数据'
                : confirmModal.type === 'stop'
                  ? '确认终止分析'
                  : confirmModal.type === 'mixed_analyze'
                    ? '确认分析策略'
                    : '确认重新分析'
            }
            type={confirmModal.type === 'delete' || confirmModal.type === 'stop' ? 'danger' : 'primary'}
            content={
              confirmModal.type === 'mixed_analyze' ? (
                <div className="flex flex-col gap-2">
                  <p className="text-base">
                    选中 <span className="font-bold">{selectedRowKeys.length}</span> 条文献，其中 <span className="font-bold text-orange-500">{library.items.filter(it => selectedRowKeys.includes(it.item_key) && it.processed_status === 'done').length}</span> 条已完成。
                  </p>
                  <p className="text-sm text-slate-500">
                    请选择您希望执行的分析策略。
                  </p>
                </div>
              ) : confirmModal.type === 'delete' ? (
                <div className="flex flex-col gap-2">
                  <p className="text-base">
                    确定要清除选中的 <span className="font-bold text-red-600">{selectedRowKeys.length}</span> 条文献的分析结果吗？
                  </p>
                  <ul className="list-disc pl-5 text-slate-500 text-sm space-y-1">
                    <li>文献的分析字段将被清空</li>
                    <li>条目将从“文献矩阵”视图中移除（回到“未处理”状态）</li>
                    <li>Zotero 中的原始条目不会被删除</li>
                    <li>如果已同步到飞书，飞书对应记录将尝试被删除</li>
                  </ul>
                </div>
              ) : confirmModal.type === 'stop' ? (
                <div className="flex flex-col gap-2">
                  <p className="text-base">
                    确定要终止当前的分析任务吗？
                  </p>
                  <ul className="list-disc pl-5 text-slate-500 text-sm space-y-1">
                    <li>已完成的分析结果会保留</li>
                    <li>正在分析和待分析的条目将被取消</li>
                  </ul>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-base">
                    确定要重新分析选中的 <span className="font-bold text-[var(--primary-color)]">{selectedRowKeys.length}</span> 条文献吗？
                  </p>
                  <ul className="list-disc pl-5 text-slate-500 text-sm space-y-1">
                    <li>现有的分析结果将被覆盖</li>
                    <li>分析过程可能需要一些时间</li>
                  </ul>
                </div>
              )
            }
            confirmText={
              confirmModal.type === 'delete'
                ? '删除'
                : confirmModal.type === 'stop'
                  ? '终止'
                  : '重新分析'
            }
            loading={
              confirmModal.type === 'delete'
                ? deletingExtracted
                : confirmModal.type === 'stop'
                  ? stoppingAnalysis
                  : false
            }
            footer={
              confirmModal.type === 'mixed_analyze' ? (
                <div className="flex gap-2">
                  <Button onClick={() => setConfirmModal((prev) => ({ ...prev, open: false }))}>
                    取消
                  </Button>
                  <Button onClick={() => {
                    void startAnalysis()
                    setConfirmModal((prev) => ({ ...prev, open: false }))
                  }}>
                    重新分析全部
                  </Button>
                  <Button type="primary" onClick={() => {
                    const items = library.items.filter((it) => selectedRowKeys.includes(it.item_key))
                    const todo = items.filter((it) => it.processed_status !== 'done').map((it) => it.item_key)
                    void startAnalysis(todo)
                    setConfirmModal((prev) => ({ ...prev, open: false }))
                  }}>
                    仅分析未处理
                  </Button>
                </div>
              ) : undefined
            }
          />
        </div>
      </AntApp>
    </ConfigProvider>
  )
}

/**
 * 子模块: 设置侧边栏
 * 功能: 在设置模式下显示的侧边栏，提供不同设置项的导航菜单。
 */
function SettingsSidebar({
  activeKey,
  onSelect,
  onGoHome,
  zoteroStatus,
}: {
  activeKey: SettingsSectionKey
  onSelect: (k: SettingsSectionKey) => void
  onGoHome: () => void
  zoteroStatus: { path: string; connected: boolean }
}) {
  return (
    <div className="flex flex-col h-full bg-[var(--app-bg)] border-r border-slate-200">
      <div className="px-4 py-3 flex items-center justify-between">
        <div className="font-bold text-xl primary-color tracking-tight">设置</div>
        <div className="flex items-center gap-1">
          <Button type="text" size="middle" icon={<HomeOutlined />} onClick={onGoHome} aria-label="返回首页" />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 custom-scrollbar">
        <Menu
          selectedKeys={[activeKey]}
          onClick={(e) => onSelect(e.key as SettingsSectionKey)}
          items={[
            { key: 'zotero', label: 'Zotero' },
            { key: 'llm', label: '大模型 API' },
            { key: 'feishu', label: '飞书多维表格' },
            { key: 'fields', label: '字段设置' },
          ]}
          className="bg-transparent"
        />
      </div>

      <div className="p-4">
        <ZoteroStatusFooter zoteroStatus={zoteroStatus} />
      </div>
    </div>
  )
}
