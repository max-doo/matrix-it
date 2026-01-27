import { useMemo } from 'react'
import { Button, Input, Popover, Space } from 'antd'
import type { CSSProperties, MutableRefObject } from 'react'
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  LoadingOutlined,
  PlayCircleOutlined,
  SearchOutlined,
  StopOutlined,
} from '@ant-design/icons'
import type { FilterMode } from '../../types'
import type { FieldFilterState } from '../hooks/useFilterState'
import type { LiteratureTableView } from './LiteratureTable'
import { ColumnSettingsPopover } from './ColumnSettingsPopover'
import { LiteratureFilterPopover } from './LiteratureFilterPopover'

type ColumnPanelState = { keys: string[]; hidden: Set<string>; allKeys: string[] }

type WorkbenchToolbarProps = {
  selectedCount: number
  activeView: LiteratureTableView

  normalizedSearchQuery: string
  searchQuery: string
  setSearchQuery: (q: string) => void
  searchPopoverOpen: boolean
  setSearchPopoverOpen: (open: boolean) => void
  searchInputElRef: MutableRefObject<HTMLInputElement | null>
  activeSearchButtonStyle?: CSSProperties

  filterMode: FilterMode
  setFilterMode: React.Dispatch<React.SetStateAction<FilterMode>>
  fieldFilter: FieldFilterState
  setFieldFilter: React.Dispatch<React.SetStateAction<FieldFilterState>>
  filterPopoverOpen: boolean
  setFilterPopoverOpen: (open: boolean) => void
  themePrimaryColor: string
  yearOptions: { value: string; label: string }[]
  typeOptions: { value: string; label: string }[]
  tagOptions: { value: string; label: string }[]
  keywordOptions: { value: string; label: string }[]
  bibTypeOptions: { value: string; label: string }[]

  columnsPopoverOpen: boolean
  setColumnsPopoverOpen: (open: boolean) => void
  metaPanel: ColumnPanelState
  analysisPanel: ColumnPanelState
  metaFieldDefs: Record<string, unknown>
  analysisFieldDefs: Record<string, unknown>
  getFieldName: (defs: Record<string, unknown>, key: string) => string
  applyMetaPanelChange: (nextKeys: string[], nextHidden: Set<string>) => Promise<void>
  applyAnalysisPanelChange: (nextKeys: string[], nextHidden: Set<string>) => Promise<void>

  analysisInProgress: boolean
  stoppingAnalysis: boolean
  onAnalyzeRequest: () => void
  onStopRequest: () => void

  deletingExtracted: boolean
  onDeleteRequest: () => void

  feishuSyncing: boolean
  feishuPendingCount: number
  feishuLastError: string | null
  feishuSyncEnabled: boolean
  onSyncRequest: () => void

  filteredItemsCount: number
}

export function WorkbenchToolbar({
  selectedCount,
  activeView,
  normalizedSearchQuery,
  searchQuery,
  setSearchQuery,
  searchPopoverOpen,
  setSearchPopoverOpen,
  searchInputElRef,
  activeSearchButtonStyle,
  filterMode,
  setFilterMode,
  fieldFilter,
  setFieldFilter,
  filterPopoverOpen,
  setFilterPopoverOpen,
  themePrimaryColor,
  yearOptions,
  typeOptions,
  tagOptions,
  keywordOptions,
  bibTypeOptions,
  columnsPopoverOpen,
  setColumnsPopoverOpen,
  metaPanel,
  analysisPanel,
  metaFieldDefs,
  analysisFieldDefs,
  getFieldName,
  applyMetaPanelChange,
  applyAnalysisPanelChange,
  analysisInProgress,
  stoppingAnalysis,
  onAnalyzeRequest,
  onStopRequest,
  deletingExtracted,
  onDeleteRequest,
  feishuSyncing,
  feishuPendingCount,
  feishuLastError,
  feishuSyncEnabled,
  onSyncRequest,
  filteredItemsCount,
}: WorkbenchToolbarProps) {
  const searchHelpText = useMemo(() => {
    return normalizedSearchQuery ? `匹配 ${filteredItemsCount} 条（标题/作者模糊）` : '支持模糊搜索：标题、作者'
  }, [filteredItemsCount, normalizedSearchQuery])

  const feishuIcon = useMemo(() => {
    if (feishuSyncing) return <LoadingOutlined spin />
    if (feishuLastError) return <ExclamationCircleOutlined />
    if (feishuPendingCount > 0) return <CloudUploadOutlined />
    return <CheckCircleOutlined />
  }, [feishuLastError, feishuPendingCount, feishuSyncing])

  const feishuTitle = useMemo(() => {
    if (feishuSyncing) return '正在同步到飞书…'
    if (feishuLastError) return `同步失败：${feishuLastError}（点击重试）`
    if (feishuPendingCount > 0) return `待同步 ${feishuPendingCount} 条（点击同步）`
    return '已同步'
  }, [feishuLastError, feishuPendingCount, feishuSyncing])

  return (
    <div className="flex items-center gap-3">
      <span className="text-xs secondary-color">已选 {selectedCount} 条</span>

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
              <div className="mt-2 text-[11px] secondary-color">{searchHelpText}</div>
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
          themePrimaryColor={themePrimaryColor}
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
          yearOptions={yearOptions}
          typeOptions={typeOptions}
          tagOptions={tagOptions}
          keywordOptions={keywordOptions}
          bibTypeOptions={bibTypeOptions}
          hideStatus={activeView === 'matrix'}
        />

        <ColumnSettingsPopover
          open={columnsPopoverOpen}
          onOpenChange={setColumnsPopoverOpen}
          activeView={activeView}
          metaPanel={metaPanel}
          analysisPanel={analysisPanel}
          metaFieldDefs={metaFieldDefs}
          analysisFieldDefs={analysisFieldDefs}
          getFieldName={getFieldName}
          applyMetaPanelChange={applyMetaPanelChange}
          applyAnalysisPanelChange={applyAnalysisPanelChange}
        />

        {activeView === 'matrix' ? (
          <Button
            key="sync_feishu"
            icon={feishuIcon}
            aria-label="同步到飞书"
            title={feishuTitle}
            onClick={onSyncRequest}
            disabled={!feishuSyncEnabled || feishuSyncing}
          />
        ) : null}

        <Button
          key="analyze"
          type={analysisInProgress ? 'default' : 'primary'}
          danger={analysisInProgress}
          icon={analysisInProgress ? <StopOutlined /> : <PlayCircleOutlined />}
          onClick={analysisInProgress ? onStopRequest : onAnalyzeRequest}
          disabled={analysisInProgress ? stoppingAnalysis : selectedCount === 0}
        >
          {analysisInProgress ? '终止分析' : '开始分析'}
        </Button>

        {activeView === 'matrix' ? (
          <Button
            key="delete_extracted"
            danger
            icon={<DeleteOutlined />}
            onClick={onDeleteRequest}
            title={deletingExtracted ? '正在删除…（可继续删除其它条目）' : '删除已提取数据'}
            disabled={selectedCount === 0}
          />
        ) : null}
      </Space>
    </div>
  )
}
