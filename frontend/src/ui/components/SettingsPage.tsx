/**
 * 模块名称: 设置页面
 * 功能描述: 应用配置中心，管理 Zotero 路径、LLM 模型参数、飞书集成配置以及自定义分析字段。
 *           支持字段的增删改查与拖拽排序。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import {
  Button,
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
  DeleteOutlined,
  ArrowLeftOutlined,
  PlusOutlined,
  ReloadOutlined,
  HolderOutlined,
  DownOutlined,
  CloseOutlined,
} from '@ant-design/icons'

import { DEFAULT_ANALYSIS_FIELDS } from '../defaults/analysisFields'
import { Space, Segmented, Collapse, Tooltip, message } from 'antd'
import { QuestionCircleOutlined, ThunderboltOutlined, EditOutlined, ApiOutlined, CloudServerOutlined } from '@ant-design/icons'
import { listModels } from '../../lib/backend'

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
        temperature: currentValues.temperature,
        max_input_chars: currentValues.max_input_chars,
        max_pdf_bytes: currentValues.max_pdf_bytes,
        multimodal: currentValues.multimodal,
      }
    }

    // 2. 加载 newProvider 的 profile (如果存在)
    const targetProfile = newProfiles[newProvider]
    let nextValues: Record<string, any> = {}

    if (targetProfile) {
      // 有存档，直接加载
      nextValues = { ...targetProfile }
      // 修正：如果存档中 Base URL 为空且非 Custom，则填充默认 URL
      if (!nextValues.base_url && newProvider !== 'custom') {
        const pData = PROVIDERS.find(x => x.value === newProvider)
        if (pData?.baseUrl) {
          nextValues.base_url = pData.baseUrl
        }
      }
    } else {
      // 无存档，加载默认值
      const pData = PROVIDERS.find(x => x.value === newProvider)
      nextValues = {
        api_key: '', // 切换到新服务商默认为空
        base_url: pData?.baseUrl || '',
        model: [],
        // 保持一些通用设置的默认值
        temperature: 0.5,
        max_input_chars: 100000,
        max_pdf_bytes: 20 * 1024 * 1024,
        multimodal: false,
      }
    }

    // 3. 批量更新 Form
    configForm.setFieldsValue({
      llm: {
        ...configForm.getFieldValue('llm'), // 保留其他可能的字段
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
                className="md:col-span-3"
              >
                <Input placeholder="https://api.openai.com/v1" autoComplete="off" />
              </Form.Item>
              <Form.Item
                label="字符限制"
                name={['llm', 'max_input_chars']}
                tooltip="单次对话允许发送的最大字符数，超出将截断。"
              >
                <InputNumber min={1000} max={1000000} step={1000} className="w-full" placeholder="100000" />
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
}) {
  const scrollRootRef = useRef<HTMLDivElement | null>(null)
  const zoteroRef = useRef<HTMLDivElement | null>(null)
  const llmRef = useRef<HTMLDivElement | null>(null)
  const feishuRef = useRef<HTMLDivElement | null>(null)
  const fieldsRef = useRef<HTMLDivElement | null>(null)
  const analysisListRef = useRef<HTMLDivElement | null>(null)
  const dragStateRef = useRef<{ active: boolean; fromIndex: number }>({ active: false, fromIndex: -1 })
  const [expandedFieldKey, setExpandedFieldKey] = useState<number | null>(null)

  const typeOptions = useMemo(
    () => [
      { value: 'string', label: '文本' },
      { value: 'number', label: '数字' },
      { value: 'select', label: '单选' },
      { value: 'multi_select', label: '多选' },
      { value: 'file', label: '文件' },
    ],
    []
  )
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

  return (
    <div className="flex-1 min-h-0 bg-white rounded-xl shadow-[0_2px_8px_rgba(0,0,0,0.04)] border border-slate-100 overflow-hidden flex flex-col relative">
      <div className="flex justify-between items-center shrink-0 px-4 py-3 border-b border-slate-100">
        <div className="flex items-center gap-2">
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={onGoHome}>
            返回首页
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button icon={<ReloadOutlined />} onClick={onReload} disabled={loading || saving}>
            重新载入
          </Button>
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
                      Zotero 数据目录
                    </Typography.Title>
                    <Form.Item
                      name={['zotero', 'data_dir']}
                      rules={[{ required: true, message: '请输入 Zotero 数据目录' }]}
                      className="!mb-0 flex-1"
                    >
                      <Input placeholder="C:\Users\<you>\Zotero" autoComplete="off" />
                    </Form.Item>
                  </div>
                  <Typography.Paragraph type="secondary" className="!mt-2 !mb-0">
                    填写 Zotero 的数据目录（需包含 `zotero.sqlite` 与 `storage/`）。
                  </Typography.Paragraph>
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
                        const currentLlm = configForm.getFieldValue('llm') || {};
                        const pData = PROVIDERS.find(x => x.value === currentLlm.provider);
                        const defaultBaseUrl = pData?.baseUrl || '';

                        configForm.setFieldsValue({
                          llm: {
                            ...currentLlm,
                            base_url: defaultBaseUrl, // 还原 Base URL
                            temperature: 0.5,
                            max_input_chars: 100000,
                            max_pdf_bytes: 20 * 1024 * 1024,
                            multimodal: false,
                          },
                        })
                        message.success('已还原默认推荐值')
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
                    支持填写 `bitable_url`，后端会自动解析 `app_token/table_id`。
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
                      <Input placeholder="https://.../base/bascn.../tbl..." autoComplete="off" />
                    </Form.Item>
                    <Form.Item label="App Token（可选）" name={['feishu', 'app_token']}>
                      <Input autoComplete="off" />
                    </Form.Item>
                    <Form.Item label="Table ID（可选）" name={['feishu', 'table_id']}>
                      <Input autoComplete="off" />
                    </Form.Item>
                  </div>
                </div>
              </Form>

              <Divider className="!my-8" />

              <div ref={fieldsRef} data-section="fields" id="settings-fields" className="scroll-mt-6">
                <Typography.Title level={5} className="!mb-2">
                  字段设置
                </Typography.Title>
                <Typography.Paragraph type="secondary" className="!mt-0">
                  Zotero 库仅展示元数据字段；文献矩阵展示元数据字段与分析字段。
                </Typography.Paragraph>
                <Divider className="!my-3" />

                <Typography.Title level={5} className="!mb-2">
                  分析字段
                </Typography.Title>
                <Typography.Paragraph type="secondary" className="!mt-0">
                  分析字段会影响 LLM 输出键集合与飞书字段映射；表格显示顺序与显隐请在主界面工具栏调整。
                </Typography.Paragraph>
                <Divider className="!my-3" />

                <Form form={fieldsForm} layout="vertical" requiredMark={false} onValuesChange={onAutoSave}>
                  <Form.List name="analysis_fields">
                    {(fields, { add, remove, move }) => (
                      <div className="flex flex-col gap-4">
                        <div className="flex items-center justify-between">
                          <Typography.Text type="secondary">共 {fields.length} 个字段</Typography.Text>
                          <div className="flex items-center gap-2">
                            <Button
                              icon={<ReloadOutlined />}
                              onClick={() => {
                                setExpandedFieldKey(null)
                                fieldsForm.setFieldsValue({ analysis_fields: DEFAULT_ANALYSIS_FIELDS })
                                onAutoSave()
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
                                        className="h-9 w-9 rounded-lg border border-slate-200 bg-white flex items-center justify-center cursor-grab active:cursor-grabbing"
                                        aria-label="拖拽排序"
                                        onClick={(e) => e.stopPropagation()}
                                        onMouseDown={(e) => beginDrag(e, idx, move)}
                                      >
                                        <HolderOutlined className="text-slate-500" />
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

                                      <Button
                                        type="text"
                                        danger
                                        icon={<CloseOutlined />}
                                        aria-label="删除字段"
                                        onClick={(e) => {
                                          e.stopPropagation()
                                          if (expandedFieldKey === field.key) setExpandedFieldKey(null)
                                          remove(field.name)
                                        }}
                                      />

                                      <DownOutlined className={open ? 'text-slate-500' : 'text-slate-400 -rotate-90'} />
                                    </div>

                                    {open ? (
                                      <div className="px-4 pb-4">
                                        <Divider className="!my-3" />
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                          <Form.Item label="中文名称" name={[field.name, 'name']}>
                                            <Input placeholder="TLDR" autoComplete="off" onClick={(e) => e.stopPropagation()} />
                                          </Form.Item>
                                          <Form.Item label="字段名" name={[field.name, 'key']} rules={[{ required: true, message: '请输入字段名' }]}>
                                            <Input placeholder="tldr" autoComplete="off" onClick={(e) => e.stopPropagation()} />
                                          </Form.Item>
                                          <Form.Item label="类型" name={[field.name, 'type']}>
                                            <Select options={typeOptions} onClick={(e) => e.stopPropagation()} />
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
