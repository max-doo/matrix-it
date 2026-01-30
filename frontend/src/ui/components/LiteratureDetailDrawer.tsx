/**
 * 模块名称: 文献详情抽屉
 * 功能描述: 侧滑展示单篇文献的详细信息，包含“Zotero 原生信息”和“Matrix 矩阵分析”两种视图。
 *           支持在 Matrix 视图下编辑分析字段，并提供上下篇切换导航。
 */
import { CloseOutlined, LeftOutlined, ReadOutlined, RightOutlined } from '@ant-design/icons'
import { App, Button, Descriptions, Drawer, Space, Tag, Typography, Input, Tooltip, Dropdown } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { openExternal, openPath, openPdfInBrowser, resolvePdfPath } from '../../lib/backend'
import type { LiteratureItem } from '../../types'
import { formatAuthor, formatIF, getJournalTags, getLiteratureTypeMeta } from '../utils/ui-formatters'
import {
  RATING_OPTIONS,
  RATING_EMOJI_MAP,
  PROGRESS_OPTIONS,
  PROGRESS_EMOJI_MAP
} from '../utils/constants'

export type LiteratureDetailDrawerMode = 'zotero' | 'matrix'

export type LiteratureDetailDrawerProps = {
  item: LiteratureItem | null
  mode: LiteratureDetailDrawerMode
  pdfOpenMode?: 'local' | 'browser'
  analysisFieldDefs?: Record<string, unknown>
  analysisOrder?: string[]
  onSwitchMode?: (mode: LiteratureDetailDrawerMode) => void
  onClose: () => void
  onLeaveGuardChange?: (guard: (() => Promise<boolean>) | null) => void
  onSave?: (key: string, patch: Record<string, unknown>) => Promise<void>
  /** 乐观更新回调，用于局部更新 item 字段 */
  onItemPatch?: (itemKey: string, patch: Record<string, unknown>) => void
  citationState?: { loading: boolean; error?: string | null }
  onPrev?: () => void
  onNext?: () => void
  canPrev?: boolean
  canNext?: boolean
}

function toText(v: unknown): string {
  if (v === null || v === undefined) return ''
  return String(v)
}

export function LiteratureDetailDrawer({
  item,
  mode,
  pdfOpenMode = 'local',
  analysisFieldDefs,
  analysisOrder,
  onSwitchMode,
  onClose,
  onLeaveGuardChange,
  onSave,
  onItemPatch,
  citationState,
  onPrev,
  onNext,
  canPrev,
  canNext,
}: LiteratureDetailDrawerProps) {
  const { modal } = App.useApp()
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth))

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const drawerWidth = useMemo(() => {
    const minWidth = 480
    const maxWidth = 960
    const preferred = Math.round(viewportWidth * 0.5)
    const next = Math.min(maxWidth, Math.max(minWidth, preferred))
    return Math.min(next, viewportWidth)
  }, [viewportWidth])

  const metaExtra = useMemo(() => {
    const raw = (item as Record<string, unknown> | null)?.meta_extra
    return (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {}
  }, [item])

  // --- 数据准备 ---
  /**
   * 提取标签与集合信息
   * 将文献对象中的元数据（meta_extra）和集合（collections）解析为便于渲染的数组格式。
   */
  const tags = useMemo(() => {
    const raw = metaExtra.tags
    if (!Array.isArray(raw)) return []
    return raw.map((x) => String(x || '').trim()).filter(Boolean)
  }, [metaExtra.tags])

  const collections = useMemo(() => {
    const raw = (item as Record<string, unknown> | null)?.collections
    if (!Array.isArray(raw)) return []
    return raw
      .map((x) => (x && typeof x === 'object' ? (x as Record<string, unknown>) : null))
      .filter(Boolean)
      .map((c) => String((c as Record<string, unknown>).path ?? (c as Record<string, unknown>).name ?? '').trim())
      .filter(Boolean)
  }, [item])

  /**
   * 生成分析字段定义列表
   * 根据全局字段配置（analysisFieldDefs）和排序设置（analysisOrder），生成当前详情页需要展示/编辑的字段结构。
   */
  const analysisFields = useMemo(() => {
    if (mode !== 'matrix') return []
    const defs = (analysisFieldDefs ?? {}) as Record<string, unknown>
    const byKey = new Map(Object.keys(defs).map((k) => [k, (defs[k] ?? {}) as Record<string, unknown>] as const))
    const order = Array.isArray(analysisOrder) ? (analysisOrder as string[]) : []
    const keys = [
      ...order.map((k) => String(k || '').trim()).filter((k) => k.length > 0 && byKey.has(k)),
      ...Array.from(byKey.keys()).filter((k) => !order.includes(k)),
    ]
    return keys.map((key) => {
      const def = byKey.get(key) ?? {}
      const name =
        typeof def.name === 'string'
          ? def.name.trim()
          : typeof def.feishu_field === 'string'
            ? def.feishu_field.trim()
            : ''
      return {
        key,
        label: name.length > 0 ? name : key,
        type: typeof def.type === 'string' ? def.type : 'string',
      }
    })
  }, [analysisFieldDefs, analysisOrder, mode])

  const [draft, setDraft] = useState<Record<string, string>>({})
  const [snapshot, setSnapshot] = useState<Record<string, string>>({})
  const [isEditing, setIsEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!item) {
      setDraft({})
      setSnapshot({})
      setIsEditing(false)
      return
    }
    const it = item as Record<string, unknown>
    const next: Record<string, string> = {}
    for (const f of analysisFields) {
      const v = it[f.key]
      if (Array.isArray(v)) {
        const parts = v.map((x) => String(x || '').trim()).filter(Boolean)
        next[f.key] = f.type === 'multi_select' ? parts.join(', ') : parts.join('\n')
      } else {
        next[f.key] = toText(v)
      }
    }
    setDraft(next)
    setSnapshot(next)
    setIsEditing(false)
  }, [analysisFields, item])

  const canEdit = mode === 'matrix' && typeof onSave === 'function'

  useEffect(() => {
    if (mode !== 'matrix') setIsEditing(false)
  }, [mode])

  const normalizeTextValue = useCallback((v: string) => String(v ?? '').replace(/\r\n/g, '\n').trimEnd(), [])
  const normalizeMultiSelectValue = useCallback(
    (v: string) =>
      String(v ?? '')
        .replace(/\r\n/g, '\n')
        .split(/[,，;；]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(', '),
    []
  )

  // --- 编辑状态管理 ---
  /**
   * 脏检查（IsDirty）
   * 对比当前草稿（draft）与快照（snapshot，即打开时的状态或上次保存的状态），判断是否有未保存的更改。
   * 支持多选字段（逗号分隔字符串）的规范化对比。
   */
  const isDirty = useMemo(() => {
    if (!canEdit || !isEditing) return false
    for (const f of analysisFields) {
      const a = f.type === 'multi_select' ? normalizeMultiSelectValue(snapshot[f.key] ?? '') : normalizeTextValue(snapshot[f.key] ?? '')
      const b = f.type === 'multi_select' ? normalizeMultiSelectValue(draft[f.key] ?? '') : normalizeTextValue(draft[f.key] ?? '')
      if (a !== b) return true
    }
    return false
  }, [analysisFields, canEdit, draft, isEditing, normalizeMultiSelectValue, normalizeTextValue, snapshot])

  const confirmDiscardIfDirty = useCallback(async () => {
    if (!isDirty) return true
    return await new Promise<boolean>((resolve) => {
      modal.confirm({
        title: '放弃未保存更改？',
        content: '你在分析字段中有未保存的修改。',
        okText: '放弃更改',
        cancelText: '继续编辑',
        okButtonProps: { danger: true },
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      })
    })
  }, [isDirty, modal])

  useEffect(() => {
    if (!onLeaveGuardChange) return
    onLeaveGuardChange(confirmDiscardIfDirty)
    return () => onLeaveGuardChange(null)
  }, [confirmDiscardIfDirty, onLeaveGuardChange])

  /**
   * 保存操作
   * 计算 Diff（仅提交变更过的字段），调用 onSave 回调，更新快照。
   */
  const handleSave = useCallback(async () => {
    if (!item || !onSave) return
    const patch: Record<string, unknown> = {}
    for (const f of analysisFields) {
      const prev = f.type === 'multi_select' ? normalizeMultiSelectValue(snapshot[f.key] ?? '') : normalizeTextValue(snapshot[f.key] ?? '')
      const next = f.type === 'multi_select' ? normalizeMultiSelectValue(draft[f.key] ?? '') : normalizeTextValue(draft[f.key] ?? '')
      if (prev === next) continue
      if (f.type === 'multi_select') {
        patch[f.key] = next
          .split(/[,，;；]/)
          .map((s) => s.trim())
          .filter(Boolean)
        continue
      }
      patch[f.key] = next.trim()
    }
    if (Object.keys(patch).length === 0) {
      setIsEditing(false)
      return
    }
    setSaving(true)
    try {
      await onSave(item.item_key, patch)
      const nextSnapshot: Record<string, string> = { ...draft }
      for (const f of analysisFields) {
        nextSnapshot[f.key] = f.type === 'multi_select' ? normalizeMultiSelectValue(draft[f.key] ?? '') : normalizeTextValue(draft[f.key] ?? '')
      }
      setSnapshot(nextSnapshot)
      setDraft(nextSnapshot)
      setIsEditing(false)
    } catch {
      return
    } finally {
      setSaving(false)
    }
  }, [analysisFields, draft, item, normalizeMultiSelectValue, normalizeTextValue, onSave, snapshot])

  useEffect(() => {
    if (!canEdit || !isEditing) return
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (!e.ctrlKey && !e.metaKey) return
      if (key !== 's') return
      e.preventDefault()
      if (!saving) void handleSave()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [canEdit, handleSave, isEditing, saving])

  const itemKey = item?.item_key ?? ''
  const doi = toText((item as Record<string, unknown> | null)?.doi)
  const url = toText((item as Record<string, unknown> | null)?.url)
  const rawPdfPath = toText((item as Record<string, unknown> | null)?.pdf_path).trim()
  const attachments = useMemo(() => {
    const raw = (item as Record<string, unknown> | null)?.attachments
    if (!Array.isArray(raw)) return []
    return raw
  }, [item])
  const abstract = toText(
    (item as Record<string, unknown> | null)?.abstract ??
    (item as Record<string, unknown> | null)?.abstractNote ??
    metaExtra.abstract ??
    metaExtra.abstractNote
  )
  const citation = toText((item as Record<string, unknown> | null)?.citation).replace(/^\[\d+\]\s*/, '')
  const originalHref = useMemo(() => {
    const rawUrl = url.trim()
    if (rawUrl) return rawUrl
    const rawDoi = doi.trim()
    if (rawDoi) return `https://doi.org/${rawDoi}`
    return ''
  }, [doi, url])
  const hasPdfAttachment = useMemo(() => {
    if (rawPdfPath) return true
    return attachments.length > 0
  }, [attachments.length, rawPdfPath])
  const readOriginalDisabled = !hasPdfAttachment && !originalHref
  const citationUi = useMemo(() => {
    if (citationState?.loading) return { kind: 'loading' as const, text: '生成中...' }
    if (citationState?.error) return { kind: 'error' as const, text: `生成失败：${citationState.error}` }
    return { kind: 'ready' as const, text: citation || '-' }
  }, [citation, citationState?.error, citationState?.loading])

  const zoteroType = useMemo(() => {
    if (!item) return ''
    const it = item as Record<string, unknown>
    return toText(it.type ?? it.item_type).trim()
  }, [item])

  const llmBibType = useMemo(() => {
    if (!item) return ''
    const it = item as Record<string, unknown>
    const v = it.bib_type
    if (Array.isArray(v)) return v.map((x) => String(x || '').trim()).filter(Boolean).join(', ')
    return toText(v).trim()
  }, [item])

  const llmBibTypeDisplay = useMemo(() => {
    if (mode !== 'matrix' || !isEditing) return llmBibType
    const v = normalizeTextValue(draft.bib_type ?? '').trim()
    return v.length > 0 ? v : llmBibType
  }, [draft.bib_type, isEditing, llmBibType, mode, normalizeTextValue])

  const requestSwitchMode = useCallback(
    async (nextMode: LiteratureDetailDrawerMode) => {
      if (!onSwitchMode) return
      if (nextMode === mode) return
      if (await confirmDiscardIfDirty()) onSwitchMode(nextMode)
    },
    [confirmDiscardIfDirty, mode, onSwitchMode]
  )

  const requestClose = useCallback(async () => {
    if (await confirmDiscardIfDirty()) onClose()
  }, [confirmDiscardIfDirty, onClose])

  const requestPrev = useCallback(async () => {
    if (!onPrev) return
    if (await confirmDiscardIfDirty()) onPrev()
  }, [confirmDiscardIfDirty, onPrev])

  const requestNext = useCallback(async () => {
    if (!onNext) return
    if (await confirmDiscardIfDirty()) onNext()
  }, [confirmDiscardIfDirty, onNext])

  const handleOpenOriginal = useCallback(async () => {
    if (!item) return
    if (hasPdfAttachment) {
      try {
        if (itemKey) {
          const pdfPath = await resolvePdfPath(itemKey)
          if (pdfPath) {
            if (pdfOpenMode === 'browser') {
              let openErr: unknown = null
              try {
                const opened = await openPdfInBrowser(pdfPath)
                if (opened.opened) return
              } catch (e) {
                openErr = e
              }
              try {
                const opened = await openPath(pdfPath)
                if (opened.opened) return
              } catch (e) {
                modal.error({ title: '打开失败', content: e instanceof Error ? e.message : String(e) })
                return
              }
              modal.error({
                title: '打开失败',
                content: openErr instanceof Error ? openErr.message : '无法打开 PDF（系统未返回成功）。',
              })
              return
            }

            let openErr: unknown = null
            try {
              const opened = await openPath(pdfPath)
              if (opened.opened) return
            } catch (e) {
              openErr = e
            }
            try {
              const opened = await openPdfInBrowser(pdfPath)
              if (opened.opened) return
            } catch (e) {
              modal.error({ title: '打开失败', content: e instanceof Error ? e.message : String(e) })
              return
            }
            modal.error({
              title: '打开失败',
              content: openErr instanceof Error ? openErr.message : '无法打开 PDF（系统未返回成功）。',
            })
            return
          }
        }
        modal.error({ title: '打开失败', content: '没有解析到可用的 PDF 路径。' })
        return
      } catch (e) {
        modal.error({ title: '打开失败', content: e instanceof Error ? e.message : String(e) })
        return
      }
    }
    if (!originalHref) {
      modal.info({ title: '提示', content: '没有附件' })
      return
    }
    try {
      await openExternal(originalHref)
    } catch (e) {
      modal.error({ title: '打开失败', content: e instanceof Error ? e.message : String(e) })
    }
  }, [hasPdfAttachment, item, itemKey, modal, originalHref, pdfOpenMode])

  const readOriginalButton = (
    <Button icon={<ReadOutlined style={{ color: 'var(--primary-color)' }} />} onClick={() => void handleOpenOriginal()} disabled={readOriginalDisabled}>
      阅读原文
    </Button>
  )

  return (
    <Drawer
      title={null}
      placement="right"
      width={drawerWidth}
      onClose={requestClose}
      open={!!item}
      closable={false}
      mask={false}
      rootStyle={{ top: 42, height: 'calc(100% - 42px)' }}
      styles={{
        header: { display: 'none' },
        wrapper: { boxShadow: '-8px 0 24px rgba(0, 0, 0, 0.12)', height: '100%' },
      }}
    >
      {item ? (
        <div className="flex flex-col h-full min-h-0">
          <div className="sticky top-0 z-10 bg-white pb-3 pt-1 border-b border-slate-200 select-none">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <Button type="text" icon={<CloseOutlined />} onClick={requestClose} aria-label="关闭" />
                <Space.Compact>
                  <Button
                    type="text"
                    icon={<LeftOutlined />}
                    onClick={requestPrev}
                    disabled={!onPrev || canPrev === false}
                    aria-label="上一条"
                  />
                  <Button
                    type="text"
                    icon={<RightOutlined />}
                    onClick={requestNext}
                    disabled={!onNext || canNext === false}
                    aria-label="下一条"
                  />
                </Space.Compact>
              </div>
              <div className="flex items-center gap-2">
                {mode === 'zotero' && onSwitchMode ? (
                  <Button
                    onClick={() => requestSwitchMode('matrix')}
                    disabled={item.processed_status !== 'done'}
                    title={item.processed_status !== 'done' ? '该文献尚未完成矩阵分析' : ''}
                  >
                    {item.processed_status !== 'done' ? '未分析' : '查看矩阵分析'}
                  </Button>
                ) : null}
                {readOriginalDisabled ? (
                  <Tooltip title="没有附件">
                    <span className="inline-block">{readOriginalButton}</span>
                  </Tooltip>
                ) : (
                  readOriginalButton
                )}
                {canEdit ? (
                  <>
                    {isEditing ? (
                      <>
                        <Button
                          disabled={saving}
                          onClick={() => {
                            // 直接取消编辑，恢复快照，不需要确认弹窗
                            setDraft(snapshot)
                            setIsEditing(false)
                          }}
                        >
                          取消
                        </Button>
                        <Button type="primary" onClick={handleSave} loading={saving} disabled={!isDirty}>
                          保存
                        </Button>
                      </>
                    ) : (
                      <Button type="primary" onClick={() => setIsEditing(true)}>
                        编辑
                      </Button>
                    )}
                  </>
                ) : null}
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-auto flex flex-col gap-4 pt-3">
            {mode === 'matrix' ? (
              <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-2">
                  <Typography.Title level={5} className="!my-0 break-words text-slate-900 leading-snug">
                    {item.title || '详情'}
                  </Typography.Title>
                  <div className="text-sm text-slate-600 flex flex-wrap gap-x-2 gap-y-1">
                    <span>{formatAuthor(item.author) || '（未知作者）'}</span>
                    <span className="text-slate-400">·</span>
                    <span>{toText(item.year) || '（未知年份）'}</span>
                    <span className="text-slate-400">·</span>
                    <span>{toText((item as Record<string, unknown>).publications) || '（未知出版物）'}</span>
                    {(() => {
                      const metaExtra = (item as Record<string, unknown>).meta_extra as Record<string, unknown> | undefined
                      const jcrData = metaExtra && typeof metaExtra === 'object' ? (metaExtra as Record<string, unknown>).jcr : null
                      const ifValue = jcrData && typeof jcrData === 'object' ? (jcrData as Record<string, unknown>).impact_factor : null
                      if (ifValue !== null && ifValue !== undefined) {
                        const formatted = formatIF(ifValue)
                        return (
                          <>
                            <span className="text-slate-400">·</span>
                            <span style={{ color: formatted.color, fontWeight: 600 }}>{formatted.text}</span>
                          </>
                        )
                      }
                      return null
                    })()}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Rating Dropdown */}
                    {(() => {
                      const v = item.rating
                      const currentVal = String(v ?? '')
                      const emoji = RATING_EMOJI_MAP[currentVal]

                      const handleChange = (key: string) => {
                        if (onItemPatch && item.item_key) {
                          onItemPatch(item.item_key, { rating: key || null })
                        }
                      }

                      if (!emoji) {
                        return (
                          <Dropdown
                            menu={{
                              items: RATING_OPTIONS,
                              onClick: ({ key }) => handleChange(key),
                              disabled: !onItemPatch
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
                            onClick: ({ key }) => handleChange(key),
                            disabled: !onItemPatch
                          }}
                          trigger={['click']}
                        >
                          <span
                            className="cursor-pointer hover:opacity-80 select-none text-xl inline-flex items-center"
                          >
                            {emoji}
                          </span>
                        </Dropdown>
                      )
                    })()}

                    {/* Progress Dropdown */}
                    {(() => {
                      const v = item.progress
                      const currentVal = String(v ?? 'Unread')
                      const emoji = PROGRESS_EMOJI_MAP[currentVal] || PROGRESS_EMOJI_MAP['Unread']

                      const handleChange = (key: string) => {
                        if (onItemPatch && item.item_key) {
                          onItemPatch(item.item_key, { progress: key })
                        }
                      }

                      return (
                        <Dropdown
                          menu={{
                            items: PROGRESS_OPTIONS,
                            onClick: ({ key }) => handleChange(key),
                            disabled: !onItemPatch
                          }}
                          trigger={['click']}
                        >
                          <span
                            className="cursor-pointer hover:opacity-80 select-none text-xl inline-flex items-center"
                          >
                            {emoji}
                          </span>
                        </Dropdown>
                      )
                    })()}

                    {/* Journal Tags */}
                    {(() => {
                      const journalTags = getJournalTags(item as any)
                      if (journalTags.length > 0) {
                        return (
                          <>
                            {journalTags.map((tag, idx) => (
                              <Tag key={`${tag.type}-${idx}`} color={tag.color} bordered={false} className="m-0">{tag.label}</Tag>
                            ))}
                          </>
                        )
                      }
                      return null
                    })()}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-600">文献类型</span>
                    {(() => {
                      const meta = getLiteratureTypeMeta(zoteroType)
                      return (
                        <Tag color={meta.color} bordered={false} className="m-0 max-w-full !whitespace-normal break-words">
                          {meta.label}
                        </Tag>
                      )
                    })()}
                    <Tag color="cyan" className="m-0 max-w-full !whitespace-normal break-words">
                      {llmBibTypeDisplay || '-'}
                    </Tag>
                    {collections.length > 0 ? (
                      <>
                        <span className="text-sm font-medium text-slate-600">集合</span>
                        {collections.map((p) => (
                          <Tag key={p} className="m-0 max-w-full !whitespace-normal break-words">
                            {p}
                          </Tag>
                        ))}
                      </>
                    ) : null}
                  </div>
                  <div className="flex items-center pt-1">
                    <Button
                      type="link"
                      size="small"
                      className="px-0"
                      disabled={!onSwitchMode}
                      onClick={() => requestSwitchMode('zotero')}
                    >
                      查看详情&gt;&gt;
                    </Button>
                  </div>
                </div>

                <div className="h-px bg-slate-200" />

                {isEditing ? (
                  <div className="flex flex-col gap-4">
                    {analysisFields.map((f) => (
                      <Field
                        key={f.key}
                        label={f.label + (f.type === 'multi_select' ? '（逗号分隔）' : '')}
                        value={draft[f.key] ?? ''}
                        onChange={(v) => setDraft((d) => ({ ...d, [f.key]: v }))}
                        disabled={!canEdit || saving}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col gap-5">
                    {analysisFields
                      .filter((f) => f.key === 'tldr')
                      .map((f) => {
                        const v = toText((item as Record<string, unknown>)[f.key]).trim()
                        if (!v) return null
                        return (
                          <section key={f.key} className="flex flex-col gap-2">
                            <div className="flex items-center justify-between">
                              <div className="text-sm font-semibold text-slate-900">{f.label}</div>
                            </div>
                            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                              <div className="text-sm leading-6 text-slate-800 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{v}</div>
                            </div>
                          </section>
                        )
                      })}

                    {analysisFields
                      .filter((f) => f.key === 'key_word')
                      .map((f) => {
                        const raw = (item as Record<string, unknown>)[f.key]
                        const arr = Array.isArray(raw)
                          ? raw.map((x) => String(x || '').trim()).filter(Boolean)
                          : toText(raw)
                            .split(/[,，;；]/)
                            .map((s) => s.trim())
                            .filter(Boolean)
                        if (arr.length === 0) return null
                        return (
                          <section key={f.key} className="flex flex-col gap-2">
                            <div className="text-sm font-semibold text-slate-900">{f.label}</div>
                            <div className="flex flex-wrap gap-1 min-w-0">
                              {arr.map((t) => (
                                <Tag key={t} className="max-w-full !whitespace-normal break-words">
                                  {t}
                                </Tag>
                              ))}
                            </div>
                          </section>
                        )
                      })}

                    {analysisFields
                      .filter((f) => f.key !== 'tldr' && f.key !== 'key_word' && f.key !== 'bib_type')
                      .map((f) => {
                        const raw = (item as Record<string, unknown>)[f.key]
                        const v = Array.isArray(raw)
                          ? (() => {
                            const parts = raw.map((x) => String(x || '').trim()).filter(Boolean)
                            return f.type === 'multi_select' ? parts.join(', ') : parts.map((x) => `• ${x}`).join('\n')
                          })()
                          : toText(raw).trim()
                        if (!v) return null
                        return (
                          <section key={f.key} className="flex flex-col gap-2">
                            <div className="text-sm font-semibold text-slate-900">{f.label}</div>
                            <div className="text-sm leading-6 text-slate-800 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{v}</div>
                          </section>
                        )
                      })}
                  </div>
                )}
              </div>
            ) : (
              <>
                <Typography.Title level={5} className="!my-0 break-words text-slate-900">
                  {item.title || '详情'}
                </Typography.Title>

                <Descriptions
                  size="small"
                  column={1}
                  bordered
                  className="[&_.ant-descriptions-view>table]:table-fixed [&_.ant-descriptions-view>table]:w-full [&_.ant-descriptions-item-content]:min-w-0 [&_.ant-descriptions-item-content]:break-words [&_.ant-descriptions-item-content]:!whitespace-normal"
                >
                  <Descriptions.Item label="作者">{formatAuthor(item.author) || '-'}</Descriptions.Item>
                  <Descriptions.Item label="年份">{toText(item.year) || '-'}</Descriptions.Item>
                  <Descriptions.Item label="类型">
                    {(() => {
                      const meta = getLiteratureTypeMeta(zoteroType)
                      return <Tag color={meta.color} bordered={false}>{meta.label}</Tag>
                    })()}
                  </Descriptions.Item>
                  <Descriptions.Item label="出版物">{toText((item as Record<string, unknown>).publications)}</Descriptions.Item>
                  <Descriptions.Item label="影响因子">
                    {(() => {
                      const metaExtra = (item as Record<string, unknown>).meta_extra as Record<string, unknown> | undefined
                      const jcrData = metaExtra && typeof metaExtra === 'object' ? (metaExtra as Record<string, unknown>).jcr : null
                      const ifValue = jcrData && typeof jcrData === 'object' ? (jcrData as Record<string, unknown>).impact_factor : null
                      if (ifValue !== null && ifValue !== undefined) {
                        const formatted = formatIF(ifValue)
                        return <span style={{ color: formatted.color, fontWeight: 600 }}>{formatted.text}</span>
                      }
                      return <span className="secondary-color">-</span>
                    })()}
                  </Descriptions.Item>
                  <Descriptions.Item label="期刊标签">
                    {(() => {
                      const journalTags = getJournalTags(item as any)
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
                    })()}
                  </Descriptions.Item>
                  <Descriptions.Item label="评分">
                    {(() => {
                      const v = item.rating
                      const currentVal = String(v ?? '')
                      const emoji = RATING_EMOJI_MAP[currentVal]

                      const handleChange = (key: string) => {
                        if (onItemPatch && item.item_key) {
                          onItemPatch(item.item_key, { rating: key || null })
                        }
                      }

                      if (!emoji) {
                        return (
                          <Dropdown
                            menu={{
                              items: RATING_OPTIONS,
                              onClick: ({ key }) => handleChange(key),
                              disabled: !onItemPatch
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
                            onClick: ({ key }) => handleChange(key),
                            disabled: !onItemPatch
                          }}
                          trigger={['click']}
                        >
                          <span
                            className="cursor-pointer hover:opacity-80 select-none text-xl inline-flex items-center"
                          >
                            {emoji}
                          </span>
                        </Dropdown>
                      )
                    })()}
                  </Descriptions.Item>
                  <Descriptions.Item label="进度">
                    {(() => {
                      const v = item.progress
                      const currentVal = String(v ?? 'Unread')
                      const emoji = PROGRESS_EMOJI_MAP[currentVal] || PROGRESS_EMOJI_MAP['Unread']

                      const handleChange = (key: string) => {
                        if (onItemPatch && item.item_key) {
                          onItemPatch(item.item_key, { progress: key })
                        }
                      }

                      return (
                        <Dropdown
                          menu={{
                            items: PROGRESS_OPTIONS,
                            onClick: ({ key }) => handleChange(key),
                            disabled: !onItemPatch
                          }}
                          trigger={['click']}
                        >
                          <span
                            className="cursor-pointer hover:opacity-80 select-none text-xl inline-flex items-center"
                          >
                            {emoji}
                          </span>
                        </Dropdown>
                      )
                    })()}
                  </Descriptions.Item>
                  <Descriptions.Item label="摘要">
                    {abstract ? <div className="break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{abstract}</div> : <span className="secondary-color">-</span>}
                  </Descriptions.Item>
                  <Descriptions.Item label="Zotero 标签">
                    {tags.length > 0 ? (
                      <div className="flex flex-wrap gap-1 min-w-0">
                        {tags.map((t) => (
                          <Tag key={t} className="max-w-full !whitespace-normal break-words">
                            {t}
                          </Tag>
                        ))}
                      </div>
                    ) : (
                      <span className="secondary-color">-</span>
                    )}
                  </Descriptions.Item>
                  <Descriptions.Item label="集合">
                    {collections.length > 0 ? (
                      <div className="flex flex-wrap gap-1 min-w-0">
                        {collections.map((p) => (
                          <Tag key={p} className="max-w-full !whitespace-normal break-words">
                            {p}
                          </Tag>
                        ))}
                      </div>
                    ) : (
                      <span className="secondary-color">-</span>
                    )}
                  </Descriptions.Item>
                  <Descriptions.Item label="日期">{toText(metaExtra.date)}</Descriptions.Item>
                  <Descriptions.Item label="卷/期/页">
                    {[toText(metaExtra.volume), toText(metaExtra.issue), toText(metaExtra.pages)].filter(Boolean).join(' / ') || '-'}
                  </Descriptions.Item>
                  <Descriptions.Item label="出版社/机构">{toText(metaExtra.publisher)}</Descriptions.Item>
                  <Descriptions.Item label="地点">{toText(metaExtra.place)}</Descriptions.Item>
                  <Descriptions.Item label="DOI">
                    {doi ? (
                      <Typography.Link
                        className="break-all"
                        href={`https://doi.org/${doi}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => {
                          e.preventDefault()
                          openExternal(`https://doi.org/${doi}`).catch(() => { })
                        }}
                      >
                        {doi}
                      </Typography.Link>
                    ) : (
                      <span className="secondary-color">-</span>
                    )}
                  </Descriptions.Item>
                  <Descriptions.Item label="URL">
                    {url ? (
                      <Typography.Link
                        className="break-all"
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => {
                          e.preventDefault()
                          openExternal(url).catch(() => { })
                        }}
                      >
                        {url}
                      </Typography.Link>
                    ) : (
                      <span className="secondary-color">-</span>
                    )}
                  </Descriptions.Item>
                  <Descriptions.Item label="访问日期">{toText(metaExtra.accessDate) || '-'}</Descriptions.Item>
                  <Descriptions.Item label="引用（GB/T 7714）">
                    {citationUi.kind === 'error' ? (
                      <span className="text-xs text-red-500">{citationUi.text}</span>
                    ) : citationUi.kind === 'loading' ? (
                      <span className="secondary-color">{citationUi.text}</span>
                    ) : (
                      <div className="break-words whitespace-pre-wrap [overflow-wrap:anywhere]">{citationUi.text}</div>
                    )}
                  </Descriptions.Item>

                </Descriptions>
              </>
            )}
          </div>
        </div>
      ) : null}
    </Drawer>
  )
}

function Field({ label, value, onChange, disabled }: { label: string; value: string; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium text-slate-700">{label}</label>
      <Input.TextArea
        className="!border-slate-200 focus:!border-[#0abab5] min-h-[96px] disabled:bg-slate-50 disabled:text-slate-500"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoSize
      />
    </div>
  )
}
