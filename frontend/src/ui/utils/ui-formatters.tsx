
import type { TagProps } from 'antd'

/**
 * 格式化作者姓名
 * 1. 自动在驼峰命名（FirstLast）之间插入空格（First Last）
 * 2. 如果包含多个作者（以逗号或分号分隔），仅显示第一位作者，并附加 " 等"
 */
export function formatAuthor(authorStr: string | unknown, truncate: boolean = false): string {
    if (typeof authorStr !== 'string' || !authorStr) return '-'

    // 归一化分隔符：将分号替换为逗号，然后分割
    const authors = authorStr.replace(/;/g, ',').split(',').map(s => s.trim()).filter(Boolean)

    if (authors.length === 0) return '-'

    // 处理 CamelCase (FirstLast -> First Last)
    // 排除 MacBook, MacDonald 等特例太复杂，这里只做简单的大小写修补
    // 假设：小写字母后跟大写字母，中间插入空格
    const fixCamel = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2')

    if (truncate) {
        const first = fixCamel(authors[0])
        return authors.length > 1 ? `${first} 等` : first
    }

    // 不截断时，全部显示
    return authors.map(fixCamel).join(', ')
}

/**
 * 文献类型映射配置
 */
export const LITERATURE_TYPE_MAP: Record<string, { label: string; color: string }> = {
    journalArticle: { label: '期刊文章', color: 'blue' },
    thesis: { label: '学位论文', color: 'orange' },
    conferencePaper: { label: '会议论文', color: 'green' },
    book: { label: '图书', color: 'purple' },
    bookSection: { label: '图书章节', color: 'geekblue' },
    report: { label: '报告', color: 'purple' },
    webpage: { label: '网页', color: 'cyan' },
    preprint: { label: '预印本', color: 'magenta' },
    patent: { label: '专利', color: 'lime' },
    blogPost: { label: '博客', color: 'cyan' },
    videoRecording: { label: '视频', color: 'volcano' },
    podcast: { label: '播客', color: 'volcano' },
    presentation: { label: '演示文稿', color: 'orange' },
    statute: { label: '法规', color: 'red' },
    newspaperArticle: { label: '报纸文章', color: 'yellow' },
    // 添加更多映射...
}

export function getLiteratureTypeMeta(typeStr: string | unknown): { label: string; color: string } {
    if (typeof typeStr !== 'string' || !typeStr) return { label: '未知', color: 'default' }
    const key = typeStr.trim()
    return LITERATURE_TYPE_MAP[key] ?? { label: key, color: 'default' }
}

/**
 * 获取状态对应的文本颜色类名
 * 用于增强状态文字的显示效果
 */
export function getStatusColorClass(status: string, resultStatus?: 'success' | 'error' | 'default' | 'processing' | 'warning'): string {
    // 配合 tailwind 使用，或者直接返回 style color
    if (resultStatus === 'success') return 'text-green-600'
    if (resultStatus === 'error') return 'text-red-600'
    if (resultStatus === 'processing') return 'text-blue-600'
    if (resultStatus === 'warning') return 'text-orange-600'
    return 'text-slate-500'
}

// ==================== JCR 影响因子和期刊标签格式化 ====================

/**
 * 根据 IF 值返回对应的颜色
 * 参考 ShowJCR 的颜色编码方案
 */
export function getIFColor(value: number): string {
    if (value >= 10) return '#d4380d'   // Volcano-6
    if (value >= 5) return '#d46b08'    // Orange-6
    if (value >= 3) return '#389e0d'    // Green-6
    if (value >= 2) return '#389e0d'    // Green-6 (简化)
    if (value >= 1) return '#389e0d'    // Green-6 (简化)
    return '#595959'                     // Grey-7
}

/**
 * 格式化 IF 值显示
 * 带颜色编码,保留1位小数
 */
export function formatIF(value: unknown): { text: string; color: string } {
    if (!value) return { text: '-', color: '#8c8c8c' }
    const num = typeof value === 'number' ? value : parseFloat(String(value))
    if (isNaN(num)) return { text: '-', color: '#8c8c8c' }
    return {
        text: num.toFixed(1),
        color: getIFColor(num),
    }
}

/**
 * JCR 分区颜色映射
 */
export const QUARTILE_COLORS: Record<string, string> = {
    'Q1': 'volcano',
    'Q2': 'orange',
    'Q3': 'green',
    'Q4': 'cyan',
}

/**
 * 中科院分区颜色映射
 */
export function getCASColor(partition: string): string {
    if (!partition) return '#d9d9d9'
    const partNum = partition.charAt(0)
    const colorMap: Record<string, string> = {
        '1': 'volcano',
        '2': 'orange',
        '3': 'green',
        '4': 'cyan',
    }
    return colorMap[partNum] || 'default'
}

/**
 * 期刊标签数据结构
 */
export interface JournalTagInfo {
    type: 'jcr' | 'cas' | 'top'
    label: string
    color: string
}

/**
 * 从记录中提取期刊标签列表
 * 用于表格中渲染多个彩色标签
 */
export function getJournalTags(record: { meta_extra?: { jcr?: { quartile?: string }; cas?: { category?: string; partition?: string; top?: boolean } } }): JournalTagInfo[] {
    const tags: JournalTagInfo[] = []
    const jcr = record.meta_extra?.jcr
    const cas = record.meta_extra?.cas

    // JCR 分区标签
    if (jcr?.quartile) {
        tags.push({
            type: 'jcr',
            label: `SCI ${jcr.quartile}`,
            color: QUARTILE_COLORS[jcr.quartile] || 'default',
        })
    }

    // 中科院分区标签
    if (cas?.partition) {
        tags.push({
            type: 'cas',
            label: `中科院 ${cas.category || ''}${cas.partition}`,
            color: getCASColor(cas.partition),
        })
    }

    // Top 期刊标签
    if (cas?.top) {
        tags.push({
            type: 'top',
            label: 'Top',
            color: 'red',
        })
    }

    return tags
}

// ==================== 搜索高亮工具函数 ====================

/**
 * 转义正则表达式特殊字符
 */
export const escapeRegExp = (input: string) => input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 根据搜索词生成用于高亮的正则表达式
 */
export const getHighlightRegex = (query: string): RegExp | null => {
    const normalized = String(query ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
    const tokens = normalized ? normalized.split(' ').filter(Boolean) : []
    if (tokens.length === 0) return null
    const pattern = tokens.map(escapeRegExp).join('|')
    if (!pattern) return null
    return new RegExp(`(${pattern})`, 'ig')
}
