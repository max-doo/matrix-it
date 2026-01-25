/**
 * 主题相关工具函数
 * 从 CSS 变量读取主题配置
 */

export type ThemeToken = {
    colorPrimary: string
    colorText: string
    colorTextSecondary: string
    bodyBg: string
    siderBg: string
    segmentedTrackBg: string
    fontSize: number
    borderRadius: number
}

/**
 * 从 CSS 变量读取当前主题配置
 * 用于确保 Ant Design 组件的主题与全局 CSS 变量保持同步（特别是颜色和圆角）
 */
export const readThemeToken = (): ThemeToken => {
    try {
        const styles = getComputedStyle(document.documentElement)
        const primary = styles.getPropertyValue('--primary-color').trim() || '#0abab5'
        const text = styles.getPropertyValue('--text-color').trim() || '#0f172a'
        const textSecondary = styles.getPropertyValue('--text-secondary-color').trim() || '#475569'
        const appBg = styles.getPropertyValue('--app-bg').trim() || '#f5f7fa'
        const secondaryBg = styles.getPropertyValue('--secondary-bg').trim() || '#f1f5f9'
        const fontSizeStr = styles.getPropertyValue('--font-size-base').trim()
        const radiusStr = styles.getPropertyValue('--radius-base').trim()
        const fontSize = Number.parseInt(fontSizeStr.replace('px', ''), 10)
        const borderRadius = Number.parseInt(radiusStr.replace('px', ''), 10)

        return {
            colorPrimary: primary,
            colorText: text,
            colorTextSecondary: textSecondary,
            bodyBg: appBg,
            siderBg: appBg,
            segmentedTrackBg: secondaryBg,
            fontSize: Number.isFinite(fontSize) ? fontSize : 14,
            borderRadius: Number.isFinite(borderRadius) ? borderRadius : 8,
        }
    } catch {
        return {
            colorPrimary: '#0abab5',
            colorText: '#0f172a',
            colorTextSecondary: '#475569',
            bodyBg: '#f5f7fa',
            siderBg: '#f5f7fa',
            segmentedTrackBg: '#f1f5f9',
            fontSize: 14,
            borderRadius: 8,
        }
    }
}

export const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
    const raw = hex.trim().replace('#', '')
    const normalized = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw
    if (normalized.length !== 6) return null
    const n = Number.parseInt(normalized, 16)
    if (!Number.isFinite(n)) return null
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}
