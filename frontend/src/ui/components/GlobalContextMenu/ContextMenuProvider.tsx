import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'
import type { ContextMenuItem, ContextMenuContextType } from './types'
import { GlobalContextMenu } from './GlobalContextMenu'

const ContextMenuContext = createContext<ContextMenuContextType | null>(null)

export function ContextMenuProvider({ children }: { children: React.ReactNode }) {
    const [visible, setVisible] = useState(false)
    const [items, setItems] = useState<ContextMenuItem[]>([])
    const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 })

    const showMenu = useCallback((newItems: ContextMenuItem[], newPosition: { x: number; y: number }) => {
        setItems(newItems)
        setPosition(newPosition)
        // 稍微延迟显示，或者直接显示。如果是为了让 UI 组件能拿到新位置。
        // 使用 flushSync ? 不，React 18 自动批处理。
        // 先设置位置，再 visible 比较安全，但这里是一次更新
        setVisible(true)
    }, [])

    const hideMenu = useCallback(() => {
        setVisible(false)
    }, [])

    // 监听全局滚动或点击以关闭菜单
    useEffect(() => {
        const handleClose = () => {
            if (visible) hideMenu()
        }

        // 阻止默认右键菜单并关闭自定义菜单（如果已打开）
        const handleGlobalContextMenu = (e: Event) => {
            // 如果事件已经被组件处理（例如 TextAnalysisHighlighter 调用了 preventDefault），
            // 则不应该关闭菜单（因为组件刚刚请求显示菜单）。
            if (e.defaultPrevented) return

            // 允许原生输入框的右键菜单
            const target = e.target as HTMLElement
            const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
            if (isInput) return

            e.preventDefault()
            handleClose()
        }

        window.addEventListener('scroll', handleClose, { capture: true })
        window.addEventListener('resize', handleClose)
        window.addEventListener('click', handleClose)
        window.addEventListener('contextmenu', handleGlobalContextMenu)

        return () => {
            window.removeEventListener('scroll', handleClose, { capture: true })
            window.removeEventListener('resize', handleClose)
            window.removeEventListener('click', handleClose)
            window.removeEventListener('contextmenu', handleGlobalContextMenu)
        }
    }, [visible, hideMenu])

    return (
        <ContextMenuContext.Provider value={{ showMenu, hideMenu }}>
            {children}
            {/* 
        这里我们在 Provider 内部把状态暴露给外部 UI 组件
        但 React Context 通常是把数据传给 *子组件*。
        UI 组件 GlobalContextMenu 需要是 Provider 的子组件。
        为了解耦状态和渲染，我们也可以在这里直接通过 Context value 传递 visible/items/pos 
        给 GlobalContextMenu (必须放在 children 中或同级但被 Provider 包裹)。
        
        但是 implementation plan 说 ContextMenuProvider 包裹 App， GlobalContextMenu 放在 App 内部。
        所以我们需要把 state 也放到 Context value 里，或者 ContextMenuProvider 就地渲染 GlobalContextMenu？
        为了更好的解耦，我们将 State 暴露出去。
        
        修正 Context 类型：
      */}
            <GlobalMenuConsumer visible={visible} items={items} position={position} onClose={hideMenu} />
        </ContextMenuContext.Provider>
    )
}

// 内部组件，用于将 State 传递给实际的 UI 渲染器
// 但等等，GlobalContextMenu 是要渲染 Antd Dropdown 的。
// 如果我们直接在这里渲染 GlobalContextMenu，那么它就不需要从 Context 获取状态了，而是直接通过 Props。
// 这样更简单。


function GlobalMenuConsumer({
    visible,
    items,
    position,
    onClose,
}: {
    visible: boolean
    items: ContextMenuItem[]
    position: { x: number; y: number }
    onClose: () => void
}) {
    return <GlobalContextMenu visible={visible} items={items} position={position} onClose={onClose} />
}

export function useContextMenu() {
    const context = useContext(ContextMenuContext)
    if (!context) {
        throw new Error('useContextMenu must be used within a ContextMenuProvider')
    }
    return context
}
