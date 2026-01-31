import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
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
import { reconcileFeishu as reconcileFeishuRpc, syncFeishu as syncFeishuRpc, resolvePdfPath, openPdfInBrowser, openPath, openExternal } from '../lib/backend'
import { AppSidebar } from './components/AppSidebar'
import { LiteratureTable, type LiteratureTableView } from './components/LiteratureTable'
import { TitleBar } from './components/TitleBar'
import { SettingsPage } from './components/SettingsPage'
import { SettingsSidebar } from './components/SettingsSidebar'
import { LiteratureDetailDrawer, type LiteratureDetailDrawerMode } from './components/LiteratureDetailDrawer'
import { WorkbenchToolbar } from './components/WorkbenchToolbar'
import { TableExportButtons } from './components/TableExportButtons'
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
import { ContextMenuProvider } from './components/GlobalContextMenu'

const { Sider, Content } = Layout

type ConfirmApi = {
  confirmDelete: (opts: { total: number; onOk: () => void | Promise<void> }) => void
  confirmReanalyze: (opts: { total: number; onOk: () => void }) => void
  confirmResyncFeishu: (opts: {
    total: number
    synced: number
    unsynced: number
    onResyncAll: () => void | Promise<void>
    onSyncUnsynced: () => void | Promise<void>
  }) => void
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
      confirmResyncFeishu: ({ total, synced, unsynced, onResyncAll, onSyncUnsynced }) => {
        let inst: { destroy: () => void } | null = null
        const onlySynced = unsynced <= 0
        inst = modal.confirm({
          title: '重新同步确认',
          content: `已选 ${total} 条文献，其中已同步 ${synced} 条、未同步 ${unsynced} 条。`,
          width: 420,
          okText: `重新同步（${total}）`,
          okType: onlySynced ? 'primary' : 'default',
          okButtonProps: { size: 'small' },
          cancelText: '取消',
          cancelButtonProps: { size: 'small' },
          onOk: () => {
            void Promise.resolve()
              .then(() => onResyncAll())
              .catch((e) => {
                const msg = e instanceof Error ? e.message : '同步失败'
                message.error(msg)
              })
          },
          footer: (_originNode, { OkBtn, CancelBtn }) => {
            if (onlySynced) {
              return (
                <div className="flex items-center justify-end gap-2 flex-nowrap max-w-full overflow-x-auto">
                  <div className="shrink-0">
                    <CancelBtn />
                  </div>
                  <div className="shrink-0">
                    <OkBtn />
                  </div>
                </div>
              )
            }
            return (
              <div className="flex items-center justify-end gap-2 flex-nowrap max-w-full overflow-x-auto">
                <div className="shrink-0">
                  <CancelBtn />
                </div>
                <div className="shrink-0">
                  <OkBtn />
                </div>
                <Button
                  type="primary"
                  size="small"
                  onClick={() => {
                    inst?.destroy()
                    void Promise.resolve()
                      .then(() => onSyncUnsynced())
                      .catch((e) => {
                        const msg = e instanceof Error ? e.message : '同步失败'
                        message.error(msg)
                      })
                  }}
                  disabled={unsynced <= 0}
                >
                  仅同步未同步（{unsynced}）
                </Button>
              </div>
            )
          },
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
  const appWindowRef = useRef<ReturnType<typeof getCurrentWindow> | null>(null)
  useEffect(() => {
    try {
      appWindowRef.current = getCurrentWindow()
    } catch {
      appWindowRef.current = null
    }
  }, [])

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
  const startupReconcileTriggeredRef = useRef(false)
  const startupReconcileTimerRef = useRef<number | null>(null)
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
    attachmentFieldDefs,
  } = useAppConfig(mode)
  const pdfOpenMode = useMemo(() => {
    const v = (rawConfig as Record<string, any> | undefined)?.ui?.pdf_open_mode
    return v === 'browser' ? 'browser' : 'local'
  }, [rawConfig])
  useZoteroWatch(zoteroStatus, refreshLibrary)
  const [currentPageRows, setCurrentPageRows] = useState<LiteratureItem[]>([])
  const [tableSortedKeys, setTableSortedKeys] = useState<string[]>([])
  const [detailMode, setDetailMode] = useState<LiteratureDetailDrawerMode>(() => (readString(STORAGE_KEYS.ACTIVE_VIEW) ?? 'zotero') === 'matrix' ? 'matrix' : 'zotero')
  const [feishuSyncing, setFeishuSyncing] = useState(false)
  const [feishuSyncLastError, setFeishuSyncLastError] = useState<string | null>(null)
  const [feishuReconciling, setFeishuReconciling] = useState(false)
  const [feishuLastReconcileAt, setFeishuLastReconcileAt] = useState<number | null>(() => {
    const raw = readString(STORAGE_KEYS.FEISHU_RECONCILE_AT)
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) ? n : null
  })
  const {
    metaColumnPanel,
    analysisColumnPanel,
    matrixAnalysisSettingsOrder,
    matrixAnalysisOrder,
    applyMetaPanelChange,
    applyAnalysisPanelChange,
    getFieldName,
    tableMetaColumns,
    tableAnalysisColumns,
    citationColumnVisible,
    defaultMetaOrder,
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

  const handleSelectCollection = useCallback((key: string | null) => {
    setActiveCollectionKey(key)
    if (key) writeString(STORAGE_KEYS.ACTIVE_COLLECTION, key)
    else deleteKey(STORAGE_KEYS.ACTIVE_COLLECTION)
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
  const matrixSearchAnalysisKeys = useMemo(() => {
    if (activeView !== 'matrix') return []
    const excluded = new Set(['key_word', 'type', 'bib_type'])
    return Object.keys(analysisFieldDefs).filter((k) => !excluded.has(k))
  }, [activeView, analysisFieldDefs])
  const filteredItems = useFilteredItems(collectionItems, filterMode, fieldFilter, normalizedSearchQuery, activeView, matrixSearchAnalysisKeys)
  const feishuPendingCount = useMemo(() => {
    if (activeView !== 'matrix') return 0
    return filteredItems.filter((it) => it.processed_status === 'done' && it.sync_status !== 'synced').length
  }, [activeView, filteredItems])
  const feishuSyncEnabled = useMemo(() => {
    if (activeView !== 'matrix') return false
    return filteredItems.some((it) => it.processed_status === 'done')
  }, [activeView, filteredItems])
  const feishuGlobalSyncEnabled = useMemo(() => {
    return library.items.some((it) => it.processed_status === 'done')
  }, [library.items])
  const feishuReconcileDue = useMemo(() => {
    if (activeView !== 'matrix') return false
    if (!feishuSyncEnabled) return false
    if (!feishuLastReconcileAt) return true
    return Date.now() - feishuLastReconcileAt > 10 * 60 * 1000
  }, [activeView, feishuLastReconcileAt, feishuSyncEnabled])
  const feishuGlobalReconcileDue = useMemo(() => {
    if (!feishuGlobalSyncEnabled) return false
    if (!feishuLastReconcileAt) return true
    return Date.now() - feishuLastReconcileAt > 10 * 60 * 1000
  }, [feishuGlobalSyncEnabled, feishuLastReconcileAt])
  const llmConfigured = useMemo(() => {
    const llm = rawConfig.llm
    if (!llm || typeof llm !== 'object') return false
    const llmObj = llm as Record<string, unknown>
    const apiKey = typeof llmObj.api_key === 'string' ? llmObj.api_key.trim() : ''
    const baseUrl = typeof llmObj.base_url === 'string' ? llmObj.base_url.trim() : ''
    const modelRaw = llmObj.model
    const model = Array.isArray(modelRaw)
      ? String(modelRaw[0] ?? '').trim()
      : typeof modelRaw === 'string'
        ? modelRaw.trim()
        : String(modelRaw ?? '').trim()
    return apiKey.length > 0 && baseUrl.length > 0 && model.length > 0
  }, [rawConfig.llm])
  const feishuApiConfigured = useMemo(() => {
    const feishu = rawConfig.feishu
    if (!feishu || typeof feishu !== 'object') return false
    const feishuObj = feishu as Record<string, unknown>
    const appId = typeof feishuObj.app_id === 'string' ? feishuObj.app_id.trim() : ''
    const appSecret = typeof feishuObj.app_secret === 'string' ? feishuObj.app_secret.trim() : ''
    const bitableUrl = typeof feishuObj.bitable_url === 'string' ? feishuObj.bitable_url.trim() : ''
    if (!appId || !appSecret) return false
    return bitableUrl.length > 0
  }, [rawConfig.feishu])
  const feishuBitableUrl = useMemo(() => {
    const feishu = rawConfig.feishu
    if (!feishu || typeof feishu !== 'object') return ''
    const feishuObj = feishu as Record<string, unknown>
    return typeof feishuObj.bitable_url === 'string' ? feishuObj.bitable_url.trim() : ''
  }, [rawConfig.feishu])
  const collectionItemKeys = useMemo(() => collectionItems.map((it) => it.item_key), [collectionItems])
  const activeCollectionName = useMemo(() => {
    if (!activeCollectionKey) return '文献'
    const findName = (nodes: typeof library.collections): string | null => {
      for (const node of nodes) {
        if (node.key === activeCollectionKey) return node.name
        if (node.children) {
          const found = findName(node.children)
          if (found) return found
        }
      }
      return null
    }
    return findName(library.collections) || '文献'
  }, [activeCollectionKey, library.collections])
  const { activeItem, canPrevDetail: canPrev, canNextDetail: canNext, goPrevDetail, goNextDetail } = useDetailNavigation(
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
    const doneBase = base.filter((it) => it.processed_status === 'done')
    const unsyncedKeys = doneBase.filter((it) => it.sync_status !== 'synced').map((it) => it.item_key)
    const syncedKeys = selectedItems.length > 0 ? doneBase.filter((it) => it.sync_status === 'synced').map((it) => it.item_key) : []
    const keys = selectedItems.length > 0 ? Array.from(new Set([...unsyncedKeys, ...syncedKeys])) : unsyncedKeys

    if (keys.length === 0) {
      message.info(selectedItems.length > 0 ? '选中的条目没有可同步内容' : '没有待同步条目')
      return
    }

    const runSync = async (nextKeys: string[], options?: { resyncSynced?: boolean; skipAttachmentUpload?: boolean }) => {
      setFeishuSyncing(true)
      setFeishuSyncLastError(null)
      setLibrary((prev) => ({
        ...prev,
        items: prev.items.map((it) => (nextKeys.includes(it.item_key) ? { ...it, sync_status: 'syncing' } : it)),
      }))
      try {
        const res = (await syncFeishuRpc(nextKeys, options)) as unknown as Record<string, unknown>
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
    }

    if (selectedItems.length > 0 && syncedKeys.length > 0) {
      confirmApiRef.current?.confirmResyncFeishu({
        total: doneBase.length,
        synced: syncedKeys.length,
        unsynced: unsyncedKeys.length,
        onResyncAll: () => runSync(keys, { resyncSynced: true, skipAttachmentUpload: true }),
        onSyncUnsynced: () => runSync(unsyncedKeys),
      })
      return
    }

    await runSync(keys)
  }, [activeView, feishuSyncing, filteredItems, library.items, refreshLibrary, selectedRowKeys])

  const handleReconcileFeishuRequest = useCallback(async () => {
    if (activeView !== 'matrix') return
    if (feishuReconciling) return
    if (!feishuSyncEnabled) return

    const selected = new Set(selectedRowKeys.map((k) => String(k)))
    const selectedItems = library.items.filter((it) => selected.has(it.item_key))
    const base = selectedItems.length > 0 ? selectedItems : filteredItems
    const keys = base.filter((it) => it.processed_status === 'done').map((it) => it.item_key)
    if (keys.length === 0) {
      message.info('没有可校验条目')
      return
    }

    setFeishuReconciling(true)
    setFeishuSyncLastError(null)
    const attemptTs = Date.now()
    setFeishuLastReconcileAt(attemptTs)
    writeString(STORAGE_KEYS.FEISHU_RECONCILE_AT, String(attemptTs))
    try {
      const res = (await reconcileFeishuRpc(keys)) as unknown as Record<string, unknown>
      const err = res?.error as Record<string, unknown> | undefined
      if (err && typeof err === 'object') {
        const msg = String(err.message || err.code || '校验失败')
        setFeishuSyncLastError(msg)
        message.error(msg)
        return
      }

      const marked = Number(res?.marked_unsynced ?? 0)
      const missing = Number(res?.missing_remote ?? 0)
      const checked = Number(res?.checked ?? 0)
      if (marked > 0) {
        message.warning(`已校验 ${checked} 条：云端缺失 ${missing} 条，已标记待同步 ${marked} 条`)
      } else {
        message.success(`已校验 ${checked} 条：同步状态正常`)
      }
      await refreshLibrary('auto')
    } catch (e) {
      const msg = e instanceof Error ? e.message : '校验失败'
      setFeishuSyncLastError(msg)
      message.error(msg)
    } finally {
      setFeishuReconciling(false)
    }
  }, [activeView, feishuReconciling, feishuSyncEnabled, filteredItems, library.items, refreshLibrary, selectedRowKeys])

  const handleAutoReconcileFeishuRequest = useCallback(async () => {
    if (feishuReconciling) return
    if (!feishuApiConfigured) return
    if (!feishuGlobalSyncEnabled) return

    const keys = library.items.filter((it) => it.processed_status === 'done').map((it) => it.item_key)
    if (keys.length === 0) return

    setFeishuReconciling(true)
    setFeishuSyncLastError(null)
    const attemptTs = Date.now()
    setFeishuLastReconcileAt(attemptTs)
    writeString(STORAGE_KEYS.FEISHU_RECONCILE_AT, String(attemptTs))
    try {
      const res = (await reconcileFeishuRpc(keys)) as unknown as Record<string, unknown>
      const err = res?.error as Record<string, unknown> | undefined
      if (err && typeof err === 'object') {
        const msg = String(err.message || err.code || '校验失败')
        setFeishuSyncLastError(msg)
        message.error(msg)
        return
      }

      const marked = Number(res?.marked_unsynced ?? 0)
      const missing = Number(res?.missing_remote ?? 0)
      const checked = Number(res?.checked ?? 0)
      if (marked > 0) {
        message.warning(`已校验 ${checked} 条：云端缺失 ${missing} 条，已标记待同步 ${marked} 条`)
      } else {
        message.success(`已校验 ${checked} 条：同步状态正常`)
      }
      await refreshLibrary('auto')
    } catch (e) {
      const msg = e instanceof Error ? e.message : '校验失败'
      setFeishuSyncLastError(msg)
      message.error(msg)
    } finally {
      setFeishuReconciling(false)
    }
  }, [feishuApiConfigured, feishuGlobalSyncEnabled, feishuReconciling, library.items, refreshLibrary])

  useEffect(() => {
    if (startupReconcileTriggeredRef.current) return
    if (mode !== 'workbench') return
    if (!feishuApiConfigured) return
    if (!feishuGlobalSyncEnabled) return
    if (feishuSyncing || feishuReconciling) return
    if (refreshingLibrary) return
    if (startupReconcileTimerRef.current) return
    startupReconcileTimerRef.current = window.setTimeout(() => {
      startupReconcileTimerRef.current = null
      startupReconcileTriggeredRef.current = true
      void handleAutoReconcileFeishuRequest()
    }, 200)
    return () => {
      if (startupReconcileTimerRef.current) {
        window.clearTimeout(startupReconcileTimerRef.current)
        startupReconcileTimerRef.current = null
      }
    }
  }, [feishuApiConfigured, feishuGlobalSyncEnabled, feishuReconciling, feishuSyncing, handleAutoReconcileFeishuRequest, mode, refreshingLibrary])

  useEffect(() => {
    if (mode !== 'workbench') return
    if (startupReconcileTriggeredRef.current) return
    if (startupReconcileTimerRef.current) return
    if (!feishuGlobalReconcileDue) return
    if (feishuSyncing || feishuReconciling) return
    if (refreshingLibrary) return
    const t = window.setTimeout(() => {
      void handleAutoReconcileFeishuRequest()
    }, 800)
    return () => window.clearTimeout(t)
  }, [feishuGlobalReconcileDue, feishuReconciling, feishuSyncing, handleAutoReconcileFeishuRequest, mode, refreshingLibrary])

  const handleReadOriginal = useCallback(
    async (itemKey: string) => {
      const item = library?.items.find((x) => x.item_key === itemKey)
      if (!item) return

      const rawPdfPath = String(item.pdf_path ?? '').trim()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const it = item as any
      const attachments = Array.isArray(it.attachments) ? it.attachments : []
      const hasPdfAttachment = rawPdfPath || attachments.length > 0

      const doi = String(it.doi ?? '')
      const url = String(it.url ?? '')
      const originalHref = url.trim() || (doi.trim() ? `https://doi.org/${doi.trim()}` : '')

      if (hasPdfAttachment) {
        try {
          const pdfPath = await resolvePdfPath(itemKey)
          if (pdfPath) {
            if (pdfOpenMode === 'browser') {
              try {
                const opened = await openPdfInBrowser(pdfPath)
                if (opened.opened) return
              } catch (e) {
                // ignore, try local
              }
              try {
                const opened = await openPath(pdfPath)
                if (opened.opened) return
              } catch (e) {
                message.error(e instanceof Error ? e.message : String(e))
                return
              }
              message.error('无法打开 PDF（系统未返回成功）。')
              return
            }

            // Local mode
            try {
              const opened = await openPath(pdfPath)
              if (opened.opened) return
            } catch (e) {
              // ignore, try browser fallback? No, existing logic is explicit.
            }
            try {
              const opened = await openPdfInBrowser(pdfPath)
              if (opened.opened) return
            } catch (e) {
              message.error(e instanceof Error ? e.message : String(e))
              return
            }
            message.error('无法打开 PDF（系统未返回成功）。')
            return
          }
          message.error('没有解析到可用的 PDF 路径。')
          return
        } catch (e) {
          message.error(e instanceof Error ? e.message : String(e))
          return
        }
      }

      if (originalHref) {
        try {
          await openExternal(originalHref)
        } catch (e) {
          message.error(e instanceof Error ? e.message : String(e))
        }
        return
      }

      message.info('没有附件或原文链接')
    },
    [library?.items, pdfOpenMode]
  )

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
        <ContextMenuProvider>
          <div className="flex h-screen w-screen overflow-hidden bg-[var(--app-bg)]">
            <TitleBar />
            <Layout className="w-full h-full bg-transparent">
              <Sider width={280} theme="light" className="border-r border-slate-200 !bg-[var(--app-bg)]">
                {mode === 'workbench' ? (
                  <AppSidebar
                    collections={library.collections}
                    items={library.items}
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
                <div
                  className="absolute top-0 left-0 right-0 h-10"
                  onMouseDown={(e) => {
                    if (e.buttons !== 1) return
                    void appWindowRef.current?.startDragging()
                  }}
                  onDoubleClick={() => {
                    void appWindowRef.current?.toggleMaximize()
                  }}
                />
                {mode === 'workbench' ? (
                  <div className="flex-1 min-h-0 bg-white rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-slate-100 overflow-hidden flex flex-col relative">
                    <div data-tauri-drag-region="false" className="flex justify-between items-center shrink-0 px-4 py-3 border-b border-slate-100">
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
                          matrixAnalysisSettingsOrder={matrixAnalysisSettingsOrder}
                          defaultMetaOrder={defaultMetaOrder}
                          getFieldName={getFieldName}
                          applyMetaPanelChange={applyMetaPanelChange}
                          applyAnalysisPanelChange={applyAnalysisPanelChange}
                          analysisInProgress={analysisInProgress}
                          stoppingAnalysis={stoppingAnalysis}
                          onAnalyzeRequest={handleAnalysisRequest}
                          onStopRequest={handleStopAnalysisRequest}
                          llmConfigured={llmConfigured}
                          deletingExtracted={deletingExtracted}
                          onDeleteRequest={handleDeleteRequest}
                          feishuSyncing={feishuSyncing}
                          feishuReconciling={feishuReconciling}
                          feishuPendingCount={feishuPendingCount}
                          feishuLastError={feishuSyncLastError}
                          feishuSyncEnabled={feishuSyncEnabled}
                          feishuReconcileDue={feishuReconcileDue}
                          feishuLastReconcileAt={feishuLastReconcileAt}
                          onSyncRequest={handleSyncFeishuRequest}
                          onReconcileRequest={handleReconcileFeishuRequest}
                          feishuApiConfigured={feishuApiConfigured}
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
                        highlightQuery={normalizedSearchQuery}
                        selectedRowKeys={selectedRowKeys}
                        onSelectedRowKeysChange={setSelectedRowKeys}
                        onOpenDetail={(key) => void requestOpenDetail(key)}
                        onRefresh={handleRefresh}
                        onItemPatch={saveMatrixPatch}
                        activeItemKey={activeItemKey}
                        onReadOriginal={handleReadOriginal}
                      />
                      {/* 导出按钮组 - 定位到分页器区域右侧 */}
                      <div className="absolute bottom-2 right-4 z-10">
                        <TableExportButtons
                          selectedKeys={selectedRowKeys.map(String)}
                          collectionKeys={collectionItemKeys}
                          collectionName={activeCollectionName}
                          feishuBitableUrl={feishuBitableUrl}
                          allItems={library?.items || []}
                        />
                      </div>
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
                    metaFieldDefs={metaFieldDefs}
                    attachmentFieldDefs={attachmentFieldDefs}
                  />
                )}
              </Content>
            </Layout>

            {mode === 'workbench' ? (
              <>
                <LiteratureDetailDrawer
                  item={activeItem}
                  mode={detailMode}
                  pdfOpenMode={pdfOpenMode}
                  analysisFieldDefs={analysisFieldDefs}
                  analysisOrder={matrixAnalysisOrder}
                  onSwitchMode={setDetailMode}
                  onLeaveGuardChange={(g) => setDetailLeaveGuard(() => g)}
                  citationState={activeItemKey ? detailCitationState : undefined}
                  onClose={() => setActiveItemKey(null)}
                  onPrev={goPrevDetail}
                  onNext={goNextDetail}
                  canPrev={canPrev}
                  canNext={canNext}
                  onSave={
                    detailMode === 'matrix'
                      ? saveMatrixPatch
                      : undefined
                  }
                  onItemPatch={saveMatrixPatch}
                />
              </>
            ) : null}
          </div>
        </ContextMenuProvider>
      </AntApp>
    </ConfigProvider >
  )
}
