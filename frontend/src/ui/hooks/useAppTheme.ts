/**
 * 主题管理 Hook
 * 负责管理应用的主题令牌（ThemeToken）和动态样式计算
 */

import { useState, useEffect, useMemo } from 'react'
import { readThemeToken, hexToRgb, type ThemeToken } from '../lib/themeUtils'

export function useAppTheme(normalizedSearchQuery: string) {
    const [themeToken, setThemeToken] = useState<ThemeToken>(readThemeToken)

    useEffect(() => {
        // 主题 token 依赖 DOM/CSS 变量：在首次渲染后读取一次，避免 SSR/非浏览器环境报错
        setThemeToken(readThemeToken())
    }, [])

    const activeSearchButtonStyle = useMemo(() => {
        if (!normalizedSearchQuery) return undefined
        const rgb = hexToRgb(themeToken.colorPrimary)
        if (!rgb) return { backgroundColor: '#f0fdfa', borderColor: '#99f6e4', color: themeToken.colorPrimary } as React.CSSProperties
        return {
            backgroundColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.12)`,
            borderColor: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.35)`,
            color: themeToken.colorPrimary,
        } as React.CSSProperties
    }, [normalizedSearchQuery, themeToken.colorPrimary])

    return {
        themeToken,
        activeSearchButtonStyle
    }
}
