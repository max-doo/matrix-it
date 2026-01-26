/**
 * 引用生成和缓存管理 Hook
 */

import { useState, useCallback, useRef } from 'react'
import { message } from 'antd'
import type { LiteratureItem } from '../../types'
import { formatCitations } from '../../lib/backend'

export function useCitationManager<T extends { items: LiteratureItem[] }>(
    library: T,
    setLibrary: React.Dispatch<React.SetStateAction<T>>
) {
    const [citationsTick, setCitationsTick] = useState(0)
    const [detailCitationState, setDetailCitationState] = useState<{ loading: boolean; error: string | null }>({
        loading: false,
        error: null,
    })
    const citationCacheRef = useRef<Map<string, { dateModified: unknown; text: string }>>(new Map())
    const citationsInFlightRef = useRef<Set<string>>(new Set())

    const applyCitationsToLibrary = useCallback(
        (citations: Record<string, string>) => {
            const entries = Object.entries(citations).filter(([, v]) => typeof v === 'string' && v.trim().length > 0)
            if (entries.length === 0) return
            setLibrary((prev) => {
                const byKey = new Map(entries)
                return {
                    ...prev,
                    items: prev.items.map((it) => {
                        const next = byKey.get(it.item_key)
                        if (!next) return it
                        return { ...(it as Record<string, unknown>), citation: next } as unknown as LiteratureItem
                    }),
                }
            })
        },
        [setLibrary]
    )

    const ensureCitations = useCallback(
        async (itemKeys: string[]) => {
            const uniq = Array.from(new Set(itemKeys.map((k) => String(k || '').trim()).filter(Boolean)))
            if (uniq.length === 0) return false

            const byKey = new Map(library.items.map((it) => [it.item_key, it]))
            const toFetch: string[] = []
            for (const k of uniq) {
                if (citationsInFlightRef.current.has(k)) continue
                const it = byKey.get(k)
                const dm = (it as unknown as Record<string, unknown> | undefined)?.date_modified
                const existingText = (it as unknown as Record<string, unknown> | undefined)?.citation
                if (typeof existingText === 'string' && existingText.trim().length > 0) {
                    citationCacheRef.current.set(k, { dateModified: dm, text: existingText })
                    continue
                }
                const cached = citationCacheRef.current.get(k)
                if (cached && cached.text && cached.dateModified === dm) continue
                toFetch.push(k)
            }

            if (toFetch.length === 0) return true
            for (const k of toFetch) citationsInFlightRef.current.add(k)
            setCitationsTick((x) => x + 1)
            try {
                for (let i = 0; i < toFetch.length; i += 40) {
                    const batch = toFetch.slice(i, i + 40)
                    const res = await formatCitations(batch)
                    const citations = res?.citations ?? {}
                    for (const [k, text] of Object.entries(citations)) {
                        const it = byKey.get(k)
                        const dm = (it as unknown as Record<string, unknown> | undefined)?.date_modified
                        if (typeof text === 'string' && text.trim().length > 0)
                            citationCacheRef.current.set(k, { dateModified: dm, text })
                    }
                    applyCitationsToLibrary(citations)
                }
                return true
            } catch (e) {
                const msg = e instanceof Error ? e.message : '引用生成失败'
                message.error(msg)
                return false
            } finally {
                for (const k of toFetch) citationsInFlightRef.current.delete(k)
                setCitationsTick((x) => x + 1)
            }
        },
        [applyCitationsToLibrary, library.items]
    )

    return {
        citationsTick,
        detailCitationState,
        setDetailCitationState,
        citationCacheRef,
        citationsInFlightRef,
        ensureCitations,
    }
}
