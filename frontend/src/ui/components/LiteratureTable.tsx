/**
 * 模块名称: 文献列表表格
 * 功能描述: 高度定制的 ProTable 组件，用于展示通过 Zotero 或 Matrix 分析后的文献列表。
 *           支持列宽调整、排序、自定义渲染（徽标、标签等）以及视图切换（Zotero模式/Matrix模式）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react'
import type { BadgeProps } from 'antd'
import { Badge, Dropdown, Tag, Typography, Button } from 'antd'
import { EyeOutlined, ReadOutlined, ReloadOutlined } from '@ant-design/icons'
import type { ProColumns } from '@ant-design/pro-components'
import { ProTable } from '@ant-design/pro-components'
import { useContextMenu } from './GlobalContextMenu'

import type { LiteratureItem, ProcessingStatus } from '../../types'
import { formatAuthor, formatIF, getJournalTags, getLiteratureTypeMeta } from '../utils/ui-formatters'
import {
  RATING_OPTIONS,
  RATING_EMOJI_MAP,
  PROGRESS_OPTIONS,
  PROGRESS_EMOJI_MAP
} from '../utils/constants'
import { updateItem } from '../../lib/backend'
import { TextAnalysisHighlighter } from './TextAnalysisHighlighter'

export type LiteratureTableView = 'zotero' | 'matrix'

export type LiteratureTableColumnOption = { key: string; label: string }

export type LiteratureTableProps = {
  data: LiteratureItem[]
  view: LiteratureTableView
  metaColumns: LiteratureTableColumnOption[]
  analysisColumns?: LiteratureTableColumnOption[]
  highlightQuery?: string
  selectedRowKeys: React.Key[]
  onSelectedRowKeysChange: (keys: React.Key[]) => void
  onOpenDetail: (itemKey: string) => void
  onRefresh: () => void
  /** 乐观更新回调，用于局部更新 item 字段避免全库刷新 */
  onItemPatch?: (itemKey: string, patch: Record<string, unknown>) => void
  onPageRowsChange?: (rows: LiteratureItem[]) => void
  /** 排序后的完整数据，用于抽屉切换条目时按视图顺序导航 */
  onSortedDataChange?: (rows: LiteratureItem[]) => void
  /** 当前激活的条目 key，用于高亮显示和自动滚动 */
  activeItemKey?: string | null
  onReadOriginal?: (itemKey: string) => void
}

const TITLE_KEY = 'title'
const STATUS_KEY = 'status'

/**
 * 列最小宽度定义
 * 防止列宽过小导致内容不可读或表头无法交互。
 */
const COLUMN_MIN_WIDTHS: Record<string, number> = {
  [TITLE_KEY]: 180,
  author: 160,
  year: 80,
  type: 90,
  bib_type: 90,
  tags: 200,
  key_word: 200,
  publications: 220,
  impact_factor: 60,
  journal_tags: 240,
  [STATUS_KEY]: 120,
  rating: 80,
  progress: 80,
}

const COLUMN_MAX_WIDTHS: Record<string, number> = {
  [TITLE_KEY]: 600,
  publications: 300,
  tags: 500,
  key_word: 500,
}

const DEFAULT_MIN_WIDTH = 360

const getMinWidth = (key: string) => COLUMN_MIN_WIDTHS[key] ?? DEFAULT_MIN_WIDTH

const truncateText = (text: string, maxLen: number) => {
  const s = String(text ?? '').trim()
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen - 1) + '…'
}

const escapeRegExp = (input: string) => input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 辅助函数：生成状态徽标
 * 根据处理状态（ProcessingStatus）和同步状态（SyncStatus）生成对应的 Antd Badge 属性。
 */
const getStatusBadge = (
  view: LiteratureTableView,
  processed: ProcessingStatus,
  sync: LiteratureItem['sync_status'],
  error?: string
): { status: BadgeProps['status']; text: string; color?: string } => {
  if (view === 'matrix') {
    if (processed !== 'done') return { status: 'default', text: '-', color: 'default' }
    if (sync === 'syncing') return { status: 'processing', text: '同步中', color: 'blue' }
    return sync === 'synced'
      ? { status: 'success', text: '已同步', color: 'var(--primary-color)' }
      : { status: 'warning', text: '待同步', color: 'orange' }
  }
  if (processed === 'processing') return { status: 'processing', text: '分析中', color: 'blue' }
  if (processed === 'reanalyzing') return { status: 'processing', text: '重新分析中', color: 'orange' }
  if (processed === 'failed') {
    const reason = typeof error === 'string' && error.trim().length > 0 ? truncateText(error, 24) : ''
    return { status: 'error', text: reason ? `失败 · ${reason}` : '失败', color: 'red' }
  }
  if (processed === 'done') return { status: 'success', text: '已分析', color: 'cyan' }
  return { status: 'default', text: '未分析', color: 'default' }
}

/**
 * 辅助函数：从 localStorage 读取排序状态
 * 定义在组件外部，确保在首次渲染时可用。
 */
const readSortFromStorage = (storageKey: string): { key: string; order: 'ascend' | 'descend' } => {
  try {
    const raw = localStorage.getItem(storageKey)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed.key === 'string' && (parsed.order === 'ascend' || parsed.order === 'descend')) {
        return parsed as { key: string; order: 'ascend' | 'descend' }
      }
    }
  } catch {
    // ignore
  }
  return { key: TITLE_KEY, order: 'ascend' }
}

type ResizableHeaderCellProps = React.ThHTMLAttributes<HTMLTableCellElement> & {
  width?: number | string
  minWidth?: number
  onResizeStart?: (e: React.PointerEvent) => void
}

/**
 * 组件：可调整宽度的表头单元格
 * 在表头右侧渲染一个不可见的交互区域，用于捕获拖拽事件以调整列宽。
 */
function ResizableHeaderCell(props: ResizableHeaderCellProps) {
  const { width, minWidth, onResizeStart, children, style, onClick, ...rest } = props
  const mergedStyle: React.CSSProperties = { ...style }
  if (width !== undefined) mergedStyle.width = width
  if (minWidth !== undefined) mergedStyle.minWidth = minWidth

  /**
   * 表头点击处理：只拦截 resizer 区域的点击，其他区域正常传递给 antd 处理排序等交互
   * 之前的逻辑会阻止所有非 sorter 区域的点击，可能导致某些交互失效
   */
  const handleHeaderClick = useCallback(
    (e: React.MouseEvent<HTMLTableCellElement>) => {
      if (!onClick) return
      const target = e.target as HTMLElement | null
      // 如果点击的是 resizer 区域，则不触发排序
      const isResizer = !!target?.closest('.matrixit-col-resizer')
      if (isResizer) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      // 其他区域正常传递点击事件
      onClick(e)
    },
    [onClick]
  )

  return (
    <th {...rest} style={mergedStyle} onClick={handleHeaderClick}>
      <div className="relative w-full h-full">
        <div className="pr-5">{children}</div>
        {onResizeStart ? (
          <div
            onPointerDown={onResizeStart}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
            className="matrixit-col-resizer absolute top-0 -right-1 h-full w-3 cursor-col-resize select-none touch-none"
            data-tauri-drag-region="false"
          />
        ) : null}
      </div>
    </th>
  )
}

/**
 * 排序辅助函数
 */
const getRatingScore = (record: LiteratureItem) => {
  const val = (record as any).rating
  const ratingScore: Record<string, number> = { High: 3, Medium: 2, Low: 1 }
  return ratingScore[String(val || '')] || 0
}

const getProgressScore = (record: LiteratureItem) => {
  const val = (record as any).progress
  const progressScore: Record<string, number> = { Finished: 3, Reading: 2, Unread: 1 }
  return progressScore[String(val || 'Unread')] || 0
}

const getImpactFactor = (record: LiteratureItem) => {
  const val = (record as any).meta_extra?.jcr?.impact_factor
  return typeof val === 'number' ? val : -1
}

const getQuantileScore = (record: LiteratureItem) => {
  const q = (record as any).meta_extra?.jcr?.quartile
  if (q === 'Q1') return 4
  if (q === 'Q2') return 3
  if (q === 'Q3') return 2
  if (q === 'Q4') return 1
  return 0
}

const SORTERS: Record<string, (a: LiteratureItem, b: LiteratureItem) => number> = {
  rating: (a, b) => getRatingScore(a) - getRatingScore(b),
  progress: (a, b) => getProgressScore(a) - getProgressScore(b),
  impact_factor: (a, b) => getImpactFactor(a) - getImpactFactor(b),
  journal_tags: (a, b) => getQuantileScore(a) - getQuantileScore(b),
}

export function LiteratureTable({
  data,
  view,
  metaColumns,
  analysisColumns,
  highlightQuery,
  selectedRowKeys,
  onSelectedRowKeysChange,
  onOpenDetail,
  onRefresh,
  onItemPatch,
  onPageRowsChange,
  onSortedDataChange,
  activeItemKey,
  onReadOriginal,
}: LiteratureTableProps) {
  const { showMenu } = useContextMenu()
  const showStatus = true
  const fixedWidthCols = useMemo(() => new Set(['author', 'year', 'type', 'bib_type', 'impact_factor', 'rating', 'progress']), [])
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)
  const highlightTokens = useMemo(() => {
    const normalized = String(highlightQuery ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
    return normalized ? normalized.split(' ').filter(Boolean) : []
  }, [highlightQuery])
  const highlightRegExp = useMemo(() => {
    if (highlightTokens.length === 0) return null
    const pattern = highlightTokens.map(escapeRegExp).join('|')
    if (!pattern) return null
    return new RegExp(`(${pattern})`, 'ig')
  }, [highlightTokens])
  const highlightText = useCallback(
    (text: string) => {
      if (!highlightRegExp) return text
      const raw = String(text ?? '')
      if (!raw) return raw
      const parts = raw.split(highlightRegExp)
      if (parts.length <= 1) return raw
      return parts.map((part, idx) =>
        idx % 2 === 1 ? (
          <Typography.Text key={idx} mark>
            {part}
          </Typography.Text>
        ) : (
          part
        )
      )
    },
    [highlightRegExp]
  )
  const highlightableAnalysisKeys = useMemo(() => {
    if (view !== 'matrix') return new Set<string>()
    const excluded = new Set(['key_word', 'type', 'bib_type'])
    return new Set((analysisColumns ?? []).map((c) => c.key).filter((k) => !excluded.has(k)))
  }, [analysisColumns, view])

  const sortStorageKey = `matrixit.ui.tableSort.${view}`

  const [sortState, setSortState] = useState<{ key: string; order: 'ascend' | 'descend' }>(() => {
    return readSortFromStorage(`matrixit.ui.tableSort.${view}`)
  })

  // 当 view 切换时，从对应的 localStorage 重新加载排序状态
  const prevViewRef = useRef(view)
  useEffect(() => {
    if (prevViewRef.current !== view) {
      prevViewRef.current = view
      // 使用 startTransition 避免视图切换时的卡顿
      startTransition(() => {
        setSortState(readSortFromStorage(sortStorageKey))
      })
    }
  }, [view, sortStorageKey])

  // 监听 sortState 变化并持久化
  useEffect(() => {
    try {
      localStorage.setItem(sortStorageKey, JSON.stringify(sortState))
    } catch {
      // ignore
    }
  }, [sortState, sortStorageKey])

  /**
   * 核心逻辑：在前端手动执行排序
   * Ant Design Table 在首次挂载时，即使指定了 sortOrder，也不会自动触发 sorter 函数对 dataSource 进行排序。
   * 因此我们需要在渲染前手动对数据进行一次排序，确保初始视图是有序的。
   */
  const sortedData = useMemo(() => {
    if (!sortState.key) return data
    const { key, order } = sortState
    const sorted = [...data].sort((a, b) => {
      // 优先使用专用排序器
      if (SORTERS[key]) {
        return SORTERS[key](a, b)
      }

      if (key === TITLE_KEY) {
        const at = String(a.title ?? '').trim()
        const bt = String(b.title ?? '').trim()
        const ae = at.length === 0
        const be = bt.length === 0
        if (ae && be) return 0
        if (ae) return 1
        if (be) return -1
        return at.localeCompare(bt, 'zh-Hans-CN')
      }
      // 特殊处理状态列
      if (key === STATUS_KEY) {
        if (view === 'matrix') {
          const syncOrder: Record<NonNullable<LiteratureItem['sync_status']>, number> = { unsynced: 0, syncing: 0.5, synced: 1 }
          const av = syncOrder[a.sync_status] ?? 0
          const bv = syncOrder[b.sync_status] ?? 0
          return av - bv
        }
        const statusOrder: Record<ProcessingStatus, number> = { unprocessed: 0, processing: 1, reanalyzing: 1.5, done: 2, failed: 3 }
        const av = statusOrder[a.processed_status] ?? 0
        const bv = statusOrder[b.processed_status] ?? 0
        return av - bv
      }
      // 通用处理其他列
      const av = (a as Record<string, unknown>)[key]
      const bv = (b as Record<string, unknown>)[key]
      const as = String(av ?? '')
      const bs = String(bv ?? '')
      return as.localeCompare(bs, 'zh-Hans-CN')
    })
    return order === 'descend' ? sorted.reverse() : sorted
  }, [data, sortState, view])

  // 当排序后的数据变化时，通知父组件
  useEffect(() => {
    if (onSortedDataChange) onSortedDataChange(sortedData)
  }, [onSortedDataChange, sortedData])

  // 当激活条目变化时，自动切换到对应页并滚动到该行
  useEffect(() => {
    if (!activeItemKey) return
    const index = sortedData.findIndex((it) => it.item_key === activeItemKey)
    if (index < 0) return
    // 计算该条目所在的页码
    const targetPage = Math.floor(index / pageSize) + 1
    if (targetPage !== currentPage) {
      setCurrentPage(targetPage)
    }
    // 延迟滚动，确保翻页后 DOM 已更新
    const rafId = window.requestAnimationFrame(() => {
      const el = containerRef.current
      if (!el) return
      const row = el.querySelector(`tr[data-row-key="${activeItemKey}"]`) as HTMLElement | null
      if (row) {
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    })
    return () => window.cancelAnimationFrame(rafId)
  }, [activeItemKey, sortedData, pageSize, currentPage])

  useEffect(() => {
    if (!onPageRowsChange) return
    const start = Math.max(0, (currentPage - 1) * pageSize)
    const end = Math.max(start, start + pageSize)
    onPageRowsChange(sortedData.slice(start, end)) // Use sortedData here
  }, [currentPage, sortedData, onPageRowsChange, pageSize])

  const titleOption = useMemo(() => metaColumns.find((c) => c.key === TITLE_KEY) ?? null, [metaColumns])
  const visibleMeta = useMemo(() => metaColumns.filter((c) => c.key !== TITLE_KEY && (view === 'zotero' || c.key !== 'tags')), [metaColumns, view])
  const visibleAnalysis = useMemo(
    () => (view === 'matrix' ? (analysisColumns ?? []) : []),
    [analysisColumns, view]
  )

  /**
   * 优化：使用 useCallback 缓存点击处理器
   * 避免每次渲染时为每一行创建新的函数引用，减少不必要的 DOM 更新
   */
  const handleTitleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      const itemKey = e.currentTarget.dataset.itemKey
      if (itemKey) onOpenDetail(itemKey)
    },
    [onOpenDetail]
  )

  /**
   * 乐观更新处理器：Rating 评分
   * 使用 useCallback 避免每行创建匿名函数，符合前端规范
   */
  const handleRatingChange = useCallback(
    (itemKey: string, newVal: string) => {
      const patch = { rating: newVal || null }
      if (onItemPatch) {
        onItemPatch(itemKey, patch)
      } else {
        updateItem(itemKey, patch).then(() => onRefresh())
      }
    },
    [onItemPatch, onRefresh]
  )

  /**
   * 乐观更新处理器：Progress 进度
   * 使用 useCallback 避免每行创建匿名函数，符合前端规范
   */
  const handleProgressChange = useCallback(
    (itemKey: string, newVal: string) => {
      const patch = { progress: newVal }
      if (onItemPatch) {
        onItemPatch(itemKey, patch)
      } else {
        updateItem(itemKey, patch).then(() => onRefresh())
      }
    },
    [onItemPatch, onRefresh]
  )

  const visibleKeys = useMemo(() => {
    const keys = [TITLE_KEY, ...visibleMeta.map((c) => c.key), ...visibleAnalysis.map((c) => c.key)]
    if (showStatus) keys.push(STATUS_KEY)
    return keys
  }, [showStatus, visibleAnalysis, visibleMeta])

  const containerRef = useRef<HTMLDivElement | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)
  const columnWidthsPxRef = useRef<Record<string, number>>({})
  const [layoutTick, setLayoutTick] = useState(0)

  const tableMinWidth = useMemo(() => {
    return visibleKeys.reduce((acc, k) => acc + getMinWidth(k), 0)
  }, [visibleKeys])

  const visibleKeysSig = useMemo(() => visibleKeys.join('|'), [visibleKeys])

  const widthsStorageKey = useMemo(() => `matrixit.ui.tableWidths.${view}`, [view])

  const [containerHeight, setContainerHeight] = useState(0)

  const readStoredWidthsPx = useCallback(
    (keys: string[], tableWidthPx: number): Record<string, number> => {
      try {
        const raw = localStorage.getItem(widthsStorageKey)
        if (!raw) return {}
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const out: Record<string, number> = {}
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v
        }
        const values = keys.map((k) => out[k]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0)
        const max = values.length ? Math.max(...values) : 0
        const looksLikePercent = max > 0 && max <= 100
        if (looksLikePercent) {
          for (const k of keys) {
            const p = out[k]
            if (typeof p === 'number' && Number.isFinite(p) && p > 0) out[k] = (p / 100) * tableWidthPx
          }
        }
        return out
      } catch {
        return {}
      }
    },
    [widthsStorageKey]
  )

  const writeStoredWidthsPx = useCallback(() => {
    try {
      const payload: Record<string, number> = {}
      for (const k of visibleKeys) {
        const v = columnWidthsPxRef.current[k]
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) payload[k] = v
      }
      localStorage.setItem(widthsStorageKey, JSON.stringify(payload))
    } catch {
      return
    }
  }, [visibleKeys, widthsStorageKey])

  const computeWeights = useCallback((key: string) => {
    if (key === TITLE_KEY) return 8.0
    if (key === STATUS_KEY) return 1.3
    if (key === 'year') return 0.8
    if (key === 'type') return 1.0
    if (key === 'author') return 1.8
    if (key === 'tags') return 2.0
    if (key === 'key_word') return 2.0
    if (key === 'publications') return 1.6
    return 2.8
  }, [])

  /**
   * 核心算法：计算默认列宽
   * 基于列的预设权重（computedWeights）和表格当前可用宽度，按比例分配宽度。
   */
  const computeDefaultWidthsPx = useCallback(
    (availableWidthPx: number) => {
      const minSum = visibleKeys.reduce((acc, k) => acc + getMinWidth(k), 0)
      const totalWidth = Math.max(availableWidthPx, minSum)
      const extra = Math.max(0, totalWidth - minSum)
      const weights = visibleKeys.map((k) => ({ key: k, weight: computeWeights(k), min: getMinWidth(k) }))
      const totalWeight = weights.reduce((acc, x) => acc + x.weight, 0) || 1
      const out: Record<string, number> = {}
      for (const x of weights) {
        let w = x.min + (extra * x.weight) / totalWeight
        const max = COLUMN_MAX_WIDTHS[x.key]
        if (max !== undefined && w > max) w = max
        out[x.key] = w
      }
      return out
    },
    [computeWeights, visibleKeys]
  )

  const toCssVarKey = useCallback((key: string) => {
    let out = ''
    for (const ch of key) {
      if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '-' || ch === '_') {
        out += ch
        continue
      }
      const cp = ch.codePointAt(0)
      out += cp ? `_${cp.toString(16)}_` : '_'
    }
    return out || 'col'
  }, [])

  const getColCssVarName = useCallback((key: string) => `--matrixit-col-${toCssVarKey(key)}`, [toCssVarKey])
  const getColCssVar = useCallback((key: string) => `var(${getColCssVarName(key)})`, [getColCssVarName])

  const applyColumnWidthsToCssVars = useCallback(
    (widths: Record<string, number>) => {
      const el = containerRef.current
      if (!el) return
      for (const [k, v] of Object.entries(widths)) {
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) continue
        el.style.setProperty(getColCssVarName(k), `${Math.round(v)}px`)
      }
    },
    [getColCssVarName]
  )

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const rect = el.getBoundingClientRect()
      setContainerWidth(rect.width)
      setContainerHeight(rect.height)
    })
    ro.observe(el)
    const rect = el.getBoundingClientRect()
    setContainerWidth(rect.width)
    setContainerHeight(rect.height)
    return () => ro.disconnect()
  }, [])

  const [reservedHeight, setReservedHeight] = useState(112)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const raf = window.requestAnimationFrame(() => {
      const paginationEl = el.querySelector('.ant-pagination') as HTMLElement | null
      const headerEl =
        (el.querySelector('.ant-table-header') as HTMLElement | null) ??
        (el.querySelector('.ant-table-thead') as HTMLElement | null)
      const pagerH = paginationEl?.getBoundingClientRect().height ?? 0
      const headerH = headerEl?.getBoundingClientRect().height ?? 0
      const next = Math.max(64, Math.ceil(pagerH + headerH + 16))
      setReservedHeight(next)
    })
    return () => window.cancelAnimationFrame(raf)
  }, [containerHeight, containerWidth, pageSize, showStatus, visibleKeysSig])

  const tableScrollY = useMemo(() => {
    if (!containerHeight || containerHeight <= 0) return undefined
    return Math.max(240, Math.floor(containerHeight - reservedHeight))
  }, [containerHeight, reservedHeight])

  useEffect(() => {
    const baseWidth = Math.max(containerWidth, tableMinWidth)
    const computed = computeDefaultWidthsPx(baseWidth)
    const stored = readStoredWidthsPx(visibleKeys, baseWidth)
    const merged: Record<string, number> = {}
    for (const k of visibleKeys) {
      const v = typeof stored[k] === 'number' ? stored[k] : computed[k]
      merged[k] = Math.max(getMinWidth(k), Number.isFinite(v) ? v : getMinWidth(k))
    }
    for (const k of fixedWidthCols) {
      if (!visibleKeys.includes(k)) continue
      merged[k] = getMinWidth(k)
    }
    columnWidthsPxRef.current = merged
    applyColumnWidthsToCssVars(merged)
  }, [applyColumnWidthsToCssVars, computeDefaultWidthsPx, containerWidth, fixedWidthCols, readStoredWidthsPx, tableMinWidth, view, visibleKeys, visibleKeysSig])

  /**
   * 交互逻辑：列宽拖拽调整
   * 处理 PointerEvent，实时计算拖拽偏移量，更新 CSS 变量以实现流畅的列宽调整。
   * 支持同时调整相邻列（若有）以保持总宽度协调（当前策略简易版：仅调整当前列或与相邻列联动）。
   */
  const startResize = useCallback(
    (colKey: string) => (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()

      if (fixedWidthCols.has(colKey)) return
      const minWidthPx = getMinWidth(colKey)
      const idx = visibleKeys.indexOf(colKey)
      const neighborKey = (() => {
        for (let i = idx + 1; i < visibleKeys.length; i += 1) {
          const k = visibleKeys[i]
          if (!fixedWidthCols.has(k)) return k
        }
        for (let i = idx - 1; i >= 0; i -= 1) {
          const k = visibleKeys[i]
          if (!fixedWidthCols.has(k)) return k
        }
        return null
      })()
      const neighborMinWidthPx = neighborKey ? getMinWidth(neighborKey) : 0

      const startX = e.clientX
      const startWidthPx = (() => {
        const v = columnWidthsPxRef.current[colKey]
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
        const th = (e.currentTarget as HTMLElement | null)?.closest('th') as HTMLElement | null
        const w = th?.getBoundingClientRect().width
        return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : minWidthPx
      })()
      const startNeighborWidthPx = neighborKey
        ? (() => {
          const v = columnWidthsPxRef.current[neighborKey]
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v
          return Math.max(neighborMinWidthPx, minWidthPx)
        })()
        : 0

      const prevCursor = document.body.style.cursor
      const prevUserSelect = document.body.style.userSelect
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const targetEl = e.currentTarget as HTMLElement | null
      if (targetEl && typeof (targetEl as unknown as { setPointerCapture?: unknown }).setPointerCapture === 'function') {
        ; (targetEl as unknown as { setPointerCapture: (pointerId: number) => void }).setPointerCapture(e.pointerId)
      }

      let latestDx = 0
      let rafId = 0

      const applyByDx = (dx: number) => {
        const widths = columnWidthsPxRef.current
        const next: Record<string, number> = { ...widths }

        const desiredCurrent = startWidthPx + dx
        const clampedCurrent = Math.max(minWidthPx, desiredCurrent)
        if (!neighborKey) {
          next[colKey] = clampedCurrent
          columnWidthsPxRef.current = next
          applyColumnWidthsToCssVars({ [colKey]: clampedCurrent })
          return
        }

        const desiredNeighbor = startNeighborWidthPx - (clampedCurrent - startWidthPx)
        const nextNeighbor = Math.max(neighborMinWidthPx, desiredNeighbor)
        next[colKey] = clampedCurrent
        next[neighborKey] = nextNeighbor
        columnWidthsPxRef.current = next
        applyColumnWidthsToCssVars({ [colKey]: clampedCurrent, [neighborKey]: nextNeighbor })
      }

      const onMove = (evt: PointerEvent) => {
        latestDx = evt.clientX - startX
        if (rafId) return
        rafId = window.requestAnimationFrame(() => {
          rafId = 0
          applyByDx(latestDx)
        })
      }

      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        if (rafId) window.cancelAnimationFrame(rafId)
        document.body.style.cursor = prevCursor
        document.body.style.userSelect = prevUserSelect
        writeStoredWidthsPx()
        setLayoutTick((x) => x + 1)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [applyColumnWidthsToCssVars, fixedWidthCols, visibleKeys, writeStoredWidthsPx]
  )

  const currentTableWidth = useMemo(() => {
    return visibleKeys.reduce((acc, k) => acc + (columnWidthsPxRef.current[k] ?? getMinWidth(k)), 0)
  }, [visibleKeys, layoutTick])

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      // 阻止默认菜单
      e.preventDefault()
      e.stopPropagation()

      const target = e.target as HTMLElement
      // 尝试寻找最近的行或 Item Key
      // ProTable 的行通常有 data-row-key。我们自定义的 Title 按钮有 data-item-key。
      const row = target.closest('tr[data-row-key]') as HTMLElement | null
      const itemBtn = target.closest('[data-item-key]') as HTMLElement | null
      const itemKey = itemBtn?.getAttribute('data-item-key') || row?.getAttribute('data-row-key')

      const menuItems: any[] = []

      // 1. Item Context
      if (itemKey) {
        menuItems.push({
          key: 'view-details',
          label: '查看详情',
          icon: <EyeOutlined />,
          onClick: () => onOpenDetail(itemKey),
        })
        menuItems.push({
          key: 'read-original',
          label: '阅读原文',
          icon: <ReadOutlined />,
          onClick: () => onReadOriginal?.(itemKey),
          disabled: !onReadOriginal, // 如果没有提供处理函数则禁用
        })

      } else {
        // 2. Background Context (Refresh)
        // 只有当点击的不是具体条目时才显示刷新，或者条目也显示刷新？通常背景显示刷新。
        // 用户需求：“未选中文字时显示，点击任意位置” -> 可能是指点击条目也显示刷新，或者只在背景。
        // “鼠标悬浮在表格标题上、高亮文字上时，点击右键可查看详情...未选中文字时显示（刷新）”
        // 这里的“未选中文字”可能是指没有 Text Selection。
        // 我们已经在 TextAnalysisHighlighter 里处理了 Selection。
        // 这里主要作为 Table 的通用菜单。
        // 策略：如果是 Item，显示 Item 功能 + 刷新；如果是背景，只显示刷新。
        // 但通常上下文菜单越短越好。Item 上不要刷新。
      }

      // Refresh (Always available or only background? User said "click anywhere" implies global for table area, but context sensitive)
      // "点击任意位置" -> 意味着 Item 上也应该有？不，"未选中文字时显示" refers to the Refresh function logic, likely "If no text selected, show menu".
      // 用户说："当鼠标悬浮在表格标题上...点击右键可查看详情...目前只有在选中文字的时候才有右键菜单...要把刷新功能加上（未选中文字时显示，点击任意位置）"
      // 这句话有点歧义。可能是说：现在只有 Highligher 选中文本才有菜单。他希望不选中文本也能唤起菜单（详情/原文/刷新）。
      // 那么我将在 Item 上显示 详情/原文/刷新（分割线），在背景显示 刷新。

      if (menuItems.length > 0) {
        // Add separator if we were to act strict, but for now just append
      }

      menuItems.push({
        key: 'refresh',
        label: '刷新列表',
        icon: <ReloadOutlined />,
        onClick: () => onRefresh(),
      })

      if (menuItems.length > 0) {
        showMenu(menuItems, { x: e.clientX, y: e.clientY })
      }
    },
    [onOpenDetail, onReadOriginal, onRefresh, showMenu]
  )

  /**
   * 列定义生成
   * 动态生成 ProTable 的 columns 配置，包含：
   * - 标题列（固定在左侧，支持双击打开详情）
   * - 元数据列（Author, Year 等）
   * - 分析字段列（动态渲染，支持多行文本或 Badge）
   * - 状态列（固定在右侧，显示处理与同步状态）
   */
  const columns: ProColumns<LiteratureItem>[] = useMemo(
    () => {
      const wrapCellStyle =
        view === 'matrix'
          ? ({ whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere', verticalAlign: 'top' } as const)
          : null

      const titleCol: ProColumns<LiteratureItem> = {
        key: TITLE_KEY,
        title: titleOption?.label ?? '标题',
        dataIndex: TITLE_KEY,
        ellipsis: false,
        width: getColCssVar(TITLE_KEY),
        onCell: () => ({
          style: {
            minWidth: getMinWidth(TITLE_KEY),
            ...(view === 'zotero'
              ? { whiteSpace: 'normal', wordBreak: 'break-word', overflowWrap: 'anywhere' }
              : {}),
            ...(wrapCellStyle ?? {}),
          },
        }),
        fixed: 'left',
        sorter: (a, b) => {
          const at = String(a.title ?? '').trim()
          const bt = String(b.title ?? '').trim()
          const ae = at.length === 0
          const be = bt.length === 0
          if (ae && be) return 0
          if (ae) return 1
          if (be) return -1
          return at.localeCompare(bt, 'zh-Hans-CN')
        },
        defaultSortOrder: sortState.key === TITLE_KEY ? sortState.order : undefined,
        sortOrder: sortState.key === TITLE_KEY ? sortState.order : undefined,
        sortDirections: ['ascend', 'descend', 'ascend'],
        onHeaderCell: () =>
        ({
          width: getColCssVar(TITLE_KEY),
          minWidth: getMinWidth(TITLE_KEY),
          onResizeStart: startResize(TITLE_KEY),
        } as unknown as ResizableHeaderCellProps),
        render: (_, record) => (
          <button
            type="button"
            data-item-key={record.item_key}
            onClick={handleTitleClick}
            className={
              view === 'zotero' || view === 'matrix'
                ? 'matrixit-title-link block whitespace-pre-wrap break-words [overflow-wrap:anywhere]'
                : 'matrixit-title-link'
            }
          >
            {highlightTokens.length > 0 ? highlightText(record.title || '（无标题）') : record.title || '（无标题）'}
          </button>
        ),
      }

      const buildValueColumn = (c: LiteratureTableColumnOption): ProColumns<LiteratureItem> => {
        const colKey = c.key
        const fixedWidth = view === 'zotero' && fixedWidthCols.has(colKey)
        return {
          key: colKey,
          title: c.label,
          dataIndex: colKey,
          ellipsis: (colKey === 'author' || colKey === 'tags') ? false : view !== 'matrix',
          width: getColCssVar(colKey),
          onCell: () => ({
            style: {
              minWidth: getMinWidth(colKey),
              ...(colKey === 'author'
                ? { whiteSpace: 'normal', wordBreak: 'break-word', overflowWrap: 'anywhere' }
                : {}),
              ...(colKey === 'tags'
                ? { whiteSpace: 'normal' }
                : {}),
              ...(wrapCellStyle ?? {})
            }
          }),
          onHeaderCell: () =>
          ({
            width: getColCssVar(colKey),
            minWidth: getMinWidth(colKey),
            ...(fixedWidth ? {} : { onResizeStart: startResize(colKey) }),
          } as unknown as ResizableHeaderCellProps),
          sorter: (a, b) => {
            if (SORTERS[colKey]) {
              return SORTERS[colKey](a, b)
            }
            const av = (a as Record<string, unknown>)[colKey]
            const bv = (b as Record<string, unknown>)[colKey]
            return String(av ?? '').localeCompare(String(bv ?? ''), 'zh-Hans-CN')
          },
          defaultSortOrder: sortState.key === colKey ? sortState.order : undefined,
          sortOrder: sortState.key === colKey ? sortState.order : undefined,
          sortDirections: ['ascend', 'descend', 'ascend'],
          render: (_, record) => {
            const v = (record as Record<string, unknown>)[colKey]
            const shouldHighlight =
              highlightTokens.length > 0 && (colKey === 'author' || (view === 'matrix' && highlightableAnalysisKeys.has(colKey)))

            // 特殊处理：作者（格式化 + 截断）
            if (colKey === 'author') {
              const text = formatAuthor(v, true)
              return <span className="secondary-color">{shouldHighlight ? highlightText(text) : text}</span>
            }

            // 特殊处理：文献类型（映射 + 配色标签）
            if (colKey === 'type' || colKey === 'bib_type') {
              const meta = getLiteratureTypeMeta(v)
              return <Tag color={meta.color} bordered={false}>{meta.label}</Tag>
            }

            // 特殊处理：IF 影响因子（颜色编码）
            if (colKey === 'impact_factor') {
              const metaExtra = (record as Record<string, unknown>).meta_extra
              const jcrData = metaExtra && typeof metaExtra === 'object' ? (metaExtra as Record<string, unknown>).jcr : null
              const ifValue = jcrData && typeof jcrData === 'object' ? (jcrData as Record<string, unknown>).impact_factor : null
              if (ifValue !== null && ifValue !== undefined) {
                const formatted = formatIF(ifValue)
                return <span style={{ color: formatted.color, fontWeight: 600 }}>{formatted.text}</span>
              }
              return <span className="secondary-color">-</span>
            }

            // 特殊处理：期刊标签（JCR分区 + 中科院分区 + Top）
            if (colKey === 'journal_tags') {
              const journalTags = getJournalTags(record as { meta_extra?: { jcr?: { quartile?: string }; cas?: { category?: string; partition?: string; top?: boolean } } })
              if (journalTags.length > 0) {
                return (
                  <div className="flex flex-wrap gap-1">
                    {journalTags.map((tag, idx) => (
                      <Tag key={`${tag.type}-${idx}`} color={tag.color} bordered={false} className="m-0">{tag.label}</Tag>
                    ))}
                  </div>
                )
              }
              return <span className="secondary-color">-</span>
            }

            // 特殊处理：Zotero 标签
            if (colKey === 'tags') {
              const metaExtra = (record as Record<string, unknown>).meta_extra
              const tags = metaExtra && typeof metaExtra === 'object' ? (metaExtra as Record<string, unknown>).tags : null
              if (Array.isArray(tags) && tags.length > 0) {
                return (
                  <div className="flex flex-wrap gap-1">
                    {tags.map((x) => String(x || '').trim()).filter(Boolean).map(t => (
                      <Tag key={t} className="m-0 max-w-full !whitespace-normal break-words">{t}</Tag>
                    ))}
                  </div>
                )
              }
              return <span className="secondary-color">-</span>
            }

            // 特殊处理：分析关键词
            if (colKey === 'key_word') {
              const val = v
              let keywords: string[] = []
              if (Array.isArray(val)) {
                keywords = val.map(x => String(x || '').trim()).filter(Boolean)
              } else if (typeof val === 'string' && val.trim().length > 0) {
                // 尝试解析可能的分隔符：中文逗号，英文逗号，分号，换行
                keywords = val.split(/[,，;；\n]/).map(s => s.trim()).filter(Boolean)
              }

              if (keywords.length > 0) {
                // 如果是 matrix 视图，且列宽足够，可以换行显示
                // 这里复用 tags 的样式
                return (
                  <div className="flex flex-wrap gap-1">
                    {keywords.map(k => (
                      <Tag key={k} className="m-0 max-w-full !whitespace-normal break-words">{k}</Tag>
                    ))}
                  </div>
                )
              }
              return <span className="secondary-color">-</span>
            }


            // 特殊处理：Rating 评分（Emoji 风格）
            if (colKey === 'rating') {
              const currentVal = String(v ?? '')
              const emoji = RATING_EMOJI_MAP[currentVal]

              if (!emoji) {
                return (
                  <Dropdown
                    menu={{
                      items: RATING_OPTIONS,
                      onClick: ({ key }) => handleRatingChange(record.item_key, key),
                    }}
                    trigger={['click']}
                  >
                    <Tag className="cursor-pointer hover:opacity-80 m-0 select-none">未评分</Tag>
                  </Dropdown>
                )
              }

              return (
                <Dropdown
                  menu={{
                    items: RATING_OPTIONS,
                    onClick: ({ key }) => handleRatingChange(record.item_key, key),
                  }}
                  trigger={['click']}
                >
                  <span
                    className="cursor-pointer hover:opacity-80 select-none text-xl flex items-center justify-center w-full"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {emoji}
                  </span>
                </Dropdown>
              )
            }

            // 特殊处理：Progress 进度 (Emoji 风格)
            if (colKey === 'progress') {
              const currentVal = String(v ?? 'Unread')
              const emoji = PROGRESS_EMOJI_MAP[currentVal] || PROGRESS_EMOJI_MAP['Unread']
              return (
                <Dropdown
                  menu={{
                    items: PROGRESS_OPTIONS,
                    onClick: ({ key }) => handleProgressChange(record.item_key, key),
                  }}
                  trigger={['click']}
                >
                  <span
                    className="cursor-pointer hover:opacity-80 select-none text-xl flex items-center justify-center w-full"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {emoji}
                  </span>
                </Dropdown>
              )
            }

            if (v === null || v === undefined || v === '') {
              return <span className="secondary-color">-</span>
            }

            // check if we should use the highlighter (Matrix view + analysis column)
            // AND we are not in the special handling cases above (though those return early)
            if (view === 'matrix' && highlightableAnalysisKeys.has(colKey)) {
              // Construct text exactly as Drawer does to ensure indices match
              let text = ''
              if (Array.isArray(v)) {
                const parts = v.map((x) => String(x ?? '').trim()).filter(Boolean)
                if (parts.length === 0) return <span className="secondary-color">-</span>
                text = parts.map((x) => `• ${x}`).join('\n')
              } else if (typeof v === 'object') {
                text = JSON.stringify(v)
              } else {
                text = String(v)
              }

              // Extract annotations
              const metaExtra = (record as any).meta_extra || {}
              const annotationsMap = metaExtra.annotations || {}
              const annotations = annotationsMap[colKey] || []

              // Use Highlighter (Read Only)
              // Note: We skip `highlightText` (search highlight) here because Highlighter expects raw string strings.
              return (
                <div className="secondary-color whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  <TextAnalysisHighlighter
                    text={text}
                    fieldKey={colKey}
                    annotations={annotations}
                    onChange={() => { }}
                    onViewDetails={() => onOpenDetail(record.item_key)}
                    readOnly={true}
                  />
                </div>
              )
            }

            if (Array.isArray(v)) {
              const parts = v.map((x) => String(x ?? '').trim()).filter(Boolean)
              if (parts.length === 0) return <span className="secondary-color">-</span>
              const text = parts.map((x) => `• ${x}`).join('\n')
              return (
                <div className="secondary-color whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {shouldHighlight ? highlightText(text) : text}
                </div>
              )
            }
            if (typeof v === 'object') {
              const text = JSON.stringify(v)
              return <span className="secondary-color">{shouldHighlight ? highlightText(text) : text}</span>
            }
            if (colKey === 'citation') {
              const text = String(v).replace(/^\[\d+\]\s*/, '')
              return <span className="secondary-color">{shouldHighlight ? highlightText(text) : text}</span>
            }
            const text = String(v)
            return <span className="secondary-color">{shouldHighlight ? highlightText(text) : text}</span>
          },
        } as ProColumns<LiteratureItem>
      }

      const metaCols = visibleMeta.map(buildValueColumn)
      const analysisCols = visibleAnalysis.map(buildValueColumn)

      const statusCol: ProColumns<LiteratureItem> | null = showStatus
        ? {
          key: STATUS_KEY,
          title: view === 'matrix' ? '同步' : '状态',
          dataIndex: STATUS_KEY,
          width: getColCssVar(STATUS_KEY),
          onCell: () => ({ style: { minWidth: getMinWidth(STATUS_KEY) } }),
          fixed: 'right',
          sorter: (a, b) => {
            if (view === 'matrix') {
              const order: Record<NonNullable<LiteratureItem['sync_status']>, number> = { unsynced: 0, syncing: 0.5, synced: 1 }
              return (order[a.sync_status] ?? 0) - (order[b.sync_status] ?? 0)
            }
            const order: Record<ProcessingStatus, number> = { unprocessed: 0, processing: 1, reanalyzing: 1.5, done: 2, failed: 3 }
            return (order[a.processed_status] ?? 0) - (order[b.processed_status] ?? 0)
          },
          defaultSortOrder: sortState.key === STATUS_KEY ? sortState.order : undefined,
          sortOrder: sortState.key === STATUS_KEY ? sortState.order : undefined,
          sortDirections: ['ascend', 'descend', 'ascend'],
          onHeaderCell: () =>
          ({
            width: getColCssVar(STATUS_KEY),
            minWidth: getMinWidth(STATUS_KEY),
            onResizeStart: startResize(STATUS_KEY),
          } as unknown as ResizableHeaderCellProps),
          render: (_, record) => {
            const badge = getStatusBadge(view, record.processed_status, record.sync_status, record.processed_error)
            // 状态文字着色：使用 AntD 预设颜色对应的 CSS 颜色，或者直接使用 style
            const colorMap: Record<string, string> = {
              blue: '#1677ff',
              orange: '#fa8c16',
              red: '#f5222d',
              green: '#52c41a',
              cyan: '#13c2c2',
              default: 'rgba(0, 0, 0, 0.45)',
            }
            const textColor =
              badge.color && colorMap[badge.color]
                ? colorMap[badge.color]
                : typeof badge.color === 'string' && badge.color.trim().length > 0
                  ? badge.color
                  : undefined
            return (
              <Badge
                status={badge.status}
                color={badge.color}
                text={<span style={{ color: textColor, fontWeight: 500 }}>{badge.text}</span>}
              />
            )
          },
        }
        : null

      return [titleCol, ...metaCols, ...analysisCols, ...(statusCol ? [statusCol] : [])]
    },
    [fixedWidthCols, getColCssVar, handleProgressChange, handleRatingChange, handleTitleClick, showStatus, sortState.key, sortState.order, startResize, titleOption?.label, view, visibleAnalysis, visibleMeta]
  )

  return (
    <div ref={containerRef} className="h-full min-h-0 flex flex-col" onContextMenu={handleContextMenu}>
      <ProTable<LiteratureItem>
        rowKey="item_key"
        dataSource={sortedData}
        columns={columns}
        size="small"
        search={false}
        toolBarRender={false}
        options={{
          density: true,
          fullScreen: false,
          setting: true,
          reload: onRefresh,
        }}
        pagination={{
          current: currentPage,
          pageSize,
          showSizeChanger: true,
          showQuickJumper: false,
          className: 'px-4 py-2',
          position: ['bottomCenter'],
          onChange: (page, nextPageSize) => {
            setCurrentPage(page)
            setPageSize(nextPageSize)
          },
          onShowSizeChange: (page, nextPageSize) => {
            setCurrentPage(page)
            setPageSize(nextPageSize)
          },
        }}
        rowSelection={{
          selectedRowKeys,
          onChange: (keys) => onSelectedRowKeysChange(keys),
          alwaysShowAlert: false,
        }}
        scroll={{ x: Math.max(containerWidth, tableMinWidth, currentTableWidth), y: tableScrollY }}
        components={{ header: { cell: ResizableHeaderCell } } as unknown as Record<string, unknown>}
        tableLayout="fixed"
        rowClassName={(record) => record.item_key === activeItemKey ? 'matrixit-row-active' : ''}
        className="matrixit-table h-full min-h-0 flex flex-col [&_.ant-pro-table-list-toolbar]:hidden [&_.ant-table-wrapper]:flex-1 [&_.ant-table-wrapper]:min-h-0 [&_.ant-table-wrapper]:flex [&_.ant-table-wrapper]:flex-col [&_.ant-spin-nested-loading]:flex-1 [&_.ant-spin-nested-loading]:min-h-0 [&_.ant-spin-nested-loading]:flex [&_.ant-spin-nested-loading]:flex-col [&_.ant-spin-container]:flex-1 [&_.ant-spin-container]:min-h-0 [&_.ant-spin-container]:flex [&_.ant-spin-container]:flex-col [&_.ant-table]:flex-1 [&_.ant-table]:min-h-0 [&_.ant-table]:flex [&_.ant-table]:flex-col [&_.ant-table-container]:flex-1 [&_.ant-table-container]:min-h-0 [&_.ant-table-container]:flex [&_.ant-table-container]:flex-col [&_.ant-table-body]:flex-1 [&_.ant-table-body]:min-h-0 [&_.ant-table-body]:overflow-auto [&_.ant-table-content]:overflow-auto [&_.ant-pagination]:mt-auto [&_.matrixit-row-active>td]:!bg-[#e6f7f6] [&_.matrixit-row-active>td:first-child]:!shadow-[inset_3px_0_0_0_var(--primary-color)]"
        tableAlertRender={false}
        onChange={(p, f, s) => {
          const sorter = Array.isArray(s) ? s[0] : s
          if (sorter && sorter.order) {
            setSortState({ key: String(sorter.field), order: sorter.order })
          }
        }}
      />
    </div>
  )
}
