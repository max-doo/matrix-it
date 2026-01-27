/**
 * 分析流程状态管理 Hook
 * 负责文献分析的启动、停止、状态更新和UI交互
 */

import { useState, useCallback, useRef } from 'react'
import { message } from 'antd'
import type { AnalysisEvent, AnalysisReport, AnalysisReportItem, LiteratureItem } from '../../types'
import {
    startAnalysis as startAnalysisRpc,
    stopAnalysis as stopAnalysisRpc,
    deleteExtractedData as deleteExtractedDataRpc,
    getItems as getItemsRpc,
} from '../../lib/backend'

export function useAnalysisState<T extends { items: LiteratureItem[] }>(
    library: T,
    setLibrary: React.Dispatch<React.SetStateAction<T>>,
    selectedRowKeys: React.Key[],
    setSelectedRowKeys: (keys: React.Key[]) => void,
    handleRefresh: () => void,
    analysisInProgressRef: React.MutableRefObject<boolean>,
    onAnalysisReport?: (report: AnalysisReport) => void
) {
    const [analysisInProgress, setAnalysisInProgress] = useState(false)
    const [stoppingAnalysis, setStoppingAnalysis] = useState(false)
    const [deletingExtracted, setDeletingExtracted] = useState(false)
    const pendingDeleteCountRef = useRef(0)
    const deleteQueueRef = useRef(Promise.resolve())

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
        let closed = false
        const startedAt = Date.now()
        const items = new Map<string, AnalysisReportItem>()
        const rawEvents: AnalysisEvent[] = []
        const finishedFetchQueue = new Set<string>()
        const finishedFetchAttempts = new Map<string, number>()
        let finishedFetchTimer: number | null = null
        let finishedFetchInFlight = false

        const ensureItem = (k: string) => {
            const prev = items.get(k)
            if (prev) return prev
            const next: AnalysisReportItem = { item_key: k, status: 'unknown' }
            items.set(k, next)
            return next
        }

        const formatMs = (ms: number) => {
            const sec = Math.max(0, Math.floor(ms / 1000))
            const m = Math.floor(sec / 60)
            const s = sec % 60
            return `${m}:${String(s).padStart(2, '0')}`
        }

        const closeAnalysis = () => {
            if (closed) return
            closed = true
            if (finishedFetchTimer !== null) {
                window.clearTimeout(finishedFetchTimer)
                finishedFetchTimer = null
            }
            setAnalysisInProgress(false)
            analysisInProgressRef.current = false
            handleRefresh()
            const endedAt = Date.now()
            const allItems = [...items.values()].sort((a, b) => a.item_key.localeCompare(b.item_key))
            const finished = allItems.filter((x) => x.status === 'finished').length
            const failed = allItems.filter((x) => x.status === 'failed').length
            const cancelled = allItems.filter((x) => x.status === 'cancelled').length
            const summary = `分析完成：${keys.length} 篇（成功 ${finished} / 失败 ${failed} / 取消 ${cancelled}）· 用时 ${formatMs(endedAt - startedAt)}`
            const report: AnalysisReport = {
                started_at: startedAt,
                ended_at: endedAt,
                duration_ms: endedAt - startedAt,
                total: keys.length,
                finished,
                failed,
                cancelled,
                items: allItems,
                raw_events: rawEvents,
            }
            if (onAnalysisReport) {
                onAnalysisReport(report)
            } else {
                message.success({ content: summary, key: msgKey })
            }
        }

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

        const flushFinishedFetchQueue = async () => {
            if (finishedFetchInFlight) return
            const keysToFetch = [...finishedFetchQueue]
            finishedFetchQueue.clear()
            if (keysToFetch.length === 0) return
            finishedFetchInFlight = true
            try {
                const res = await getItemsRpc(keysToFetch)
                const fetched = Array.isArray(res?.items) ? res.items : []
                if (fetched.length === 0) return
                const fetchedKeys = new Set<string>()
                setLibrary((prev) => {
                    const indexByKey = new Map<string, number>()
                    const nextItems = prev.items.slice()
                    for (let i = 0; i < nextItems.length; i++) {
                        indexByKey.set(nextItems[i].item_key, i)
                    }
                    for (const next of fetched) {
                        const k = (next as LiteratureItem).item_key
                        if (!k) continue
                        fetchedKeys.add(k)
                        const idx = indexByKey.get(k)
                        if (idx === undefined) {
                            nextItems.push(next as LiteratureItem)
                            indexByKey.set(k, nextItems.length - 1)
                            continue
                        }
                        const prevIt = nextItems[idx]
                        nextItems[idx] = { ...prevIt, ...(next as LiteratureItem), item_key: prevIt.item_key }
                    }
                    return { ...prev, items: nextItems }
                })
                for (const k of fetchedKeys) finishedFetchAttempts.delete(k)
                for (const k of keysToFetch) {
                    if (fetchedKeys.has(k)) continue
                    const attempt = (finishedFetchAttempts.get(k) ?? 0) + 1
                    finishedFetchAttempts.set(k, attempt)
                    if (attempt <= 5) finishedFetchQueue.add(k)
                }
            } catch {
                for (const k of keysToFetch) {
                    const attempt = (finishedFetchAttempts.get(k) ?? 0) + 1
                    finishedFetchAttempts.set(k, attempt)
                    if (attempt <= 5) finishedFetchQueue.add(k)
                }
            } finally {
                finishedFetchInFlight = false
                if (finishedFetchQueue.size > 0 && !closed) {
                    const maxAttempt = Math.max(0, ...[...finishedFetchQueue].map((k) => finishedFetchAttempts.get(k) ?? 0))
                    const delayMs = Math.min(2000, 200 * Math.pow(2, Math.max(0, maxAttempt - 1)))
                    finishedFetchTimer = window.setTimeout(() => {
                        finishedFetchTimer = null
                        void flushFinishedFetchQueue()
                    }, delayMs)
                }
            }
        }

        const scheduleFinishedFetch = (k: string) => {
            if (!k) return
            finishedFetchQueue.add(k)
            if (!finishedFetchAttempts.has(k)) finishedFetchAttempts.set(k, 0)
            if (finishedFetchTimer !== null) return
            finishedFetchTimer = window.setTimeout(() => {
                finishedFetchTimer = null
                void flushFinishedFetchQueue()
            }, 200)
        }

        const onEvent = (evt: AnalysisEvent) => {
            rawEvents.push(evt)
            if (evt.event === 'Started') {
                const k = evt.data.item_key
                const it = ensureItem(k)
                if (!it.started_at) it.started_at = Date.now()
            }
            if (evt.event === 'Finished') {
                const k = evt.data.item_key
                const patch = evt.data.item
                const it = ensureItem(k)
                it.ended_at = Date.now()
                it.status = 'finished'
                setLibrary((prev) => ({
                    ...prev,
                    items: prev.items.map((it) => {
                        if (it.item_key !== k) return it
                        return {
                            ...it,
                            ...(patch ?? {}),
                            item_key: it.item_key,
                            processed_status: 'done',
                            sync_status: 'unsynced',
                        }
                    })
                }))
                const patchObj = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : null
                const hasAnyPayload = !!patchObj && Object.keys(patchObj).length > 0
                if (!hasAnyPayload) scheduleFinishedFetch(k)
            }
            if (evt.event === 'Failed') {
                const k = evt.data.item_key
                const isCancelled = evt.data.error === 'CANCELLED'
                const it = ensureItem(k)
                it.ended_at = Date.now()
                it.status = isCancelled ? 'cancelled' : 'failed'
                it.error = evt.data.error
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
                void flushFinishedFetchQueue()
                closeAnalysis()
            }
        }

        try {
            await startAnalysisRpc(keys, onEvent)
            if (analysisInProgressRef.current) {
                closeAnalysis()
            }
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
    }, [selectedRowKeys, setLibrary, handleRefresh, analysisInProgressRef, onAnalysisReport])

    /**
     * 确认终止分析
     */
    const handleConfirmStopAnalysis = useCallback(async () => {
        const msgKey = 'analysis'
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
                message.info({ content: `已终止分析，取消了 ${res.cancelled_count} 个待分析任务`, key: msgKey })
            } else {
                message.info({ content: '当前没有正在进行的分析任务', key: msgKey })
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : '终止分析失败'
            message.error({ content: msg, key: msgKey })
        } finally {
            setStoppingAnalysis(false)
        }
    }, [setLibrary])

    /**
     * 核心操作：确认删除已提取数据（乐观更新）
     */
    const handleConfirmDelete = useCallback(async () => {
        const keys = selectedRowKeys as string[]
        if (keys.length === 0) {
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

        // 3. 异步执行后端删除操作
        pendingDeleteCountRef.current += 1
        setDeletingExtracted(true)
        deleteQueueRef.current = deleteQueueRef.current
            .catch(() => undefined)
            .then(async () => {
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

                handleRefresh()

                if (feishuFailed > 0) {
                    message.warning(`已清除 ${cleared} 条（缺失 ${missing} 条），飞书删除成功 ${feishuDeleted} 条，失败 ${feishuFailed} 条`)
                } else {
                    message.success(`已清除 ${cleared} 条（缺失 ${missing} 条），飞书删除 ${feishuDeleted} 条`)
                }
            })
            .finally(() => {
                pendingDeleteCountRef.current -= 1
                if (pendingDeleteCountRef.current <= 0) {
                    pendingDeleteCountRef.current = 0
                    setDeletingExtracted(false)
                }
            })
    }, [selectedRowKeys, setLibrary, setSelectedRowKeys, handleRefresh])

    return {
        analysisInProgress,
        analysisInProgressRef,
        stoppingAnalysis,
        deletingExtracted,
        startAnalysis,
        handleConfirmStopAnalysis,
        handleConfirmDelete,
    }
}
