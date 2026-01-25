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
                  <Typography.Title level={5} className="!mb-2">
                    Zotero 数据目录
                  </Typography.Title>
                  <Typography.Paragraph type="secondary" className="!mt-0">
                    填写 Zotero 的数据目录（需包含 `zotero.sqlite` 与 `storage/`）。
                  </Typography.Paragraph>
                  <Divider className="!my-3" />

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Form.Item
                      label="数据目录"
                      name={['zotero', 'data_dir']}
                      rules={[{ required: true, message: '请输入 Zotero 数据目录' }]}
                    >
                      <Input placeholder="C:\Users\<you>\Zotero" autoComplete="off" />
                    </Form.Item>
                  </div>
                </div>

                <Divider className="!my-8" />

                <div ref={llmRef} data-section="llm" id="settings-llm" className="scroll-mt-6">
                  <Typography.Title level={5} className="!mb-2">
                    大模型 API 与参数
                  </Typography.Title>
                  <Typography.Paragraph type="secondary" className="!mt-0">
                    这里的配置会写入 `config/config.json`（桌面端运行时由后端读取）。
                  </Typography.Paragraph>
                  <Divider className="!my-3" />

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Form.Item
                      label="Base URL"
                      name={['llm', 'base_url']}
                      rules={[{ required: true, message: '请输入 base_url' }]}
                    >
                      <Input placeholder="https://api.openai.com/v1" autoComplete="off" />
                    </Form.Item>
                    <Form.Item label="模型" name={['llm', 'model']} rules={[{ required: true, message: '请输入模型名' }]}>
                      <Input placeholder="gpt-4o-mini" autoComplete="off" />
                    </Form.Item>
                    <Form.Item label="API Key" name={['llm', 'api_key']} rules={[{ required: true, message: '请输入 API Key' }]}>
                      <Input.Password placeholder="sk-..." autoComplete="off" />
                    </Form.Item>
                    <Form.Item label="温度" name={['llm', 'temperature']}>
                      <InputNumber min={0} max={2} step={0.1} className="w-full" placeholder="0.2" />
                    </Form.Item>
                    <Form.Item label="最大输入字符" name={['llm', 'max_input_chars']}>
                      <InputNumber min={1000} max={200000} step={500} className="w-full" placeholder="12000" />
                    </Form.Item>
                    <Form.Item label="最大 PDF 字节" name={['llm', 'max_pdf_bytes']}>
                      <InputNumber min={0} step={1024 * 1024} className="w-full" placeholder="0 表示不限制" />
                    </Form.Item>
                  </div>
                  <Form.Item label="多模态优先" name={['llm', 'multimodal']} valuePropName="checked">
                    <Switch />
                  </Form.Item>
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
