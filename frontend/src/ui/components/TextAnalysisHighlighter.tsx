
import { DeleteOutlined, HighlightOutlined, MessageOutlined } from '@ant-design/icons'
import { Button, Input, Popover, Space, theme, Tooltip } from 'antd'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Annotation } from '../../types'

export type TextAnalysisHighlighterProps = {
    text: string
    fieldKey: string
    annotations: Annotation[]
    onChange: (newAnnotations: Annotation[]) => void
    readOnly?: boolean
}

type SelectionState = {
    range: Range | null
    rect: DOMRect | null
    isNew: boolean // true for new selection, false for clicking existing highlight
    activeAnnotationId?: string
}

const COLORS = [
    { key: 'yellow', value: '#fef08a', label: '黄' }, // yellow-200
    { key: 'red', value: '#fecaca', label: '红' }, // red-200
    { key: 'green', value: '#bbf7d0', label: '绿' }, // green-200
    { key: 'blue', value: '#bfdbfe', label: '蓝' }, // blue-200
]

export function TextAnalysisHighlighter({
    text,
    fieldKey,
    annotations,
    onChange,
    readOnly = false,
}: TextAnalysisHighlighterProps) {
    const containerRef = useRef<HTMLDivElement>(null)
    const [selectionState, setSelectionState] = useState<SelectionState | null>(null)
    const [commentDraft, setCommentDraft] = useState('')

    const { token } = theme.useToken()

    // 1. 渲染逻辑：将文本切片并插入高亮元素
    const renderContent = useMemo(() => {
        if (!text) return null

        // 过滤掉无效或文本不匹配的高亮 (Strict Validation)
        const validAnnotations = annotations
            .filter((a) => {
                const slice = text.slice(a.start, a.end)
                return slice === a.text
            })
            .sort((a, b) => a.start - b.start)

        if (validAnnotations.length === 0) {
            return <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{text}</span>
        }

        const nodes: React.ReactNode[] = []
        let lastIndex = 0

        validAnnotations.forEach((ann) => {
            // 添加普通文本
            if (ann.start > lastIndex) {
                nodes.push(
                    <span key={`text-${lastIndex}`} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                        {text.slice(lastIndex, ann.start)}
                    </span>
                )
            }

            // 添加高亮文本
            const colorDef = COLORS.find((c) => c.key === ann.color)
            const highlightSpan = (
                <span
                    key={`ann-${ann.id}`}
                    data-annotation-id={ann.id}
                    className="cursor-pointer whitespace-pre-wrap break-words [overflow-wrap:anywhere] transition-colors hover:brightness-95"
                    style={{
                        backgroundColor: colorDef?.value || '#fef08a',
                        borderBottom: '2px solid transparent',
                    }}
                    onClick={(e) => {
                        e.stopPropagation()
                        handleAnnotationClick(ann, e)
                    }}
                >
                    {text.slice(ann.start, ann.end)}
                </span>
            )

            if (ann.comment) {
                nodes.push(
                    <Tooltip key={`tooltip-${ann.id}`} title={ann.comment} color="#1e293b">
                        {highlightSpan}
                    </Tooltip>
                )
            } else {
                nodes.push(highlightSpan)
            }

            lastIndex = ann.end
        })

        // 添加剩余文本
        if (lastIndex < text.length) {
            nodes.push(
                <span key={`text-${lastIndex}`} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                    {text.slice(lastIndex)}
                </span>
            )
        }

        return nodes
    }, [text, annotations])

    // 2. 处理选区
    const handleMouseUp = useCallback(() => {
        if (readOnly) return
        const selection = window.getSelection()
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
            // 点击空白处关闭 Popover，除非是点击了高亮本身（由 handleAnnotationClick 处理）
            // 这里稍微延迟一下，避免与 onClick 冲突
            return
        }

        const range = selection.getRangeAt(0)
        const textContent = range.toString()
        if (!textContent.trim()) return

        // 确保选区在我们的容器内
        if (!containerRef.current?.contains(range.commonAncestorContainer)) return

        // 计算相对于 text 的 start/end 索引
        // 这是一个难点，因为 DOM 结构被高亮打断了。
        // 我们采用比较笨但可靠的方法：重新构建纯文本位置。
        // 但是，利用 Range offset 在混合 DOM 中很复杂。
        // 简便方案：禁止跨越高亮选区？或者只允许选中纯文本节点？
        // 为了 V1 简单，我们利用 selection 的 anchorNode 和 focusNode 来计算。

        // 更稳健的方法：
        // 获取选区相对于 container 的纯文本偏移量。
        // 由于我们渲染时保持了文本顺序，可以用 TreeWalker 或 Range 扩展来计算。

        const preSelectionRange = range.cloneRange()
        preSelectionRange.selectNodeContents(containerRef.current)
        preSelectionRange.setEnd(range.startContainer, range.startOffset)
        const start = preSelectionRange.toString().length
        const end = start + textContent.length

        // 检查是否与现有高亮重叠 (Overlap Check)
        const isOverlap = annotations.some((a) => {
            // 简单的区间重叠判断: start < a.end && end > a.start
            return start < a.end && end > a.start && text.slice(a.start, a.end) === a.text // 且该高亮有效
        })

        if (isOverlap) {
            // V1 不支持重叠高亮
            selection.removeAllRanges()
            return
        }

        const rect = range.getBoundingClientRect()
        setSelectionState({
            range,
            rect,
            isNew: true,
        })
    }, [annotations, readOnly, text])

    // 处理点击现有高亮
    const handleAnnotationClick = (ann: Annotation, e: React.MouseEvent) => {
        if (readOnly) return
        const target = e.currentTarget as HTMLElement
        const rect = target.getBoundingClientRect()
        setSelectionState({
            range: null,
            rect,
            isNew: false,
            activeAnnotationId: ann.id,
        })
        setCommentDraft(ann.comment || '')
    }

    // 关闭 Popover
    const handleClose = () => {
        setSelectionState(null)
        setCommentDraft('')
        window.getSelection()?.removeAllRanges()
    }

    // 创建新高亮
    const handleCreate = (color: string) => {
        if (!selectionState?.range) return

        // 重新计算 start/end (确保准确)
        const range = selectionState.range
        const preSelectionRange = range.cloneRange()
        if (!containerRef.current) return
        preSelectionRange.selectNodeContents(containerRef.current)
        preSelectionRange.setEnd(range.startContainer, range.startOffset)
        const start = preSelectionRange.toString().length
        const textContent = range.toString()
        const end = start + textContent.length

        const newAnn: Annotation = {
            id: crypto.randomUUID(),
            start,
            end,
            text: textContent,
            color,
            createdAt: Date.now(),
        }

        onChange([...annotations, newAnn])
        handleClose()
    }

    // 更新现有高亮 (评论)
    const handleUpdateComment = () => {
        if (!selectionState?.activeAnnotationId) return
        const next = annotations.map((a) =>
            a.id === selectionState.activeAnnotationId ? { ...a, comment: commentDraft } : a
        )
        onChange(next)
        handleClose()
    }

    // 删除高亮
    const handleDelete = () => {
        if (!selectionState?.activeAnnotationId) return
        const next = annotations.filter((a) => a.id !== selectionState.activeAnnotationId)
        onChange(next)
        handleClose()
    }

    // 监听全局点击以关闭 Popover (如果点击在外部)
    useEffect(() => {
        const onClickGlobal = (e: MouseEvent) => {
            if (!selectionState) return
            // 如果点击在 Popover 内部，不关闭。Antd Popover 处理了这个吗？通常 overlay 也是 body 的子元素。
            // 最简单的方式是依靠 Popover 的 trigger="click" or open/onOpenChange？
            // 但我们需要手动控制位置。
            // 实际上，我们不需要全局监听，点击 document 任何非 popover 区域应该关闭。
            // 这里简便处理：在 container 的 onMouseDown (Capture) 或者利用 mask?
            // Antd Popover 没有 mask。
            const target = e.target as HTMLElement

            // Klik Popover 内部，不关闭
            if (target.closest('.ant-popover')) return

            // 点击容器内：如果是为了开始新的选择或取消选择，我们应该关闭当前的 Popover
            // 但不应调用 removeAllRanges，否则会打断用户的拖拽选择操作或光标定位
            if (containerRef.current?.contains(target)) {
                setSelectionState(null)
                setCommentDraft('')
                return
            }

            handleClose()
        }
        document.addEventListener('mousedown', onClickGlobal)
        return () => document.removeEventListener('mousedown', onClickGlobal)
    }, [selectionState])

    // 虚拟元素用于 Popover 定位
    const getPopupContainer = () => document.body
    // 构造一个虚拟的 DOM 元素给 Popover
    const virtualEl = useMemo(() => {
        if (!selectionState?.rect) return null
        const { left, top, width, height } = selectionState.rect
        return {
            getBoundingClientRect: () => DOMRect.fromRect({ x: left, y: top, width, height }),
            clientWidth: width,
            clientHeight: height,
        } as HTMLElement
    }, [selectionState])

    return (
        <>
            <div
                ref={containerRef}
                onMouseUp={handleMouseUp}
                className="relative outline-none"
                style={{ cursor: readOnly ? 'default' : 'text' }}
            >
                {renderContent}
            </div>

            {/* Popover */}
            {selectionState?.rect && virtualEl && (
                <Popover
                    open={true}
                    getPopupContainer={getPopupContainer}
                    destroyTooltipOnHide
                    content={
                        <div className="flex flex-col gap-2 min-w-[200px]">
                            {selectionState.isNew ? (
                                // 新建模式：选颜色
                                <div className="flex gap-2 justify-center">
                                    {COLORS.map((c) => (
                                        <button
                                            key={c.key}
                                            className="w-6 h-6 rounded-full border border-slate-200 hover:scale-110 transition-transform"
                                            style={{ backgroundColor: c.value }}
                                            onClick={() => handleCreate(c.key)}
                                            title={c.label}
                                        />
                                    ))}
                                </div>
                            ) : (
                                // 编辑模式：改颜色(可选) + 评论 + 删除
                                <>
                                    <div className="flex gap-2 justify-center pb-2 border-b border-slate-100">
                                        {COLORS.map((c) => (
                                            <button
                                                key={c.key}
                                                className={`w-5 h-5 rounded-full border border-slate-200 hover:scale-110 transition-transform ${annotations.find((a) => a.id === selectionState.activeAnnotationId)?.color === c.key
                                                    ? 'ring-2 ring-primary ring-offset-1'
                                                    : ''
                                                    }`}
                                                style={{ backgroundColor: c.value }}
                                                onClick={() => {
                                                    const next = annotations.map((a) =>
                                                        a.id === selectionState.activeAnnotationId ? { ...a, color: c.key } : a
                                                    )
                                                    onChange(next)
                                                }}
                                            />
                                        ))}
                                    </div>
                                    <Input.TextArea
                                        placeholder="添加评论..."
                                        value={commentDraft}
                                        onChange={(e) => setCommentDraft(e.target.value)}
                                        autoSize={{ minRows: 2, maxRows: 4 }}
                                        className="text-xs"
                                    />
                                    <div className="flex justify-between items-center pt-1">
                                        <Button
                                            type="text"
                                            danger
                                            size="small"
                                            icon={<DeleteOutlined />}
                                            onClick={handleDelete}
                                        >
                                            删除
                                        </Button>
                                        <Button type="primary" size="small" onClick={handleUpdateComment}>
                                            保存
                                        </Button>
                                    </div>
                                </>
                            )}
                        </div>
                    }
                >
                    {/* 这里的 div 是为了让 Popover 有挂载点，通过 ref 传递虚拟位置 */}
                    <div
                        style={{
                            position: 'fixed',
                            left: selectionState.rect.left,
                            top: selectionState.rect.top,
                            width: selectionState.rect.width,
                            height: selectionState.rect.height,
                            pointerEvents: 'none',
                            visibility: 'hidden'
                        }}
                    />
                </Popover>
            )}
        </>
    )
}
