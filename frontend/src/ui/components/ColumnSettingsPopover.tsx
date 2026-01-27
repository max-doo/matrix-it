/**
 * 模块名称: 列设置气泡弹窗
 * 功能描述: 允许用户通过拖拽排序、显示/隐藏来配置表格列（元数据列和分析字段列）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Popover } from 'antd'
import { BarsOutlined, EyeInvisibleOutlined, EyeOutlined, HolderOutlined } from '@ant-design/icons'
import { DEFAULT_META_COLUMN_ORDER } from '../defaults/metaColumnOrder'

export type ColumnPanelGroup = 'meta' | 'analysis'

export type ColumnPanelState = {
  keys: string[]
  hidden: Set<string>
  allKeys: string[]
}

export type ColumnSettingsPopoverProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  activeView: 'zotero' | 'matrix'
  metaPanel: ColumnPanelState
  analysisPanel: ColumnPanelState
  metaFieldDefs: Record<string, unknown>
  analysisFieldDefs: Record<string, unknown>
  matrixAnalysisSettingsOrder: string[]
  getFieldName: (defs: Record<string, unknown>, key: string) => string
  applyMetaPanelChange: (nextKeys: string[], nextHidden: Set<string>) => Promise<void>
  applyAnalysisPanelChange: (nextKeys: string[], nextHidden: Set<string>) => Promise<void>
}

export function ColumnSettingsPopover({
  open,
  onOpenChange,
  activeView,
  metaPanel,
  analysisPanel,
  metaFieldDefs,
  analysisFieldDefs,
  matrixAnalysisSettingsOrder,
  getFieldName,
  applyMetaPanelChange,
  applyAnalysisPanelChange,
}: ColumnSettingsPopoverProps) {
  const dragRef = useRef<{ group: ColumnPanelGroup; key: string } | null>(null)
  const [draftKeys, setDraftKeys] = useState<{ meta: string[] | null; analysis: string[] | null }>({ meta: null, analysis: null })
  const draftKeysRef = useRef<{ meta: string[] | null; analysis: string[] | null }>({ meta: null, analysis: null })
  const scrollElRef = useRef<HTMLDivElement | null>(null)
  const openRef = useRef(false)

  const [dragUi, setDragUi] = useState<{
    dragging: { group: ColumnPanelGroup; key: string } | null
    over: { group: ColumnPanelGroup; key: string } | null
  }>({ dragging: null, over: null })

  useEffect(() => {
    draftKeysRef.current = draftKeys
  }, [draftKeys])

  useEffect(() => {
    if (open && !openRef.current) {
      setDraftKeys({ meta: metaPanel.keys, analysis: analysisPanel.keys })
    }
    if (!open && openRef.current) {
      setDraftKeys({ meta: null, analysis: null })
      dragRef.current = null
      setDragUi({ dragging: null, over: null })
    }
    openRef.current = open
  }, [analysisPanel.keys, metaPanel.keys, open])

  const reorderKeys = useCallback((keys: string[], fromKey: string, toKey: string) => {
    if (fromKey === toKey) return keys
    const fromIdx = keys.indexOf(fromKey)
    const toIdx = keys.indexOf(toKey)
    if (fromIdx < 0 || toIdx < 0) return keys
    const next = [...keys]
    next.splice(fromIdx, 1)
    next.splice(toIdx, 0, fromKey)
    return next
  }, [])

  const currentMetaKeys = useMemo(() => draftKeys.meta ?? metaPanel.keys, [draftKeys.meta, metaPanel.keys])
  const currentAnalysisKeys = useMemo(() => draftKeys.analysis ?? analysisPanel.keys, [analysisPanel.keys, draftKeys.analysis])

  const resetMetaDefaults = useCallback(async () => {
    const allKeys = metaPanel.allKeys
    const ordered = DEFAULT_META_COLUMN_ORDER.filter((k) => allKeys.includes(k) && k !== 'title')
    const rest = allKeys.filter((k) => k !== 'title' && !ordered.includes(k))
    const nextKeys = [...ordered, ...rest]
    setDraftKeys((prev) => ({ ...prev, meta: nextKeys }))
    await applyMetaPanelChange(nextKeys, new Set())
  }, [applyMetaPanelChange, metaPanel.allKeys])

  const resetAnalysisDefaults = useCallback(async () => {
    const allKeys = analysisPanel.allKeys
    const ordered = matrixAnalysisSettingsOrder.filter((k) => allKeys.includes(k))
    const rest = allKeys.filter((k) => !ordered.includes(k))
    const nextKeys = [...ordered, ...rest]
    setDraftKeys((prev) => ({ ...prev, analysis: nextKeys }))
    await applyAnalysisPanelChange(nextKeys, new Set())
  }, [analysisPanel.allKeys, applyAnalysisPanelChange, matrixAnalysisSettingsOrder])

  const startDrag = useCallback(
    (group: ColumnPanelGroup, key: string) => (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()

      dragRef.current = { group, key }
      setDragUi({ dragging: { group, key }, over: { group, key } })
      const prevCursor = document.body.style.cursor
      const prevUserSelect = document.body.style.userSelect
      document.body.style.cursor = 'grabbing'
      document.body.style.userSelect = 'none'

      const onMove = (evt: MouseEvent) => {
        const target = document.elementFromPoint(evt.clientX, evt.clientY) as HTMLElement | null
        const itemEl = target?.closest('[data-column-drag-item]') as HTMLElement | null
        const raw = itemEl?.getAttribute('data-column-drag-item') ?? ''
        const [g, toKey] = raw.split(':')
        if ((g !== 'meta' && g !== 'analysis') || !toKey) return
        const from = dragRef.current
        if (!from || from.group !== g || from.key === toKey) return

        setDragUi((prev) => {
          if (prev.over?.group === g && prev.over.key === toKey && prev.dragging?.group === from.group && prev.dragging.key === from.key) return prev
          return { dragging: prev.dragging ?? from, over: { group: g, key: toKey } }
        })

        if (g === 'meta') {
          setDraftKeys((prev) => ({ ...prev, meta: reorderKeys(prev.meta ?? metaPanel.keys, from.key, toKey) }))
        } else {
          setDraftKeys((prev) => ({ ...prev, analysis: reorderKeys(prev.analysis ?? analysisPanel.keys, from.key, toKey) }))
        }

        const scrollEl = scrollElRef.current
        if (scrollEl) {
          const rect = scrollEl.getBoundingClientRect()
          const edge = 18
          if (evt.clientY < rect.top + edge) scrollEl.scrollTop -= 14
          else if (evt.clientY > rect.bottom - edge) scrollEl.scrollTop += 14
        }
      }

      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = prevCursor
        document.body.style.userSelect = prevUserSelect

        const from = dragRef.current
        dragRef.current = null
        setDragUi({ dragging: null, over: null })
        if (!from) return

        void (async () => {
          if (from.group === 'meta') {
            const keys = draftKeysRef.current.meta ?? metaPanel.keys
            await applyMetaPanelChange(keys, new Set(metaPanel.hidden))
          } else {
            const keys = draftKeysRef.current.analysis ?? analysisPanel.keys
            await applyAnalysisPanelChange(keys, new Set(analysisPanel.hidden))
          }
        })()
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [analysisPanel.hidden, analysisPanel.keys, applyAnalysisPanelChange, applyMetaPanelChange, metaPanel.hidden, metaPanel.keys, reorderKeys]
  )

  const content = (
    <div
      ref={scrollElRef}
      data-tauri-drag-region="false"
      className="w-56 max-w-[calc(100vw-32px)] max-h-[70vh] overflow-auto custom-scrollbar p-1"
    >
      <div className="flex items-center justify-between gap-2 text-xs secondary-color mb-2 px-1">
        <span>元数据字段</span>
        <Button type="link" size="small" onClick={resetMetaDefaults}>
          恢复默认
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        {currentMetaKeys.map((k) => {
          const hidden = metaPanel.hidden.has(k)
          const metaDragging = dragUi.dragging?.group === 'meta' ? dragUi.dragging : null
          const metaOver = dragUi.over?.group === 'meta' ? dragUi.over : null
          const isDragging = metaDragging?.key === k
          const isOver = !!metaDragging && metaOver?.key === k && metaDragging.key !== k
          return (
            <div
              key={`meta:${k}`}
              data-column-drag-item={`meta:${k}`}
              onMouseDown={startDrag('meta', k)}
              className={[
                'flex items-center justify-between gap-2 rounded-md border px-2 py-1 bg-white select-none transition-colors',
                isDragging ? 'border-teal-300 bg-teal-50/40 ring-2 ring-teal-200 opacity-70' : 'border-slate-200',
                isOver ? 'border-slate-400 bg-slate-50 ring-2 ring-slate-200' : '',
              ].join(' ')}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="inline-flex cursor-grab active:cursor-grabbing">
                  <HolderOutlined className={isDragging ? 'text-teal-500' : 'text-slate-400'} />
                </span>
                <span className="text-sm truncate">{getFieldName(metaFieldDefs, k)}</span>
              </div>
              <Button
                type="text"
                size="small"
                aria-label={hidden ? '显示字段' : '隐藏字段'}
                icon={hidden ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onClick={async (e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  const nextHidden = new Set(metaPanel.hidden)
                  if (nextHidden.has(k)) nextHidden.delete(k)
                  else nextHidden.add(k)
                  await applyMetaPanelChange(draftKeysRef.current.meta ?? currentMetaKeys, nextHidden)
                }}
              />
            </div>
          )
        })}
      </div>

      {activeView === 'matrix' ? (
        <>
          <div className="h-px bg-slate-100 my-3" />
          <div className="flex items-center justify-between gap-2 text-xs secondary-color mb-2 px-1">
            <span>分析字段</span>
            <Button type="link" size="small" onClick={resetAnalysisDefaults}>
              恢复默认
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            {currentAnalysisKeys.map((k) => {
              const hidden = analysisPanel.hidden.has(k)
              const analysisDragging = dragUi.dragging?.group === 'analysis' ? dragUi.dragging : null
              const analysisOver = dragUi.over?.group === 'analysis' ? dragUi.over : null
              const isDragging = analysisDragging?.key === k
              const isOver = !!analysisDragging && analysisOver?.key === k && analysisDragging.key !== k
              return (
                <div
                  key={`analysis:${k}`}
                  data-column-drag-item={`analysis:${k}`}
                  onMouseDown={startDrag('analysis', k)}
                  className={[
                    'flex items-center justify-between gap-2 rounded-md border px-2 py-1 bg-white select-none transition-colors',
                    isDragging ? 'border-teal-300 bg-teal-50/40 ring-2 ring-teal-200 opacity-70' : 'border-slate-200',
                    isOver ? 'border-slate-400 bg-slate-50 ring-2 ring-slate-200' : '',
                  ].join(' ')}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="inline-flex cursor-grab active:cursor-grabbing">
                      <HolderOutlined className={isDragging ? 'text-teal-500' : 'text-slate-400'} />
                    </span>
                    <span className="text-sm truncate">{getFieldName(analysisFieldDefs, k)}</span>
                  </div>
                  <Button
                    type="text"
                    size="small"
                    aria-label={hidden ? '显示字段' : '隐藏字段'}
                    icon={hidden ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                    }}
                    onClick={async (e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      const nextHidden = new Set(analysisPanel.hidden)
                      if (nextHidden.has(k)) nextHidden.delete(k)
                      else nextHidden.add(k)
                      await applyAnalysisPanelChange(draftKeysRef.current.analysis ?? currentAnalysisKeys, nextHidden)
                    }}
                  />
                </div>
              )
            })}
          </div>
        </>
      ) : null}
    </div>
  )

  return (
    <Popover trigger="click" placement="bottomRight" open={open} onOpenChange={onOpenChange} content={content}>
      <Button key="columns" icon={<BarsOutlined />} aria-label="字段设置" title="字段设置" />
    </Popover>
  )
}
