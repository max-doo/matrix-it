import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ConfigProvider,
  Layout,
  Button,
  Alert,
  Popover,
  Input,
  Space,
  App as AntApp,
  Segmented,
  Modal,
  message,
} from 'antd'
import {
  PlayCircleOutlined,
  SearchOutlined,
  DeleteOutlined,
  StopOutlined,
  ExclamationCircleOutlined,
} from '@ant-design/icons'
import zhCN from 'antd/locale/zh_CN'

import type { LiteratureItem } from '../types'
import {
  updateItem as updateItemRpc,
} from '../lib/backend'
import { AppSidebar } from './components/AppSidebar'
import { LiteratureTable, type LiteratureTableView } from './components/LiteratureTable'
import { TitleBar } from './components/TitleBar'
import { SettingsPage } from './components/SettingsPage'
import { SettingsSidebar } from './components/SettingsSidebar'
import { ColumnSettingsPopover } from './components/ColumnSettingsPopover'
import { LiteratureFilterPopover } from './components/LiteratureFilterPopover'
import { LiteratureDetailDrawer, type LiteratureDetailDrawerMode } from './components/LiteratureDetailDrawer'
import { useAppConfig } from './hooks/useAppConfig'
import { useAppTheme } from './hooks/useAppTheme'
import { useAnalysisState } from './hooks/useAnalysisState'
import { useCitationManager } from './hooks/useCitationManager'
import { useColumnConfig } from './hooks/useColumnConfig'
import { useFilterState } from './hooks/useFilterState'
import { useLibraryState, useZoteroWatch } from './hooks/useLibraryState'
import { STORAGE_KEYS, deleteKey, readString, writeString } from './lib/storage'
import { collectCollectionKeys } from './lib/collectionUtils'

const { Sider, Content } = Layout

/**
 * 应用主组件：负责组装工作台/设置页布局，并将筛选、主题等状态委托给独立 hooks 管理。
 */
export default function App() {
  const analysisInProgressRef = useRef(false)
  const { library, setLibrary, refreshingLibrary, refreshError, setRefreshError, lastRefreshAt, refreshLibrary, handleRefresh } =
    useLibraryState(analysisInProgressRef)
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([])
  const [activeCollectionKey, setActiveCollectionKey] = useState<string | null>(() => readString(STORAGE_KEYS.ACTIVE_COLLECTION))
  const [activeItemKey, setActiveItemKey] = useState<string | null>(null)
  const [detailLeaveGuard, setDetailLeaveGuard] = useState<null | (() => Promise<boolean>)>(null)
  const [activeView, setActiveView] = useState(() => readString(STORAGE_KEYS.ACTIVE_VIEW) ?? 'zotero')
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
  const { themeToken, activeSearchButtonStyle } = useAppTheme(normalizedSearchQuery)
  const [columnsPopoverOpen, setColumnsPopoverOpen] = useState(false)
  const [mode, setMode] = useState<'workbench' | 'settings'>('workbench')
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
    analysisFieldDefs,
  } = useAppConfig(mode)
  useZoteroWatch(zoteroStatus, refreshLibrary)
  const [currentPageRows, setCurrentPageRows] = useState<LiteratureItem[]>([])
  const [tableSortedKeys, setTableSortedKeys] = useState<string[]>([])
  const [detailMode, setDetailMode] = useState<LiteratureDetailDrawerMode>(() => (readString(STORAGE_KEYS.ACTIVE_VIEW) ?? 'zotero') === 'matrix' ? 'matrix' : 'zotero')
  const {
    metaColumnPanel,
    analysisColumnPanel,
    matrixAnalysisOrder,
    applyMetaPanelChange,
    applyAnalysisPanelChange,
    getFieldName,
    tableMetaColumns,
    tableAnalysisColumns,
    citationColumnVisible,
  } = useColumnConfig(rawConfig, setRawConfig, metaFieldDefs, analysisFieldDefs, activeView)
  const { citationsTick, detailCitationState, setDetailCitationState, citationCacheRef, citationsInFlightRef, ensureCitations } =
    useCitationManager(library, setLibrary)
  const {
    analysisInProgress,
    stoppingAnalysis,
    deletingExtracted,
    confirmModal,
    setConfirmModal,
    startAnalysis: startAnalysis,
    handleAnalysisRequest,
    handleConfirmAnalysis,
    handleDeleteRequest,
    handleConfirmDelete,
    handleStopAnalysisRequest,
    handleConfirmStopAnalysis,
  } = useAnalysisState(library, setLibrary, selectedRowKeys, setSelectedRowKeys, handleRefresh, analysisInProgressRef)

  const handleSelectCollection = useCallback((key: string) => {
    setActiveCollectionKey(key)
    writeString(STORAGE_KEYS.ACTIVE_COLLECTION, key)
  }, [])

  const requestOpenDetail = useCallback(
    async (key: string) => {
      if (key === activeItemKey) return
      if (detailLeaveGuard) {
        const ok = await detailLeaveGuard()
        if (!ok) return
      }
      setActiveItemKey(key)
    },
    [activeItemKey, detailLeaveGuard]
  )

  useEffect(() => {
    writeString(STORAGE_KEYS.ACTIVE_VIEW, activeView)
  }, [activeView])

  const lastDetailItemKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!activeItemKey) {
      lastDetailItemKeyRef.current = null
      return
    }
    const wasClosed = lastDetailItemKeyRef.current === null
    lastDetailItemKeyRef.current = activeItemKey
    if (!wasClosed) return
    setDetailMode(activeView === 'matrix' ? 'matrix' : 'zotero')
  }, [activeItemKey, activeView])

  useEffect(() => {
    if (!activeCollectionKey) deleteKey(STORAGE_KEYS.ACTIVE_COLLECTION)
  }, [activeCollectionKey])

  useEffect(() => {
    if (library.collections.length === 0) return
    const keys = collectCollectionKeys(library.collections)
    setActiveCollectionKey((prev) => (prev && keys.has(prev) ? prev : null))
  }, [library.collections])

  useEffect(() => {
    if (mode !== 'workbench') {
      setSearchPopoverOpen(false)
      setFilterPopoverOpen(false)
    }
  }, [mode])

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

  const collectionItems = useMemo(() => {
    return activeCollectionKey
      ? library.items.filter((it) =>
        (it.collections ?? []).some((c) => c.key === activeCollectionKey || c.pathKeyChain?.includes(activeCollectionKey))
      )
      : library.items
  }, [activeCollectionKey, library.items])

  const filterYearOptions = useMemo(() => {
    const years = new Set<number>()
    for (const it of collectionItems) {
      const raw = String((it as unknown as Record<string, unknown>).year ?? '')
      const y = Number.parseInt(raw.replace(/[^\d]/g, ''), 10)
      if (Number.isFinite(y) && y > 0) years.add(y)
    }
    return Array.from(years)
      .sort((a, b) => b - a)
      .map((y) => ({ value: String(y), label: String(y) }))
  }, [collectionItems])

  const filterTypeOptions = useMemo(() => {
    const types = new Set<string>()
    for (const it of collectionItems) {
      const raw = String(((it as unknown as Record<string, unknown>).type ?? it.bib_type ?? '') as unknown)
        .trim()
        .replace(/\s+/g, ' ')
      if (raw) types.add(raw)
    }
    return Array.from(types)
      .sort((a, b) => a.localeCompare(b, 'zh-CN'))
      .map((t) => ({ value: t, label: t }))
  }, [collectionItems])

  const filterTagOptions = useMemo(() => {
    const allTags = new Set<string>()
    for (const it of collectionItems) {
      const metaExtra = (it as Record<string, unknown>).meta_extra
      const tags = metaExtra && typeof metaExtra === 'object' ? (metaExtra as Record<string, unknown>).tags : null
      if (Array.isArray(tags)) {
        for (const t of tags) {
          const s = String(t || '').trim()
          if (s) allTags.add(s)
        }
      }
    }
    return Array.from(allTags)
      .sort((a, b) => a.localeCompare(b, 'zh-CN'))
      .map((t) => ({ value: t, label: t }))
  }, [collectionItems])

  const filterKeywordOptions = useMemo(() => {
    const allKeywords = new Set<string>()
    for (const it of collectionItems) {
      const val = (it as Record<string, unknown>).key_word
      if (Array.isArray(val)) {
        for (const k of val) {
          const s = String(k || '').trim()
          if (s) allKeywords.add(s)
        }
      } else if (typeof val === 'string' && val.trim().length > 0) {
        const parts = val.split(/[,，;；\n]/).map((s) => s.trim()).filter(Boolean)
        for (const p of parts) allKeywords.add(p)
      }
    }
    return Array.from(allKeywords)
      .sort((a, b) => a.localeCompare(b, 'zh-CN'))
      .map((t) => ({ value: t, label: t }))
  }, [collectionItems])

  const filterBibTypeOptions = useMemo(() => {
    const types = new Set<string>()
    for (const it of collectionItems) {
      const raw = String(((it as unknown as Record<string, unknown>).bib_type ?? '') as unknown)
        .trim()
        .replace(/\s+/g, ' ')
      if (raw) types.add(raw)
    }
    return Array.from(types)
      .sort((a, b) => a.localeCompare(b, 'zh-CN'))
      .map((t) => ({ value: t, label: t }))
  }, [collectionItems])

  // 根据集合与状态筛选条目：
  // - 集合命中规则：集合 key 命中或 pathKeyChain 包含（选中父集合会包含其子集合条目）
  const filteredItems = useMemo(() => {
    const byStatus =
      filterMode === 'all'
        ? collectionItems
        : filterMode === 'unprocessed'
          ? collectionItems.filter((it) => it.processed_status !== 'done' && it.processed_status !== 'reanalyzing')
          : collectionItems.filter((it) => it.processed_status === 'done' || it.processed_status === 'reanalyzing')

    const q = normalizedSearchQuery
    const normalizeText = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

    const predicates: Array<(it: LiteratureItem) => boolean> = []

    const yearRaw = fieldFilter.year.trim()
    if (yearRaw) {
      const targetYear = Number.parseInt(yearRaw, 10)
      if (Number.isFinite(targetYear)) {
        predicates.push((it) => {
          const raw = String((it as unknown as Record<string, unknown>).year ?? '')
          const y = Number.parseInt(raw.replace(/[^\d]/g, ''), 10)
          if (!Number.isFinite(y)) return false
          if (fieldFilter.yearOp === 'gt') return y > targetYear
          if (fieldFilter.yearOp === 'lt') return y < targetYear
          return y === targetYear
        })
      }
    }

    const bibTypeRaw = fieldFilter.bibType.trim()
    if (bibTypeRaw) {
      const target = normalizeText(bibTypeRaw)
      predicates.push((it) => {
        const v = ((it as unknown as Record<string, unknown>).bib_type ?? '') as unknown
        return normalizeText(v) === target
      })
    }

    const typeRaw = fieldFilter.type.trim()
    if (typeRaw) {
      const target = normalizeText(typeRaw)
      predicates.push((it) => {
        const v = ((it as unknown as Record<string, unknown>).type ?? it.bib_type ?? '') as unknown
        return normalizeText(v) === target
      })
    }

    const pubRaw = fieldFilter.publications.trim()
    if (pubRaw) {
      const target = normalizeText(pubRaw)
      predicates.push((it) => {
        const v = ((it as unknown as Record<string, unknown>).publications ?? '') as unknown
        return normalizeText(v).includes(target)
      })
    }

    if (fieldFilter.tags.length > 0) {
      const targetSet = new Set(fieldFilter.tags)
      predicates.push((it) => {
        const metaExtra = (it as Record<string, unknown>).meta_extra
        const tags = metaExtra && typeof metaExtra === 'object' ? (metaExtra as Record<string, unknown>).tags : null
        if (!Array.isArray(tags)) return false
        return tags.some((t) => targetSet.has(String(t || '').trim()))
      })
    }

    if (fieldFilter.keywords.length > 0) {
      const targetSet = new Set(fieldFilter.keywords)
      predicates.push((it) => {
        const val = (it as Record<string, unknown>).key_word
        let currentKeywords: string[] = []
        if (Array.isArray(val)) {
          currentKeywords = val.map((x) => String(x || '').trim()).filter(Boolean)
        } else if (typeof val === 'string' && val.trim().length > 0) {
          currentKeywords = val.split(/[,，;；\n]/).map((s) => s.trim()).filter(Boolean)
        }
        return currentKeywords.some((k) => targetSet.has(k))
      })
    }

    const byFieldFilter =
      predicates.length === 0
        ? byStatus
        : byStatus.filter((it) => (fieldFilter.match === 'all' ? predicates.every((p) => p(it)) : predicates.some((p) => p(it))))

    if (!q) return byFieldFilter

    return byFieldFilter.filter((it) => {
      const title = normalizeText(it.title)
      const author = normalizeText(it.author)
      return title.includes(q) || author.includes(q)
    })
  }, [activeView, collectionItems, fieldFilter, filterMode, normalizedSearchQuery])

  const activeItem = useMemo(
    () => (activeItemKey ? library.items.find((it) => it.item_key === activeItemKey) ?? null : null),
    [activeItemKey, library.items]
  )

  const filteredItemKeys = useMemo(() => {
    return filteredItems
      .map((it) => it.item_key)
      .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
  }, [filteredItems])

  const detailNavKeys = useMemo(() => {
    if (tableSortedKeys.length === filteredItemKeys.length) {
      const pool = new Set(filteredItemKeys)
      if (tableSortedKeys.every((k) => pool.has(k))) return tableSortedKeys
    }
    return filteredItemKeys
  }, [filteredItemKeys, tableSortedKeys])

  const activeItemIndex = useMemo(() => {
    if (!activeItemKey) return -1
    return detailNavKeys.indexOf(activeItemKey)
  }, [activeItemKey, detailNavKeys])

  const canPrevDetail = activeItemIndex > 0
  const canNextDetail = activeItemIndex >= 0 && activeItemIndex < detailNavKeys.length - 1

  const goPrevDetail = useCallback(() => {
    if (!canPrevDetail) return
    const prevKey = detailNavKeys[activeItemIndex - 1]
    if (prevKey) setActiveItemKey(prevKey)
  }, [activeItemIndex, canPrevDetail, detailNavKeys])

  const goNextDetail = useCallback(() => {
    if (!canNextDetail) return
    const nextKey = detailNavKeys[activeItemIndex + 1]
    if (nextKey) setActiveItemKey(nextKey)
  }, [activeItemIndex, canNextDetail, detailNavKeys])

  const handleTableSortedDataChange = useCallback((rows: LiteratureItem[]) => {
    const keys = rows
      .map((it) => it.item_key)
      .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
    setTableSortedKeys(keys)
  }, [])

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

  useEffect(() => {
    if (!citationColumnVisible) return
    const keys = currentPageRows.map((it) => it.item_key).filter(Boolean)
    if (keys.length === 0) return
    void ensureCitations(keys)
  }, [citationColumnVisible, currentPageRows, ensureCitations])
  const closeConfirmModal = useCallback(() => {
    setConfirmModal((prev) => ({ ...prev, open: false }))
  }, [setConfirmModal])

  const selectedItemStats = useMemo(() => {
    const selected = new Set(selectedRowKeys.map((k) => String(k)))
    let total = 0
    let done = 0
    for (const it of library.items) {
      if (!selected.has(it.item_key)) continue
      total += 1
      if (it.processed_status === 'done') done += 1
    }
    return { total, done, unprocessed: Math.max(0, total - done) }
  }, [library.items, selectedRowKeys])

  const handleConfirmMixedAnalyzeUnprocessed = useCallback(() => {
    const selected = new Set(selectedRowKeys.map((k) => String(k)))
    const keys = library.items
      .filter((it) => selected.has(it.item_key) && it.processed_status !== 'done')
      .map((it) => it.item_key)
    closeConfirmModal()
    if (keys.length === 0) return
    void startAnalysis(keys)
  }, [closeConfirmModal, library.items, selectedRowKeys, startAnalysis])

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
          <TitleBar />
          <Layout className="w-full h-full bg-transparent">
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
            <Content className="flex flex-col overflow-hidden min-h-0 relative p-4 pt-10 gap-4">
              <div data-tauri-drag-region className="absolute top-0 left-0 right-0 h-10" />
              {mode === 'workbench' ? (
                <div className="flex-1 min-h-0 bg-white rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-slate-100 overflow-hidden flex flex-col relative">
                  <div data-tauri-drag-region className="flex justify-between items-center shrink-0 px-4 py-3 border-b border-slate-100">
                    <div data-tauri-drag-region="false">
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

                    <div data-tauri-drag-region="false" className="flex items-center gap-3">
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
                            setFilterMode(next.statusMode)
                            setFieldFilter({
                              match: next.match,
                              yearOp: next.yearOp,
                              year: next.year,
                              type: next.type,
                              publications: next.publications,
                              tags: next.tags ?? [],
                              keywords: next.keywords ?? [],
                              bibType: next.bibType ?? '',
                            })
                          }}
                          yearOptions={filterYearOptions}
                          typeOptions={filterTypeOptions}
                          tagOptions={filterTagOptions}
                          keywordOptions={filterKeywordOptions}
                          bibTypeOptions={filterBibTypeOptions}
                          hideStatus={activeView === 'matrix'}
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
                        <Button
                          key="analyze"
                          type={analysisInProgress ? 'default' : 'primary'}
                          danger={analysisInProgress}
                          icon={analysisInProgress ? <StopOutlined /> : <PlayCircleOutlined />}
                          onClick={analysisInProgress ? handleStopAnalysisRequest : handleAnalysisRequest}
                          disabled={analysisInProgress ? stoppingAnalysis : selectedRowKeys.length === 0}
                        >
                          {analysisInProgress ? '终止分析' : '开始分析'}
                        </Button>
                        {activeView === 'matrix' ? (
                          <Button
                            key="delete_extracted"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={handleDeleteRequest}
                            disabled={selectedRowKeys.length === 0 || deletingExtracted}
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
                      onOpenDetail={(key) => void requestOpenDetail(key)}
                      onRefresh={handleRefresh}
                      onPageRowsChange={setCurrentPageRows}
                      onSortedDataChange={handleTableSortedDataChange}
                      activeItemKey={activeItemKey}
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

          {mode === 'workbench' ? (
            <>
              <Modal
                open={confirmModal.open}
                onCancel={closeConfirmModal}
                title={
                  confirmModal.type === 'delete'
                    ? '删除已提取数据'
                    : confirmModal.type === 'analyze'
                      ? '重新分析确认'
                      : confirmModal.type === 'mixed_analyze'
                        ? '分析确认'
                        : confirmModal.type === 'stop'
                          ? (
                            <span className="text-red-600">
                              <ExclamationCircleOutlined className="mr-2" />
                              终止分析确认
                            </span>
                          )
                          : '确认'
                }
                footer={
                  confirmModal.type === 'mixed_analyze'
                    ? [
                      <Button key="cancel" onClick={closeConfirmModal}>
                        取消
                      </Button>,
                      <Button key="reanalyze_all" onClick={handleConfirmAnalysis}>
                        分析全部
                      </Button>,
                      <Button
                        key="only_unprocessed"
                        type="primary"
                        onClick={handleConfirmMixedAnalyzeUnprocessed}
                        disabled={selectedItemStats.unprocessed <= 0}
                      >
                        仅分析未完成（{selectedItemStats.unprocessed}）
                      </Button>,
                    ]
                    : [
                      <Button key="cancel" onClick={closeConfirmModal}>
                        取消
                      </Button>,
                      <Button
                        key="ok"
                        type="primary"
                        danger={confirmModal.type === 'delete' || confirmModal.type === 'stop'}
                        loading={confirmModal.type === 'stop' ? stoppingAnalysis : undefined}
                        onClick={
                          confirmModal.type === 'delete'
                            ? handleConfirmDelete
                            : confirmModal.type === 'stop'
                              ? handleConfirmStopAnalysis
                              : handleConfirmAnalysis
                        }
                      >
                        {confirmModal.type === 'delete' ? '删除' : confirmModal.type === 'stop' ? '终止' : '确定'}
                      </Button>,
                    ]
                }
              >
                {confirmModal.type === 'delete' ? (
                  <div>将清除 {selectedItemStats.total} 条文献的分析字段（不删除标题/作者/年份等元数据），并尝试删除飞书表格中的对应条目。</div>
                ) : confirmModal.type === 'analyze' ? (
                  <div>将重新分析已完成的 {selectedItemStats.total} 条文献，是否继续？</div>
                ) : confirmModal.type === 'mixed_analyze' ? (
                  <div>
                    已选 {selectedItemStats.total} 条文献，其中已完成分析 {selectedItemStats.done} 条。
                  </div>
                ) : confirmModal.type === 'stop' ? (
                  <Alert
                    type="warning"
                    showIcon
                    message="将尝试终止当前分析任务"
                    description="终止后会取消待分析任务，并恢复文献状态，是否继续？"
                  />
                ) : null}
              </Modal>

              <LiteratureDetailDrawer
                item={activeItem}
                mode={detailMode}
                analysisFieldDefs={analysisFieldDefs}
                analysisOrder={matrixAnalysisOrder}
                onSwitchMode={setDetailMode}
                onLeaveGuardChange={(g) => setDetailLeaveGuard(() => g)}
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
            </>
          ) : null}
        </div>
      </AntApp>
    </ConfigProvider>
  )
}
