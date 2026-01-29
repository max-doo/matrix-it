/**
 * 应用配置管理 Hook
 * 负责管理设置页面的所有状态、表单交互、数据读写和自动保存逻辑。
 */

import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { Form, message } from 'antd'
import { homeDir } from '@tauri-apps/api/path'
import { readConfig, saveConfig } from '../../lib/backend'
import type { AnalysisFieldRow } from '../../types'
import type { SettingsScrollApi, SettingsSectionKey } from '../components/SettingsPage'

export function useAppConfig(mode: 'workbench' | 'settings') {
    const [rawConfig, setRawConfig] = useState<Record<string, unknown>>({})
    const [rawFields, setRawFields] = useState<Record<string, unknown>>({})
    const [configForm] = Form.useForm()
    const [fieldsForm] = Form.useForm()

    // UI Refs
    const settingsScrollApiRef = useRef<SettingsScrollApi | null>(null)
    const settingsHydratingRef = useRef(false)
    const autoSaveTimerRef = useRef<number | null>(null)

    // UI States
    const [zoteroStatus, setZoteroStatus] = useState<{ path: string; connected: boolean }>({ path: '未配置', connected: false })
    const [settingsSection, setSettingsSection] = useState<SettingsSectionKey>('zotero')
    const [settingsLoading, setSettingsLoading] = useState(false)
    const [settingsSaving, setSettingsSaving] = useState(false)

    // --- Helpers ---

    const guessDefaultZoteroDir = useCallback(async () => {
        try {
            const hd = await homeDir()
            const base = String(hd ?? '').replace(/[\\/]+$/, '')
            if (!base) return ''
            return `${base}\\Zotero`
        } catch {
            return ''
        }
    }, [])

    const buildNextConfig = useCallback((nextPartial: Record<string, unknown>) => {
        const prev = rawConfig
        const prevZotero = (prev.zotero as Record<string, unknown>) ?? {}
        const prevLlm = (prev.llm as Record<string, unknown>) ?? {}
        const prevFeishu = (prev.feishu as Record<string, unknown>) ?? {}
        const prevFields = (prev.fields as Record<string, unknown>) ?? {}
        const prevUi = (prev.ui as Record<string, unknown>) ?? {}
        const nextZotero = (nextPartial.zotero as Record<string, unknown>) ?? {}
        const nextLlm = (nextPartial.llm as Record<string, unknown>) ?? {}
        const nextFeishu = (nextPartial.feishu as Record<string, unknown>) ?? {}
        const nextFields = (nextPartial.fields as Record<string, unknown>) ?? {}
        const nextUi = (nextPartial.ui as Record<string, unknown>) ?? {}
        return {
            ...prev,
            ...nextPartial,
            zotero: { ...prevZotero, ...nextZotero },
            llm: { ...prevLlm, ...nextLlm },
            feishu: { ...prevFeishu, ...nextFeishu },
            fields: { ...prevFields, ...nextFields },
            ui: { ...prevUi, ...nextUi },
        }
    }, [rawConfig])

    const buildNextFields = useCallback((rows: AnalysisFieldRow[]) => {
        const normalizeFieldType = (keyRaw: unknown) => {
            const k = String(keyRaw ?? '').trim()
            if (k === 'bib_type') return 'select'
            if (k === 'key_word') return 'multi_select'
            return 'string'
        }

        const deduped = rows
            .map((r) => ({
                key: String(r.key ?? '').trim(),
                description: String(r.description ?? '').trim(),
                type: normalizeFieldType(r.key),
                rule: String(r.rule ?? '').trim(),
                name: String(r.name ?? '').trim(),
            }))
            .filter((r) => r.key.length > 0)

        const seen = new Set<string>()
        for (const r of deduped) {
            if (seen.has(r.key)) {
                throw new Error(`重复字段 key：${r.key}`)
            }
            seen.add(r.key)
        }

        const nextAnalysis: Record<string, unknown> = {}
        for (const r of deduped) {
            nextAnalysis[r.key] = {
                description: r.description,
                type: r.type,
                rule: r.rule || undefined,
                name: r.name || undefined,
            }
        }

        return {
            ...rawFields,
            analysis_fields: nextAnalysis,
        }
    }, [rawFields])

    const buildNextAnalysisOrder = useCallback((rows: AnalysisFieldRow[]) => {
        return rows
            .map((r) => String(r.key ?? '').trim())
            .filter((k) => k.length > 0)
    }, [])

    // --- Core Operations ---

    /**
     * 加载设置页数据
     * 读取后端配置，并回填到 Ant Design Form 表单中。
     */
    const loadSettings = useCallback(async () => {
        setSettingsLoading(true)
        try {
            const cfg = await readConfig()
            const fds = (cfg.fields as Record<string, unknown>) ?? {}
            setRawConfig(cfg)
            setRawFields(fds)
            settingsHydratingRef.current = true
            const zoteroCfg = (cfg.zotero as Record<string, unknown>) ?? {}
            const zoteroDataDir = typeof zoteroCfg.data_dir === 'string' ? zoteroCfg.data_dir : ''
            const defaultZoteroDir = zoteroDataDir || (await guessDefaultZoteroDir())
            configForm.setFieldsValue({
                ...cfg,
                zotero: { ...zoteroCfg, data_dir: defaultZoteroDir },
            })
            setZoteroStatus({ path: defaultZoteroDir || '未配置', connected: !!defaultZoteroDir })
            const analysisFields = (fds.analysis_fields as Record<string, unknown>) ?? {}
            const ui = (cfg.ui as Record<string, unknown>) ?? {}
            const tableColumns = (ui.table_columns as Record<string, unknown>) ?? {}
            const matrixUi = (tableColumns.matrix as Record<string, unknown>) ?? {}
            const analysisUi = (matrixUi.analysis as Record<string, unknown>) ?? {}
            const orderRaw = analysisUi.order

            const byKey = new Map<string, AnalysisFieldRow>(
                Object.entries(analysisFields)
                    .map(([k, v]) => {
                        const obj = (v ?? {}) as Record<string, unknown>
                        const row: AnalysisFieldRow = {
                            key: k,
                            description: typeof obj.description === 'string' ? obj.description : '',
                            type: k === 'bib_type' ? 'select' : k === 'key_word' ? 'multi_select' : 'string',
                            rule: typeof obj.rule === 'string' ? obj.rule : '',
                            name:
                                typeof obj.name === 'string'
                                    ? obj.name
                                    : typeof obj.feishu_field === 'string'
                                        ? obj.feishu_field
                                        : '',
                        }
                        return [k, row] as const
                    })
                    .filter(([k]) => k.trim().length > 0)
            )

            const keys = Array.isArray(orderRaw)
                ? [...(orderRaw as string[]).filter((k) => byKey.has(k)), ...Array.from(byKey.keys()).filter((k) => !(orderRaw as string[]).includes(k))]
                : Array.from(byKey.keys())

            const rows: AnalysisFieldRow[] = keys.map((k) => byKey.get(k) as AnalysisFieldRow).filter((r) => r && r.key.trim().length > 0)
            fieldsForm.setFieldsValue({ analysis_fields: rows })
        } catch (e) {
            const msg = e instanceof Error ? e.message : '加载设置失败'
            message.error(msg)
        } finally {
            settingsHydratingRef.current = false
            setSettingsLoading(false)
        }
    }, [configForm, fieldsForm, guessDefaultZoteroDir])

    /**
     * 设置页操作：保存设置
     */
    const saveSettingsNow = useCallback(async () => {
        if (settingsHydratingRef.current) return
        setSettingsSaving(true)
        try {
            const partial = configForm.getFieldsValue(true) as Record<string, unknown>
            const fieldsValue = fieldsForm.getFieldsValue(true) as { analysis_fields?: AnalysisFieldRow[] }
            const rows = Array.isArray(fieldsValue.analysis_fields) ? fieldsValue.analysis_fields : []
            const nextConfig = buildNextConfig(partial)
            const nextFields = buildNextFields(rows)
            nextConfig.fields = nextFields

            const allowedJsonKeys = new Set<string>(['attachment'])
            for (const section of ['meta_fields', 'analysis_fields', 'attachment_fields'] as const) {
                const defs = (nextFields as Record<string, unknown>)[section]
                if (defs && typeof defs === 'object') {
                    for (const k of Object.keys(defs as Record<string, unknown>)) {
                        const kk = String(k || '').trim()
                        if (kk) allowedJsonKeys.add(kk)
                    }
                }
            }
            const feishu = (nextConfig.feishu as Record<string, unknown>) ?? {}
            const schema = (feishu.schema as Record<string, unknown>) ?? {}
            const schemaFields = schema.fields
            if (schemaFields && typeof schemaFields === 'object' && !Array.isArray(schemaFields)) {
                const nextSchemaFields: Record<string, unknown> = {}
                for (const [k, v] of Object.entries(schemaFields as Record<string, unknown>)) {
                    if (allowedJsonKeys.has(String(k || '').trim())) nextSchemaFields[k] = v
                }
                nextConfig.feishu = { ...feishu, schema: { ...schema, fields: nextSchemaFields } }
            }

            const nextOrder = buildNextAnalysisOrder(rows)
            const ui = (nextConfig.ui as Record<string, unknown>) ?? {}
            const tableColumns = (ui.table_columns as Record<string, unknown>) ?? {}
            const matrix = (tableColumns.matrix as Record<string, unknown>) ?? {}
            const analysis = (matrix.analysis as Record<string, unknown>) ?? {}
            const nextAnalysis = { ...analysis, order: nextOrder }
            nextConfig.ui = {
                ...ui,
                table_columns: {
                    ...tableColumns,
                    matrix: { ...matrix, analysis: nextAnalysis },
                },
            }

            const cfgRes = await saveConfig(nextConfig)
            if (!cfgRes.saved) {
                message.error('保存失败：请检查运行环境与文件权限')
                return
            }

            setRawConfig(nextConfig)
            setRawFields(nextFields)

            const zoteroCfg = (nextConfig.zotero as Record<string, unknown>) ?? {}
            const zoteroDataDir = typeof zoteroCfg.data_dir === 'string' ? zoteroCfg.data_dir : ''
            setZoteroStatus({ path: zoteroDataDir || '未配置', connected: !!zoteroDataDir })
        } catch (e) {
            const msg = e instanceof Error ? e.message : '未知错误'
            message.error(msg)
        } finally {
            setSettingsSaving(false)
        }
    }, [buildNextAnalysisOrder, buildNextConfig, buildNextFields, configForm, fieldsForm])

    const scheduleAutoSaveSettings = useCallback(() => {
        if (settingsHydratingRef.current) return
        if (autoSaveTimerRef.current) window.clearTimeout(autoSaveTimerRef.current)
        autoSaveTimerRef.current = window.setTimeout(() => {
            autoSaveTimerRef.current = null
            void saveSettingsNow()
        }, 500)
    }, [saveSettingsNow])

    // --- Effects ---

    useEffect(() => {
        if (mode === 'settings') {
            loadSettings()
        }
    }, [loadSettings, mode])

    // 初始化时也需要读取部分配置（为了 Zotero 状态）
    useEffect(() => {
        readConfig()
            .then((cfg) => {
                setRawConfig(cfg)
                const fds = (cfg.fields as Record<string, unknown>) ?? {}
                setRawFields(fds)
                const zoteroCfg = (cfg.zotero as Record<string, unknown>) ?? {}
                const zoteroDataDir = typeof zoteroCfg.data_dir === 'string' ? zoteroCfg.data_dir : ''
                setZoteroStatus({ path: zoteroDataDir || '未配置', connected: !!zoteroDataDir })
            })
            .catch(() => {
                return
            })
    }, [])

    // --- Computed fields ---

    const fieldsDef = useMemo(() => {
        const fromCfg = rawConfig.fields
        if (fromCfg && typeof fromCfg === 'object') return fromCfg as Record<string, unknown>
        return rawFields
    }, [rawConfig.fields, rawFields])

    const metaFieldDefs = useMemo(
        () => ((fieldsDef.meta_fields as Record<string, unknown>) ?? {}) as Record<string, unknown>,
        [fieldsDef.meta_fields]
    )

    const analysisFieldDefs = useMemo(
        () => ((fieldsDef.analysis_fields as Record<string, unknown>) ?? {}) as Record<string, unknown>,
        [fieldsDef.analysis_fields]
    )

    const attachmentFieldDefs = useMemo(
        () => ((fieldsDef.attachment_fields as Record<string, unknown>) ?? {}) as Record<string, unknown>,
        [fieldsDef.attachment_fields]
    )


    return {
        rawConfig,
        setRawConfig,
        rawFields,
        setRawFields,
        configForm,
        fieldsForm,
        settingsScrollApiRef,
        zoteroStatus,
        settingsSection,
        setSettingsSection,
        settingsLoading,
        settingsSaving,
        scheduleAutoSaveSettings,
        saveSettingsNow, // 可以不需要暴露，因为 scheduleAutoSaveSettings 已经够了，但是 SettingsPage 可能会手动保存？
        loadSettings,
        metaFieldDefs,
        analysisFieldDefs,
        attachmentFieldDefs
    }
}
