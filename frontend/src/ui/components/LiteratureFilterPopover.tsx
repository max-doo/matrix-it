/**
 * 模块名称: 文献高级筛选器
 * 功能描述: 提供多维度的文献筛选功能，包括状态、年份、文献类型、出版物等条件的组合筛选。
 */
import { useCallback, useMemo } from 'react'
import { Button, Input, Popover, Select, Tag } from 'antd'
import { getLiteratureTypeMeta } from '../utils/ui-formatters'
import { FilterOutlined } from '@ant-design/icons'
import type { FilterMode } from '../../types'
import { RATING_OPTIONS, PROGRESS_OPTIONS } from '../utils/constants'

type MatchMode = 'all' | 'any'

export type YearOperator = 'eq' | 'gt' | 'lt'

export type LiteratureFilterPopoverValue = {
  statusMode: FilterMode
  match: MatchMode
  yearOp: YearOperator
  year: string
  type: string[]
  publications: string
  tags?: string[]
  keywords?: string[]
  bibType?: string
  rating?: string
  progress?: string
}

export type LiteratureFilterPopoverProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  disabled?: boolean
  themePrimaryColor: string
  value: LiteratureFilterPopoverValue
  onChange: (next: LiteratureFilterPopoverValue) => void
  yearOptions: { value: string; label: string }[]
  typeOptions: { value: string; label: string }[]
  tagOptions?: { value: string; label: string }[]
  keywordOptions?: { value: string; label: string }[]
  bibTypeOptions?: { value: string; label: string }[]
  hideStatus?: boolean
}

const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
  const raw = hex.trim().replace('#', '')
  const normalized = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw
  if (normalized.length !== 6) return null
  const n = Number.parseInt(normalized, 16)
  if (!Number.isFinite(n)) return null
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function LiteratureFilterPopover({
  open,
  onOpenChange,
  disabled,
  themePrimaryColor,
  value,
  onChange,
  yearOptions,
  typeOptions,
  tagOptions = [],
  keywordOptions = [],
  bibTypeOptions = [],
  hideStatus,
}: LiteratureFilterPopoverProps) {
  const hasActiveFilters = useMemo(() => {
    if (disabled) return false
    const tags = value.tags ?? []
    const keywords = value.keywords ?? []
    const bibType = value.bibType ?? ''
    const rating = value.rating ?? ''
    const progress = value.progress ?? ''
    return (
      (value.statusMode !== 'all' && !hideStatus) ||
      value.year.trim().length > 0 ||
      value.type.length > 0 ||
      value.publications.trim().length > 0 ||
      tags.length > 0 ||
      keywords.length > 0 ||
      bibType.trim().length > 0 ||
      rating.length > 0 ||
      progress.length > 0
    )
  }, [disabled, value.publications, value.statusMode, value.type, value.year, value.tags, value.keywords, value.bibType, value.rating, value.progress, hideStatus])

  const activeButtonStyle = useMemo(() => {
    if (!hasActiveFilters) return undefined
    const rgb = hexToRgb(themePrimaryColor)
    if (!rgb) return { backgroundColor: '#f0fdfa', borderColor: '#99f6e4', color: themePrimaryColor } satisfies React.CSSProperties
    return {
      backgroundColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.12)`,
      borderColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.35)`,
      color: themePrimaryColor,
    } satisfies React.CSSProperties
  }, [hasActiveFilters, themePrimaryColor])

  const update = useCallback(
    (patch: Partial<LiteratureFilterPopoverValue>) => {
      onChange({ ...value, ...patch })
    },
    [onChange, value]
  )

  const content = (
    <div data-tauri-drag-region="false" className="w-[320px] max-w-[calc(100vw-32px)]">
      <div className="flex items-center justify-between px-1">
        <div className="text-sm font-medium">设置筛选条件</div>
        <div className="flex items-center gap-2 text-sm secondary-color">
          <span>符合以下</span>
          <Select
            size="small"
            value={value.match}
            onChange={(v) => update({ match: v })}
            options={[
              { value: 'all', label: '所有' },
              { value: 'any', label: '任一' },
            ]}
          />
          <span>条件</span>
        </div>
      </div>

      <div className="mt-3 px-1">
        <div className="max-h-[52vh] overflow-auto custom-scrollbar flex flex-col gap-1">
          {/* 状态筛选：仅在 hideStatus 为 false 时显示 */}
          {!hideStatus && (
            <div className="grid grid-cols-[56px_54px_minmax(160px,1fr)] items-center gap-x-1 gap-y-1">
              <div className="h-8 flex items-center justify-end pr-1 text-sm text-slate-700 select-none">状态</div>
              <div className="h-8 flex items-center justify-center text-sm text-slate-700 select-none">=</div>
              <Select
                value={value.statusMode}
                onChange={(v) => update({ statusMode: v })}
                className="w-full"
                options={[
                  { value: 'all', label: '全部' },
                  { value: 'unprocessed', label: '未分析' },
                  { value: 'processed', label: '已分析' },
                ]}
              />
            </div>
          )}

          <div className="grid grid-cols-[56px_54px_minmax(160px,1fr)] items-center gap-x-1 gap-y-1">
            <div className="h-8 flex items-center justify-end pr-1 text-sm text-slate-700 select-none">年份</div>
            <Select
              value={value.yearOp}
              onChange={(v) => update({ yearOp: v as YearOperator })}
              className="w-full [&_.ant-select-selector]:px-0 [&_.ant-select-selection-item]:text-center"
              options={[
                { value: 'eq', label: '=' },
                { value: 'gt', label: '>' },
                { value: 'lt', label: '<' },
              ]}
            />
            <Select
              allowClear
              value={value.year || undefined}
              onChange={(v) => update({ year: String(v ?? '') })}
              className="w-full"
              placeholder="请选择"
              options={yearOptions}
            />
          </div>

          <div className="grid grid-cols-[56px_54px_minmax(160px,1fr)] items-center gap-x-1 gap-y-1">
            <div className="h-8 flex items-center justify-end pr-1 text-sm text-slate-700 select-none">类型</div>
            <div className="h-8 flex items-center justify-center text-sm text-slate-700 select-none">∈</div>
            <Select
              mode="multiple"
              allowClear
              maxTagCount="responsive"
              value={value.type}
              onChange={(v) => update({ type: v })}
              className="w-full"
              placeholder="请选择"
              options={typeOptions.map(opt => {
                const meta = getLiteratureTypeMeta(opt.value)
                return {
                  value: opt.value,
                  label: <Tag color={meta.color} bordered={false} className="m-0 !whitespace-normal">{meta.label}</Tag>
                }
              })}
            />
          </div>

          <div className="grid grid-cols-[56px_54px_minmax(160px,1fr)] items-center gap-x-1 gap-y-1">
            <div className="h-8 flex items-center justify-end pr-1 text-sm text-slate-700 select-none">出版物</div>
            <div className="h-8 flex items-center justify-center text-sm text-slate-700 select-none">=</div>
            <Input
              allowClear
              value={value.publications}
              placeholder="请输入（模糊匹配）"
              onChange={(e) => update({ publications: e.target.value })}
            />
          </div>

          <div className="grid grid-cols-[56px_54px_minmax(160px,1fr)] items-center gap-x-1 gap-y-1">
            <div className="h-8 flex items-center justify-end pr-1 text-sm text-slate-700 select-none">评分</div>
            <div className="h-8 flex items-center justify-center text-sm text-slate-700 select-none">=</div>
            <Select
              allowClear
              value={value.rating || undefined}
              onChange={(v) => update({ rating: String(v ?? '') })}
              className="w-full"
              placeholder="请选择"
              options={RATING_OPTIONS.map(opt => ({ value: opt.key, label: opt.label }))}
            />
          </div>

          <div className="grid grid-cols-[56px_54px_minmax(160px,1fr)] items-center gap-x-1 gap-y-1">
            <div className="h-8 flex items-center justify-end pr-1 text-sm text-slate-700 select-none">进度</div>
            <div className="h-8 flex items-center justify-center text-sm text-slate-700 select-none">=</div>
            <Select
              allowClear
              value={value.progress || undefined}
              onChange={(v) => update({ progress: String(v ?? '') })}
              className="w-full"
              placeholder="请选择"
              options={PROGRESS_OPTIONS.map(opt => ({ value: opt.key, label: opt.label }))}
            />
          </div>

          {/* 标签筛选：仅在 Zotero 视图（hideStatus=false）显示 */}
          {!hideStatus && (
            <div className="grid grid-cols-[56px_54px_minmax(160px,1fr)] items-center gap-x-1 gap-y-1">
              <div className="h-8 flex items-center justify-end pr-1 text-sm text-slate-700 select-none">标签</div>
              <div className="h-8 flex items-center justify-center text-sm text-slate-700 select-none">∈</div>
              <Select
                mode="multiple"
                allowClear
                maxTagCount="responsive"
                value={value.tags ?? []}
                onChange={(v) => update({ tags: v })}
                className="w-full"
                placeholder="请选择"
                options={tagOptions}
              />
            </div>
          )}

          {/* 关键词筛选：仅在 Matrix 视图（hideStatus=true）显示 */}
          {hideStatus && (
            <>
              {/* 解析类型筛选 */}
              <div className="grid grid-cols-[56px_54px_minmax(160px,1fr)] items-center gap-x-1 gap-y-1">
                <div className="h-8 flex items-center justify-end pr-1 text-sm text-slate-700 select-none">类型2</div>
                <div className="h-8 flex items-center justify-center text-sm text-slate-700 select-none">=</div>
                <Select
                  allowClear
                  value={value.bibType || undefined}
                  onChange={(v) => update({ bibType: String(v ?? '') })}
                  className="w-full"
                  placeholder="请选择"
                  options={bibTypeOptions.map(opt => {
                    const meta = getLiteratureTypeMeta(opt.value)
                    return {
                      value: opt.value,
                      label: <Tag color={meta.color} bordered={false} className="m-0 !whitespace-normal">{meta.label}</Tag>
                    }
                  })}
                />
              </div>

              {/* 关键词筛选 */}
              <div className="grid grid-cols-[56px_54px_minmax(160px,1fr)] items-center gap-x-1 gap-y-1">
                <div className="h-8 flex items-center justify-end pr-1 text-sm text-slate-700 select-none">关键词</div>
                <div className="h-8 flex items-center justify-center text-sm text-slate-700 select-none">∈</div>
                <Select
                  mode="multiple"
                  allowClear
                  maxTagCount="responsive"
                  value={value.keywords ?? []}
                  onChange={(v) => update({ keywords: v })}
                  className="w-full"
                  placeholder="请选择"
                  options={keywordOptions}
                />
              </div>
            </>
          )}
        </div>

        <div className="mt-2 flex items-center justify-end">
          <Button
            type="text"
            onClick={() =>
              onChange({
                statusMode: 'all',
                match: 'all',
                yearOp: 'eq',
                year: '',
                type: [],
                publications: '',
                tags: [],
                keywords: [],
                bibType: '',
                rating: '',
                progress: '',
              })
            }
          >
            清空
          </Button>
        </div>
      </div>
    </div>
  )

  return (
    <Popover trigger="click" placement="bottomRight" open={open} onOpenChange={onOpenChange} content={content}>
      <Button
        icon={<FilterOutlined />}
        aria-label="筛选"
        title="筛选"
        style={activeButtonStyle}
        disabled={disabled}
      />
    </Popover>
  )
}
