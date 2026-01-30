/**
 * 模块名称: 设置页面
 * 功能描述: 应用配置中心，管理 Zotero 路径、LLM 模型参数、飞书集成配置以及自定义分析字段。
 *           支持字段的增删改查与拖拽排序。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import {
  Button,
  Checkbox,
  Divider,
  Form,
  Input,
  InputNumber,
  Select,
  Spin,
  Tag,
  Switch,
  Typography,
} from 'antd'
import type { FormInstance } from 'antd'
import {
  ArrowLeftOutlined,
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
  HolderOutlined,
  DownOutlined,
} from '@ant-design/icons'

import { DEFAULT_ANALYSIS_FIELDS } from '../defaults/analysisFields'

import { App, Space, Segmented, Collapse, Tooltip, message } from 'antd'
import { QuestionCircleOutlined, ThunderboltOutlined, EditOutlined, ApiOutlined, CloudServerOutlined, LinkOutlined, PaperClipOutlined } from '@ant-design/icons'
import { listModels, openExternal, purgeItemField } from '../../lib/backend'

const FALLBACK_META_ORDER = ['title', 'author', 'year', 'type', 'publications', 'rating', 'progress', 'impact_factor', 'journal_tags', 'abstract', 'tags', 'collections', 'url', 'doi']

const PROVIDERS = [
  { label: '自定义 (Custom)', value: 'custom', baseUrl: '' },
  { label: 'OpenAI', value: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { label: 'Google Gemini', value: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/' },
  { label: '硅基流动', value: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1' },
  { label: '阿里云百炼', value: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { label: 'DeepSeek', value: 'deepseek', baseUrl: 'https://api.deepseek.com' },
  { label: '智谱 GLM', value: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { label: '字节豆包', value: 'doubao', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { label: 'OpenRouter', value: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }
]

/**
 * 预设模型列表（用于不支持 /models 端点的服务商）
 * 这些列表来自官方文档，需要定期更新
 */
const PROVIDER_PRESET_MODELS: Record<string, string[]> = {
  dashscope: [
    'qwen-max', 'qwen-max-latest', 'qwen-plus', 'qwen-plus-latest',
    'qwen-turbo', 'qwen-turbo-latest', 'qwen-long',
    'qwen3-235b-a22b', 'qwen3-32b', 'qwen3-14b', 'qwen3-8b',
    'qwq-plus', 'qwen-math-plus',
  ],
  zhipu: [
    'glm-4-plus', 'glm-4-air', 'glm-4-airx', 'glm-4-long', 'glm-4-flash',
    'glm-4v-plus', 'glm-4v',
  ],
  doubao: [
    'doubao-1-5-pro-32k', 'doubao-1-5-pro-256k', 'doubao-1-5-lite-32k',
    'doubao-pro-32k', 'doubao-pro-128k', 'doubao-pro-256k',
    'doubao-lite-32k', 'doubao-lite-128k',
  ],
}


import { Slider } from 'antd'

function LLMSettingsForm({ configForm }: { configForm: FormInstance }) {
  const [loadingModels, setLoadingModels] = useState(false)
  const [modelList, setModelList] = useState<string[]>([])
  const lastClampRef = useRef<{ multimodal: boolean; from: number } | null>(null)

  // 监听 Provider 变化
  const provider = Form.useWatch(['llm', 'provider'], configForm)

  // 初始化: 如果 config 中没有 provider，尝试根据 base_url 推断一次 (兼容旧配置)
  // 注意：这个副作用只在挂载时或 provider 为空时运行一次，避免死循环
  useEffect(() => {
    const p = configForm.getFieldValue(['llm', 'provider'])
    if (!p) {
      const url = configForm.getFieldValue(['llm', 'base_url'])
      const found = PROVIDERS.find(x => x.baseUrl && url?.startsWith(x.baseUrl))
      const initProvider = found ? found.value : 'custom'
      configForm.setFieldValue(['llm', 'provider'], initProvider)
    }
  }, [configForm])

  const handleProviderChange = (newProvider: string) => {
    // 关键修正：使用当前的 provider (closure variable) 作为 oldProvider，
    // 而不是 configForm.getFieldValue，以避免 Form.Item 更新导致的时序问题
    const oldProvider = provider || 'custom'
    if (oldProvider === newProvider) return

    // 1. 保存当前配置到 oldProvider 的 profile
    const currentValues = configForm.getFieldsValue(['llm']).llm
    const profiles = configForm.getFieldValue(['llm', 'profiles']) || {}

    const newProfiles = {
      ...profiles,
      [oldProvider]: {
        api_key: currentValues.api_key,
        base_url: currentValues.base_url,
        model: currentValues.model,
        // 注意：temperature 不保存到 profile，作为全局统一设置
      }
    }

    // 2. 加载 newProvider 的 profile (如果存在)
    const targetProfile = newProfiles[newProvider]
    let nextValues: Record<string, any> = {}

    if (targetProfile) {
      // 有存档，加载 provider 特定配置（不包含 temperature）
      const { parallel_count_max: _pMax, multimodal_parallel_count_max: _mMax, temperature: _temp, ...rest } = targetProfile as Record<string, any>
      nextValues = { ...rest }
      // 修正：如果存档中 Base URL 为空且非 Custom，则填充默认 URL
      if (!nextValues.base_url && newProvider !== 'custom') {
        const pData = PROVIDERS.find(x => x.value === newProvider)
        if (pData?.baseUrl) {
          nextValues.base_url = pData.baseUrl
        }
      }
    } else {
      // 无存档，加载默认值（不设置 temperature，保持当前全局值）
      const pData = PROVIDERS.find(x => x.value === newProvider)
      nextValues = {
        api_key: '', // 切换到新服务商默认为空
        base_url: pData?.baseUrl || '',
        model: [],
      }
    }

    // 3. 批量更新 Form
    const currentLlmRaw = (configForm.getFieldValue('llm') || {}) as Record<string, unknown>
    const { parallel_count_max: _pMax, multimodal_parallel_count_max: _mMax, ...currentLlm } = currentLlmRaw as Record<string, any>
    configForm.setFieldsValue({
      llm: {
        ...currentLlm, // 保留其他可能的字段
        profiles: newProfiles, // 保存更新后的 profiles
        provider: newProvider, // 更新当前 provider
        ...nextValues, // 覆盖配置项
      }
    })

    // 清空模型列表缓存，因为 Key/Url 变了
    setModelList([])
  }

  const handleFetchModels = async () => {
    const currentProvider = configForm.getFieldValue(['llm', 'provider']) || 'custom'
    const key = configForm.getFieldValue(['llm', 'api_key'])
    const url = configForm.getFieldValue(['llm', 'base_url'])

    if (!key || !url) {
      message.error('请先填写 API Key 和 Base URL')
      return
    }

    setLoadingModels(true)
    try {
      // 优先尝试从 API 获取
      const models = await listModels(key, url)
      if (models && models.length > 0) {
        setModelList(models)
        message.success(`成功获取 ${models.length} 个模型`)
        return
      }
      // API 返回空列表，尝试使用预设
      const presetModels = PROVIDER_PRESET_MODELS[currentProvider]
      if (presetModels && presetModels.length > 0) {
        setModelList(presetModels)
        message.info(`已加载 ${presetModels.length} 个预设模型`)
      } else {
        message.warning('未获取到模型列表，请手动输入')
      }
    } catch (e) {
      // API 请求失败，尝试使用预设模型作为 fallback
      const presetModels = PROVIDER_PRESET_MODELS[currentProvider]
      if (presetModels && presetModels.length > 0) {
        setModelList(presetModels)
        message.info(`API 不可用，已加载 ${presetModels.length} 个预设模型`)
      } else {
        message.error(`获取失败: ${e instanceof Error ? e.message : String(e)}`)
      }
    } finally {
      setLoadingModels(false)
    }
  }


  // 监听温度变化
  const temp = Form.useWatch(['llm', 'temperature'], configForm)
  const multimodal = Form.useWatch(['llm', 'multimodal'], configForm)
  const parallelCount = Form.useWatch(['llm', 'parallel_count'], configForm)
  const parallelCountMax = multimodal ? 2 : 10

  useEffect(() => {
    if (!multimodal) {
      lastClampRef.current = null
      return
    }
    const raw = Number(parallelCount ?? 1)
    const v = Number.isFinite(raw) ? raw : 1
    if (v <= 2) return
    if (lastClampRef.current?.multimodal && lastClampRef.current.from === v) return
    lastClampRef.current = { multimodal: true, from: v }
    configForm.setFieldValue(['llm', 'parallel_count'], 2)
    message.info('多模态模式下并行数量已限制为 2')
  }, [configForm, multimodal, parallelCount])

  return (
    <div className="flex flex-col gap-5">
      {/* 1. 服务商选择 */}
      {/* Row 1: Provider, API Key, Model */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-start">
        <Form.Item label="服务商 (Provider)" name={['llm', 'provider']} className="!mb-0 md:col-span-3">
          <Select
            onChange={handleProviderChange}
            options={PROVIDERS}
            optionRender={(option) => (
              <Space>
                <CloudServerOutlined />
                {option.label}
              </Space>
            )}
          />
        </Form.Item>

        <Form.Item label="API Key" name={['llm', 'api_key']} rules={[{ required: true, message: '请输入 API Key' }]} className="!mb-0 md:col-span-5">
          <Input.Password placeholder="sk-..." autoComplete="off" />
        </Form.Item>

        <div className="flex gap-2 items-end md:col-span-4">
          <Form.Item
            label="模型 (Model)"
            name={['llm', 'model']}
            className="flex-1 !mb-0"
            rules={[{ required: true, message: '请输入或选择模型' }]}
          >
            <Select
              mode="tags"
              placeholder="输入或选择模型"
              maxCount={1}
              popupMatchSelectWidth={false}
              options={modelList.map(m => ({ label: m, value: m }))}
              notFoundContent={loadingModels ? <Spin size="small" /> : null}
            />
          </Form.Item>
          <Button onClick={handleFetchModels} loading={loadingModels} icon={<ReloadOutlined />}>
            获取
          </Button>
        </div>
      </div>

      <Divider className="!my-0" dashed />

      {/* Row 2: 创造力 (温度) */}
      <Form.Item
        label={
          <span>
            创造力 (Temperature)
            <span className="text-xs text-slate-400 font-normal ml-2">当前值: {temp ?? 0.5}</span>
          </span>
        }
        className="!mb-0"
        id="llm_temperature"
      >
        <div className="px-6 py-2">
          <Form.Item name={['llm', 'temperature']} noStyle>
            <Slider
              min={0.2}
              max={1.5}
              step={0.1}
              marks={{
                0.2: '严谨',
                0.8: '平衡',
                1.5: '发散'
              }}
            />
          </Form.Item>
        </div>
      </Form.Item>

      {/* Hidden: Profiles persistence */}
      <Form.Item name={['llm', 'profiles']} hidden />

      {/* 4. 高级设置 */}
      <Collapse
        ghost
        size="small"
        items={[{
          key: 'advanced',
          label: <span className="text-slate-500 font-medium text-sm">显示高级设置 (Base URL, Defaults)</span>,
          children: (
            <div className="grid grid-cols-1 md:grid-cols-6 gap-6 pt-2 relative">
              <Form.Item
                label="Base URL"
                name={['llm', 'base_url']}
                rules={[{ required: true, message: '请输入 base_url' }]}
                tooltip="模型服务商的 API endpoint，通常不需要修改。"
                className="md:col-span-2"
              >
                <Input placeholder="https://api.openai.com/v1" autoComplete="off" />
              </Form.Item>
              <Form.Item
                label="并行数量"
                name={['llm', 'parallel_count']}
                tooltip="同时并行处理的文献数量。建议 3-5，过高可能触发 API 限流。开启多模态时会自动限制为 1-2。"
              >
                <InputNumber min={1} max={parallelCountMax} step={1} className="w-full" placeholder={multimodal ? '2' : '3'} />
              </Form.Item>
              <Form.Item
                label="字符限制"
                name={['llm', 'max_input_chars']}
                tooltip="单次对话允许发送的最大字符数，超出将截断。"
              >
                <InputNumber min={1000} max={1000000} step={1000} className="w-full" placeholder="500000" />
              </Form.Item>
              <Form.Item
                label="PDF大小"
                name={['llm', 'max_pdf_bytes']}
                tooltip="允许上传解析的最大 PDF 文件大小。"
              >
                <InputNumber min={0} step={1024 * 1024} className="w-full" formatter={(v) => v ? `${(Number(v) / 1024 / 1024).toFixed(0)}MB` : '无限制'} placeholder="20MB" />
              </Form.Item>
              <Form.Item
                label="多模态优先"
                name={['llm', 'multimodal']}
                valuePropName="checked"
                tooltip="开启后，若模型支持视觉，将优先发送 PDF 截图而非纯文本。适合图表分析。"
              >
                <Switch />
              </Form.Item>
            </div>
          )
        }]}
      />
    </div>
  )
}

export type SettingsSectionKey = 'zotero' | 'llm' | 'feishu' | 'fields'

export type SettingsScrollApi = {
  scrollToSection: (k: SettingsSectionKey) => void
}

export function SettingsPage({
  configForm,
  fieldsForm,
  loading,
  saving,
  activeSection,
  scrollApiRef,
  onActiveSectionChange,
  onGoHome,
  onReload,
  onAutoSave,
  metaFieldDefs,
  attachmentFieldDefs,
}: {
  configForm: FormInstance
  fieldsForm: FormInstance
  loading: boolean
  saving: boolean
  activeSection: SettingsSectionKey
  scrollApiRef: MutableRefObject<SettingsScrollApi | null>
  onActiveSectionChange: (k: SettingsSectionKey) => void
  onGoHome: () => void
  onReload: () => void
  onAutoSave: () => void
  /** 元数据字段定义（从 rawConfig.fields.meta_fields 传入） */
  metaFieldDefs: Record<string, unknown>
  /** 附件字段定义（从 rawConfig.fields.attachment_fields 传入） */
  attachmentFieldDefs: Record<string, unknown>
}) {
  const { modal, message: messageApi } = App.useApp()

  // 使用从 props 传入的字段定义 (从 rawConfig.fields 计算)，避免 Form.useWatch 无法监听未绑定字段的问题
  const metaDefs = useMemo(() => {
    return metaFieldDefs && typeof metaFieldDefs === 'object' ? (metaFieldDefs as Record<string, any>) : {}
  }, [metaFieldDefs])

  const attachmentDefs = useMemo(() => {
    return attachmentFieldDefs && typeof attachmentFieldDefs === 'object' ? (attachmentFieldDefs as Record<string, any>) : {}
  }, [attachmentFieldDefs])
  const metaOrderWatched = Form.useWatch(['fields', 'meta_order'], configForm) as string[] | undefined
  const feishuMetaSyncOptions = useMemo(() => {
    const fixed = new Set(['title', 'author', 'year', 'publications'])
    const order = metaOrderWatched && metaOrderWatched.length > 0 ? metaOrderWatched : FALLBACK_META_ORDER
    const ordered = [...order, ...Object.keys(metaDefs).filter((k) => !order.includes(k))]
    const keys = ordered.filter((k) => !fixed.has(k))
    // 字段中文名直接从 props 的 metaFieldDefs 读取
    return keys.map((k) => ({
      label: String((metaDefs as any)?.[k]?.name || '').trim() || k,
      value: k,
    }))
  }, [metaDefs, metaOrderWatched])
  const attachmentLabel = useMemo(() => {
    const v = attachmentDefs.attachment as Record<string, unknown> | undefined
    return String(v?.name ?? '').trim() || '附件'
  }, [attachmentDefs])
  const scrollRootRef = useRef<HTMLDivElement | null>(null)
  const zoteroRef = useRef<HTMLDivElement | null>(null)
  const llmRef = useRef<HTMLDivElement | null>(null)
  const feishuRef = useRef<HTMLDivElement | null>(null)
  const fieldsRef = useRef<HTMLDivElement | null>(null)
  const analysisListRef = useRef<HTMLDivElement | null>(null)
  const dragStateRef = useRef<{ active: boolean; fromIndex: number }>({ active: false, fromIndex: -1 })
  const [expandedFieldKey, setExpandedFieldKey] = useState<number | null>(null)
  const initialAnalysisFieldKeysRef = useRef<Set<string> | null>(null)
  const [, forceRender] = useState(0)

  const fixedAnalysisFieldKeys = useMemo(() => new Set(['tldr', 'key_word', 'bib_type']), [])
  const modeOptions = useMemo(() => [{ value: 'A', label: '客观提取' }, { value: 'B', label: '专家批判' }], [])

  const getModeLabel = useCallback(
    (rule: unknown) => {
      const r = String(rule ?? '').trim().toUpperCase()
      const found = modeOptions.find((x) => x.value === r)
      return found?.label ?? '未设置'
    },
    [modeOptions]
  )

  const truncate = useCallback((text: unknown, maxLen: number) => {
    const s = String(text ?? '').trim().replace(/\s+/g, ' ')
    if (s.length <= maxLen) return s
    return s.slice(0, maxLen - 1) + '…'
  }, [])

  const handleFieldsValuesChange = useCallback(() => {
    const hasErrors = fieldsForm.getFieldsError().some((x) => x.errors.length > 0)
    if (hasErrors) return
    onAutoSave()
  }, [fieldsForm, onAutoSave])

  /**
   * 交互逻辑：字段拖拽排序
   * 不使用 dnd-kit 等重型库，使用原生 MouseEvent 实现轻量级垂直列表拖拽排序。
   */
  const beginDrag = useCallback((e: React.MouseEvent, fromIndex: number, move: (from: number, to: number) => void) => {
    e.preventDefault()
    e.stopPropagation()
    if (fromIndex < 0) return
    dragStateRef.current = { active: true, fromIndex }

    const prevCursor = document.body.style.cursor
    const prevUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'

    const handleMove = (ev: MouseEvent) => {
      if (!dragStateRef.current.active) return
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
      const item = el?.closest('[data-analysis-field-item]') as HTMLElement | null
      const toStr = item?.dataset.index
      const toIndex = typeof toStr === 'string' ? Number.parseInt(toStr, 10) : -1
      if (Number.isFinite(toIndex) && toIndex >= 0 && toIndex !== dragStateRef.current.fromIndex) {
        const from = dragStateRef.current.fromIndex
        move(from, toIndex)
        dragStateRef.current.fromIndex = toIndex
      }

      const container = analysisListRef.current
      if (container) {
        const rect = container.getBoundingClientRect()
        const edge = 48
        if (ev.clientY < rect.top + edge) {
          container.scrollTop -= 18
        } else if (ev.clientY > rect.bottom - edge) {
          container.scrollTop += 18
        }
      }
    }

    const handleUp = () => {
      dragStateRef.current = { active: false, fromIndex: -1 }
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevUserSelect
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }, [])

  useEffect(() => {
    scrollApiRef.current = {
      scrollToSection: (k) => {
        const target =
          k === 'zotero'
            ? zoteroRef.current
            : k === 'llm'
              ? llmRef.current
              : k === 'feishu'
                ? feishuRef.current
                : fieldsRef.current
        if (!target) return
        target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      },
    }
    return () => {
      scrollApiRef.current = null
    }
  }, [scrollApiRef])

  /**
   * 交互逻辑：滚动监听（Spy）
   * 使用 IntersectionObserver 监听各个设置区块的可见性，自动高亮侧边栏对应的导航菜单。
   */
  useEffect(() => {
    const root = scrollRootRef.current
    if (!root) return

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => (b.intersectionRatio ?? 0) - (a.intersectionRatio ?? 0))

        const top = visible[0]
        const section = (top?.target as HTMLElement | undefined)?.dataset.section as SettingsSectionKey | undefined
        if (section && section !== activeSection) {
          onActiveSectionChange(section)
        }
      },
      {
        root,
        threshold: [0.1, 0.3, 0.6],
        rootMargin: '-15% 0px -70% 0px',
      }
    )

    const targets = [zoteroRef.current, llmRef.current, feishuRef.current, fieldsRef.current].filter(Boolean) as HTMLDivElement[]
    for (const t of targets) observer.observe(t)
    return () => observer.disconnect()
  }, [activeSection, onActiveSectionChange])

  useEffect(() => {
    if (loading) {
      initialAnalysisFieldKeysRef.current = null
      forceRender((v) => v + 1)
      return
    }
    if (initialAnalysisFieldKeysRef.current) return
    const rows = fieldsForm.getFieldValue('analysis_fields') as Array<Record<string, unknown> | undefined> | undefined
    const next = new Set<string>()
    for (const r of rows ?? []) {
      const k = String(r?.key ?? '').trim()
      if (k) next.add(k)
    }
    initialAnalysisFieldKeysRef.current = next
    forceRender((v) => v + 1)
  }, [fieldsForm, loading])

  return (
    <div className="flex-1 min-h-0 bg-white rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-slate-100 overflow-hidden flex flex-col relative">
      <div className="flex justify-between items-center shrink-0 px-4 py-3 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={onGoHome}>
            返回首页
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Tooltip title="从已保存配置重新读取并回填（会覆盖未保存的修改）">
            <Button icon={<ReloadOutlined />} onClick={onReload} disabled={loading || saving}>
              重新加载配置
            </Button>
          </Tooltip>
        </div>
      </div>

      <div ref={scrollRootRef} className="flex-1 min-h-0 overflow-auto custom-scrollbar">
        <Spin spinning={loading} className="w-full">
          <div className="p-4">
            <div className="max-w-[980px]">
              <Form form={configForm} layout="vertical" requiredMark={false} onValuesChange={onAutoSave}>
                <div ref={zoteroRef} data-section="zotero" id="settings-zotero" className="scroll-mt-6">
                  <div className="flex items-center gap-4">
                    <Typography.Title level={5} className="!mb-0 shrink-0">
                      基础设置
                    </Typography.Title>
                  </div>
                  <Typography.Paragraph type="secondary" className="!mt-2 !mb-0">
                    配置应用的基础行为，包括 Zotero 数据目录与 PDF 阅读方式。
                  </Typography.Paragraph>

                  <Divider className="!my-4" />

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Form.Item
                      label="Zotero 数据目录"
                      name={['zotero', 'data_dir']}
                      rules={[{ required: true, message: '请输入 Zotero 数据目录' }]}
                      tooltip="需包含 `zotero.sqlite` 与 `storage/`"
                      className="!mb-0"
                    >
                      <Input placeholder="C:\Users\<you>\Zotero" autoComplete="off" />
                    </Form.Item>

                    <Form.Item
                      label="PDF 打开方式"
                      name={['ui', 'pdf_open_mode']}
                      initialValue="local"
                      tooltip="本地打开会使用系统默认的 PDF 程序；如失败会自动兜底用浏览器打开。"
                      className="!mb-0"
                    >
                      <Select
                        options={[
                          { label: '本地打开（默认）', value: 'local' },
                          { label: '优先用浏览器打开', value: 'browser' },
                        ]}
                      />
                    </Form.Item>
                  </div>
                </div>

                <Divider className="!my-8" />

                <div ref={llmRef} data-section="llm" id="settings-llm" className="scroll-mt-6">
                  <div className="flex items-center justify-between">
                    <Typography.Title level={5} className="!mb-0">
                      大模型 API 与参数
                    </Typography.Title>
                    <Button
                      icon={<ReloadOutlined />}
                      onClick={() => {
                        const currentLlmRaw = (configForm.getFieldValue('llm') || {}) as Record<string, unknown>
                        const { parallel_count_max: _pMax, multimodal_parallel_count_max: _mMax, ...currentLlm } = currentLlmRaw as Record<string, any>
                        const pData = PROVIDERS.find(x => x.value === currentLlm.provider);
                        // custom provider 保留用户的 base_url，其他 provider 还原为预设值
                        const defaultBaseUrl = currentLlm.provider === 'custom'
                          ? currentLlm.base_url
                          : (pData?.baseUrl || '');

                        configForm.setFieldsValue({
                          llm: {
                            ...currentLlm,
                            base_url: defaultBaseUrl, // custom 保留，其他还原
                            temperature: 0.5,
                            max_input_chars: 500000,
                            max_pdf_bytes: 20 * 1024 * 1024,
                            multimodal: false,
                            parallel_count: 3,
                          },
                        })
                        onAutoSave()
                        messageApi.success('已还原默认推荐值')
                      }}
                    >
                      还原默认
                    </Button>
                  </div>
                  <Typography.Paragraph type="secondary" className="!mt-1">
                    配置 LLM 服务商与参数。
                  </Typography.Paragraph>
                  <Divider className="!my-3" />

                  <LLMSettingsForm configForm={configForm} />
                </div>

                <Divider className="!my-8" />

                <div ref={feishuRef} data-section="feishu" id="settings-feishu" className="scroll-mt-6">
                  <Typography.Title level={5} className="!mb-2">
                    飞书多维表格 API
                  </Typography.Title>
                  <Typography.Paragraph type="secondary" className="!mt-0">
                    仅需填写 Bitable URL，后端会自动解析必要信息。
                  </Typography.Paragraph>
                  <Divider className="!my-3" />

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Form.Item label="App ID" name={['feishu', 'app_id']} rules={[{ required: true, message: '请输入 App ID' }]}>
                      <Input autoComplete="off" />
                    </Form.Item>
                    <Form.Item
                      label="App Secret"
                      name={['feishu', 'app_secret']}
                      rules={[{ required: true, message: '请输入 App Secret' }]}
                    >
                      <Input.Password autoComplete="off" />
                    </Form.Item>
                    <Form.Item
                      label="Bitable URL"
                      name={['feishu', 'bitable_url']}
                      rules={[{ required: true, message: '请输入多维表格链接' }]}
                    >
                      <Input
                        placeholder="https://.../base/bascn.../tbl..."
                        autoComplete="off"
                        addonAfter={
                          <Tooltip title="用系统默认浏览器打开">
                            <Button
                              type="text"
                              aria-label="打开飞书多维表格"
                              icon={<LinkOutlined />}
                              onClick={async () => {
                                const url = String(configForm.getFieldValue(['feishu', 'bitable_url']) ?? '').trim()
                                if (!url) {
                                  messageApi.warning('请先填写 Bitable URL')
                                  return
                                }
                                try {
                                  const res = await openExternal(url)
                                  if (!res.opened) {
                                    messageApi.warning('链接无效或无法打开')
                                  }
                                } catch (e) {
                                  const msg = e instanceof Error ? e.message : '打开失败'
                                  messageApi.error(msg)
                                }
                              }}
                            />
                          </Tooltip>
                        }
                      />
                    </Form.Item>
                  </div>

                  <Divider className="!my-4" />

                  <div className="flex items-center justify-between">
                    <Typography.Title level={5} className="!mb-2">
                      同步/导出元数据字段
                    </Typography.Title>
                    <Button
                      icon={<ReloadOutlined />}
                      onClick={() => {
                        const currentRules = configForm.getFieldValue('feishu') || {}
                        configForm.setFieldsValue({
                          feishu: {
                            ...currentRules,
                            attachment_sync: true,
                            meta_sync: FALLBACK_META_ORDER.filter((k) => !['title', 'author', 'year', 'publications', 'doi', 'rating', 'progress'].includes(k))
                          }
                        })
                        onAutoSave()
                        messageApi.success('已还原默认推荐值')
                      }}
                    >
                      还原默认
                    </Button>
                  </div>
                  <Typography.Paragraph type="secondary" className="!mt-0">
                    标题、作者、年份、出版物固定上传；其他字段可勾选是否同步（默认全部勾选，DOI/评分/进度 默认不勾选）。
                  </Typography.Paragraph>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <Form.Item
                      name={['feishu', 'attachment_sync']}
                      valuePropName="checked"
                      initialValue={true}
                      noStyle
                    >
                      <Checkbox>
                        <span className="inline-flex items-center gap-1">
                          {attachmentLabel}
                          <PaperClipOutlined className="text-slate-400" />
                        </span>
                      </Checkbox>
                    </Form.Item>

                    <Form.Item
                      name={['feishu', 'meta_sync']}
                      initialValue={FALLBACK_META_ORDER.filter((k) => !['title', 'author', 'year', 'publications', 'doi', 'rating', 'progress'].includes(k))}
                      noStyle
                    >
                      <Checkbox.Group
                        className="flex flex-wrap items-center gap-x-4 gap-y-2"
                        style={{ display: 'contents' }}
                        options={feishuMetaSyncOptions}
                      />
                    </Form.Item>
                  </div>
                </div>
              </Form>

              <Divider className="!my-8" />

              <div ref={fieldsRef} data-section="fields" id="settings-fields" className="scroll-mt-6">

                <Typography.Title level={5} className="!mb-2">
                  分析字段
                </Typography.Title>
                <Typography.Paragraph type="secondary" className="!mt-0">
                  分析字段会影响 LLM 输出键集合与飞书字段映射；表格显示顺序与显隐请在主界面工具栏调整。
                </Typography.Paragraph>
                <Divider className="!my-3" />

                <Form form={fieldsForm} layout="vertical" requiredMark={false} onValuesChange={handleFieldsValuesChange}>
                  <Form.List name="analysis_fields">
                    {(fields, { add, remove, move }) => (
                      <div className="flex flex-col gap-4">
                        <div className="flex items-center justify-between">
                          <Typography.Text type="secondary">共 {fields.length} 个字段</Typography.Text>
                          <div className="flex items-center gap-2">
                            <Button
                              icon={<ReloadOutlined />}
                              onClick={() => {
                                modal.confirm({
                                  title: '确认还原默认配置？',
                                  content: '这将重置所有分析字段定义与排序，自定义字段将丢失。',
                                  okText: '确认还原',
                                  okType: 'danger',
                                  cancelText: '取消',
                                  onOk: () => {
                                    setExpandedFieldKey(null)
                                    fieldsForm.setFieldsValue({ analysis_fields: DEFAULT_ANALYSIS_FIELDS })
                                    onAutoSave()
                                    messageApi.success('已还原默认推荐值')
                                  }
                                })
                              }}
                            >
                              还原默认
                            </Button>
                            <Button
                              type="default"
                              icon={<PlusOutlined />}
                              onClick={() => add({ key: '', name: '', description: '', type: 'string', rule: '' })}
                            >
                              新增字段
                            </Button>
                          </div>
                        </div>

                        <div ref={analysisListRef} className="flex flex-col gap-3 max-h-[560px] overflow-auto pr-1 custom-scrollbar">
                          {fields.map((field, idx) => (
                            <Form.Item key={field.key} shouldUpdate noStyle>
                              {() => {
                                const row = fieldsForm.getFieldValue(['analysis_fields', field.name]) as Record<string, unknown> | undefined
                                const k = String(row?.key ?? '').trim()
                                const cnName = String(row?.name ?? '').trim()
                                const rule = String(row?.rule ?? '').trim()
                                const desc = String(row?.description ?? '').trim()
                                const open = expandedFieldKey === field.key
                                const title = cnName || k || `字段 ${idx + 1}`
                                const modeLabel = getModeLabel(rule)
                                const ruleText = truncate(desc || '未填写', 46)
                                const isFixed = fixedAnalysisFieldKeys.has(k)
                                const isExistingKey = initialAnalysisFieldKeysRef.current?.has(k) ?? false

                                return (
                                  <div
                                    data-analysis-field-item
                                    data-index={idx}
                                    className={[
                                      'rounded-xl border bg-white transition-colors',
                                      open ? 'border-slate-300 shadow-[0_2px_12px_rgba(15,23,42,0.06)]' : 'border-slate-200 hover:border-slate-300',
                                    ].join(' ')}
                                    onClick={() => setExpandedFieldKey((prev) => (prev === field.key ? null : field.key))}
                                  >
                                    <div className="flex items-center gap-3 px-4 py-3">
                                      <button
                                        type="button"
                                        className="h-10 w-10 bg-transparent border-0 shadow-none p-0 flex items-center justify-center cursor-grab active:cursor-grabbing focus:outline-none transition-none"
                                        aria-label="拖拽排序"
                                        onClick={(e) => e.stopPropagation()}
                                        onMouseDown={(e) => beginDrag(e, idx, move)}
                                      >
                                        <HolderOutlined className="text-slate-500 text-xl" />
                                      </button>

                                      <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                          <Typography.Text className="font-medium truncate">{title}</Typography.Text>
                                          <Tag color={rule?.toUpperCase() === 'B' ? 'purple' : 'blue'} className="shrink-0">
                                            {modeLabel}
                                          </Tag>
                                        </div>
                                        <Typography.Text type="secondary" className="block">
                                          提取规则：{ruleText}
                                        </Typography.Text>
                                      </div>

                                      {isFixed ? (
                                        <Tooltip title="固定字段不可删除">
                                          <Button type="text" danger disabled icon={<DeleteOutlined className="text-lg" />} aria-label="删除字段" onClick={(e) => e.stopPropagation()} />
                                        </Tooltip>
                                      ) : (
                                        <Button
                                          type="text"
                                          danger
                                          icon={<DeleteOutlined className="text-lg" />}
                                          aria-label="删除字段"
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            const targetKey = k
                                            let shouldPurge = false
                                            void modal.confirm({
                                              title: '删除字段确认',
                                              content: (
                                                <div className="flex flex-col gap-2">
                                                  <div>确认删除「{title}」？</div>
                                                  <Typography.Text type="secondary">
                                                    默认仅删除字段定义（历史数据保留，可通过重新创建同名字段找回）。
                                                  </Typography.Text>
                                                  <Checkbox
                                                    onChange={(ev) => {
                                                      shouldPurge = ev.target.checked
                                                    }}
                                                  >
                                                    同时清理历史数据（不可恢复）
                                                  </Checkbox>
                                                </div>
                                              ),
                                              okText: '删除',
                                              okButtonProps: { danger: true },
                                              cancelText: '取消',
                                              onOk: async () => {
                                                if (shouldPurge && targetKey) {
                                                  const res = await purgeItemField(targetKey)
                                                  if (res.purged > 0) {
                                                    messageApi.success(`已清理 ${res.purged} 条记录中的「${targetKey}」字段`)
                                                  }
                                                }
                                                if (expandedFieldKey === field.key) setExpandedFieldKey(null)
                                                remove(field.name)
                                                onAutoSave()
                                              },
                                            })
                                          }}
                                        />
                                      )}

                                      <DownOutlined className={open ? 'text-slate-500' : 'text-slate-400 -rotate-90'} />
                                    </div>

                                    {open ? (
                                      <div className="px-4 pb-4">
                                        <Divider className="!my-3" />
                                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                          <Form.Item label="中文名称" name={[field.name, 'name']}>
                                            <Input disabled={isFixed} placeholder="TLDR" autoComplete="off" onClick={(e) => e.stopPropagation()} />
                                          </Form.Item>
                                          <Form.Item
                                            label="字段名"
                                            name={[field.name, 'key']}
                                            validateTrigger={['onChange', 'onBlur']}
                                            rules={[
                                              { required: true, message: '请输入字段名' },
                                              {
                                                validator: async (_rule, value) => {
                                                  const v = String(value ?? '').trim()
                                                  if (!v) return
                                                  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(v)) {
                                                    throw new Error('字段名需以字母开头，仅允许字母/数字/下划线')
                                                  }
                                                  const rows = fieldsForm.getFieldValue('analysis_fields') as Array<Record<string, unknown> | undefined> | undefined
                                                  const dup = (rows ?? []).some((r, i) => i !== idx && String(r?.key ?? '').trim() === v)
                                                  if (dup) {
                                                    throw new Error('字段名已存在')
                                                  }
                                                },
                                              },
                                            ]}
                                          >
                                            <Input disabled={isFixed || isExistingKey} placeholder="tldr" autoComplete="off" onClick={(e) => e.stopPropagation()} />
                                          </Form.Item>
                                          <Form.Item label="模式" name={[field.name, 'rule']}>
                                            <Select allowClear placeholder="可选" options={modeOptions} onClick={(e) => e.stopPropagation()} />
                                          </Form.Item>
                                        </div>
                                        <Form.Item label="提取规则" name={[field.name, 'description']}>
                                          <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} placeholder="字段描述与要求" onClick={(e) => e.stopPropagation()} />
                                        </Form.Item>
                                      </div>
                                    ) : null}
                                  </div>
                                )
                              }}
                            </Form.Item>
                          ))}
                        </div>
                      </div>
                    )}
                  </Form.List>
                </Form>
              </div>
            </div>
          </div>
        </Spin>
      </div>
    </div>
  )
}
