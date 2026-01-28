/**
 * 筛选和搜索状态管理 Hook
 */

import { useState, useMemo, useRef } from 'react'
import type { FilterMode, LiteratureItem } from '../../types'

export type FieldFilterState = {
    match: 'all' | 'any'
    yearOp: 'eq' | 'gt' | 'lt'
    year: string
    type: string
    publications: string
    tags: string[]
    keywords: string[]
    bibType: string
}

export function useFilterState(activeView: string) {
    const [filterMode, setFilterMode] = useState<FilterMode>(() => (activeView === 'matrix' ? 'processed' : 'all'))
    const zoteroFilterModeRef = useRef<FilterMode>('all')
    const [filterPopoverOpen, setFilterPopoverOpen] = useState(false)
    const [fieldFilter, setFieldFilter] = useState<FieldFilterState>({
        match: 'all',
        yearOp: 'eq',
        year: '',
        type: '',
        publications: '',
        tags: [],
        keywords: [],
        bibType: '',
    })
    const [searchQuery, setSearchQuery] = useState('')
    const [searchPopoverOpen, setSearchPopoverOpen] = useState(false)
    const searchInputElRef = useRef<HTMLInputElement | null>(null)

    const normalizedSearchQuery = useMemo(() => searchQuery.trim().toLowerCase().replace(/\s+/g, ' '), [searchQuery])

    return {
        filterMode,
        setFilterMode,
        zoteroFilterModeRef,
        filterPopoverOpen,
        setFilterPopoverOpen,
        fieldFilter,
        setFieldFilter,
        searchQuery,
        setSearchQuery,
        normalizedSearchQuery,
        searchPopoverOpen,
        setSearchPopoverOpen,
        searchInputElRef,
    }
}

/**
 * 根据集合筛选文献列表
 */
export function useCollectionItems(library: { items: LiteratureItem[] }, activeCollectionKey: string | null) {
    return useMemo(() => {
        const isAnnotation = (it: LiteratureItem) => {
            const t = String(it.type ?? it.item_type ?? '').trim().toLowerCase()
            return t === 'annotation'
        }
        return activeCollectionKey
            ? library.items.filter((it) =>
                (it.collections ?? []).some((c) => c.key === activeCollectionKey || c.pathKeyChain?.includes(activeCollectionKey))
            )
            : library.items.filter((it) => !isAnnotation(it))
    }, [activeCollectionKey, library.items])
}

/**
 * 筛选逻辑：根据当前筛选条件过滤文献列表
 */
export function useFilteredItems(
    collectionItems: LiteratureItem[],
    filterMode: FilterMode,
    fieldFilter: FieldFilterState,
    normalizedSearchQuery: string,
    activeView?: string,
    matrixSearchAnalysisKeys?: string[]
) {
    return useMemo(() => {
        const normalizeText = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
        const excludedSearchKeys = new Set(['key_word', 'type', 'bib_type'])

        // 1. 按处理状态筛选
        const byStatus =
            filterMode === 'all'
                ? collectionItems
                : filterMode === 'unprocessed'
                    ? collectionItems.filter((it) => it.processed_status !== 'done' && it.processed_status !== 'reanalyzing')
                    : collectionItems.filter((it) => it.processed_status === 'done' || it.processed_status === 'reanalyzing')

        // 2. 按字段筛选
        const predicates: Array<(it: LiteratureItem) => boolean> = []

        // 年份筛选
        const yearRaw = fieldFilter.year.trim()
        if (yearRaw) {
            const targetYear = Number.parseInt(yearRaw, 10)
            if (Number.isFinite(targetYear)) {
                predicates.push((it) => {
                    const raw = String((it as unknown as Record<string, unknown>).year ?? '')
                    const y = Number.parseInt(raw.replace(/[^\d]/g, ''), 10)
                    if (!Number.isFinite(y)) return false
                    if (fieldFilter.yearOp === 'gt') return y > targetYear
                    if (fieldFilter.yearOp === 'lt') return y < targetYear
                    return y === targetYear
                })
            }
        }

        // bib_type 筛选
        const bibTypeRaw = fieldFilter.bibType.trim()
        if (bibTypeRaw) {
            const target = normalizeText(bibTypeRaw)
            predicates.push((it) => {
                const v = ((it as unknown as Record<string, unknown>).bib_type ?? '') as unknown
                return normalizeText(v) === target
            })
        }

        // type 筛选
        const typeRaw = fieldFilter.type.trim()
        if (typeRaw) {
            const target = normalizeText(typeRaw)
            predicates.push((it) => {
                const v = ((it as unknown as Record<string, unknown>).type ?? it.bib_type ?? '') as unknown
                return normalizeText(v) === target
            })
        }

        // 出版物筛选
        const pubRaw = fieldFilter.publications.trim()
        if (pubRaw) {
            const target = normalizeText(pubRaw)
            predicates.push((it) => {
                const v = ((it as unknown as Record<string, unknown>).publications ?? '') as unknown
                return normalizeText(v).includes(target)
            })
        }

        // 标签筛选
        if (fieldFilter.tags.length > 0) {
            const targetSet = new Set(fieldFilter.tags)
            predicates.push((it) => {
                const metaExtra = (it as Record<string, unknown>).meta_extra
                const tags = metaExtra && typeof metaExtra === 'object' ? (metaExtra as Record<string, unknown>).tags : null
                if (!Array.isArray(tags)) return false
                return tags.some((t) => targetSet.has(String(t || '').trim()))
            })
        }

        // 关键词筛选
        if (fieldFilter.keywords.length > 0) {
            const targetSet = new Set(fieldFilter.keywords)
            predicates.push((it) => {
                const val = (it as Record<string, unknown>).key_word
                let currentKeywords: string[] = []
                if (Array.isArray(val)) {
                    currentKeywords = val.map((x) => String(x || '').trim()).filter(Boolean)
                } else if (typeof val === 'string' && val.trim().length > 0) {
                    currentKeywords = val.split(/[,，;；\n]/).map((s) => s.trim()).filter(Boolean)
                }
                return currentKeywords.some((k) => targetSet.has(k))
            })
        }

        const byFieldFilter =
            predicates.length === 0
                ? byStatus
                : byStatus.filter((it) => (fieldFilter.match === 'all' ? predicates.every((p) => p(it)) : predicates.some((p) => p(it))))

        // 3. 按搜索关键词筛选
        if (!normalizedSearchQuery) return byFieldFilter

        return byFieldFilter.filter((it) => {
            const title = normalizeText(it.title)
            const author = normalizeText(it.author)
            if (title.includes(normalizedSearchQuery) || author.includes(normalizedSearchQuery)) return true

            if (activeView !== 'matrix') return false
            if (!Array.isArray(matrixSearchAnalysisKeys) || matrixSearchAnalysisKeys.length === 0) return false

            for (const k of matrixSearchAnalysisKeys) {
                const key = String(k || '').trim()
                if (!key || excludedSearchKeys.has(key)) continue

                const raw = (it as unknown as Record<string, unknown>)[key]
                if (raw === null || raw === undefined || raw === '') continue

                let text = ''
                if (Array.isArray(raw)) text = raw.filter((x) => x !== null && x !== undefined).map((x) => String(x)).join(' ')
                else if (typeof raw === 'object') text = JSON.stringify(raw)
                else text = String(raw)

                if (normalizeText(text).includes(normalizedSearchQuery)) return true
            }
            return false
        })
    }, [collectionItems, filterMode, fieldFilter, normalizedSearchQuery, activeView, matrixSearchAnalysisKeys])
}

/**
 * 生成筛选选项（年份、类型、标签等）
 */
export function useFilterOptions(collectionItems: LiteratureItem[]) {
    const filterYearOptions = useMemo(() => {
        const years = new Set<number>()
        for (const it of collectionItems) {
            const raw = String((it as unknown as Record<string, unknown>).year ?? '').replace(/[^\d]/g, '')
            const y = Number.parseInt(raw, 10)
            if (Number.isFinite(y)) years.add(y)
        }
        return Array.from(years)
            .sort((a, b) => b - a)
            .map((y) => ({ label: String(y), value: String(y) }))
    }, [collectionItems])

    const filterTypeOptions = useMemo(() => {
        const types = new Set<string>()
        for (const it of collectionItems) {
            const raw = String(((it as unknown as Record<string, unknown>).type ?? it.bib_type ?? '') as unknown)
                .trim()
                .replace(/\s+/g, ' ')
            if (raw) types.add(raw)
        }
        return Array.from(types)
            .sort((a, b) => a.localeCompare(b, 'zh-CN'))
            .map((t) => ({ value: t, label: t }))
    }, [collectionItems])

    const filterTagOptions = useMemo(() => {
        const allTags = new Set<string>()
        for (const it of collectionItems) {
            const metaExtra = (it as Record<string, unknown>).meta_extra
            const tags = metaExtra && typeof metaExtra === 'object' ? (metaExtra as Record<string, unknown>).tags : null
            if (Array.isArray(tags)) {
                for (const t of tags) {
                    const s = String(t || '').trim()
                    if (s) allTags.add(s)
                }
            }
        }
        return Array.from(allTags)
            .sort((a, b) => a.localeCompare(b, 'zh-CN'))
            .map((t) => ({ value: t, label: t }))
    }, [collectionItems])

    const filterKeywordOptions = useMemo(() => {
        const allKeywords = new Set<string>()
        for (const it of collectionItems) {
            const val = (it as Record<string, unknown>).key_word
            if (Array.isArray(val)) {
                for (const k of val) {
                    const s = String(k || '').trim()
                    if (s) allKeywords.add(s)
                }
            } else if (typeof val === 'string' && val.trim().length > 0) {
                const parts = val.split(/[,，;；\n]/).map((s) => s.trim()).filter(Boolean)
                for (const p of parts) allKeywords.add(p)
            }
        }
        return Array.from(allKeywords)
            .sort((a, b) => a.localeCompare(b, 'zh-CN'))
            .map((t) => ({ value: t, label: t }))
    }, [collectionItems])

    const filterBibTypeOptions = useMemo(() => {
        const types = new Set<string>()
        for (const it of collectionItems) {
            const raw = String(((it as unknown as Record<string, unknown>).bib_type ?? '') as unknown)
                .trim()
                .replace(/\s+/g, ' ')
            if (raw) types.add(raw)
        }
        return Array.from(types)
            .sort((a, b) => a.localeCompare(b, 'zh-CN'))
            .map((t) => ({ value: t, label: t }))
    }, [collectionItems])

    return {
        filterYearOptions,
        filterTypeOptions,
        filterTagOptions,
        filterKeywordOptions,
        filterBibTypeOptions,
    }
}
