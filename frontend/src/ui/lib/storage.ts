/**
 * LocalStorage 工具函数
 * 提供类型安全的 localStorage 操作封装
 */

import type { CollectionNode, LiteratureItem } from '../../types'

export const STORAGE_KEYS = {
    LIBRARY_CACHE: 'matrixit.library.cache.v1',
    ACTIVE_COLLECTION: 'matrixit.ui.activeCollectionKey',
    ACTIVE_VIEW: 'matrixit.ui.activeView',
} as const

export type LibraryCachePayload = {
    savedAt: number
    collections: CollectionNode[]
    items: LiteratureItem[]
}

/**
 * 读取文献库缓存
 */
export const readLibraryCache = (): LibraryCachePayload | null => {
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.LIBRARY_CACHE)
        if (!raw) return null
        const parsed = JSON.parse(raw) as Partial<LibraryCachePayload>
        if (!parsed || !Array.isArray(parsed.collections) || !Array.isArray(parsed.items)) return null
        return {
            savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
            collections: parsed.collections as CollectionNode[],
            items: parsed.items as LiteratureItem[],
        }
    } catch {
        return null
    }
}

/**
 * 写入文献库缓存
 */
export const writeLibraryCache = (payload: LibraryCachePayload) => {
    try {
        localStorage.setItem(STORAGE_KEYS.LIBRARY_CACHE, JSON.stringify(payload))
    } catch {
        return
    }
}

/**
 * 读取字符串值
 */
export const readString = (key: string): string | null => {
    try {
        const v = localStorage.getItem(key)
        return v && v.trim().length > 0 ? v : null
    } catch {
        return null
    }
}

/**
 * 写入字符串值
 */
export const writeString = (key: string, value: string) => {
    try {
        localStorage.setItem(key, value)
    } catch {
        return
    }
}

/**
 * 删除键
 */
export const deleteKey = (key: string) => {
    try {
        localStorage.removeItem(key)
    } catch {
        return
    }
}
