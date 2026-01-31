import type { ReactNode } from 'react'

export interface ContextMenuItem {
    key: string
    label: ReactNode
    icon?: ReactNode
    disabled?: boolean
    danger?: boolean
    onClick?: () => void
    children?: ContextMenuItem[]
}

export interface ContextMenuContextType {
    showMenu: (items: ContextMenuItem[], position: { x: number; y: number }) => void
    hideMenu: () => void
}
