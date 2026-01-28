/**
 * 组件名称: TableExportButtons
 * 功能描述: 表格底部导出按钮组，放置于分页器区域
 *           使用 Ant Design Button 和 Dropdown 组件，只显示图标
 */
import React, { useState } from 'react'
import { Button, Dropdown, message, Space, Tooltip } from 'antd'
import type { MenuProps } from 'antd'
import { FileExcelOutlined, FilePdfOutlined, TableOutlined, ExportOutlined } from '@ant-design/icons'
import { openExternal } from '../../lib/backend'
import { ExportModal, type ExportType } from './ExportModal'
import type { LiteratureItem } from '../../types'

interface TableExportButtonsProps {
    /** 当前选中的 item keys */
    selectedKeys: string[]
    /** 当前合集的所有 item keys（不受筛选影响） */
    collectionKeys: string[]
    /** 当前合集名称 */
    collectionName?: string
    /** 飞书多维表格 URL */
    feishuBitableUrl?: string
    /** 所有文献条目 */
    allItems: LiteratureItem[]
}

/**
 * 表格底部导出按钮组
 */
export const TableExportButtons: React.FC<TableExportButtonsProps> = ({
    selectedKeys,
    collectionKeys,
    collectionName,
    feishuBitableUrl,
    allItems,
}) => {
    const [exportModalVisible, setExportModalVisible] = useState(false)
    const [exportType, setExportType] = useState<ExportType>('excel')
    const [dropdownOpen, setDropdownOpen] = useState(false)

    const handleExportExcel = () => {
        setExportType('excel')
        setExportModalVisible(true)
        setDropdownOpen(false)
    }

    const handleExportPdf = () => {
        setExportType('pdf')
        setExportModalVisible(true)
        setDropdownOpen(false)
    }

    const handleOpenFeishu = async () => {
        if (!feishuBitableUrl) {
            message.warning('未配置飞书多维表格地址')
            return
        }
        try {
            await openExternal(feishuBitableUrl)
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            message.error(`打开失败: ${msg}`)
        }
    }

    const exportMenuItems: MenuProps['items'] = [
        {
            key: 'excel',
            icon: <FileExcelOutlined style={{ color: '#52c41a', fontSize: '18px' }} />,
            label: '导出 Excel',
            onClick: handleExportExcel,
        },
        {
            key: 'pdf',
            icon: <FilePdfOutlined style={{ color: '#ff4d4f', fontSize: '18px' }} />,
            label: '导出 PDF',
            onClick: handleExportPdf,
        },
    ]

    return (
        <>
            <Space size="small">
                {/* 导出下拉按钮 - 只显示图标 */}
                <Dropdown
                    menu={{ items: exportMenuItems }}
                    placement="topRight"
                    trigger={['click']}
                    onOpenChange={setDropdownOpen}
                    open={dropdownOpen}
                >
                    <Tooltip title="导出" open={dropdownOpen ? false : undefined}>
                        <Button
                            icon={<ExportOutlined />}
                        />
                    </Tooltip>
                </Dropdown>

                {/* 打开飞书多维表格按钮 - 只显示图标 */}
                {feishuBitableUrl && (
                    <Tooltip title="打开飞书多维表格">
                        <Button
                            icon={<TableOutlined style={{ color: '#1890ff' }} />}
                            onClick={handleOpenFeishu}
                        />
                    </Tooltip>
                )}
            </Space>

            {/* 导出弹窗 */}
            <ExportModal
                visible={exportModalVisible}
                exportType={exportType}
                onClose={() => setExportModalVisible(false)}
                selectedKeys={selectedKeys}
                collectionKeys={collectionKeys}
                collectionName={collectionName}
                allItems={allItems}
            />
        </>
    )
}

export default TableExportButtons
