/**
 * 模块名称: 侧边栏组件
 * 功能描述: 显示文献库的文件夹（Collections）树状结构，支持搜索过滤、展开/折叠，以及底部的 Zotero 连接状态显示。
 */
import { useEffect, useMemo, useState } from 'react'
import { Tree, Input, Empty, Button, Tooltip } from 'antd'
import type { TreeDataNode } from 'antd'
import { FolderOutlined, FolderOpenOutlined, SettingOutlined, SyncOutlined, InfoCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons'
import { openExternal } from '../../lib/backend'
import type { CollectionNode } from '../../types'

interface AppSidebarProps {
  collections: CollectionNode[]
  activeKey: string | null
  onSelect: (key: string) => void
  zoteroStatus: { path: string; connected: boolean }
  refreshState?: { refreshing: boolean; error?: string | null; lastUpdatedAt?: number | null }
  onRefresh?: () => void
  onSettings?: () => void
}

const { Search } = Input

const formatUpdatedAt = (ts: number) => {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(ts))
  } catch {
    return new Date(ts).toLocaleString()
  }
}

export function AppSidebar({ collections, activeKey, onSelect, zoteroStatus, refreshState, onRefresh, onSettings }: AppSidebarProps) {
  const [searchValue, setSearchValue] = useState('')
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([])
  const [autoExpandParent, setAutoExpandParent] = useState(true)

  // 将集合树拍平成 key 列表：用于“搜索时强制展开全部节点”，避免每次渲染重复递归遍历
  const allCollectionKeys = useMemo(() => {
    const loop = (nodes: CollectionNode[]): string[] => {
      const keys: string[] = []
      for (const node of nodes) {
        keys.push(node.key)
        if (node.children?.length) keys.push(...loop(node.children))
      }
      return keys
    }
    return loop(collections)
  }, [collections])

  const treeData = useMemo(() => {
    const loop = (data: CollectionNode[]): TreeDataNode[] =>
      data.map((item) => {
        const strTitle = item.name as string
        const index = strTitle.indexOf(searchValue)
        const beforeStr = strTitle.substring(0, index)
        const afterStr = strTitle.slice(index + searchValue.length)
        // 搜索高亮：仅在命中时将命中片段包裹为高亮样式
        const title =
          index > -1 ? (
            <span>
              {beforeStr}
              <span className="primary-color font-bold">{searchValue}</span>
              {afterStr}
            </span>
          ) : (
            <span>{strTitle}</span>
          )

        if (item.children) {
          return {
            title,
            key: item.key,
            children: loop(item.children),
            icon: (props: { expanded?: boolean }) => (props.expanded ? <FolderOpenOutlined /> : <FolderOutlined />)
          }
        }
        return {
          title,
          key: item.key,
          icon: <FolderOutlined />
        }
      })
    return loop(collections)
  }, [collections, searchValue])

  const onExpand = (newExpandedKeys: React.Key[]) => {
    setExpandedKeys(newExpandedKeys)
    setAutoExpandParent(false)
  }

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { value } = e.target
    // 当前策略：输入搜索即强制展开全部节点，保证命中项可见；清空搜索后依旧保持全部展开
    if (value) {
      setExpandedKeys(allCollectionKeys)
    } else {
      setExpandedKeys(allCollectionKeys)
    }
    setSearchValue(value)
    setAutoExpandParent(true)
  }

  useEffect(() => {
    // 首次拿到 collections 后默认展开全部：对“大树”可能有性能/视觉噪音风险，后续可按需优化为“仅展开根/命中路径”
    if (collections.length > 0 && expandedKeys.length === 0) setExpandedKeys(allCollectionKeys)
  }, [allCollectionKeys, collections.length, expandedKeys.length])

  const refreshTooltipTitle = useMemo(() => {
    if (refreshState?.refreshing) return '正在更新...'
    if (refreshState?.error) return `更新失败：${refreshState.error}`
    const ts = refreshState?.lastUpdatedAt
    if (!ts) return '刷新'
    return `上次更新：${formatUpdatedAt(ts)}`
  }, [refreshState?.error, refreshState?.lastUpdatedAt, refreshState?.refreshing])

  return (
    <div className="flex flex-col h-full bg-[var(--app-bg)] border-r border-slate-200">
      <div className="px-4 py-3 flex items-center gap-2">
        <div data-tauri-drag-region className="flex-1 flex items-center min-w-0">
          <div className="font-bold text-xl primary-color tracking-tight select-none">MatrixIt</div>
        </div>
        <div data-tauri-drag-region="false" className="flex items-center gap-1">
          <Tooltip title={refreshTooltipTitle}>
            <Button
              type="text"
              size="middle"
              icon={
                refreshState?.error ? (
                  <ExclamationCircleOutlined className="!text-red-500" />
                ) : (
                  <SyncOutlined spin={!!refreshState?.refreshing} />
                )
              }
              onClick={onRefresh}
              disabled={!!refreshState?.refreshing}
            />
          </Tooltip>
          <Tooltip title="设置">
            <Button type="text" size="middle" icon={<SettingOutlined />} onClick={onSettings} />
          </Tooltip>
        </div>
      </div>

      <div className="px-4 pb-2">
        <Search
          placeholder="搜索集合"
          onChange={onChange}
          allowClear
          className="w-full"
          variant="filled"
        />
      </div>

      <div className="flex-1 overflow-y-auto px-2 custom-scrollbar">
        {collections.length > 0 ? (
          <Tree
            showIcon
            onExpand={onExpand}
            expandedKeys={expandedKeys}
            autoExpandParent={autoExpandParent}
            onSelect={(keys) => keys[0] && onSelect(keys[0] as string)}
            selectedKeys={activeKey ? [activeKey] : []}
            treeData={treeData}
            blockNode
            className="bg-transparent"
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无集合" />
        )}
      </div>

      <div className="p-4">
        <ZoteroStatusFooter zoteroStatus={zoteroStatus} />
      </div>
    </div>
  )
}

export function ZoteroStatusFooter({
  zoteroStatus,
}: {
  zoteroStatus: { path: string; connected: boolean }
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2 overflow-hidden">
        <div className={`w-2 h-2 rounded-full shrink-0 ${zoteroStatus.connected ? 'bg-green-500' : 'bg-gray-300'}`} />
        <span className="text-xs text-slate-600 truncate" title={zoteroStatus.path}>
          {zoteroStatus.connected ? 'Zotero 已连接' : 'Zotero 未连接'}
        </span>
      </div>
      <Tooltip title="使用说明">
        <Button
          type="text"
          size="small"
          icon={<InfoCircleOutlined />}
          onClick={() => {
            openExternal('https://example.com').catch(() => { })
          }}
        />
      </Tooltip>
    </div>
  )
}
