import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ConfigProvider,
  Layout,
  Button,
  App as AntApp,
  Segmented,
} from 'antd'
import {
  ExclamationCircleOutlined,
} from '@ant-design/icons'
import zhCN from 'antd/locale/zh_CN'

import type { LiteratureItem } from '../types'
import { AppSidebar } from './components/AppSidebar'
import { LiteratureTable, type LiteratureTableView } from './components/LiteratureTable'
import { TitleBar } from './components/TitleBar'
import { SettingsPage } from './components/SettingsPage'
import { SettingsSidebar } from './components/SettingsSidebar'
import { LiteratureDetailDrawer, type LiteratureDetailDrawerMode } from './components/LiteratureDetailDrawer'
import { ConfirmModal } from './components/ConfirmModal'
import { WorkbenchToolbar } from './components/WorkbenchToolbar'
import { useAppConfig } from './hooks/useAppConfig'
import { useAppTheme } from './hooks/useAppTheme'
import { useAnalysisState } from './hooks/useAnalysisState'
import { useCitationManager } from './hooks/useCitationManager'
import { useColumnConfig } from './hooks/useColumnConfig'
import { useDetailNavigation } from './hooks/useDetailNavigation'
import { useCollectionItems, useFilterOptions, useFilteredItems, useFilterState } from './hooks/useFilterState'
import { useItemUpdater } from './hooks/useItemUpdater'
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
  const [selectedRowKeysByView, setSelectedRowKeysByView] = useState<{ zotero: React.Key[]; matrix: React.Key[] }>({ zotero: [], matrix: [] })
  const [activeCollectionKey, setActiveCollectionKey] = useState<string | null>(() => readString(STORAGE_KEYS.ACTIVE_COLLECTION))
  const [activeItemKey, setActiveItemKey] = useState<string | null>(null)
  const [detailLeaveGuard, setDetailLeaveGuard] = useState<null | (() => Promise<boolean>)>(null)
  const [activeView, setActiveView] = useState(() => readString(STORAGE_KEYS.ACTIVE_VIEW) ?? 'zotero')
  const activeViewKey = activeView === 'matrix' ? 'matrix' : 'zotero'
  const selectedRowKeys = selectedRowKeysByView[activeViewKey]
  const setSelectedRowKeys = useCallback(
    (next: React.Key[]) => {
      setSelectedRowKeysByView((prev) => ({ ...prev, [activeViewKey]: next }))
    },
    [activeViewKey]
  )
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
  const { detailCitationState } = useCitationManager(library, setLibrary, {
    activeItemKey,
    currentPageRows,
    citationColumnVisible,
  })
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
  const { saveMatrixPatch } = useItemUpdater(setLibrary)

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

  const collectionItems = useCollectionItems(library, activeCollectionKey)
  const { filterYearOptions, filterTypeOptions, filterTagOptions, filterKeywordOptions, filterBibTypeOptions } = useFilterOptions(collectionItems)
  const filteredItems = useFilteredItems(collectionItems, filterMode, fieldFilter, normalizedSearchQuery)
  const { activeItem, canPrevDetail, canNextDetail, goPrevDetail, goNextDetail } = useDetailNavigation(
    library.items,
    filteredItems,
    tableSortedKeys,
    activeItemKey,
    setActiveItemKey
  )

  const handleTableSortedDataChange = useCallback((rows: LiteratureItem[]) => {
    const keys = rows
      .map((it) => it.item_key)
      .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
    setTableSortedKeys(keys)
  }, [])
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

                    <div data-tauri-drag-region="false">
                      <WorkbenchToolbar
                        selectedCount={selectedRowKeys.length}
                        activeView={activeView as LiteratureTableView}
                        normalizedSearchQuery={normalizedSearchQuery}
                        searchQuery={searchQuery}
                        setSearchQuery={setSearchQuery}
                        searchPopoverOpen={searchPopoverOpen}
                        setSearchPopoverOpen={setSearchPopoverOpen}
                        searchInputElRef={searchInputElRef}
                        activeSearchButtonStyle={activeSearchButtonStyle}
                        filterMode={filterMode}
                        setFilterMode={setFilterMode}
                        fieldFilter={fieldFilter}
                        setFieldFilter={setFieldFilter}
                        filterPopoverOpen={filterPopoverOpen}
                        setFilterPopoverOpen={setFilterPopoverOpen}
                        themePrimaryColor={themeToken.colorPrimary}
                        yearOptions={filterYearOptions}
                        typeOptions={filterTypeOptions}
                        tagOptions={filterTagOptions}
                        keywordOptions={filterKeywordOptions}
                        bibTypeOptions={filterBibTypeOptions}
                        columnsPopoverOpen={columnsPopoverOpen}
                        setColumnsPopoverOpen={setColumnsPopoverOpen}
                        metaPanel={metaColumnPanel}
                        analysisPanel={analysisColumnPanel}
                        metaFieldDefs={metaFieldDefs}
                        analysisFieldDefs={analysisFieldDefs}
                        getFieldName={getFieldName}
                        applyMetaPanelChange={applyMetaPanelChange}
                        applyAnalysisPanelChange={applyAnalysisPanelChange}
                        analysisInProgress={analysisInProgress}
                        stoppingAnalysis={stoppingAnalysis}
                        onAnalyzeRequest={handleAnalysisRequest}
                        onStopRequest={handleStopAnalysisRequest}
                        deletingExtracted={deletingExtracted}
                        onDeleteRequest={handleDeleteRequest}
                        filteredItemsCount={filteredItems.length}
                      />
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
              <ConfirmModal
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
                            <span className="inline-flex items-center gap-2">
                              <ExclamationCircleOutlined className="text-amber-600" />
                              <span className="text-slate-900">终止分析确认</span>
                            </span>
                          )
                          : '确认'
                }
                content={
                  confirmModal.type === 'delete' ? (
                    <div>将清除 {selectedItemStats.total} 条文献的分析字段（不删除标题/作者/年份等元数据），并尝试删除飞书表格中的对应条目。</div>
                  ) : confirmModal.type === 'analyze' ? (
                    <div>将重新分析已完成的 {selectedItemStats.total} 条文献，是否继续？</div>
                  ) : confirmModal.type === 'mixed_analyze' ? (
                    <div>
                      已选 {selectedItemStats.total} 条文献，其中已完成分析 {selectedItemStats.done} 条。
                    </div>
                  ) : confirmModal.type === 'stop' ? (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
                      <div className="flex items-start gap-2">
                        <ExclamationCircleOutlined className="mt-0.5 text-amber-600" />
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-amber-900">将尝试终止当前分析任务</div>
                          <div className="mt-1 text-sm leading-6 text-amber-800">
                            终止后会取消待分析任务，并恢复文献状态，是否继续？
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null
                }
                type={confirmModal.type === 'delete' || confirmModal.type === 'stop' ? 'danger' : 'primary'}
                confirmText={confirmModal.type === 'delete' ? '删除' : confirmModal.type === 'stop' ? '终止' : '确定'}
                loading={confirmModal.type === 'stop' ? stoppingAnalysis : false}
                onConfirm={
                  confirmModal.type === 'delete'
                    ? handleConfirmDelete
                    : confirmModal.type === 'stop'
                      ? handleConfirmStopAnalysis
                      : handleConfirmAnalysis
                }
                footer={
                  confirmModal.type === 'mixed_analyze' ? (
                    <>
                      <Button key="cancel" onClick={closeConfirmModal}>
                        取消
                      </Button>
                      <Button key="reanalyze_all" onClick={handleConfirmAnalysis}>
                        分析全部
                      </Button>
                      <Button
                        key="only_unprocessed"
                        type="primary"
                        onClick={handleConfirmMixedAnalyzeUnprocessed}
                        disabled={selectedItemStats.unprocessed <= 0}
                      >
                        仅分析未完成（{selectedItemStats.unprocessed}）
                      </Button>
                    </>
                  ) : undefined
                }
              />

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
                    ? saveMatrixPatch
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
