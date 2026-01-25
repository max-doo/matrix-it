/**
 * 集合相关工具函数
 */

import type { CollectionNode } from '../../types'

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
