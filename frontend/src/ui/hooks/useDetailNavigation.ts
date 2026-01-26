/**
 * 详情页导航 Logic Hook
 * 管理当前选中的文献详情，以及上一条/下一条的导航逻辑
 */

import { useMemo, useCallback } from 'react'
import type { LiteratureItem } from '../../types'

export function useDetailNavigation(
    items: LiteratureItem[],
    filteredItems: LiteratureItem[],
    tableSortedKeys: string[],
    activeItemKey: string | null,
    setActiveItemKey: (key: string | null) => void
) {
    const activeItem = useMemo(
        () => (activeItemKey ? items.find((it) => it.item_key === activeItemKey) ?? null : null),
        [activeItemKey, items]
    )

    const filteredItemKeys = useMemo(() => {
        return filteredItems
            .map((it) => it.item_key)
            .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
    }, [filteredItems])

    const detailNavKeys = useMemo(() => {
        if (tableSortedKeys.length === filteredItemKeys.length) {
            const pool = new Set(filteredItemKeys)
            if (tableSortedKeys.every((k) => pool.has(k))) return tableSortedKeys
        }
        return filteredItemKeys
    }, [filteredItemKeys, tableSortedKeys])

    const activeItemIndex = useMemo(() => {
        if (!activeItemKey) return -1
        return detailNavKeys.indexOf(activeItemKey)
    }, [activeItemKey, detailNavKeys])

    const canPrevDetail = activeItemIndex > 0
    const canNextDetail = activeItemIndex >= 0 && activeItemIndex < detailNavKeys.length - 1

    const goPrevDetail = useCallback(() => {
        if (!canPrevDetail) return
        const prevKey = detailNavKeys[activeItemIndex - 1]
        if (prevKey) setActiveItemKey(prevKey)
    }, [activeItemIndex, canPrevDetail, detailNavKeys, setActiveItemKey])

    const goNextDetail = useCallback(() => {
        if (!canNextDetail) return
        const nextKey = detailNavKeys[activeItemIndex + 1]
        if (nextKey) setActiveItemKey(nextKey)
    }, [activeItemIndex, canNextDetail, detailNavKeys, setActiveItemKey])

    return {
        activeItem,
        canPrevDetail,
        canNextDetail,
        goPrevDetail,
        goNextDetail,
    }
}
