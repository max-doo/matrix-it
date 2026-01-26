/**
 * 分析流程状态管理 Hook
 * 负责文献分析的启动、停止、状态更新和UI交互
 */

import { useState, useCallback, useRef } from 'react'
import { message } from 'antd'
import type { AnalysisEvent, LiteratureItem } from '../../types'
import { startAnalysis as startAnalysisRpc, stopAnalysis as stopAnalysisRpc, deleteExtractedData as deleteExtractedDataRpc } from '../../lib/backend'

type LibraryState = {
    collections: any[]
    items: LiteratureItem[]
}

export function useAnalysisState(
    library: LibraryState,
    setLibrary: React.Dispatch<React.SetStateAction<LibraryState>>,
    selectedRowKeys: React.Key[],
    setSelectedRowKeys: (keys: React.Key[]) => void,
    handleRefresh: () => void,
    analysisInProgressRef: React.MutableRefObject<boolean>
) {
    const [analysisInProgress, setAnalysisInProgress] = useState(false)
    const [stoppingAnalysis, setStoppingAnalysis] = useState(false)
    const [deletingExtracted, setDeletingExtracted] = useState(false)
    const [confirmModal, setConfirmModal] = useState<{ open: boolean; type: 'delete' | 'analyze' | 'stop' | 'mixed_analyze' }>({
        open: false,
        type: 'delete',
    })

    /**
     * 核心操作：启动分析
     * 1. 将选中的文献标记为 processing/reanalyzing 状态
     * 2. 调用后端 RPC startAnalysis
     * 3. 监听后端通过 Channel 返回的 AnalysisEvent 事件流，实时更新 UI 状态
     */
    const startAnalysis = useCallback(async (customKeys?: string[]) => {
        const keys = customKeys ?? (selectedRowKeys as string[])
        if (keys.length === 0) return

        const msgKey = 'analysis'

        setAnalysisInProgress(true)
        analysisInProgressRef.current = true
        setLibrary((prev) => ({
            ...prev,
            items: prev.items.map((it) => {
                if (!keys.includes(it.item_key)) return it
                const isReanalyze = it.processed_status === 'done'
                return { ...it, processed_status: isReanalyze ? 'reanalyzing' : 'processing', processed_error: undefined }
            }),
        }))
        message.loading({ content: '正在分析…', key: msgKey, duration: 0 })

        const onEvent = (evt: AnalysisEvent) => {
            if (evt.event === 'Finished') {
                const k = evt.data.item_key
                setLibrary((prev) => ({
                    ...prev,
                    items: prev.items.map((it) => (it.item_key === k ? { ...it, processed_status: 'done', sync_status: 'unsynced' } : it))
                }))
            }
            if (evt.event === 'Failed') {
                const k = evt.data.item_key
                const isCancelled = evt.data.error === 'CANCELLED'
                // 获取当前状态，用于判断恢复目标
                let restoreTarget: 'done' | 'unprocessed' = 'unprocessed'
                setLibrary((prev) => ({
                    ...prev,
                    items: prev.items.map((it) => {
                        if (it.item_key !== k) return it
                        // 记录恢复目标：reanalyzing -> done, processing -> unprocessed
                        restoreTarget = it.processed_status === 'reanalyzing' ? 'done' : 'unprocessed'
                        if (isCancelled) {
                            return { ...it, processed_status: restoreTarget, processed_error: undefined }
                        }
                        return { ...it, processed_status: 'failed', processed_error: evt.data.error }
                    })
                }))
                if (!isCancelled) {
                    message.error(`分析失败(${k}): ${evt.data.error}`)
                    // 5 秒后恢复到分析前的状态
                    setTimeout(() => {
                        setLibrary((prev) => ({
                            ...prev,
                            items: prev.items.map((it) =>
                                it.item_key === k && it.processed_status === 'failed'
                                    ? { ...it, processed_status: restoreTarget, processed_error: undefined }
                                    : it
                            )
                        }))
                    }, 5000)
                }
            }
            if (evt.event === 'AllDone') {
                setAnalysisInProgress(false)
                analysisInProgressRef.current = false
                handleRefresh()
                message.success({ content: '分析完成', key: msgKey })
            }
        }

        try {
            await startAnalysisRpc(keys, onEvent)
        } catch (e) {
            const msg = e instanceof Error ? e.message : '启动分析失败'
            setAnalysisInProgress(false)
            analysisInProgressRef.current = false
            setLibrary((prev) => ({
                ...prev,
                items: prev.items.map((it) =>
                    keys.includes(it.item_key) ? { ...it, processed_status: 'failed', processed_error: msg } : it
                ),
            }))
            message.error({ content: msg, key: msgKey })
        }
    }, [selectedRowKeys, setLibrary, handleRefresh])

    /**
     * UI 交互：请求分析
     */
    const handleAnalysisRequest = useCallback(() => {
        if (selectedRowKeys.length === 0) return
        const items = library.items.filter((it) => selectedRowKeys.includes(it.item_key))
        const total = items.length
        const doneCount = items.filter((it) => it.processed_status === 'done').length

        if (doneCount > 0 && doneCount < total) {
            setConfirmModal({ open: true, type: 'mixed_analyze' })
            return
        }

        if (doneCount > 0) {
            setConfirmModal({ open: true, type: 'analyze' })
        } else {
            void startAnalysis()
        }
    }, [selectedRowKeys, library.items, startAnalysis])

    /**
     * UI 交互：请求终止分析
     */
    const handleStopAnalysisRequest = useCallback(() => {
        setConfirmModal({ open: true, type: 'stop' })
    }, [])

    /**
     * 确认终止分析
     */
    const handleConfirmStopAnalysis = useCallback(async () => {
        setStoppingAnalysis(true)
        try {
            const res = await stopAnalysisRpc()
            if (res.stopped) {
                setLibrary((prev) => ({
                    ...prev,
                    items: prev.items.map((it) => {
                        if (it.processed_status === 'processing') {
                            return { ...it, processed_status: 'unprocessed', processed_error: undefined }
                        }
                        if (it.processed_status === 'reanalyzing') {
                            return { ...it, processed_status: 'done', processed_error: undefined }
                        }
                        return it
                    })
                }))
                setAnalysisInProgress(false)
                analysisInProgressRef.current = false
                message.info(`已终止分析，取消了 ${res.cancelled_count} 个待分析任务`)
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : '终止分析失败'
            message.error(msg)
        } finally {
            setStoppingAnalysis(false)
            setConfirmModal((prev) => ({ ...prev, open: false }))
        }
    }, [setLibrary])

    const handleConfirmAnalysis = useCallback(() => {
        void startAnalysis()
        setConfirmModal((prev) => ({ ...prev, open: false }))
    }, [startAnalysis])

    /**
     * 核心操作：删除已提取数据 - 触发确认弹窗
     */
    const handleDeleteRequest = useCallback(() => {
        const keys = selectedRowKeys as string[]
        if (keys.length === 0 || deletingExtracted) return
        setConfirmModal({ open: true, type: 'delete' })
    }, [selectedRowKeys, deletingExtracted])

    /**
     * 核心操作：确认删除已提取数据（乐观更新）
     */
    const handleConfirmDelete = useCallback(async () => {
        const keys = selectedRowKeys as string[]
        if (keys.length === 0) {
            setConfirmModal((prev) => ({ ...prev, open: false }))
            return
        }

        // 1. 立即更新前端状态
        setLibrary((prev) => ({
            ...prev,
            items: prev.items.map((it) =>
                keys.includes(it.item_key)
                    ? { ...it, processed_status: 'unprocessed', sync_status: 'unsynced' }
                    : it
            ),
        }))

        // 2. 立即清空选中项并关闭弹窗
        setSelectedRowKeys([])
        setConfirmModal((prev) => ({ ...prev, open: false }))

        // 3. 异步执行后端删除操作
        setDeletingExtracted(true)
        try {
            const res = (await deleteExtractedDataRpc(keys)) as {
                cleared?: number
                missing?: number
                analysis_fields?: number
                feishu?: { deleted?: number; skipped?: number; failed?: number }
            }
            const cleared = Number(res?.cleared ?? 0)
            const missing = Number(res?.missing ?? 0)
            const feishuDeleted = Number(res?.feishu?.deleted ?? 0)
            const feishuFailed = Number(res?.feishu?.failed ?? 0)

            // 刷新同步真实状态
            handleRefresh()

            if (feishuFailed > 0) {
                message.warning(`已清除 ${cleared} 条（缺失 ${missing} 条），飞书删除成功 ${feishuDeleted} 条，失败 ${feishuFailed} 条`)
            } else {
                message.success(`已清除 ${cleared} 条（缺失 ${missing} 条），飞书删除 ${feishuDeleted} 条`)
            }
        } finally {
            setDeletingExtracted(false)
        }
    }, [selectedRowKeys, setLibrary, setSelectedRowKeys, handleRefresh])

    return {
        analysisInProgress,
        analysisInProgressRef,
        stoppingAnalysis,
        deletingExtracted,
        confirmModal,
        setConfirmModal,
        startAnalysis,
        handleAnalysisRequest,
        handleStopAnalysisRequest,
        handleConfirmStopAnalysis,
        handleConfirmAnalysis,
        handleDeleteRequest,
        handleConfirmDelete,
    }
}
