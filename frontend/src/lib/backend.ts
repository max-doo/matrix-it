/**
 * 模块名称: 后端通信接口
 * 功能描述: 封装前端与后端 Sidecar 之间的通信逻辑（IPC），提供统一的 API 供 UI 组件调用。
 *           兼容 Tauri 环境与浏览器环境（Mock/LocalStorage兜底）。
 */
import { Channel, invoke } from '@tauri-apps/api/core'
import { openPath as openerOpenPath } from '@tauri-apps/plugin-opener'
import type { AnalysisEvent, CollectionNode, LiteratureItem } from '../types'
import { loadLibraryMock } from './mock'

export type LibraryState = { collections: CollectionNode[]; items: LiteratureItem[] }

/**
 * 判断当前是否运行在 Tauri 环境中
 */
const isTauriRuntime = () => {
  const g = globalThis as unknown as Record<string, unknown>
  return !!(g && (g.__TAURI_INTERNALS__ || g.__TAURI__))
}

/**
 * 规范化 Invoke 错误，将其转换为标准的 Error 对象
 */
const normalizeInvokeError = (e: unknown) => {
  if (e instanceof Error) return e
  if (typeof e === 'string') return new Error(e)
  if (typeof e === 'number' || typeof e === 'boolean') return new Error(`IPC_ERROR: ${String(e)}`)
  if (e && typeof e === 'object') {
    const obj = e as Record<string, unknown>
    const code = typeof obj.code === 'string' ? obj.code.trim() : ''
    const message = typeof obj.message === 'string' ? obj.message.trim() : ''
    if (code || message) {
      return new Error(`${code || 'IPC_ERROR'}: ${message || 'unknown'}`)
    }
    const nested = obj.error
    if (nested && typeof nested === 'object') {
      const n = nested as Record<string, unknown>
      const ncode = typeof n.code === 'string' ? n.code.trim() : ''
      const nmsg = typeof n.message === 'string' ? n.message.trim() : ''
      if (ncode || nmsg) return new Error(`${ncode || 'IPC_ERROR'}: ${nmsg || 'unknown'}`)
    }
    try {
      return new Error(`IPC_ERROR: ${JSON.stringify(obj)}`)
    } catch {
      return new Error('IPC_ERROR: unknown')
    }
  }
  return new Error('IPC_ERROR: unknown')
}

/**
 * 规范化外部 URL，移除非法字符并校验协议
 */
const normalizeExternalUrl = (raw: string) => {
  const s = String(raw || '').trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    const protocol = (u.protocol || '').toLowerCase()
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:' || protocol === 'tel:') return u.toString()
    return ''
  } catch {
    return ''
  }
}

/**
 * 打开外部链接
 * 在 Tauri 环境下调用 shell open，在浏览器环境下使用 window.open
 */
export async function openExternal(rawUrl: string): Promise<{ opened: boolean }> {
  const url = normalizeExternalUrl(rawUrl)
  if (!url) return { opened: false }
  if (isTauriRuntime()) {
    try {
      await invoke('plugin:shell|open', { path: url })
      return { opened: true }
    } catch (e) {
      throw normalizeInvokeError(e)
    }
  }
  try {
    const win = window.open(url, '_blank', 'noreferrer')
    return { opened: !!win }
  } catch {
    return { opened: false }
  }
}

export async function openPath(rawPath: string): Promise<{ opened: boolean }> {
  const path = String(rawPath || '').trim()
  if (!path) return { opened: false }
  if (isTauriRuntime()) {
    try {
      await openerOpenPath(path)
      return { opened: true }
    } catch (e) {
      throw normalizeInvokeError(e)
    }
  }
  try {
    const win = window.open(path, '_blank', 'noreferrer')
    return { opened: !!win }
  } catch {
    return { opened: false }
  }
}

export async function resolvePdfPath(itemKey: string): Promise<string> {
  const key = String(itemKey || '').trim()
  if (!key) return ''
  if (!isTauriRuntime()) return ''
  try {
    const res = await invoke<string>('resolve_pdf_path', { itemKey: key })
    return typeof res === 'string' ? res : ''
  } catch (e) {
    throw normalizeInvokeError(e)
  }
}

export async function openPdfInBrowser(pdfPath: string): Promise<{ opened: boolean }> {
  const path = String(pdfPath || '').trim()
  if (!path) return { opened: false }
  if (!isTauriRuntime()) return { opened: false }
  try {
    await invoke('open_pdf_in_browser', { pdfPath: path })
    return { opened: true }
  } catch (e) {
    throw normalizeInvokeError(e)
  }
}

/**
 * 前端到 Tauri Command 的 RPC 封装层：
 * - command 名称需要与 Rust/Tauri 侧保持一致（如：load_library/start_analysis/sync_feishu/update_item）
 * - 这里的异常兜底（mock / 默认返回）主要用于开发期与离线演示，可能会掩盖真实 IPC 错误
 */
export async function loadLibrary(): Promise<LibraryState> {
  try {
    const res = await invoke<LibraryState>('load_library')
    if (res && Array.isArray(res.items) && Array.isArray(res.collections)) return res
    if (isTauriRuntime()) throw new Error('IPC_BAD_PAYLOAD: invalid load_library response')
    return loadLibraryMock()
  } catch (e) {
    if (isTauriRuntime()) throw normalizeInvokeError(e)
    return loadLibraryMock()
  }
}

/**
 * 批量拉取条目（仅从后端本地库读取）。
 *
 * 用于分析 Finished 后快速回填该条目的最新矩阵字段，避免等待整库 load_library 刷新。
 */
export async function getItems(itemKeys: string[]): Promise<{ items: LiteratureItem[] }> {
  try {
    const res = await invoke<{ items: LiteratureItem[] }>('get_items', { itemKeys })
    if (res && Array.isArray(res.items)) return res
    if (isTauriRuntime()) throw new Error('IPC_BAD_PAYLOAD: invalid get_items response')
    return { items: [] }
  } catch (e) {
    if (isTauriRuntime()) throw normalizeInvokeError(e)
    return { items: [] }
  }
}

/**
 * 启动 Zotero 数据监听
 */
export async function startZoteroWatch(dataDir: string): Promise<{ started: boolean }> {
  if (!isTauriRuntime()) return { started: false }
  try {
    await invoke('start_zotero_watch', { dataDir })
    return { started: true }
  } catch (e) {
    throw normalizeInvokeError(e)
  }
}

/**
 * 停止 Zotero 数据监听
 */
export async function stopZoteroWatch(): Promise<{ stopped: boolean }> {
  if (!isTauriRuntime()) return { stopped: false }
  try {
    await invoke('stop_zotero_watch')
    return { stopped: true }
  } catch (e) {
    throw normalizeInvokeError(e)
  }
}

/**
 * 格式化引文
 * 调用后端接口获取指定文献的引用格式
 */
export async function formatCitations(itemKeys: string[]): Promise<{ citations: Record<string, string> }> {
  try {
    const res = await invoke<Record<string, unknown>>('format_citations', { itemKeys })
    const err = res && typeof res === 'object' ? ((res as Record<string, unknown>).error as unknown) : null
    if (err && typeof err === 'object') {
      const code = typeof (err as Record<string, unknown>).code === 'string' ? String((err as Record<string, unknown>).code) : 'FORMAT_CITATIONS_FAILED'
      const msg = typeof (err as Record<string, unknown>).message === 'string' ? String((err as Record<string, unknown>).message) : 'unknown'
      throw new Error(`${code}: ${msg}`)
    }
    const citations = res && typeof res === 'object' ? ((res as Record<string, unknown>).citations as unknown) : null
    return { citations: (citations && typeof citations === 'object' ? (citations as Record<string, string>) : {}) as Record<string, string> }
  } catch (e) {
    if (!isTauriRuntime()) return { citations: {} }
    throw normalizeInvokeError(e)
  }
}

/**
 * 启动分析（支持事件流回调）：
 * - 通过 Tauri Channel 将后端分析过程中的事件（AnalysisEvent）推送到前端
 * - 参数名默认采用 Tauri 的 camelCase 映射（Rust side 使用 snake_case 变量名）
 *
 * 注意：catch 分支会伪造一段“完整事件流”用于 UI 演示/开发兜底。
 */
export async function startAnalysis(itemKeys: string[], onEvent: (evt: AnalysisEvent) => void) {
  try {
    const ch = new Channel<AnalysisEvent>()
    ch.onmessage = onEvent
    await invoke('start_analysis', { itemKeys, onEvent: ch })
  } catch (e) {
    if (isTauriRuntime()) throw normalizeInvokeError(e)
    for (const key of itemKeys) {
      onEvent({ event: 'Started', data: { item_key: key } })
      onEvent({ event: 'Progress', data: { item_key: key, current: 1, total: 1 } })
      onEvent({ event: 'Finished', data: { item_key: key } })
    }
    onEvent({ event: 'AllDone', data: null })
  }
}

/**
 * 终止分析任务
 * 仅终止待处理和进行中的任务，已完成的不受影响
 */
export async function stopAnalysis(): Promise<{ stopped: boolean; cancelled_count: number }> {
  if (!isTauriRuntime()) return { stopped: true, cancelled_count: 0 }
  try {
    return await invoke<{ stopped: boolean; cancelled_count: number }>('stop_analysis')
  } catch (e) {
    throw normalizeInvokeError(e)
  }
}

/**
 * 同步到飞书（返回值为后端响应的透传）。
 * 注意：失败兜底会返回全 0，UI 无法区分“确实为 0”还是“调用失败兜底为 0”。
 */
export type SyncFeishuOptions = {
  resyncSynced?: boolean
  skipAttachmentUpload?: boolean
}

export async function syncFeishu(itemKeys: string[], options?: SyncFeishuOptions) {
  return await invoke('sync_feishu', { itemKeys, options })
}

export async function reconcileFeishu(itemKeys: string[]) {
  return await invoke('reconcile_feishu', { itemKeys })
}

/**
 * 删除已提取的数据
 * 包括清除本地分析结果和飞书对应记录
 */
export async function deleteExtractedData(itemKeys: string[]) {
  try {
    return await invoke('delete_extracted_data', { itemKeys })
  } catch {
    return { cleared: 0, missing: itemKeys.length, analysis_fields: 0, feishu: { deleted: 0, skipped: 0, failed: itemKeys.length } }
  }
}

export async function purgeItemField(fieldKey: string): Promise<{ scanned: number; purged: number }> {
  try {
    const res = await invoke<{ scanned: number; purged: number }>('purge_item_field', { fieldKey })
    return { scanned: Number(res?.scanned ?? 0), purged: Number(res?.purged ?? 0) }
  } catch {
    return { scanned: 0, purged: 0 }
  }
}

/**
 * 更新单条文献的字段 patch（返回值为后端响应的透传）。
 * 注意：失败兜底只返回 { updated: false }，调用方如需错误提示应自行补充。
 */
export async function updateItem(itemKey: string, patch: Record<string, unknown>) {
  try {
    return await invoke('update_item', { itemKey, patch })
  } catch {
    return { updated: false }
  }
}

const LOCAL_STORAGE_CONFIG_KEY = 'matrixit.config'
const LOCAL_STORAGE_FIELDS_KEY = 'matrixit.fields'

/**
 * 读取应用配置
 * 优先从后端读取，失败时降级读取 LocalStorage
 */
export async function readConfig(): Promise<Record<string, unknown>> {
  try {
    return await invoke<Record<string, unknown>>('read_config')
  } catch {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_CONFIG_KEY)
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
}

/**
 * 保存应用配置
 * 尝试保存到后端，失败时降级保存到 LocalStorage
 */
export async function saveConfig(next: Record<string, unknown>): Promise<{ saved: boolean }> {
  try {
    await invoke('save_config', { next })
    return { saved: true }
  } catch {
    try {
      localStorage.setItem(LOCAL_STORAGE_CONFIG_KEY, JSON.stringify(next))
      return { saved: true }
    } catch {
      return { saved: false }
    }
  }
}

/**
 * 读取字段配置
 * 优先从后端读取，失败时降级读取 LocalStorage
 */
export async function readFields(): Promise<Record<string, unknown>> {
  try {
    return await invoke<Record<string, unknown>>('read_fields')
  } catch {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_FIELDS_KEY)
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
}

/**
 * 保存字段配置
 * 尝试保存到后端，失败时降级保存到 LocalStorage
 */
export async function saveFields(next: Record<string, unknown>): Promise<{ saved: boolean }> {
  try {
    await invoke('save_fields', { next })
    return { saved: true }
  } catch {
    try {
      localStorage.setItem(LOCAL_STORAGE_FIELDS_KEY, JSON.stringify(next))
      return { saved: true }
    } catch {
      return { saved: false }
    }
  }
}

/**
 * 获取模型列表
 * 直接使用 fetch 调用 OpenAI 兼容的 /models 端点
 * 这样可以利用系统代理，避免 Python urllib 的问题
 */
export async function listModels(apiKey: string, baseUrl: string): Promise<string[]> {
  try {
    const url = baseUrl.replace(/\/+$/, '')
    const response = await fetch(`${url}/models`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      }
    })

    if (!response.ok) {
      const errorText = await response.text()
      let errorMessage = `HTTP ${response.status}`
      try {
        const errorData = JSON.parse(errorText)
        errorMessage = errorData?.error?.message || errorData?.message || errorMessage
      } catch {
        if (errorText) errorMessage = `${errorMessage}: ${errorText.substring(0, 200)}`
      }
      throw new Error(errorMessage)
    }

    const data = await response.json()
    // OpenAI 标准格式: {"data": [{"id": "model-id"}, ...]}
    const models: string[] = []
    if (data && Array.isArray(data.data)) {
      for (const item of data.data) {
        if (item && typeof item.id === 'string') {
          models.push(item.id)
        }
      }
    }
    return models.sort()
  } catch (e) {
    throw e instanceof Error ? e : new Error(String(e))
  }
}
