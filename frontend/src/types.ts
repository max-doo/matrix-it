/**
 * 模块名称: 全局类型定义
 * 功能描述: 定义前端应用使用的核心数据结构和类型，包括文献对象、处理状态、事件类型等。
 *           这些类型通常与后端 API 或 Sidecar 的数据结构保持对应。
 */
/**
 * 前后端数据契约（JSON 结构）：
 * - 这些类型需要与后端 sidecar/Tauri Command 的输入输出保持一致
 * - 多数分析字段（如 tldr/methods/key_findings 等）可能在分析流程中逐步补全，因此是可选字段
 */
/**
 * 文献处理状态：
 * - unprocessed: 未处理
 * - processing: 正在分析中
 * - reanalyzing: 重新分析中
 * - done: 分析完成
 * - failed: 分析失败
 */
export type ProcessingStatus = 'unprocessed' | 'processing' | 'reanalyzing' | 'done' | 'failed'
export type SyncStatus = 'unsynced' | 'syncing' | 'synced'

export type FilterMode = 'all' | 'unprocessed' | 'processed'

/**
 * 集合（文件夹）引用：
 * 用于在文献对象中标记其所属的文件夹（支持多层级路径）。
 */
export type CollectionRef = {
  id: number
  name: string
  path: string
  key: string
  pathKeyChain?: string[]
}

/**
 * 文献对象（核心实体）：
 * 包含 Zotero 基础元数据（Title, Author, Year 等）与 Matrix 分析结果（Tldr, Findings 等）。
 */
export type LiteratureItem = {
  item_key: string
  title: string
  author: string
  year: string | number
  type?: string
  item_type?: string
  collections?: CollectionRef[]
  pdf_path?: string
  record_id?: string
  processed_status: ProcessingStatus
  sync_status: SyncStatus
  processed_error?: string
  bib_type?: string
  tldr?: string
  key_word?: string[] | string
  research_question?: string
  methods?: string
  logic?: string
  key_findings?: string
  contribution?: string
  highlights?: string
  limitations?: string
  inspiration?: string
}

/**
 * 集合节点（树状结构）：
 * 用于构建侧边栏的文件夹树。
 */
export type CollectionNode = {
  key: string
  name: string
  children: CollectionNode[]
}

/**
 * 分析事件的典型生命周期：
 * Started → Progress（可多次）→ Finished/Failed → AllDone
 */
export type AnalysisEvent =
  | { event: 'Started'; data: { item_key: string } }
  | { event: 'Progress'; data: { item_key: string; current: number; total: number } }
  | { event: 'Finished'; data: { item_key: string; item?: Partial<LiteratureItem> } }
  | { event: 'Failed'; data: { item_key: string; error: string } }
  | { event: 'AllDone'; data: null }

export type AnalysisReportItem = {
  item_key: string
  started_at?: number
  ended_at?: number
  status: 'finished' | 'failed' | 'cancelled' | 'unknown'
  error?: string
}

export type AnalysisReport = {
  started_at: number
  ended_at: number
  duration_ms: number
  total: number
  finished: number
  failed: number
  cancelled: number
  items: AnalysisReportItem[]
  raw_events: AnalysisEvent[]
}

/**
 * 分析字段配置行：
 * 用于设置页面定义自定义分析字段
 */
export type AnalysisFieldRow = {
  key: string
  description?: string
  type?: string
  rule?: string
  name?: string
}
