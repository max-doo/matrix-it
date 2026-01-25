/**
 * 详情页导航 Logic Hook
 * 管理当前选中的文献详情，以及上一条/下一条的导航逻辑
 */

import { useState, useMemo, useCallback } from 'react'
import type { LiteratureItem } from '../../types'
import type { LibraryState } from './useLibraryState'

export function useDetailNavigation(
    library: LibraryState,
    filteredItems: LiteratureItem[]
) {
    const [activeItemKey, setActiveItemKey] = useState<string | null>(null)

    const activeItem = useMemo(
        () => (activeItemKey ? library.items.find((it) => it.item_key === activeItemKey) ?? null : null),
        [activeItemKey, library.items]
    )

    const activeItemIndex = useMemo(() => {
        if (!activeItemKey) return -1
        // 注意：如果在过滤后的列表中找不到当前 activeItemKey（例如过滤条件变了导致当前条目不可见），
        // 这里的 index 会是 -1。这符合预期，此时上一条/下一条可能不可用或行为改变。
        return filteredItems.findIndex((it) => it.item_key === activeItemKey)
    }, [activeItemKey, filteredItems])

    const canPrevDetail = activeItemIndex > 0
    const canNextDetail = activeItemIndex >= 0 && activeItemIndex < filteredItems.length - 1

    const goPrevDetail = useCallback(() => {
        if (!canPrevDetail) return
        const prevKey = filteredItems[activeItemIndex - 1]?.item_key
        if (prevKey) setActiveItemKey(prevKey)
    }, [activeItemIndex, canPrevDetail, filteredItems])

    const goNextDetail = useCallback(() => {
        if (!canNextDetail) return
        const nextKey = filteredItems[activeItemIndex + 1]?.item_key
        if (nextKey) setActiveItemKey(nextKey)
    }, [activeItemIndex, canNextDetail, filteredItems])

    return {
        activeItemKey,
        setActiveItemKey,
        activeItem,
        canPrevDetail,
        canNextDetail,
        goPrevDetail,
        goNextDetail
    }
}
