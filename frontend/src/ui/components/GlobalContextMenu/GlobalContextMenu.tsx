import React, { useMemo, useEffect, useRef } from 'react'
import { Menu, type MenuProps } from 'antd'
import { createPortal } from 'react-dom'
import type { ContextMenuItem } from './types'

export interface GlobalContextMenuProps {
    visible: boolean
    items: ContextMenuItem[]
    position: { x: number; y: number }
    onClose: () => void
}

/**
 * GlobalContextMenu 使用 Portal + 固定定位的 Menu 实现。
 * 不依赖 Dropdown 的 trigger 机制，完全受控显示。
 */
export function GlobalContextMenu({ visible, items, position, onClose }: GlobalContextMenuProps) {
    const menuRef = useRef<HTMLDivElement>(null)

    // 转换 items 到 Antd Menu items
    const menuItems: MenuProps['items'] = useMemo(() => {
        const mapItem = (item: ContextMenuItem): NonNullable<MenuProps['items']>[number] => {
            return {
                key: item.key,
                label: item.label,
                icon: item.icon,
                disabled: item.disabled,
                danger: item.danger,
                onClick: () => {
                    item.onClick?.()
                    onClose()
                },
                children: item.children?.map(mapItem),
            }
        }
        return items.map(mapItem)
    }, [items, onClose])

    // 点击菜单外部关闭
    useEffect(() => {
        if (!visible) return

        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                onClose()
            }
        }
        // 延迟添加，避免当前右键事件触发此监听
        const timer = setTimeout(() => {
            document.addEventListener('mousedown', handleClickOutside)
        }, 0)

        return () => {
            clearTimeout(timer)
            document.removeEventListener('mousedown', handleClickOutside)
        }
    }, [visible, onClose])

    if (!visible || items.length === 0) return null

    // 计算位置，确保不超出视口
    const menuStyle: React.CSSProperties = {
        position: 'fixed',
        left: position.x,
        top: position.y,
        zIndex: 9999,
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        borderRadius: 8,
        overflow: 'hidden',
    }

    return createPortal(
        <div ref={menuRef} style={menuStyle}>
            <Menu
                items={menuItems}
                mode="vertical"
                selectable={false}
                style={{ border: 'none' }}
            />
        </div>,
        document.body
    )
}
