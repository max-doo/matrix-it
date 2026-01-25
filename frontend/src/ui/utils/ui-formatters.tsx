
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
