/**
 * 集合相关工具函数
 */

import type { CollectionNode, LiteratureItem } from '../../types'

/**
 * 递归收集所有集合的 key
 */
export const collectCollectionKeys = (nodes: CollectionNode[]): Set<string> => {
    const out = new Set<string>()
    const stack = [...nodes]
    while (stack.length) {
        const n = stack.pop()
        if (!n) continue
        out.add(n.key)
        if (Array.isArray(n.children) && n.children.length) stack.push(...n.children)
    }
    return out
}

export const normalizeSearchText = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')

export const fuzzySubsequenceMatch = (target: string, query: string) => {
    if (!query) return true
    if (!target) return false
    if (query.length > target.length) return false
    let qi = 0
    for (let ti = 0; ti < target.length; ti += 1) {
        if (target[ti] === query[qi]) qi += 1
        if (qi >= query.length) return true
    }
    return false
}

export type CollectionItemIndex = {
    countByKey: Map<string, number>
    titleIndex: Array<{ titleNorm: string; collectionKeys: string[] }>
}

export const buildCollectionItemIndex = (items: LiteratureItem[]): CollectionItemIndex => {
    const countByKey = new Map<string, number>()
    const titleIndex: Array<{ titleNorm: string; collectionKeys: string[] }> = []

    for (const it of items) {
        const keySet = new Set<string>()
        for (const c of it.collections ?? []) {
            if (c?.key) keySet.add(String(c.key))
            for (const k of c?.pathKeyChain ?? []) {
                if (k) keySet.add(String(k))
            }
        }

        if (keySet.size > 0) {
            for (const k of keySet) {
                countByKey.set(k, (countByKey.get(k) ?? 0) + 1)
            }
        }

        const titleNorm = normalizeSearchText(it.title)
        titleIndex.push({ titleNorm, collectionKeys: Array.from(keySet) })
    }

    return { countByKey, titleIndex }
}
