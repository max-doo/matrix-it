/**
 * 组件名称: ExportModal
 * 功能描述: 导出确认弹窗，支持 Excel 和 PDF 导出配置
 *           使用 Ant Design 标准组件实现
 *           导出路径会持久化保存到 localStorage
 */
import React, { useState, useEffect } from 'react'
import { Modal, Radio, Input, App, Spin, Form, Typography, Alert, Button } from 'antd'
import type { RadioChangeEvent } from 'antd'
import { FileExcelOutlined, FilePdfOutlined, FolderOpenOutlined } from '@ant-design/icons'
import { open as openFolderDialog } from '@tauri-apps/plugin-dialog'
import { exportExcel, exportPdfs, openPath } from '../../lib/backend'

import type { LiteratureItem } from '../../types'
const { Text } = Typography

/** localStorage 存储键 */
const EXPORT_PATH_EXCEL_KEY = 'matrixit.export.excelOutputPath'
const EXPORT_PATH_PDF_KEY = 'matrixit.export.pdfOutputPath'

export type ExportType = 'excel' | 'pdf'
export type ExportScope = 'selected' | 'collection'

interface ExportModalProps {
    /** 弹窗是否可见 */
    visible: boolean
    /** 导出类型 */
    exportType: ExportType
    /** 关闭弹窗回调 */
    onClose: () => void
    /** 当前选中的 item keys */
    selectedKeys: string[]
    /** 当前合集的所有 item keys（不受筛选影响） */
    collectionKeys: string[]
    /** 当前合集名称（用于默认文件名） */
    collectionName?: string
    /** 所有文献条目（用于计算已分析数量） */
    allItems: LiteratureItem[]
}

/**
 * 从 localStorage 读取上次使用的导出路径
 */
function getLastExportPath(type: ExportType): string {
    try {
        const key = type === 'excel' ? EXPORT_PATH_EXCEL_KEY : EXPORT_PATH_PDF_KEY
        return localStorage.getItem(key) || ''
    } catch {
        return ''
    }
}

/**
 * 保存导出路径到 localStorage
 */
function saveExportPath(type: ExportType, path: string): void {
    try {
        if (path.trim()) {
            const key = type === 'excel' ? EXPORT_PATH_EXCEL_KEY : EXPORT_PATH_PDF_KEY
            localStorage.setItem(key, path.trim())
        }
    } catch {
        // ignore
    }
}

/**
 * 导出确认弹窗
 */
export const ExportModal: React.FC<ExportModalProps> = ({
    visible,
    exportType,
    onClose,
    selectedKeys,
    collectionKeys,
    collectionName = '文献',
    allItems,
}) => {
    const { message } = App.useApp()
    // 构建 item 查找表
    const itemMap = React.useMemo(() => {
        const map = new Map<string, LiteratureItem>()
        allItems.forEach(item => map.set(item.item_key, item))
        return map
    }, [allItems])

    // 计算已分析数量
    const getDoneCount = (keys: string[]) => {
        return keys.filter(key => itemMap.get(key)?.processed_status === 'done').length
    }

    const [scope, setScope] = useState<ExportScope>('selected')
    const [outputPath, setOutputPath] = useState('')
    const [filename, setFilename] = useState('')
    const [loading, setLoading] = useState(false)

    // 重置表单
    useEffect(() => {
        if (visible) {
            // 优先使用选中项，如果没有选中则默认当前合集
            setScope(selectedKeys.length > 0 ? 'selected' : 'collection')
            // 从 localStorage 读取上次使用的路径（按类型区分）
            setOutputPath(getLastExportPath(exportType))
            const defaultFilename = exportType === 'excel'
                ? `${collectionName}文献集.xlsx`
                : ''
            setFilename(defaultFilename)
        }
    }, [visible, exportType, collectionName, selectedKeys.length])

    const handleScopeChange = (e: RadioChangeEvent) => {
        setScope(e.target.value as ExportScope)
    }

    /** 打开文件夹选择对话框 */
    const handleSelectFolder = async () => {
        try {
            const selected = await openFolderDialog({
                directory: true,
                multiple: false,
                title: exportType === 'excel' ? '选择 Excel 导出目录' : '选择 PDF 导出目录',
                defaultPath: outputPath || undefined,
            })
            if (typeof selected === 'string' && selected) {
                setOutputPath(selected)
            }
        } catch (e) {
            console.error('选择目录失败:', e)
            message.error('无法打开文件夹选择对话框')
        }
    }

    const handleExport = async () => {
        if (!outputPath.trim()) {
            message.warning('请选择导出目录')
            return
        }

        const keys = scope === 'selected' ? selectedKeys : collectionKeys
        if (keys.length === 0) {
            message.warning(scope === 'selected' ? '没有选中的条目' : '当前合集没有条目')
            return
        }

        // 保存路径到 localStorage 供下次使用（按类型区分）
        saveExportPath(exportType, outputPath)

        setLoading(true)
        try {
            if (exportType === 'excel') {
                const finalFilename = filename.trim() || `${collectionName}文献集.xlsx`
                const result = await exportExcel({
                    outputPath: outputPath.trim(),
                    filename: finalFilename,
                    keys,
                })
                if (result.failures && result.failures.length > 0) {
                    message.warning(`导出完成，但有 ${result.failures.length} 条失败`)
                } else {
                    message.success(`成功导出 ${result.written} 条，跳过 ${result.skipped} 条（未分析完成）`)
                }
                // 尝试打开导出目录
                if (result.output_path) {
                    const dirPath = result.output_path.replace(/[/\\][^/\\]+$/, '')
                    await openPath(dirPath)
                }
            } else {
                const result = await exportPdfs({
                    outputDir: outputPath.trim(),
                    keys,
                })
                if (result.failures && result.failures.length > 0) {
                    message.warning(`导出完成，但有 ${result.failures.length} 条失败`)
                } else {
                    message.success(
                        `成功导出 ${result.exported} 个 PDF` +
                        (result.skipped_no_pdf > 0 ? `，${result.skipped_no_pdf} 个无 PDF` : '') +
                        (result.skipped_missing > 0 ? `，${result.skipped_missing} 个文件缺失` : '')
                    )
                }
                // 尝试打开导出目录
                if (result.output_dir) {
                    await openPath(result.output_dir)
                }
            }
            onClose()
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            message.error(`导出失败: ${msg}`)
        } finally {
            setLoading(false)
        }
    }

    const title = (
        <span>
            {exportType === 'excel' ? (
                <><FileExcelOutlined style={{ color: '#52c41a', marginRight: 8 }} />导出 Excel</>
            ) : (
                <><FilePdfOutlined style={{ color: '#ff4d4f', marginRight: 8 }} />导出 PDF</>
            )}
        </span>
    )
    const selectedCount = scope === 'selected' ? selectedKeys.length : collectionKeys.length

    return (
        <Modal
            title={title}
            open={visible}
            onCancel={onClose}
            onOk={handleExport}
            okText="导出"
            cancelText="取消"
            confirmLoading={loading}
            maskClosable={!loading}
            closable={!loading}
            width={480}
        >
            <Spin spinning={loading}>
                <Form layout="vertical" style={{ marginTop: 16 }}>
                    {/* 导出范围 */}
                    <Form.Item label="导出范围">
                        <Radio.Group value={scope} onChange={handleScopeChange}>
                            <Radio value="selected" disabled={selectedKeys.length === 0}>
                                选中项 ({exportType === 'excel' ? `已分析 ${getDoneCount(selectedKeys)}` : selectedKeys.length} 条)
                            </Radio>
                            <Radio value="collection">
                                当前合集 ({exportType === 'excel' ? `已分析 ${getDoneCount(collectionKeys)}` : collectionKeys.length} 条)
                            </Radio>
                        </Radio.Group>
                    </Form.Item>

                    {/* 导出目录 */}
                    <Form.Item
                        label="导出目录"
                        extra={outputPath ? undefined : <Text type="secondary" style={{ fontSize: 12 }}>点击"选择"按钮打开文件夹选择器</Text>}
                    >
                        <Input.Search
                            value={outputPath}
                            onChange={(e) => setOutputPath(e.target.value)}
                            placeholder="请选择导出目录"
                            enterButton={<><FolderOpenOutlined /> 选择</>}
                            onSearch={handleSelectFolder}
                            readOnly
                        />
                    </Form.Item>

                    {/* Excel 文件名（仅 Excel 导出时显示） */}
                    {exportType === 'excel' && (
                        <Form.Item label="文件名">
                            <Input
                                value={filename}
                                onChange={(e) => setFilename(e.target.value)}
                                placeholder={`${collectionName}文献集.xlsx`}
                                suffix=".xlsx"
                            />
                        </Form.Item>
                    )}
                </Form>

                {/* 提示信息 */}
                <Alert
                    type="info"
                    showIcon
                    message={
                        exportType === 'excel'
                            ? `将导出 ${selectedCount} 条文献的元数据和分析结果（仅"分析完成"状态）`
                            : `将导出 ${selectedCount} 条文献的 PDF 附件（仅存在附件的条目）`
                    }
                    style={{ marginTop: 8 }}
                />
            </Spin>
        </Modal>
    )
}

export default ExportModal
