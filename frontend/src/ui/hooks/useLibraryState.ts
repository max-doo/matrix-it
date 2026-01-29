/**
 * 文献库状态管理 Hook
 * 负责文献库数据的加载、刷新、缓存和 Zotero 监听
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { message } from 'antd'
import { listen } from '@tauri-apps/api/event'
import type { CollectionNode, LiteratureItem } from '../../types'
import { loadLibrary, startZoteroWatch, stopZoteroWatch } from '../../lib/backend'
import { readLibraryCache, writeLibraryCache } from '../lib/storage'
import { collectCollectionKeys } from '../lib/collectionUtils'

export type LibraryState = {
    collections: CollectionNode[]
    items: LiteratureItem[]
}

const isTauriRuntime = () => {
    const w = window as unknown as Record<string, unknown>
    return !!(w && (w.__TAURI_INTERNALS__ || w.__TAURI__))
}

export function useLibraryState(analysisInProgressRef: React.MutableRefObject<boolean>) {
    const [library, setLibrary] = useState<LibraryState>(() => {
        const cached = readLibraryCache()
        return cached ? { collections: cached.collections, items: cached.items } : { collections: [], items: [] }
    })
    const [refreshingLibrary, setRefreshingLibrary] = useState(false)
    const [refreshError, setRefreshError] = useState<string | null>(null)
    const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(() => readLibraryCache()?.savedAt ?? null)

    // 防止并发刷新：如果正在刷新，忽略新的刷新请求
    const refreshInFlightRef = useRef(false)

    /**
     * 刷新文献库数据
     * 防止并发刷新：如果正在刷新，忽略新请求
     */
    const refreshLibrary = useCallback(
        async (trigger: 'auto' | 'manual') => {
            // 防止并发刷新：如果正在刷新中
            if (refreshInFlightRef.current) {
                if (trigger === 'manual') {
                    message.info('正在刷新中，请稍候...')
                }
                return
            }

            refreshInFlightRef.current = true
            const msgKey = 'matrixit.library.refresh'
            setRefreshingLibrary(true)
            setRefreshError(null)
            if (trigger === 'manual') message.destroy(msgKey)
            try {
                const next = await loadLibrary()
                // 刷新时保留前端正在处理的状态（processing/reanalyzing），防止后端旧数据覆盖
                setLibrary((prev) => {
                    // 如果分析不在进行中，需要清理后端返回的残留状态（脏数据）
                    if (!analysisInProgressRef.current) {
                        return {
                            ...next,
                            items: next.items.map((it) => {
                                // 将后端残留的 processing 状态清理为 unprocessed
                                if (it.processed_status === 'processing') {
                                    return { ...it, processed_status: 'unprocessed', processed_error: undefined }
                                }
                                // 将后端残留的 reanalyzing 状态恢复为 done
                                if (it.processed_status === 'reanalyzing') {
                                    return { ...it, processed_status: 'done', processed_error: undefined }
                                }
                                return it
                            }),
                        }
                    }
                    // 分析进行中时，保留前端的 processing/reanalyzing 状态
                    const processingKeys = new Map<string, LiteratureItem>()
                    for (const it of prev.items) {
                        if (it.processed_status === 'processing' || it.processed_status === 'reanalyzing') {
                            processingKeys.set(it.item_key, it)
                        }
                    }
                    if (processingKeys.size === 0) {
                        return next
                    }
                    return {
                        ...next,
                        items: next.items.map((it) => {
                            const preserved = processingKeys.get(it.item_key)
                            if (preserved) {
                                return { ...it, processed_status: preserved.processed_status, processed_error: preserved.processed_error }
                            }
                            return it
                        }),
                    }
                })
                writeLibraryCache({ savedAt: Date.now(), collections: next.collections, items: next.items })
                setLastRefreshAt(Date.now())
                if (trigger === 'manual') message.success({ content: '数据已更新' })
            } catch (e) {
                const msg = e instanceof Error ? e.message : '更新失败'
                setRefreshError(msg)
                if (trigger === 'manual') message.error({ content: msg })
                else message.error(msg)
            } finally {
                refreshInFlightRef.current = false
                setRefreshingLibrary(false)
            }
        },
        [analysisInProgressRef]
    )

    const handleRefresh = useCallback(() => {
        refreshLibrary('manual')
    }, [refreshLibrary])

    // 初始化：自动刷新文献库
    useEffect(() => {
        const cached = readLibraryCache()
        if (cached) setLastRefreshAt(cached.savedAt)

        // F5 防抖：如果距离上次初始化刷新不到 2 秒，跳过（防止频繁刷新页面导致后端压力）
        const LAST_INIT_KEY = 'matrixit_last_init_refresh'
        const lastInit = localStorage.getItem(LAST_INIT_KEY)
        const now = Date.now()
        if (lastInit && now - parseInt(lastInit, 10) < 2000) {
            console.log('[useLibraryState] 防止 F5 频繁刷新，跳过本次初始化加载')
            return
        }
        localStorage.setItem(LAST_INIT_KEY, now.toString())

        refreshLibrary('auto')
    }, [refreshLibrary])

    return {
        library,
        setLibrary,
        refreshingLibrary,
        refreshError,
        setRefreshError,
        lastRefreshAt,
        refreshLibrary,
        handleRefresh,
    }
}

/**
 * Zotero 文件监听 Hook
 */
export function useZoteroWatch(
    zoteroStatus: { path: string; connected: boolean },
    refreshLibrary: (trigger: 'auto' | 'manual') => Promise<void>
) {
    const zoteroWatchTimerRef = useRef<number | null>(null)

    useEffect(() => {
        if (!isTauriRuntime()) return
        if (!zoteroStatus.connected) {
            void stopZoteroWatch().catch(() => null)
            return
        }

        const dataDir = zoteroStatus.path
        let unlisten: (() => void) | null = null

        startZoteroWatch(dataDir).catch((e) => {
            const msg = e instanceof Error ? e.message : 'Zotero 监听启动失败'
            console.error(msg)
        })

        listen('matrixit://zotero-changed', () => {
            if (zoteroWatchTimerRef.current) window.clearTimeout(zoteroWatchTimerRef.current)
            zoteroWatchTimerRef.current = window.setTimeout(() => {
                zoteroWatchTimerRef.current = null
                void refreshLibrary('auto')
            }, 800)
        })
            .then((fn) => {
                unlisten = fn
            })
            .catch((e) => {
                const msg = e instanceof Error ? e.message : 'Zotero 监听订阅失败'
                console.error(msg)
            })

        return () => {
            if (unlisten) unlisten()
            if (zoteroWatchTimerRef.current) window.clearTimeout(zoteroWatchTimerRef.current)
            zoteroWatchTimerRef.current = null
            void stopZoteroWatch().catch(() => null)
        }
    }, [refreshLibrary, zoteroStatus.connected, zoteroStatus.path])
}
