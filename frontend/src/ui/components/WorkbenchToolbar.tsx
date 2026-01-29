import { useMemo } from 'react'
import { App as AntApp, Button, Input, Popover, Space } from 'antd'
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
  SyncOutlined,
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
  matrixAnalysisSettingsOrder: string[]
  defaultMetaOrder: string[]
  getFieldName: (defs: Record<string, unknown>, key: string) => string
  applyMetaPanelChange: (nextKeys: string[], nextHidden: Set<string>) => Promise<void>
  applyAnalysisPanelChange: (nextKeys: string[], nextHidden: Set<string>) => Promise<void>

  analysisInProgress: boolean
  stoppingAnalysis: boolean
  onAnalyzeRequest: () => void
  onStopRequest: () => void
  llmConfigured: boolean

  deletingExtracted: boolean
  onDeleteRequest: () => void

  feishuSyncing: boolean
  feishuReconciling: boolean
  feishuPendingCount: number
  feishuLastError: string | null
  feishuSyncEnabled: boolean
  feishuReconcileDue: boolean
  feishuLastReconcileAt: number | null
  onSyncRequest: () => void
  onReconcileRequest: () => void
  feishuApiConfigured: boolean

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
  matrixAnalysisSettingsOrder,
  defaultMetaOrder,
  getFieldName,
  applyMetaPanelChange,
  applyAnalysisPanelChange,
  analysisInProgress,
  stoppingAnalysis,
  onAnalyzeRequest,
  onStopRequest,
  llmConfigured,
  deletingExtracted,
  onDeleteRequest,
  feishuSyncing,
  feishuReconciling,
  feishuPendingCount,
  feishuLastError,
  feishuSyncEnabled,
  feishuReconcileDue,
  feishuLastReconcileAt,
  onSyncRequest,
  onReconcileRequest,
  feishuApiConfigured,
  filteredItemsCount,
}: WorkbenchToolbarProps) {
  const { message } = AntApp.useApp()
  const searchHelpText = useMemo(() => {
    const scope =
      activeView === 'matrix' ? '标题、作者、分析字段（不含关键词/文献类型）' : '标题、作者'
    return normalizedSearchQuery ? `匹配 ${filteredItemsCount} 条（${scope} 模糊）` : `支持模糊搜索：${scope}`
  }, [activeView, filteredItemsCount, normalizedSearchQuery])

  const feishuIcon = useMemo(() => {
    if (feishuSyncing) return <LoadingOutlined spin />
    if (feishuReconciling) return <LoadingOutlined spin />
    if (feishuLastError) return <ExclamationCircleOutlined />
    if (feishuPendingCount > 0) return <CloudUploadOutlined />
    if (feishuReconcileDue) return <SyncOutlined />
    return <CheckCircleOutlined />
  }, [feishuLastError, feishuPendingCount, feishuReconcileDue, feishuReconciling, feishuSyncing])

  const feishuTitle = useMemo(() => {
    if (feishuSyncing) return '正在同步到飞书…'
    if (feishuReconciling) return '正在校验飞书同步状态…'
    if (feishuLastError) return `同步失败：${feishuLastError}（点击重试）`
    if (feishuPendingCount > 0) return `待同步 ${feishuPendingCount} 条（点击同步）`
    if (feishuReconcileDue) return '云端状态未校验（点击更新）'
    if (feishuLastReconcileAt) return '已同步（已校验）'
    return '已同步'
  }, [feishuLastError, feishuLastReconcileAt, feishuPendingCount, feishuReconcileDue, feishuReconciling, feishuSyncing])

  const handleFeishuAction = useMemo(() => {
    if (selectedCount > 0) return onSyncRequest
    if (feishuPendingCount > 0) return onSyncRequest
    return onReconcileRequest
  }, [feishuPendingCount, onReconcileRequest, onSyncRequest, selectedCount])

  const feishuBusy = feishuSyncing || feishuReconciling

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
                placeholder={activeView === 'matrix' ? '搜索标题/作者/分析字段（不含关键词/文献类型）' : '搜索标题/作者'}
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
          matrixAnalysisSettingsOrder={matrixAnalysisSettingsOrder}
          defaultMetaOrder={defaultMetaOrder}
          getFieldName={getFieldName}
          applyMetaPanelChange={applyMetaPanelChange}
          applyAnalysisPanelChange={applyAnalysisPanelChange}
        />

        {activeView === 'matrix' ? (
          <Button
            key="sync_feishu"
            type={selectedCount > 0 ? 'primary' : 'default'}
            icon={feishuIcon}
            aria-label="同步到飞书"
            title={feishuTitle}
            onClick={() => {
              if (!feishuApiConfigured) {
                message.warning('飞书 API 未配置完成，请到设置页填写 App ID / App Secret / Bitable URL')
                return
              }
              handleFeishuAction()
            }}
            disabled={!feishuSyncEnabled || feishuBusy}
          />
        ) : null}

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

        <Button
          key="analyze"
          type={analysisInProgress ? 'default' : 'primary'}
          danger={analysisInProgress}
          icon={analysisInProgress ? <StopOutlined /> : <PlayCircleOutlined />}
          onClick={
            analysisInProgress
              ? onStopRequest
              : () => {
                if (!llmConfigured) {
                  message.warning('模型 API 未配置完成，请到设置页填写 API Key / Base URL / Model')
                  return
                }
                onAnalyzeRequest()
              }
          }
          disabled={analysisInProgress ? stoppingAnalysis : selectedCount === 0}
        >
          {analysisInProgress ? '终止分析' : activeView === 'matrix' ? '重新分析' : '开始分析'}
        </Button>
      </Space>
    </div>
  )
}
