import { Modal, Button } from 'antd'
import type { ReactNode } from 'react'

interface ConfirmModalProps {
    open: boolean
    title: ReactNode
    content: ReactNode
    onConfirm: () => void
    onCancel: () => void
    confirmText?: string
    cancelText?: string
    /* danger: 红色按钮, primary: 主色按钮 */
    type?: 'danger' | 'primary'
    loading?: boolean
    footer?: ReactNode
}

export function ConfirmModal({
    open,
    title,
    content,
    onConfirm,
    onCancel,
    confirmText = '确认',
    cancelText = '取消',
    type = 'primary',
    loading = false,
    footer,
}: ConfirmModalProps) {
    return (
        <Modal
            open={open}
            onCancel={onCancel}
            footer={null}
            centered
            width={420}
            className="matrixit-confirm-modal"
            styles={{
                content: {
                    padding: 0,
                    borderRadius: 16,
                    overflow: 'hidden',
                    boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
                },
            }}
            closeIcon={null}
        >
            <div className="flex flex-col">
                {/* Header */}
                <div className="px-6 pt-6 pb-2">
                    <h3 className="text-lg font-semibold text-slate-900 leading-6 tracking-tight">
                        {title}
                    </h3>
                </div>

                {/* Content */}
                <div className="px-6 py-2 text-sm text-slate-500 leading-relaxed">
                    {content}
                </div>

                {/* Footer Actions */}
                <div className="px-6 py-4 bg-slate-50/50 flex items-center justify-end gap-3 mt-4 border-t border-slate-100">
                    {footer ? footer : (
                        <>
                            <Button
                                onClick={onCancel}
                                disabled={loading}
                                className="rounded-lg border-slate-200 text-slate-600 hover:text-slate-700 hover:border-slate-300 shadow-sm"
                            >
                                {cancelText}
                            </Button>
                            <Button
                                type={type === 'danger' ? 'primary' : 'primary'}
                                danger={type === 'danger'}
                                onClick={onConfirm}
                                loading={loading}
                                className={`rounded-lg shadow-sm font-medium ${type === 'primary' ? 'bg-[var(--primary-color)]' : ''
                                    }`}
                            >
                                {confirmText}
                            </Button>
                        </>
                    )}
                </div>
            </div>
        </Modal>
    )
}
