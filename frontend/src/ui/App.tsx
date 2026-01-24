/**
 * 模块名称: 主应用组件
 * 功能描述: 整个 React 应用的根组件，负责布局结构（Layout）、路由/视图切换、状态管理（文献库、配置、筛选）
 *           以及核心业务逻辑的协调（如加载文献库、调用分析、同步设置、定时刷新等）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
} from '@ant-design/icons'
import { homeDir } from '@tauri-apps/api/path'
import { listen } from '@tauri-apps/api/event'
import zhCN from 'antd/locale/zh_CN'

import type { AnalysisEvent, CollectionNode, FilterMode, LiteratureItem } from '../types'
import {
  loadLibrary,
  formatCitations,
  startAnalysis as startAnalysisRpc,
  deleteExtractedData as deleteExtractedDataRpc,
  updateItem as updateItemRpc,
  readConfig,
  saveConfig,
  startZoteroWatch,
  stopZoteroWatch,
} from '../lib/backend'
import { AppSidebar, ZoteroStatusFooter } from './components/AppSidebar'
import { LiteratureTable, type LiteratureTableColumnOption, type LiteratureTableView } from './components/LiteratureTable'
import { TitleBar } from './components/TitleBar'
import { SettingsPage, type SettingsScrollApi, type SettingsSectionKey } from './components/SettingsPage'
import { ColumnSettingsPopover } from './components/ColumnSettingsPopover'
import { LiteratureFilterPopover } from './components/LiteratureFilterPopover'
import { LiteratureDetailDrawer, type LiteratureDetailDrawerMode } from './components/LiteratureDetailDrawer'

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

type LibraryState = {
  collections: CollectionNode[]
  items: LiteratureItem[]
}

type AnalysisFieldRow = {
  key: string
  description?: string
  type?: string
  rule?: string
  name?: string
}

export default function App() {
  /**
   * 工具函数：从 CSS 变量读取当前主题配置
   * 用于确保 Ant Design 组件的主题与全局 CSS 变量保持同步（特别是颜色和圆角）。
   */
  const readThemeToken = () => {
    try {
      const styles = getComputedStyle(document.documentElement)
      const primary = styles.getPropertyValue('--primary-color').trim() || '#0abab5'
      const text = styles.getPropertyValue('--text-color').trim() || '#0f172a'
      const textSecondary = styles.getPropertyValue('--text-secondary-color').trim() || '#475569'
      const appBg = styles.getPropertyValue('--app-bg').trim() || '#f5f7fa'
      const secondaryBg = styles.getPropertyValue('--secondary-bg').trim() || '#f1f5f9'
      const fontSizeStr = styles.getPropertyValue('--font-size-base').trim()
      const radiusStr = styles.getPropertyValue('--radius-base').trim()
      const fontSize = Number.parseInt(fontSizeStr.replace('px', ''), 10)
      const borderRadius = Number.parseInt(radiusStr.replace('px', ''), 10)

      return {
        colorPrimary: primary,
        colorText: text,
        colorTextSecondary: textSecondary,
        bodyBg: appBg,
        siderBg: appBg,
        segmentedTrackBg: secondaryBg,
        fontSize: Number.isFinite(fontSize) ? fontSize : 14,
        borderRadius: Number.isFinite(borderRadius) ? borderRadius : 8,
      }
    } catch {
      return {
        colorPrimary: '#0abab5',
        colorText: '#0f172a',
        colorTextSecondary: '#475569',
        bodyBg: '#f5f7fa',
        siderBg: '#f5f7fa',
        segmentedTrackBg: '#f1f5f9',
        fontSize: 14,
        borderRadius: 8,
      }
    }
  }

  // --- 状态定义：文献库与核心数据 ---
  /**
   * 当前加载的文献库数据（包含所有集合与文献条目）
   * 初始化时尝试从 LocalStorage 缓存恢复，随后会自动触发 refreshLibrary 更新。
   */
  const [library, setLibrary] = useState<LibraryState>(() => {
    const cached = readLibraryCache()
    return cached ? { collections: cached.collections, items: cached.items } : { collections: [], items: [] }
  })
  // --- 状态定义：UI 交互与筛选 ---
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([])
  const [activeCollectionKey, setActiveCollectionKey] = useState<string | null>(() => readString(ACTIVE_COLLECTION_KEY))
  const [activeItemKey, setActiveItemKey] = useState<string | null>(null)
  const [filterMode, setFilterMode] = useState<FilterMode>('all')
  const zoteroFilterModeRef = useRef<FilterMode>('all')
  const [filterPopoverOpen, setFilterPopoverOpen] = useState(false)
  const [fieldFilterMatch, setFieldFilterMatch] = useState<'all' | 'any'>('all')
  const [fieldFilterYearOp, setFieldFilterYearOp] = useState<'eq' | 'gt' | 'lt'>('eq')
  const [fieldFilterYear, setFieldFilterYear] = useState('')
  const [fieldFilterType, setFieldFilterType] = useState('')
  const [fieldFilterPublications, setFieldFilterPublications] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchPopoverOpen, setSearchPopoverOpen] = useState(false)
  const [columnsPopoverOpen, setColumnsPopoverOpen] = useState(false)
  const searchInputElRef = useRef<HTMLInputElement | null>(null)
  const [activeView, setActiveView] = useState(() => readString(ACTIVE_VIEW_KEY) ?? 'zotero')
  const [mode, setMode] = useState<'workbench' | 'settings'>('workbench')
  const [settingsSection, setSettingsSection] = useState<SettingsSectionKey>('zotero')
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [settingsSaving, setSettingsSaving] = useState(false)
  const [deletingExtracted, setDeletingExtracted] = useState(false)
  const [rawConfig, setRawConfig] = useState<Record<string, unknown>>({})
  const [rawFields, setRawFields] = useState<Record<string, unknown>>({})
  const [configForm] = Form.useForm()
  const [fieldsForm] = Form.useForm()
  const settingsScrollApiRef = useRef<SettingsScrollApi | null>(null)
  const settingsHydratingRef = useRef(false)
  const autoSaveTimerRef = useRef<number | null>(null)
  const [zoteroStatus, setZoteroStatus] = useState<{ path: string; connected: boolean }>({ path: '未配置', connected: false })
  const [themeToken, setThemeToken] = useState<{
    colorPrimary: string
    colorText: string
    colorTextSecondary: string
    bodyBg: string
    siderBg: string
    segmentedTrackBg: string
    fontSize: number
    borderRadius: number
  }>(readThemeToken)

  const [refreshingLibrary, setRefreshingLibrary] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(() => readLibraryCache()?.savedAt ?? null)
  const [currentPageRows, setCurrentPageRows] = useState<LiteratureItem[]>([])
  const [detailCitationState, setDetailCitationState] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null })
  const [detailMode, setDetailMode] = useState<LiteratureDetailDrawerMode>(() => (readString(ACTIVE_VIEW_KEY) ?? 'zotero') === 'matrix' ? 'matrix' : 'zotero')

  const citationCacheRef = useRef<Map<string, { dateModified: unknown; text: string }>>(new Map())
  const citationsInFlightRef = useRef<Set<string>>(new Set())
  const [citationsTick, setCitationsTick] = useState(0)

  // --- Memo：配置解析 ---
  /**
   * 当前生效的字段定义
   * 优先使用后端返回的配置（rawConfig），兜底使用本地解析的配置（rawFields）。
   */
  const fieldsDef = useMemo(() => {
    const fromCfg = rawConfig.fields
    if (fromCfg && typeof fromCfg === 'object') return fromCfg as Record<string, unknown>
    return rawFields
  }, [rawConfig.fields, rawFields])

  const metaFieldDefs = useMemo(
    () => ((fieldsDef.meta_fields as Record<string, unknown>) ?? {}) as Record<string, unknown>,
    [fieldsDef.meta_fields]
  )

  const analysisFieldDefs = useMemo(
    () => ((fieldsDef.analysis_fields as Record<string, unknown>) ?? {}) as Record<string, unknown>,
    [fieldsDef.analysis_fields]
  )

  /**
   * UI 列显示配置
   * 从全局配置中提取表格列的显示/隐藏/排序设置。
   */
  const uiTableColumns = useMemo(() => {
    const ui = rawConfig.ui
    if (ui && typeof ui === 'object' && (ui as Record<string, unknown>).table_columns) {
      return (ui as Record<string, unknown>).table_columns as Record<string, unknown>
    }
    return {}
  }, [rawConfig.ui])

  const getFieldName = useCallback((defs: Record<string, unknown>, key: string) => {
    const def = (defs[key] ?? {}) as Record<string, unknown>
    const name = typeof def.name === 'string' ? def.name.trim() : ''
    return name.length > 0 ? name : key
  }, [])

  /**
   * 核心操作：保存列配置
   *将当前的列显示状态（metaVisible / analysisVisible）持久化到后端配置中。
   */
  const saveTableColumnsUi = useCallback(
    async (next: { metaVisible?: string[]; analysisVisible?: string[] }) => {
      const ui = ((rawConfig.ui as Record<string, unknown>) ?? {}) as Record<string, unknown>
      const tableColumns = ((ui.table_columns as Record<string, unknown>) ?? {}) as Record<string, unknown>
      const zoteroUi = ((tableColumns.zotero as Record<string, unknown>) ?? {}) as Record<string, unknown>
      const matrixUi = ((tableColumns.matrix as Record<string, unknown>) ?? {}) as Record<string, unknown>

      const nextZotero =
        next.metaVisible && activeView === 'zotero'
          ? {
            ...zoteroUi,
            meta: { visible: next.metaVisible },
          }
          : zoteroUi

      const nextMatrix = {
        ...matrixUi,
        ...(next.metaVisible && activeView === 'matrix'
          ? {
            meta: { visible: next.metaVisible },
          }
          : {}),
        ...(next.analysisVisible
          ? {
            analysis: { visible: next.analysisVisible },
          }
          : {}),
      }

      const nextConfig: Record<string, unknown> = {
        ...rawConfig,
        ui: {
          ...ui,
          table_columns: {
            ...tableColumns,
            zotero: nextZotero,
            matrix: nextMatrix,
          },
        },
      }

      const res = await saveConfig(nextConfig)
      if (!res.saved) {
        message.error('保存失败：请检查运行环境与文件权限')
        return
      }
      setRawConfig(nextConfig)
    },
    [activeView, rawConfig]
  )

  const readVisibleKeys = useCallback(
    (uiObj: Record<string, unknown>, allKeys: string[], defaultVisible: string[], requireTitle: boolean) => {
      const normalizedDefault = requireTitle
        ? ['title', ...defaultVisible.filter((k) => allKeys.includes(k) && k !== 'title')]
        : defaultVisible.filter((k) => allKeys.includes(k))

      const visibleRaw = uiObj.visible
      if (Array.isArray(visibleRaw)) {
        const v = (visibleRaw as unknown[])
          .map((x) => (typeof x === 'string' ? x : ''))
          .map((s) => s.trim())
          .filter((k) => k && allKeys.includes(k))
        const uniq: string[] = []
        for (const k of v) if (!uniq.includes(k)) uniq.push(k)
        if (requireTitle && !uniq.includes('title')) uniq.unshift('title')
        return uniq
      }

      const orderRaw = uiObj.order
      const hiddenRaw = uiObj.hidden
      const order = Array.isArray(orderRaw) ? (orderRaw as string[]).filter((k) => allKeys.includes(k)) : allKeys
      const hidden = new Set(Array.isArray(hiddenRaw) ? (hiddenRaw as string[]).filter((k) => allKeys.includes(k)) : [])
      hidden.delete('title')
      const mergedOrder = [...order, ...allKeys.filter((k) => !order.includes(k))]
      const fromLegacy = requireTitle
        ? ['title', ...mergedOrder.filter((k) => k !== 'title' && !hidden.has(k))]
        : mergedOrder.filter((k) => !hidden.has(k))
      if (fromLegacy.length > 0) return fromLegacy

      return normalizedDefault
    },
    []
  )

  const matrixAnalysisOrder = useMemo(() => {
    const allKeys = Object.keys(analysisFieldDefs)
    const matrixUi = (uiTableColumns.matrix as Record<string, unknown>) ?? {}
    const analysisUi = (matrixUi.analysis as Record<string, unknown>) ?? {}
    const visible = readVisibleKeys(analysisUi, allKeys, allKeys, false)
    const orderRaw = analysisUi.order
    const order = Array.isArray(orderRaw)
      ? (orderRaw as unknown[])
        .map((x) => String(x || '').trim())
        .filter((k) => k.length > 0 && allKeys.includes(k))
      : allKeys
    const orderedAll = [...order, ...allKeys.filter((k) => !order.includes(k))]
    const rest = orderedAll.filter((k) => !visible.includes(k))
    return [...visible, ...rest]
  }, [analysisFieldDefs, readVisibleKeys, uiTableColumns.matrix])

  const metaColumnPanel = useMemo(() => {
    const primaryKeys = ['title', 'author', 'year', 'type', 'publications']
    const allKeys = primaryKeys.filter((k) => k in metaFieldDefs)
    const viewUi = (uiTableColumns as Record<string, unknown>)[activeView] as Record<string, unknown> | undefined
    const metaUi = (viewUi?.meta as Record<string, unknown>) ?? {}
    const visible = allKeys
    const hidden = new Set(allKeys.filter((k) => k !== 'title' && !visible.includes(k)))
    const ordered = visible.filter((k) => k !== 'title')
    const mergedOrder = [...ordered, ...allKeys.filter((k) => k !== 'title' && !ordered.includes(k))]
    return { keys: mergedOrder, hidden, allKeys }
  }, [activeView, metaFieldDefs, readVisibleKeys, uiTableColumns])

  const analysisColumnPanel = useMemo(() => {
    if (activeView !== 'matrix') return { keys: [] as string[], hidden: new Set<string>(), allKeys: [] as string[] }
    const allKeys = Object.keys(analysisFieldDefs)
    const viewUi = (uiTableColumns as Record<string, unknown>)[activeView] as Record<string, unknown> | undefined
    const analysisUi = (viewUi?.analysis as Record<string, unknown>) ?? {}
    const visible = readVisibleKeys(analysisUi, allKeys, allKeys, false)
    const hidden = new Set(allKeys.filter((k) => !visible.includes(k)))
    const mergedOrder = [...visible, ...allKeys.filter((k) => !visible.includes(k))]
    return { keys: mergedOrder, hidden, allKeys }
  }, [activeView, analysisFieldDefs, readVisibleKeys, uiTableColumns])

  const applyMetaPanelChange = useCallback(
    async (nextKeys: string[], nextHidden: Set<string>) => {
      const allKeys = metaColumnPanel.allKeys
      const visible = ['title', ...nextKeys.filter((k) => allKeys.includes(k) && k !== 'title' && !nextHidden.has(k))]
      await saveTableColumnsUi({ metaVisible: visible })
    },
    [metaColumnPanel.allKeys, saveTableColumnsUi]
  )

  const applyAnalysisPanelChange = useCallback(
    async (nextKeys: string[], nextHidden: Set<string>) => {
      const allKeys = analysisColumnPanel.allKeys
      const visible = nextKeys.filter((k) => allKeys.includes(k) && !nextHidden.has(k))
      await saveTableColumnsUi({ analysisVisible: visible })
    },
    [analysisColumnPanel.allKeys, saveTableColumnsUi]
  )

  const tableMetaColumns = useMemo<LiteratureTableColumnOption[]>(() => {
    const primaryKeys = ['title', 'author', 'year', 'type', 'publications']
    const allKeys = primaryKeys.filter((k) => k in metaFieldDefs)
    const viewUi = (uiTableColumns as Record<string, unknown>)[activeView] as Record<string, unknown> | undefined
    const metaUi = (viewUi?.meta as Record<string, unknown>) ?? {}
    const visible = allKeys
    return visible
      .map((key) => {
        const def = ((metaFieldDefs as Record<string, unknown>)[key] ?? {}) as Record<string, unknown>
        const label = typeof def.name === 'string' && def.name.trim().length > 0 ? def.name.trim() : key
        return { key, label }
      })
  }, [activeView, metaFieldDefs, readVisibleKeys, uiTableColumns])

  const tableAnalysisColumns = useMemo<LiteratureTableColumnOption[]>(() => {
    if (activeView !== 'matrix') return []
    const allKeys = Object.keys(analysisFieldDefs)
    const viewUi = (uiTableColumns as Record<string, unknown>)[activeView] as Record<string, unknown> | undefined
    const analysisUi = (viewUi?.analysis as Record<string, unknown>) ?? {}
    const visible = readVisibleKeys(analysisUi, allKeys, allKeys, false)
    return visible
      .map((key) => {
        const def = ((analysisFieldDefs as Record<string, unknown>)[key] ?? {}) as Record<string, unknown>
        const label = typeof def.name === 'string' && def.name.trim().length > 0 ? def.name.trim() : key
        return { key, label }
      })
  }, [activeView, analysisFieldDefs, readVisibleKeys, uiTableColumns])

  const citationColumnVisible = useMemo(() => tableMetaColumns.some((c) => c.key === 'citation'), [tableMetaColumns])

  // --- 核心操作：数据刷新 ---
  /**
   * 刷新文献库数据
   * 调用后端 loadLibrary 接口，更新本地 state，并写入 LocalStorage 缓存。
   */
  const refreshLibrary = useCallback(
    async (trigger: 'auto' | 'manual') => {
      const msgKey = 'matrixit.library.refresh'
      setRefreshingLibrary(true)
      setRefreshError(null)
      if (trigger === 'manual') message.destroy(msgKey)
      try {
        const next = await loadLibrary()
        setLibrary(next)
        writeLibraryCache({ savedAt: Date.now(), collections: next.collections, items: next.items })
        setLastRefreshAt(Date.now())
        const keys = collectCollectionKeys(next.collections)
        setActiveCollectionKey((prev) => (prev && keys.has(prev) ? prev : null))
        if (trigger === 'manual') message.success({ content: '数据已更新' })
      } catch (e) {
        const msg = e instanceof Error ? e.message : '更新失败'
        setRefreshError(msg)
        if (trigger === 'manual') message.error({ content: msg })
        else message.error(msg)
      } finally {
        setRefreshingLibrary(false)
      }
    },
    []
  )

  const handleRefresh = useCallback(() => {
    refreshLibrary('manual')
  }, [refreshLibrary])

  const applyCitationsToLibrary = useCallback((citations: Record<string, string>) => {
    const entries = Object.entries(citations).filter(([, v]) => typeof v === 'string' && v.trim().length > 0)
    if (entries.length === 0) return
    setLibrary((prev) => {
      const byKey = new Map(entries)
      return {
        ...prev,
        items: prev.items.map((it) => {
          const next = byKey.get(it.item_key)
          if (!next) return it
          return { ...(it as Record<string, unknown>), citation: next } as unknown as LiteratureItem
        }),
      }
    })
  }, [])

  const ensureCitations = useCallback(
    async (itemKeys: string[]) => {
      const uniq = Array.from(new Set(itemKeys.map((k) => String(k || '').trim()).filter(Boolean)))
      if (uniq.length === 0) return false

      const byKey = new Map(library.items.map((it) => [it.item_key, it]))
      const toFetch: string[] = []
      for (const k of uniq) {
        if (citationsInFlightRef.current.has(k)) continue
        const it = byKey.get(k)
        const dm = (it as unknown as Record<string, unknown> | undefined)?.date_modified
        const existingText = (it as unknown as Record<string, unknown> | undefined)?.citation
        if (typeof existingText === 'string' && existingText.trim().length > 0) {
          citationCacheRef.current.set(k, { dateModified: dm, text: existingText })
          continue
        }
        const cached = citationCacheRef.current.get(k)
        if (cached && cached.text && cached.dateModified === dm) continue
        toFetch.push(k)
      }

      if (toFetch.length === 0) return true
      for (const k of toFetch) citationsInFlightRef.current.add(k)
      setCitationsTick((x) => x + 1)
      try {
        for (let i = 0; i < toFetch.length; i += 40) {
          const batch = toFetch.slice(i, i + 40)
          const res = await formatCitations(batch)
          const citations = res?.citations ?? {}
          for (const [k, text] of Object.entries(citations)) {
            const it = byKey.get(k)
            const dm = (it as unknown as Record<string, unknown> | undefined)?.date_modified
            if (typeof text === 'string' && text.trim().length > 0) citationCacheRef.current.set(k, { dateModified: dm, text })
          }
          applyCitationsToLibrary(citations)
        }
        return true
      } catch (e) {
        const msg = e instanceof Error ? e.message : '引用生成失败'
        setRefreshError(msg)
        message.error(msg)
        return false
      } finally {
        for (const k of toFetch) citationsInFlightRef.current.delete(k)
        setCitationsTick((x) => x + 1)
      }
    },
    [applyCitationsToLibrary, formatCitations, library.items]
  )

  const handleSelectCollection = useCallback((key: string) => {
    setActiveCollectionKey(key)
    writeString(ACTIVE_COLLECTION_KEY, key)
  }, [])

  // --- Effect：状态持久化与初始化 ---

  // 监听 Active View 变化并持久化
  useEffect(() => {
    writeString(ACTIVE_VIEW_KEY, activeView)
  }, [activeView])

  const lastDetailItemKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!activeItemKey) {
      lastDetailItemKeyRef.current = null
      return
    }
    if (lastDetailItemKeyRef.current === activeItemKey) return
    lastDetailItemKeyRef.current = activeItemKey
    setDetailMode(activeView === 'matrix' ? 'matrix' : 'zotero')
  }, [activeItemKey, activeView])

  useEffect(() => {
    if (!activeCollectionKey) deleteKey(ACTIVE_COLLECTION_KEY)
  }, [activeCollectionKey])

  useEffect(() => {
    const cached = readLibraryCache()
    if (cached) setLastRefreshAt(cached.savedAt)
    refreshLibrary('auto')
  }, [refreshLibrary])

  useEffect(() => {
    // 主题 token 依赖 DOM/CSS 变量：在首次渲染后读取一次，避免 SSR/非浏览器环境报错
    setThemeToken(readThemeToken())
  }, [])

  const guessDefaultZoteroDir = useCallback(async () => {
    try {
      const hd = await homeDir()
      const base = String(hd ?? '').replace(/[\\/]+$/, '')
      if (!base) return ''
      return `${base}\\Zotero`
    } catch {
      return ''
    }
  }, [])

  useEffect(() => {
    readConfig()
      .then((cfg) => {
        setRawConfig(cfg)
        const fds = (cfg.fields as Record<string, unknown>) ?? {}
        setRawFields(fds)
        const zoteroCfg = (cfg.zotero as Record<string, unknown>) ?? {}
        const zoteroDataDir = typeof zoteroCfg.data_dir === 'string' ? zoteroCfg.data_dir : ''
        setZoteroStatus({ path: zoteroDataDir || '未配置', connected: !!zoteroDataDir })
      })
      .catch(() => {
        return
      })
  }, [])

  const zoteroWatchTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!isTauriRuntime()) return
    if (!zoteroStatus.connected) {
      void stopZoteroWatch().catch(() => null)
      return
    }

    const dataDir = zoteroStatus.path
    let unlisten: (() => void) | null = null

    startZoteroWatch(dataDir).catch((e) => {
      const msg = e instanceof Error ? e.message : 'Zotero 监听启动失败'
      setRefreshError(msg)
    })

    listen('matrixit://zotero-changed', () => {
      if (zoteroWatchTimerRef.current) window.clearTimeout(zoteroWatchTimerRef.current)
      zoteroWatchTimerRef.current = window.setTimeout(() => {
        zoteroWatchTimerRef.current = null
        void refreshLibrary('auto')
      }, 800)
    })
      .then((fn) => {
        unlisten = fn
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : 'Zotero 监听订阅失败'
        setRefreshError(msg)
      })

    return () => {
      if (unlisten) unlisten()
      if (zoteroWatchTimerRef.current) window.clearTimeout(zoteroWatchTimerRef.current)
      zoteroWatchTimerRef.current = null
      void stopZoteroWatch().catch(() => null)
    }
  }, [refreshLibrary, zoteroStatus.connected, zoteroStatus.path])

  // --- 设置页逻辑 ---

  /**
   * 加载设置页数据
   * 读取后端配置，并回填到 Ant Design Form 表单中。
   */
  const loadSettings = useCallback(async () => {
    setSettingsLoading(true)
    try {
      const cfg = await readConfig()
      const fds = (cfg.fields as Record<string, unknown>) ?? {}
      setRawConfig(cfg)
      setRawFields(fds)
      settingsHydratingRef.current = true
      const zoteroCfg = (cfg.zotero as Record<string, unknown>) ?? {}
      const zoteroDataDir = typeof zoteroCfg.data_dir === 'string' ? zoteroCfg.data_dir : ''
      const defaultZoteroDir = zoteroDataDir || (await guessDefaultZoteroDir())
      configForm.setFieldsValue({
        ...cfg,
        zotero: { ...zoteroCfg, data_dir: defaultZoteroDir },
      })
      setZoteroStatus({ path: defaultZoteroDir || '未配置', connected: !!defaultZoteroDir })
      const analysisFields = (fds.analysis_fields as Record<string, unknown>) ?? {}
      const ui = (cfg.ui as Record<string, unknown>) ?? {}
      const tableColumns = (ui.table_columns as Record<string, unknown>) ?? {}
      const matrixUi = (tableColumns.matrix as Record<string, unknown>) ?? {}
      const analysisUi = (matrixUi.analysis as Record<string, unknown>) ?? {}
      const orderRaw = analysisUi.order

      const byKey = new Map<string, AnalysisFieldRow>(
        Object.entries(analysisFields)
          .map(([k, v]) => {
            const obj = (v ?? {}) as Record<string, unknown>
            const row: AnalysisFieldRow = {
              key: k,
              description: typeof obj.description === 'string' ? obj.description : '',
              type: typeof obj.type === 'string' ? obj.type : 'string',
              rule: typeof obj.rule === 'string' ? obj.rule : '',
              name:
                typeof obj.name === 'string'
                  ? obj.name
                  : typeof obj.feishu_field === 'string'
                    ? obj.feishu_field
                    : '',
            }
            return [k, row] as const
          })
          .filter(([k]) => k.trim().length > 0)
      )

      const keys = Array.isArray(orderRaw)
        ? [...(orderRaw as string[]).filter((k) => byKey.has(k)), ...Array.from(byKey.keys()).filter((k) => !(orderRaw as string[]).includes(k))]
        : Array.from(byKey.keys())

      const rows: AnalysisFieldRow[] = keys.map((k) => byKey.get(k) as AnalysisFieldRow).filter((r) => r && r.key.trim().length > 0)
      fieldsForm.setFieldsValue({ analysis_fields: rows })
    } catch (e) {
      const msg = e instanceof Error ? e.message : '加载设置失败'
      message.error(msg)
    } finally {
      settingsHydratingRef.current = false
      setSettingsLoading(false)
    }
  }, [configForm, fieldsForm, guessDefaultZoteroDir])

  useEffect(() => {
    if (mode === 'settings') {
      loadSettings()
    }
  }, [loadSettings, mode])

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

  const normalizedSearchQuery = useMemo(() => {
    return searchQuery.trim().toLowerCase().replace(/\s+/g, ' ')
  }, [searchQuery])

  const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
    const raw = hex.trim().replace('#', '')
    const normalized = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw
    if (normalized.length !== 6) return null
    const n = Number.parseInt(normalized, 16)
    if (!Number.isFinite(n)) return null
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
  }

  const activeSearchButtonStyle = useMemo(() => {
    if (!normalizedSearchQuery) return undefined
    const rgb = hexToRgb(themeToken.colorPrimary)
    if (!rgb) return { backgroundColor: '#f0fdfa', borderColor: '#99f6e4', color: themeToken.colorPrimary } satisfies React.CSSProperties
    return {
      backgroundColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.12)`,
      borderColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.35)`,
      color: themeToken.colorPrimary,
    } satisfies React.CSSProperties
  }, [normalizedSearchQuery, themeToken.colorPrimary])

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

  /**
   * 核心计算：文献列表筛选
   * 综合应用以下过滤条件：
   * 1. 当前选中的集合（activeCollectionKey）
   * 2. 处理状态（statusMode：未处理/已处理/全部）
   * 3. 搜索关键词（searchQuery：模糊匹配标题/作者）
   * 4. 字段高级筛选（年份、类型、出版物）
   */
  // 根据集合与状态筛选条目：
  // - 集合命中规则：集合 key 命中或 pathKeyChain 包含（选中父集合会包含其子集合条目）
  const filteredItems = useMemo(() => {
    const byStatus =
      filterMode === 'all'
        ? collectionItems
        : filterMode === 'unprocessed'
          ? collectionItems.filter((it) => it.processed_status !== 'done')
          : collectionItems.filter((it) => it.processed_status === 'done')

    const q = normalizedSearchQuery
    const normalizeText = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

    const byFieldFilter =
      activeView === 'matrix'
        ? byStatus
        : (() => {
          const predicates: Array<(it: LiteratureItem) => boolean> = []

          const yearRaw = fieldFilterYear.trim()
          if (yearRaw) {
            const targetYear = Number.parseInt(yearRaw, 10)
            if (Number.isFinite(targetYear)) {
              predicates.push((it) => {
                const raw = String((it as unknown as Record<string, unknown>).year ?? '')
                const y = Number.parseInt(raw.replace(/[^\d]/g, ''), 10)
                if (!Number.isFinite(y)) return false
                if (fieldFilterYearOp === 'gt') return y > targetYear
                if (fieldFilterYearOp === 'lt') return y < targetYear
                return y === targetYear
              })
            }
          }

          const typeRaw = fieldFilterType.trim()
          if (typeRaw) {
            const target = normalizeText(typeRaw)
            predicates.push((it) => {
              const v = ((it as unknown as Record<string, unknown>).type ?? it.bib_type ?? '') as unknown
              return normalizeText(v) === target
            })
          }

          const pubRaw = fieldFilterPublications.trim()
          if (pubRaw) {
            const target = normalizeText(pubRaw)
            predicates.push((it) => {
              const v = ((it as unknown as Record<string, unknown>).publications ?? '') as unknown
              return normalizeText(v).includes(target)
            })
          }

          if (predicates.length === 0) return byStatus
          const matchAll = fieldFilterMatch === 'all'
          return byStatus.filter((it) => (matchAll ? predicates.every((p) => p(it)) : predicates.some((p) => p(it))))
        })()

    if (!q) return byFieldFilter

    return byFieldFilter.filter((it) => {
      const title = normalizeText(it.title)
      const author = normalizeText(it.author)
      return title.includes(q) || author.includes(q)
    })
  }, [
    activeView,
    collectionItems,
    fieldFilterMatch,
    fieldFilterPublications,
    fieldFilterType,
    fieldFilterYear,
    fieldFilterYearOp,
    filterMode,
    normalizedSearchQuery,
  ])

  const activeItem = useMemo(
    () => (activeItemKey ? library.items.find((it) => it.item_key === activeItemKey) ?? null : null),
    [activeItemKey, library.items]
  )

  const activeItemIndex = useMemo(() => {
    if (!activeItemKey) return -1
    return filteredItems.findIndex((it) => it.item_key === activeItemKey)
  }, [activeItemKey, filteredItems])

  const canPrevDetail = activeItemIndex > 0
  const canNextDetail = activeItemIndex >= 0 && activeItemIndex < filteredItems.length - 1

  const goPrevDetail = useCallback(() => {
    if (!canPrevDetail) return
    const prevKey = filteredItems[activeItemIndex - 1]?.item_key
    if (prevKey) setActiveItemKey(prevKey)
  }, [activeItemIndex, canPrevDetail, filteredItems])

  const goNextDetail = useCallback(() => {
    if (!canNextDetail) return
    const nextKey = filteredItems[activeItemIndex + 1]?.item_key
    if (nextKey) setActiveItemKey(nextKey)
  }, [activeItemIndex, canNextDetail, filteredItems])

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

  /**
   * 核心操作：启动分析
   * 1. 将选中的文献标记为 processing 状态
   * 2. 调用后端 RPC startAnalysis
   * 3. 监听后端通过 Channel 返回的 AnalysisEvent 事件流，实时更新 UI 状态
   */
  const startAnalysis = async () => {
    const keys = selectedRowKeys as string[]
    if (keys.length === 0) return

    const msgKey = 'analysis'
    setLibrary((prev) => ({
      ...prev,
      items: prev.items.map((it) =>
        keys.includes(it.item_key) ? { ...it, processed_status: 'processing', processed_error: undefined } : it
      ),
    }))
    message.loading({ content: '正在分析…', key: msgKey, duration: 0 })

    // 通过事件流驱动 UI 状态：目前仅消费 Started/Finished/Failed，Progress/AllDone 未用于 UI（后续可扩展进度条/队列完成提示）
    const onEvent = (evt: AnalysisEvent) => {
      if (evt.event === 'Started') {
        const k = evt.data.item_key
        setLibrary((prev) => ({
          ...prev,
          items: prev.items.map((it) => (it.item_key === k ? { ...it, processed_status: 'processing' } : it))
        }))
      }
      if (evt.event === 'Finished') {
        const k = evt.data.item_key
        setLibrary((prev) => ({
          ...prev,
          items: prev.items.map((it) => (it.item_key === k ? { ...it, processed_status: 'done', sync_status: 'unsynced' } : it))
        }))
      }
      if (evt.event === 'Failed') {
        const k = evt.data.item_key
        setLibrary((prev) => ({
          ...prev,
          items: prev.items.map((it) =>
            it.item_key === k ? { ...it, processed_status: 'failed', processed_error: evt.data.error } : it
          )
        }))
        message.error(`分析失败(${k}): ${evt.data.error}`)
      }
      if (evt.event === 'AllDone') {
        refreshLibrary('auto')
        message.success({ content: '分析完成', key: msgKey })
      }
    }

    try {
      await startAnalysisRpc(keys, onEvent)
    } catch (e) {
      const msg = e instanceof Error ? e.message : '启动分析失败'
      setLibrary((prev) => ({
        ...prev,
        items: prev.items.map((it) =>
          keys.includes(it.item_key) ? { ...it, processed_status: 'failed', processed_error: msg } : it
        ),
      }))
      message.error({ content: msg, key: msgKey })
    }
  }

  /**
   * 核心操作：删除已提取数据
   * 清除选中条目的分析结果字段，并同步删除飞书上的对应记录。
   */
  const deleteExtractedData = async () => {
    const keys = selectedRowKeys as string[]
    if (keys.length === 0 || deletingExtracted) return

    Modal.confirm({
      title: '删除已提取数据',
      content: `将清除 ${keys.length} 条文献的分析字段（不删除标题/作者/年份等元数据），并尝试删除飞书表格中的对应条目。`,
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        setDeletingExtracted(true)
        try {
          const res = (await deleteExtractedDataRpc(keys)) as {
            cleared?: number
            missing?: number
            analysis_fields?: number
            feishu?: { deleted?: number; skipped?: number; failed?: number }
          }
          const cleared = Number(res?.cleared ?? 0)
          const missing = Number(res?.missing ?? 0)
          const feishuDeleted = Number(res?.feishu?.deleted ?? 0)
          const feishuFailed = Number(res?.feishu?.failed ?? 0)

          await handleRefresh()
          setSelectedRowKeys([])

          if (feishuFailed > 0) {
            message.warning(`已清除 ${cleared} 条（缺失 ${missing} 条），飞书删除成功 ${feishuDeleted} 条，失败 ${feishuFailed} 条`)
          } else {
            message.success(`已清除 ${cleared} 条（缺失 ${missing} 条），飞书删除 ${feishuDeleted} 条`)
          }
        } finally {
          setDeletingExtracted(false)
        }
      },
    })
  }

  const segmentedOptions: { label: string; value: string }[] = [
    { label: 'Zotero库', value: 'zotero' },
    { label: '文献矩阵', value: 'matrix' },
  ]

  const buildNextConfig = useCallback((nextPartial: Record<string, unknown>) => {
    const prev = rawConfig
    const prevZotero = (prev.zotero as Record<string, unknown>) ?? {}
    const prevLlm = (prev.llm as Record<string, unknown>) ?? {}
    const prevFeishu = (prev.feishu as Record<string, unknown>) ?? {}
    const prevFields = (prev.fields as Record<string, unknown>) ?? {}
    const prevUi = (prev.ui as Record<string, unknown>) ?? {}
    const nextZotero = (nextPartial.zotero as Record<string, unknown>) ?? {}
    const nextLlm = (nextPartial.llm as Record<string, unknown>) ?? {}
    const nextFeishu = (nextPartial.feishu as Record<string, unknown>) ?? {}
    const nextFields = (nextPartial.fields as Record<string, unknown>) ?? {}
    const nextUi = (nextPartial.ui as Record<string, unknown>) ?? {}
    return {
      ...prev,
      ...nextPartial,
      zotero: { ...prevZotero, ...nextZotero },
      llm: { ...prevLlm, ...nextLlm },
      feishu: { ...prevFeishu, ...nextFeishu },
      fields: { ...prevFields, ...nextFields },
      ui: { ...prevUi, ...nextUi },
    }
  }, [rawConfig])

  const buildNextFields = useCallback((rows: AnalysisFieldRow[]) => {
    const deduped = rows
      .map((r) => ({
        key: String(r.key ?? '').trim(),
        description: String(r.description ?? '').trim(),
        type: String(r.type ?? 'string').trim(),
        rule: String(r.rule ?? '').trim(),
        name: String(r.name ?? '').trim(),
      }))
      .filter((r) => r.key.length > 0)

    const seen = new Set<string>()
    for (const r of deduped) {
      if (seen.has(r.key)) {
        throw new Error(`重复字段 key：${r.key}`)
      }
      seen.add(r.key)
    }

    const nextAnalysis: Record<string, unknown> = {}
    for (const r of deduped) {
      nextAnalysis[r.key] = {
        description: r.description,
        type: r.type || 'string',
        rule: r.rule || undefined,
        name: r.name || undefined,
      }
    }

    return {
      ...rawFields,
      analysis_fields: nextAnalysis,
    }
  }, [rawFields])

  const buildNextAnalysisOrder = useCallback((rows: AnalysisFieldRow[]) => {
    return rows
      .map((r) => String(r.key ?? '').trim())
      .filter((k) => k.length > 0)
  }, [])

  /**
   * 设置页操作：保存设置
   * 收集所有 Form 表单的数据，构造完整的 Config 对象并发送给后端保存。
   */
  const saveSettingsNow = useCallback(async () => {
    if (settingsHydratingRef.current) return
    setSettingsSaving(true)
    try {
      const partial = configForm.getFieldsValue(true) as Record<string, unknown>
      const fieldsValue = fieldsForm.getFieldsValue(true) as { analysis_fields?: AnalysisFieldRow[] }
      const rows = Array.isArray(fieldsValue.analysis_fields) ? fieldsValue.analysis_fields : []
      const nextConfig = buildNextConfig(partial)
      const nextFields = buildNextFields(rows)
      nextConfig.fields = nextFields
      const nextOrder = buildNextAnalysisOrder(rows)
      const ui = (nextConfig.ui as Record<string, unknown>) ?? {}
      const tableColumns = (ui.table_columns as Record<string, unknown>) ?? {}
      const matrix = (tableColumns.matrix as Record<string, unknown>) ?? {}
      const analysis = (matrix.analysis as Record<string, unknown>) ?? {}
      const nextAnalysis = { ...analysis, order: nextOrder }
      nextConfig.ui = {
        ...ui,
        table_columns: {
          ...tableColumns,
          matrix: { ...matrix, analysis: nextAnalysis },
        },
      }

      const cfgRes = await saveConfig(nextConfig)
      if (!cfgRes.saved) {
        message.error('保存失败：请检查运行环境与文件权限')
        return
      }

      setRawConfig(nextConfig)
      setRawFields(nextFields)

      const zoteroCfg = (nextConfig.zotero as Record<string, unknown>) ?? {}
      const zoteroDataDir = typeof zoteroCfg.data_dir === 'string' ? zoteroCfg.data_dir : ''
      setZoteroStatus({ path: zoteroDataDir || '未配置', connected: !!zoteroDataDir })
    } catch (e) {
      const msg = e instanceof Error ? e.message : '未知错误'
      message.error(msg)
    } finally {
      setSettingsSaving(false)
    }
  }, [buildNextAnalysisOrder, buildNextConfig, buildNextFields, configForm, fieldsForm])

  const scheduleAutoSaveSettings = useCallback(() => {
    if (settingsHydratingRef.current) return
    if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null
      void saveSettingsNow()
    }, 500)
  }, [saveSettingsNow])

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
                          disabled={activeView === 'matrix'}
                          themePrimaryColor={themeToken.colorPrimary}
                          value={{
                            statusMode: filterMode,
                            match: fieldFilterMatch,
                            yearOp: fieldFilterYearOp,
                            year: fieldFilterYear,
                            type: fieldFilterType,
                            publications: fieldFilterPublications,
                          }}
                          onChange={(next) => {
                            setFilterMode(next.statusMode)
                            setFieldFilterMatch(next.match)
                            setFieldFilterYearOp(next.yearOp)
                            setFieldFilterYear(next.year)
                            setFieldFilterType(next.type)
                            setFieldFilterPublications(next.publications)
                          }}
                          yearOptions={filterYearOptions}
                          typeOptions={filterTypeOptions}
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
                        <Button key="analyze" type="primary" icon={<PlayCircleOutlined />} onClick={startAnalysis} disabled={selectedRowKeys.length === 0}>
                          开始分析
                        </Button>
                        {activeView === 'matrix' ? (
                          <Button
                            key="delete_extracted"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={deleteExtractedData}
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
                      onOpenDetail={(key) => setActiveItemKey(key)}
                      onRefresh={handleRefresh}
                      onPageRowsChange={setCurrentPageRows}
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
        </div>
      </AntApp>
    </ConfigProvider>
  )
}

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
      <div data-tauri-drag-region className="px-4 py-3 flex items-center justify-between">
        <div className="font-bold text-xl primary-color tracking-tight">设置</div>
        <div data-tauri-drag-region="false" className="flex items-center gap-1">
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
