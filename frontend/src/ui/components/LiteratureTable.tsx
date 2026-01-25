/**
 * 模块名称: 文献列表表格
 * 功能描述: 高度定制的 ProTable 组件，用于展示通过 Zotero 或 Matrix 分析后的文献列表。
 *           支持列宽调整、排序、自定义渲染（徽标、标签等）以及视图切换（Zotero模式/Matrix模式）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react'
import type { BadgeProps } from 'antd'
import { Badge } from 'antd'
import type { ProColumns } from '@ant-design/pro-components'
import { ProTable } from '@ant-design/pro-components'

import type { LiteratureItem, ProcessingStatus } from '../../types'

export type LiteratureTableView = 'zotero' | 'matrix'

export type LiteratureTableColumnOption = { key: string; label: string }

export type LiteratureTableProps = {
  data: LiteratureItem[]
  view: LiteratureTableView
  metaColumns: LiteratureTableColumnOption[]
  analysisColumns?: LiteratureTableColumnOption[]
  selectedRowKeys: React.Key[]
  onSelectedRowKeysChange: (keys: React.Key[]) => void
  onOpenDetail: (itemKey: string) => void
  onRefresh: () => void
  onPageRowsChange?: (rows: LiteratureItem[]) => void
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
  year: 110,
  type: 140,
  publications: 220,
  citation: 220,
  abstract: 260,
  doi: 160,
  url: 240,
  collections: 220,
  [STATUS_KEY]: 160,
}

const DEFAULT_MIN_WIDTH = 260

const getMinWidth = (key: string) => COLUMN_MIN_WIDTHS[key] ?? DEFAULT_MIN_WIDTH

const truncateText = (text: string, maxLen: number) => {
  const s = String(text ?? '').trim()
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen - 1) + '…'
}

/**
 * 辅助函数：生成状态徽标
 * 根据处理状态（ProcessingStatus）和同步状态（SyncStatus）生成对应的 Antd Badge 属性。
 */
const getStatusBadge = (
  processed: ProcessingStatus,
  sync: LiteratureItem['sync_status'],
  error?: string
): { status: BadgeProps['status']; text: string; color?: string } => {
  if (processed === 'processing') return { status: 'processing', text: '分析中', color: 'blue' }
  if (processed === 'reanalyzing') return { status: 'processing', text: '重新分析中', color: 'orange' }
  if (processed === 'failed') {
    const reason = typeof error === 'string' && error.trim().length > 0 ? truncateText(error, 24) : ''
    return { status: 'error', text: reason ? `失败 · ${reason}` : '失败', color: 'red' }
  }
  if (processed === 'done')
    return sync === 'synced'
      ? { status: 'success', text: '已完成 · 已同步', color: 'green' }
      : { status: 'success', text: '已完成', color: 'cyan' }
  return { status: 'default', text: '未处理', color: 'default' }
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

export function LiteratureTable({
  data,
  view,
  metaColumns,
  analysisColumns,
  selectedRowKeys,
  onSelectedRowKeysChange,
  onOpenDetail,
  onRefresh,
  onPageRowsChange,
}: LiteratureTableProps) {
  const showStatus = view === 'zotero'
  const fixedWidthCols = useMemo(() => (view === 'zotero' ? new Set(['author', 'year', 'type']) : new Set<string>()), [view])
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

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
      // 特殊处理状态列
      if (key === STATUS_KEY) {
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
  }, [data, sortState])

  useEffect(() => {
    if (!onPageRowsChange) return
    const start = Math.max(0, (currentPage - 1) * pageSize)
    const end = Math.max(start, start + pageSize)
    onPageRowsChange(sortedData.slice(start, end)) // Use sortedData here
  }, [currentPage, sortedData, onPageRowsChange, pageSize])

  const titleOption = useMemo(() => metaColumns.find((c) => c.key === TITLE_KEY) ?? null, [metaColumns])
  const visibleMeta = useMemo(() => metaColumns.filter((c) => c.key !== TITLE_KEY), [metaColumns])
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
    if (key === TITLE_KEY) return 3.2
    if (key === STATUS_KEY) return 2.0
    if (key === 'year') return 1.2
    if (key === 'type') return 1.4
    if (key === 'author') return 1.8
    if (key === 'publications') return 2.2
    if (key === 'citation') return 2.2
    if (key === 'abstract') return 3.2
    if (key === 'doi') return 1.6
    if (key === 'url') return 2.4
    if (key === 'collections') return 2.0
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
      for (const x of weights) out[x.key] = x.min + (extra * x.weight) / totalWeight
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
    if (view === 'zotero') {
      for (const k of fixedWidthCols) {
        if (!visibleKeys.includes(k)) continue
        merged[k] = getMinWidth(k)
      }
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
        sorter: (a, b) => (a.title || '').localeCompare(b.title || '', 'zh-Hans-CN'),
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
            {record.title || '（无标题）'}
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
          ellipsis: view !== 'matrix',
          width: getColCssVar(colKey),
          onCell: () => ({ style: { minWidth: getMinWidth(colKey), ...(wrapCellStyle ?? {}) } }),
          onHeaderCell: () =>
          ({
            width: getColCssVar(colKey),
            minWidth: getMinWidth(colKey),
            ...(fixedWidth ? {} : { onResizeStart: startResize(colKey) }),
          } as unknown as ResizableHeaderCellProps),
          sorter: (a, b) => {
            const av = (a as Record<string, unknown>)[colKey]
            const bv = (b as Record<string, unknown>)[colKey]
            return String(av ?? '').localeCompare(String(bv ?? ''), 'zh-Hans-CN')
          },
          defaultSortOrder: sortState.key === colKey ? sortState.order : undefined,
          sortOrder: sortState.key === colKey ? sortState.order : undefined,
          sortDirections: ['ascend', 'descend', 'ascend'],
          render: (_, record) => {
            const v = (record as Record<string, unknown>)[colKey]
            if (v === null || v === undefined || v === '') {
              if (colKey === 'key_word') {
                const metaExtra = (record as Record<string, unknown>).meta_extra
                const tags = metaExtra && typeof metaExtra === 'object' ? (metaExtra as Record<string, unknown>).tags : null
                if (Array.isArray(tags)) {
                  const s = tags.map((x) => String(x || '').trim()).filter(Boolean).join(', ')
                  if (s) return <span className="secondary-color">{s}</span>
                }
              }
              return <span className="secondary-color">-</span>
            }
            if (Array.isArray(v)) return <span className="secondary-color">{v.filter(Boolean).join(', ') || '-'}</span>
            if (typeof v === 'object') return <span className="secondary-color">{JSON.stringify(v)}</span>
            if (colKey === 'citation') return <span className="secondary-color">{String(v).replace(/^\[\d+\]\s*/, '')}</span>
            return <span className="secondary-color">{String(v)}</span>
          },
        } as ProColumns<LiteratureItem>
      }

      const metaCols = visibleMeta.map(buildValueColumn)
      const analysisCols = visibleAnalysis.map(buildValueColumn)

      const statusCol: ProColumns<LiteratureItem> | null = showStatus
        ? {
          key: STATUS_KEY,
          title: '状态',
          dataIndex: STATUS_KEY,
          width: getColCssVar(STATUS_KEY),
          onCell: () => ({ style: { minWidth: getMinWidth(STATUS_KEY) } }),
          fixed: 'right',
          sorter: (a, b) => {
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
            const badge = getStatusBadge(record.processed_status, record.sync_status, record.processed_error)
            return <Badge status={badge.status} text={badge.text} color={badge.color} />
          },
        }
        : null

      return [titleCol, ...metaCols, ...analysisCols, ...(statusCol ? [statusCol] : [])]
    },
    [fixedWidthCols, getColCssVar, handleTitleClick, showStatus, sortState.key, sortState.order, startResize, titleOption?.label, view, visibleAnalysis, visibleMeta]
  )

  return (
    <div ref={containerRef} className="h-full min-h-0 flex flex-col">
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
        className="matrixit-table h-full min-h-0 flex flex-col [&_.ant-pro-table-list-toolbar]:hidden [&_.ant-table-wrapper]:flex-1 [&_.ant-table-wrapper]:min-h-0 [&_.ant-table-wrapper]:flex [&_.ant-table-wrapper]:flex-col [&_.ant-spin-nested-loading]:flex-1 [&_.ant-spin-nested-loading]:min-h-0 [&_.ant-spin-nested-loading]:flex [&_.ant-spin-nested-loading]:flex-col [&_.ant-spin-container]:flex-1 [&_.ant-spin-container]:min-h-0 [&_.ant-spin-container]:flex [&_.ant-spin-container]:flex-col [&_.ant-table]:flex-1 [&_.ant-table]:min-h-0 [&_.ant-table]:flex [&_.ant-table]:flex-col [&_.ant-table-container]:flex-1 [&_.ant-table-container]:min-h-0 [&_.ant-table-container]:flex [&_.ant-table-container]:flex-col [&_.ant-table-body]:flex-1 [&_.ant-table-body]:min-h-0 [&_.ant-table-body]:overflow-auto [&_.ant-table-content]:overflow-auto [&_.ant-pagination]:mt-auto"
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
