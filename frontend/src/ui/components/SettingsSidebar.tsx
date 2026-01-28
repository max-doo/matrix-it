/**
 * 设置页侧边栏组件
 */

import { Button, Menu } from 'antd'
import { HomeOutlined } from '@ant-design/icons'
import { ZoteroStatusFooter } from './AppSidebar'
import type { SettingsSectionKey } from './SettingsPage'

interface SettingsSidebarProps {
    activeKey: SettingsSectionKey
    onSelect: (k: SettingsSectionKey) => void
    onGoHome: () => void
    zoteroStatus: { path: string; connected: boolean }
}

export function SettingsSidebar({ activeKey, onSelect, onGoHome, zoteroStatus }: SettingsSidebarProps) {
    return (
        <div className="flex flex-col h-full bg-[var(--app-bg)] border-r border-slate-200">
            <div className="px-4 py-3 flex items-center justify-between">
                <div className="font-bold text-xl primary-color tracking-tight">设置</div>
                <div className="flex items-center gap-1">
                    <Button type="text" size="middle" icon={<HomeOutlined />} onClick={onGoHome} aria-label="返回首页" />
                </div>
            </div>

            <div className="flex-1 overflow-y-auto px-2 custom-scrollbar">
                <Menu
                    selectedKeys={[activeKey]}
                    onClick={(e) => onSelect(e.key as SettingsSectionKey)}
                    items={[
                        { key: 'zotero', label: '基础设置' },
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
