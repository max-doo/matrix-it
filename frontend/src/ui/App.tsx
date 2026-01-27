import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ConfigProvider,
  Layout,
  Button,
  message,
  App as AntApp,
  Segmented,
} from 'antd'
import zhCN from 'antd/locale/zh_CN'

import type { AnalysisReport, LiteratureItem } from '../types'
import { syncFeishu as syncFeishuRpc } from '../lib/backend'
import { AppSidebar } from './components/AppSidebar'
import { LiteratureTable, type LiteratureTableView } from './components/LiteratureTable'
import { TitleBar } from './components/TitleBar'
import { SettingsPage } from './components/SettingsPage'
import { SettingsSidebar } from './components/SettingsSidebar'
import { LiteratureDetailDrawer, type LiteratureDetailDrawerMode } from './components/LiteratureDetailDrawer'
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
import { createAnalysisResultUi } from './components/analysisResultUi'

const { Sider, Content } = Layout

type ConfirmApi = {
  confirmDelete: (opts: { total: number; onOk: () => void | Promise<void> }) => void
  confirmReanalyze: (opts: { total: number; onOk: () => void }) => void
  confirmMixedAnalyze: (opts: {
    total: number
    done: number
    unprocessed: number
    onAnalyzeAll: () => void
    onAnalyzeUnprocessed: () => void
  }) => void
  confirmStop: (opts: { onOk: () => void | Promise<void> }) => void
  showAnalysisResult: (report: AnalysisReport) => void
}

function ConfirmController({
  apiRef,
}: {
  apiRef: React.MutableRefObject<ConfirmApi | null>
}) {
  const { modal, message } = AntApp.useApp()

  useEffect(() => {
    const analysisUi = createAnalysisResultUi(modal, message)

    apiRef.current = {
      confirmDelete: ({ total, onOk }) => {
        void modal.confirm({
          title: '删除已提取数据',
          content: `将清除 ${total} 条文献的分析字段（不删除标题/作者/年份等元数据），并尝试删除飞书表格中的对应条目。`,
          okText: '删除',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: () => {
            void Promise.resolve()
              .then(() => onOk())
              .catch((e) => {
                const msg = e instanceof Error ? e.message : '删除失败'
                message.error(msg)
              })
          },
        })
      },
      confirmReanalyze: ({ total, onOk }) => {
        void modal.confirm({
          title: '重新分析确认',
          content: `将重新分析已完成的 ${total} 条文献，是否继续？`,
          okText: '确定',
          cancelText: '取消',
          onOk: () => onOk(),
        })
      },
      confirmMixedAnalyze: ({ total, done, unprocessed, onAnalyzeAll, onAnalyzeUnprocessed }) => {
        let inst: { destroy: () => void } | null = null
        inst = modal.confirm({
          title: '分析确认',
          content: `已选 ${total} 条文献，其中已完成分析 ${done} 条。`,
          okText: '分析全部',
          okType: 'default',
          cancelText: '取消',
          onOk: () => onAnalyzeAll(),
          footer: (_originNode, { OkBtn, CancelBtn }) => (
            <>
              <CancelBtn />
              <OkBtn />
              <Button
                type="primary"
                onClick={() => {
                  inst?.destroy()
                  onAnalyzeUnprocessed()
                }}
                disabled={unprocessed <= 0}
              >
                仅分析未完成（{unprocessed}）
              </Button>
            </>
          ),
        })
      },
      confirmStop: ({ onOk }) => {
        void modal.confirm({
          title: '终止分析确认',
          content: '终止后会取消待分析任务，并恢复文献状态，是否继续？',
          okText: '终止',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: async () => {
            await onOk()
          },
        })
      },
      showAnalysisResult: (report: AnalysisReport) => {
        analysisUi.showToast(report)
      },
    }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, modal])

  return null



}

/**
 * 应用主组件：负责组装工作台/设置页布局，并将筛选、主题等状态委托给独立 hooks 管理。
 */
export default function App() {
  const analysisInProgressRef = useRef(false)
  const confirmApiRef = useRef<ConfirmApi | null>(null)
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
  const [feishuSyncing, setFeishuSyncing] = useState(false)
  const [feishuSyncLastError, setFeishuSyncLastError] = useState<string | null>(null)
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
    startAnalysis: startAnalysis,
    handleConfirmDelete,
    handleConfirmStopAnalysis,
  } = useAnalysisState(
    library,
    setLibrary,
    selectedRowKeys,
    setSelectedRowKeys,
    handleRefresh,
    analysisInProgressRef,
    (report) => confirmApiRef.current?.showAnalysisResult(report)
  )
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
  const feishuPendingCount = useMemo(() => {
    if (activeView !== 'matrix') return 0
    return filteredItems.filter((it) => it.processed_status === 'done' && it.sync_status !== 'synced').length
  }, [activeView, filteredItems])
  const feishuSyncEnabled = useMemo(() => {
    if (activeView !== 'matrix') return false
    return filteredItems.some((it) => it.processed_status === 'done')
  }, [activeView, filteredItems])
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
    if (keys.length === 0) return
    void startAnalysis(keys)
  }, [library.items, selectedRowKeys, startAnalysis])

  const handleAnalysisRequest = useCallback(() => {
    if (selectedRowKeys.length === 0) return
    const selected = new Set(selectedRowKeys.map((k) => String(k)))
    const items = library.items.filter((it) => selected.has(it.item_key))
    const total = items.length
    const doneCount = items.filter((it) => it.processed_status === 'done').length

    if (doneCount > 0 && doneCount < total) {
      confirmApiRef.current?.confirmMixedAnalyze({
        total,
        done: doneCount,
        unprocessed: Math.max(0, total - doneCount),
        onAnalyzeAll: () => {
          void startAnalysis()
        },
        onAnalyzeUnprocessed: handleConfirmMixedAnalyzeUnprocessed,
      })
      return
    }

    if (doneCount > 0) {
      confirmApiRef.current?.confirmReanalyze({
        total,
        onOk: () => {
          void startAnalysis()
        },
      })
      return
    }

    void startAnalysis()
  }, [handleConfirmMixedAnalyzeUnprocessed, library.items, selectedRowKeys, startAnalysis])

  const handleDeleteRequest = useCallback(() => {
    const keys = selectedRowKeys as string[]
    if (keys.length === 0) return
    confirmApiRef.current?.confirmDelete({
      total: selectedItemStats.total,
      onOk: handleConfirmDelete,
    })
  }, [handleConfirmDelete, selectedItemStats.total, selectedRowKeys])

  const handleStopAnalysisRequest = useCallback(() => {
    confirmApiRef.current?.confirmStop({
      onOk: handleConfirmStopAnalysis,
    })
  }, [handleConfirmStopAnalysis])

  const handleSyncFeishuRequest = useCallback(async () => {
    if (activeView !== 'matrix') return
    if (feishuSyncing) return

    const selected = new Set(selectedRowKeys.map((k) => String(k)))
    const selectedItems = library.items.filter((it) => selected.has(it.item_key))
    const base = selectedItems.length > 0 ? selectedItems : filteredItems
    const keys = base
      .filter((it) => it.processed_status === 'done' && it.sync_status !== 'synced')
      .map((it) => it.item_key)

    if (keys.length === 0) {
      message.info('没有待同步条目')
      return
    }

    setFeishuSyncing(true)
    setFeishuSyncLastError(null)
    setLibrary((prev) => ({
      ...prev,
      items: prev.items.map((it) => (keys.includes(it.item_key) ? { ...it, sync_status: 'syncing' } : it)),
    }))
    try {
      const res = (await syncFeishuRpc(keys)) as unknown as Record<string, unknown>
      const err = res?.error as Record<string, unknown> | undefined
      if (err && typeof err === 'object') {
        const msg = String(err.message || err.code || '同步失败')
        setFeishuSyncLastError(msg)
        message.error(msg)
        return
      }

      const uploaded = Number(res?.uploaded ?? 0)
      const failed = Number(res?.failed ?? 0)
      if (failed > 0) {
        const msg = `同步完成：成功 ${uploaded} 条，失败 ${failed} 条`
        setFeishuSyncLastError(`失败 ${failed} 条`)
        message.warning(msg)
      } else {
        message.success(`已同步 ${uploaded} 条`)
      }
      await refreshLibrary('auto')
    } catch (e) {
      const msg = e instanceof Error ? e.message : '同步失败'
      setFeishuSyncLastError(msg)
      message.error(msg)
    } finally {
      setFeishuSyncing(false)
    }
  }, [activeView, feishuSyncing, filteredItems, library.items, refreshLibrary, selectedRowKeys])

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
        <ConfirmController apiRef={confirmApiRef} />
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
                        feishuSyncing={feishuSyncing}
                        feishuPendingCount={feishuPendingCount}
                        feishuLastError={feishuSyncLastError}
                        feishuSyncEnabled={feishuSyncEnabled}
                        onSyncRequest={handleSyncFeishuRequest}
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
