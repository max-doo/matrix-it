import { Tag } from 'antd'

/**
 * Rating/Progress 下拉框与映射配置
 * 用于表格和抽屉的统一显示
 */

export const RATING_OPTIONS = [
    { key: 'High', label: <span className="text-base">💗 推荐</span> },
    { key: 'Medium', label: <span className="text-base">👍 良好</span> },
    { key: 'Low', label: <span className="text-base">👎 一般</span> },
    { key: '', label: <span className="secondary-color">清除评分</span> },
]

export const RATING_EMOJI_MAP: Record<string, string> = {
    High: '💗',
    Medium: '👍',
    Low: '👎',
}

export const RATING_LABEL_MAP: Record<string, string> = {
    High: '推荐',
    Medium: '良好',
    Low: '一般',
}

export const PROGRESS_OPTIONS = [
    { key: 'Unread', label: <span className="text-base">🆕 未读</span> },
    { key: 'Reading', label: <span className="text-base">⏳ 在读</span> },
    { key: 'Finished', label: <span className="text-base">✅ 已读</span> },
]

export const PROGRESS_EMOJI_MAP: Record<string, string> = {
    Finished: '✅',
    Reading: '⏳',
    Unread: '🆕',
}

export const PROGRESS_LABEL_MAP: Record<string, string> = {
    Finished: '已读',
    Reading: '在读',
    Unread: '未读',
}
