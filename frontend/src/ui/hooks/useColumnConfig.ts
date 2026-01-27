/**
 * 列配置管理 Hook
 * 管理表格列的显示/隐藏/排序配置
 */

import { useCallback, useMemo } from 'react'
import { message } from 'antd'
import type { LiteratureTableColumnOption } from '../components/LiteratureTable'
import { saveConfig } from '../../lib/backend'
import { DEFAULT_META_COLUMN_ORDER } from '../defaults/metaColumnOrder'

export function useColumnConfig(
    rawConfig: Record<string, unknown>,
    setRawConfig: React.Dispatch<React.SetStateAction<Record<string, unknown>>>,
    metaFieldDefs: Record<string, unknown>,
    analysisFieldDefs: Record<string, unknown>,
    activeView: string
) {
    const uiTableColumns = useMemo(() => {
        const ui = rawConfig.ui
        if (ui && typeof ui === 'object' && (ui as Record<string, unknown>).table_columns) {
            return (ui as Record<string, unknown>).table_columns as Record<string, unknown>
        }
        return {}
    }, [rawConfig.ui])

    const readVisibleKeys = useCallback(
        (uiObj: Record<string, unknown>, allKeys: string[], defaultVisible: string[], requireTitle: boolean) => {
            const normalizedDefault = requireTitle
                ? ['title', ...defaultVisible.filter((k) => allKeys.includes(k) && k !== 'title')]
                : defaultVisible.filter((k) => allKeys.includes(k))

            const visibleRaw = uiObj.visible
            if (Array.isArray(visibleRaw)) {
                const v = (visibleRaw as unknown[])
                    .map((x) => (typeof x === 'string' ? x : ''))
                    .map((s) => s.trim())
                    .filter((k) => k && allKeys.includes(k))
                const uniq: string[] = []
                for (const k of v) if (!uniq.includes(k)) uniq.push(k)
                if (requireTitle && !uniq.includes('title')) uniq.unshift('title')
                return uniq
            }

            const orderRaw = uiObj.order
            const hiddenRaw = uiObj.hidden
            const order = Array.isArray(orderRaw) ? (orderRaw as string[]).filter((k) => allKeys.includes(k)) : allKeys
            const hidden = new Set(Array.isArray(hiddenRaw) ? (hiddenRaw as string[]).filter((k) => allKeys.includes(k)) : [])
            hidden.delete('title')
            const mergedOrder = [...order, ...allKeys.filter((k) => !order.includes(k))]
            const fromLegacy = requireTitle
                ? ['title', ...mergedOrder.filter((k) => k !== 'title' && !hidden.has(k))]
                : mergedOrder.filter((k) => !hidden.has(k))
            if (fromLegacy.length > 0) return fromLegacy

            return normalizedDefault
        },
        []
    )

    const saveTableColumnsUi = useCallback(
        async (next: { metaVisible?: string[]; analysisVisible?: string[] }) => {
            const ui = ((rawConfig.ui as Record<string, unknown>) ?? {}) as Record<string, unknown>
            const tableColumns = ((ui.table_columns as Record<string, unknown>) ?? {}) as Record<string, unknown>
            const zoteroUi = ((tableColumns.zotero as Record<string, unknown>) ?? {}) as Record<string, unknown>
            const matrixUi = ((tableColumns.matrix as Record<string, unknown>) ?? {}) as Record<string, unknown>

            const nextZotero =
                next.metaVisible && activeView === 'zotero'
                    ? {
                        ...zoteroUi,
                        meta: { visible: next.metaVisible },
                    }
                    : zoteroUi

            const prevMatrixMeta = ((matrixUi.meta as Record<string, unknown>) ?? {}) as Record<string, unknown>
            const prevMatrixAnalysis = ((matrixUi.analysis as Record<string, unknown>) ?? {}) as Record<string, unknown>

            const nextMatrix = {
                ...matrixUi,
                ...(next.metaVisible && activeView === 'matrix'
                    ? {
                        meta: { ...prevMatrixMeta, visible: next.metaVisible },
                    }
                    : {}),
                ...(next.analysisVisible
                    ? {
                        analysis: { ...prevMatrixAnalysis, visible: next.analysisVisible },
                    }
                    : {}),
            }

            const nextConfig: Record<string, unknown> = {
                ...rawConfig,
                ui: {
                    ...ui,
                    table_columns: {
                        ...tableColumns,
                        zotero: nextZotero,
                        matrix: nextMatrix,
                    },
                },
            }

            const res = await saveConfig(nextConfig)
            if (!res.saved) {
                message.error('保存失败：请检查运行环境与文件权限')
                return
            }
            setRawConfig(nextConfig)
        },
        [activeView, rawConfig, setRawConfig]
    )

    const metaColumnPanel = useMemo(() => {
        const primaryKeys = ['title', 'author', 'year', 'type', 'publications', 'tags']
        const allKeys = primaryKeys.filter((k) => {
            if (activeView === 'matrix' && k === 'tags') return false
            if (['year', 'author', 'type', 'publications'].includes(k)) return true
            return k in metaFieldDefs || k === 'tags'
        })
        const defaultVisible = DEFAULT_META_COLUMN_ORDER.filter((k) => allKeys.includes(k))
        const viewUi = (uiTableColumns as Record<string, unknown>)[activeView] as Record<string, unknown> | undefined
        const metaUi = (viewUi?.meta as Record<string, unknown>) ?? {}
        const visible = readVisibleKeys(metaUi, allKeys, defaultVisible, true)
        const hidden = new Set(allKeys.filter((k) => k !== 'title' && !visible.includes(k)))
        const mergedOrder = [...visible.filter((k) => k !== 'title'), ...allKeys.filter((k) => k !== 'title' && !visible.includes(k))]
        return { keys: mergedOrder, hidden, allKeys }
    }, [activeView, metaFieldDefs, readVisibleKeys, uiTableColumns])

    const analysisColumnPanel = useMemo(() => {
        if (activeView !== 'matrix') return { keys: [] as string[], hidden: new Set<string>(), allKeys: [] as string[] }
        const allKeys = Object.keys(analysisFieldDefs)
        const viewUi = (uiTableColumns as Record<string, unknown>)[activeView] as Record<string, unknown> | undefined
        const analysisUi = (viewUi?.analysis as Record<string, unknown>) ?? {}
        const visible = readVisibleKeys(analysisUi, allKeys, allKeys, false)
        const hidden = new Set(allKeys.filter((k) => !visible.includes(k)))
        const mergedOrder = [...visible, ...allKeys.filter((k) => !visible.includes(k))]
        return { keys: mergedOrder, hidden, allKeys }
    }, [activeView, analysisFieldDefs, readVisibleKeys, uiTableColumns])

    const matrixAnalysisSettingsOrder = useMemo(() => {
        if (activeView !== 'matrix') return [] as string[]
        const allKeys = Object.keys(analysisFieldDefs)
        const matrixUi = (uiTableColumns.matrix as Record<string, unknown>) ?? {}
        const analysisUi = (matrixUi.analysis as Record<string, unknown>) ?? {}
        const orderRaw = analysisUi.order
        const order = Array.isArray(orderRaw)
            ? (orderRaw as unknown[])
                .map((x) => String(x || '').trim())
                .filter((k) => k.length > 0 && allKeys.includes(k))
            : []
        return [...order, ...allKeys.filter((k) => !order.includes(k))]
    }, [activeView, analysisFieldDefs, uiTableColumns.matrix])

    const matrixAnalysisOrder = useMemo(() => {
        const allKeys = Object.keys(analysisFieldDefs)
        const matrixUi = (uiTableColumns.matrix as Record<string, unknown>) ?? {}
        const analysisUi = (matrixUi.analysis as Record<string, unknown>) ?? {}
        const visible = readVisibleKeys(analysisUi, allKeys, allKeys, false)
        const orderRaw = analysisUi.order
        const order = Array.isArray(orderRaw)
            ? (orderRaw as unknown[])
                .map((x) => String(x || '').trim())
                .filter((k) => k.length > 0 && allKeys.includes(k))
            : allKeys
        const orderedAll = [...order, ...allKeys.filter((k) => !order.includes(k))]
        const rest = orderedAll.filter((k) => !visible.includes(k))
        return [...visible, ...rest]
    }, [analysisFieldDefs, readVisibleKeys, uiTableColumns.matrix])

    const applyMetaPanelChange = useCallback(
        async (nextKeys: string[], nextHidden: Set<string>) => {
            const allKeys = metaColumnPanel.allKeys
            const visible = ['title', ...nextKeys.filter((k) => allKeys.includes(k) && k !== 'title' && !nextHidden.has(k))]
            await saveTableColumnsUi({ metaVisible: visible })
        },
        [metaColumnPanel.allKeys, saveTableColumnsUi]
    )

    const applyAnalysisPanelChange = useCallback(
        async (nextKeys: string[], nextHidden: Set<string>) => {
            const allKeys = analysisColumnPanel.allKeys
            const visible = nextKeys.filter((k) => allKeys.includes(k) && !nextHidden.has(k))
            await saveTableColumnsUi({ analysisVisible: visible })
        },
        [analysisColumnPanel.allKeys, saveTableColumnsUi]
    )

    const getFieldName = useCallback((defs: Record<string, unknown>, key: string) => {
        const def = (defs[key] ?? {}) as Record<string, unknown>
        const name = typeof def.name === 'string' ? def.name.trim() : ''
        return name.length > 0 ? name : key
    }, [])

    const tableMetaColumns = useMemo<LiteratureTableColumnOption[]>(() => {
        const primaryKeys = ['title', 'author', 'year', 'type', 'publications', 'tags']
        const allKeys = primaryKeys.filter((k) => {
            if (activeView === 'matrix' && k === 'tags') return false
            if (['year', 'author', 'type', 'publications'].includes(k)) return true
            return k in metaFieldDefs || k === 'tags'
        })
        const defaultVisible = DEFAULT_META_COLUMN_ORDER.filter((k) => allKeys.includes(k))
        const viewUi = (uiTableColumns as Record<string, unknown>)[activeView] as Record<string, unknown> | undefined
        const metaUi = (viewUi?.meta as Record<string, unknown>) ?? {}
        const visible = readVisibleKeys(metaUi, allKeys, defaultVisible, true)
        return visible.map((key) => {
            if (key === 'tags') return { key: 'tags', label: '标签' }
            const def = ((metaFieldDefs as Record<string, unknown>)[key] ?? {}) as Record<string, unknown>
            const label = typeof def.name === 'string' && def.name.trim().length > 0 ? def.name.trim() : key
            return { key, label }
        })
    }, [activeView, metaFieldDefs, readVisibleKeys, uiTableColumns])

    const tableAnalysisColumns = useMemo<LiteratureTableColumnOption[]>(() => {
        if (activeView !== 'matrix') return []
        const allKeys = Object.keys(analysisFieldDefs)
        const viewUi = (uiTableColumns as Record<string, unknown>)[activeView] as Record<string, unknown> | undefined
        const analysisUi = (viewUi?.analysis as Record<string, unknown>) ?? {}
        const visible = readVisibleKeys(analysisUi, allKeys, allKeys, false)
        return visible.map((key) => {
            const def = ((analysisFieldDefs as Record<string, unknown>)[key] ?? {}) as Record<string, unknown>
            const label = typeof def.name === 'string' && def.name.trim().length > 0 ? def.name.trim() : key
            return { key, label }
        })
    }, [activeView, analysisFieldDefs, readVisibleKeys, uiTableColumns])

    const citationColumnVisible = useMemo(() => tableMetaColumns.some((c) => c.key === 'citation'), [tableMetaColumns])

    return {
        metaColumnPanel,
        analysisColumnPanel,
        matrixAnalysisSettingsOrder,
        matrixAnalysisOrder,
        applyMetaPanelChange,
        applyAnalysisPanelChange,
        getFieldName,
        tableMetaColumns,
        tableAnalysisColumns,
        citationColumnVisible,
    }
}
