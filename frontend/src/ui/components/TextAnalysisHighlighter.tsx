
import { DeleteOutlined, CopyOutlined, EyeOutlined } from '@ant-design/icons'
import { Button, Input, Popover, Tooltip, message, Typography, Modal } from 'antd'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import type { Annotation } from '../../types'
import { useContextMenu } from './GlobalContextMenu'
import { getHighlightRegex } from '../utils/ui-formatters'

export type TextAnalysisHighlighterProps = {
    text: string
    fieldKey: string
    annotations: Annotation[]
    onChange: (newAnnotations: Annotation[]) => void
    readOnly?: boolean
    onAnalyze?: (text: string, id?: string) => void
    onViewDetails?: (id: string) => void
    onReadOriginal?: (id: string) => void
    showViewDetails?: boolean
    highlightQuery?: string
}

type SelectionState = {
    range: Range | null
    rect: DOMRect | null
    isNew: boolean // 新建选区为 true，点击现有高亮为 false
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
    onAnalyze,
    onViewDetails,
    onReadOriginal,
    showViewDetails = false,
    highlightQuery,
}: TextAnalysisHighlighterProps) {
    const containerRef = useRef<HTMLDivElement>(null)
    const [selectionState, setSelectionState] = useState<SelectionState | null>(null)
    const [commentDraft, setCommentDraft] = useState('')
    const { showMenu } = useContextMenu()

    // 1. 渲染逻辑：将文本切片并插入高亮元素
    const renderContent = useMemo(() => {
        if (!text) return null

        // 过滤文本不匹配的高亮
        const validAnnotations = annotations
            .filter((a) => {
                const slice = text.slice(a.start, a.end)
                return slice === a.text
            })
            .sort((a, b) => a.start - b.start)

        if (validAnnotations.length === 0) {
            // 如果只有搜索高亮，没有分析高亮
            const regex = highlightQuery ? getHighlightRegex(highlightQuery) : null
            if (!regex || !text) {
                return <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{text}</span>
            }

            const parts = text.split(regex)
            return (
                <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                    {parts.map((part, idx) =>
                        idx % 2 === 1 ? (
                            <Typography.Text key={idx} mark className="!p-0 !mx-0 rounded-[2px]">
                                {part}
                            </Typography.Text>
                        ) : (
                            part
                        )
                    )}
                </span>
            )
        }


        const nodes: React.ReactNode[] = []
        let lastIndex = 0

        validAnnotations.forEach((ann) => {
            // 添加普通文本 (尝试在该段文本中进行搜索高亮)
            if (ann.start > lastIndex) {
                const subText = text.slice(lastIndex, ann.start)
                const regex = highlightQuery ? getHighlightRegex(highlightQuery) : null
                let content: React.ReactNode = subText

                if (regex && subText) {
                    const parts = subText.split(regex)
                    if (parts.length > 1) {
                        content = parts.map((part, idx) =>
                            idx % 2 === 1 ? (
                                <Typography.Text key={`h-${lastIndex}-${idx}`} mark className="!p-0 !mx-0 rounded-[2px]">
                                    {part}
                                </Typography.Text>
                            ) : (
                                part
                            )
                        )
                    }
                }

                nodes.push(
                    <span key={`text-${lastIndex}`} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                        {content}
                    </span>
                )
            }

            // 添加高亮文本
            const colorDef = COLORS.find((c) => c.key === ann.color)
            const highlightSpan = (
                <span
                    key={`ann-${ann.id}`}
                    data-annotation-id={ann.id}
                    className="cursor-pointer whitespace-pre-wrap break-words [overflow-wrap:anywhere] transition-colors hover:brightness-95 relative"
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
                    {ann.comment && (
                        <div
                            className="absolute w-1.5 h-1.5 rounded-full"
                            style={{
                                top: '-3px',
                                left: '-3px',
                                backgroundColor: 'var(--primary-color)',
                                pointerEvents: 'none'
                            }}
                        />
                    )}
                </span>
            )

            if (ann.comment) {
                nodes.push(
                    <Tooltip
                        key={`tooltip-${ann.id}`}
                        title={
                            <div className="whitespace-normal break-words markdown-tooltip max-h-[50vh] overflow-y-auto custom-scrollbar">
                                <ReactMarkdown
                                    remarkPlugins={[remarkGfm, remarkMath]}
                                    rehypePlugins={[rehypeKatex]}
                                    components={{
                                        h1: (props: any) => <h1 className="text-xl font-bold mb-2 mt-2 first:mt-0 pb-1 border-b border-slate-600">{props.children}</h1>,
                                        h2: (props: any) => <h2 className="text-lg font-bold mb-2 mt-2 first:mt-0">{props.children}</h2>,
                                        h3: (props: any) => <h3 className="text-base font-bold mb-1 mt-1 first:mt-0">{props.children}</h3>,
                                        p: (props: any) => <div className="text-sm leading-relaxed mb-2 last:mb-0">{props.children}</div>,
                                        ul: (props: any) => <ul className="pl-5 list-disc mb-2 last:mb-0 space-y-1">{props.children}</ul>,
                                        ol: (props: any) => <ol className="pl-5 list-decimal mb-2 last:mb-0 space-y-1">{props.children}</ol>,
                                        li: (props: any) => <li className="leading-relaxed">{props.children}</li>,
                                        blockquote: (props: any) => <blockquote className="border-l-4 border-orange-400 pl-2 italic text-orange-200 my-2">{props.children}</blockquote>,
                                        strong: (props: any) => <strong className="font-semibold">{props.children}</strong>,
                                        a: (props: any) => <a href={props.href} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline hover:text-blue-300">{props.children}</a>,
                                        table: (props: any) => <table className="w-full border-collapse border border-slate-600 my-2 text-sm">{props.children}</table>,
                                        thead: (props: any) => <thead className="bg-slate-800">{props.children}</thead>,
                                        tbody: (props: any) => <tbody>{props.children}</tbody>,
                                        tr: (props: any) => <tr className="border-b border-slate-700 last:border-0 hover:bg-slate-700/50">{props.children}</tr>,
                                        th: (props: any) => <th className="p-2 text-left font-semibold border-r border-slate-600 last:border-0 text-slate-200">{props.children}</th>,
                                        td: (props: any) => <td className="p-2 border-r border-slate-700 last:border-0 align-top">{props.children}</td>
                                    }}
                                >
                                    {ann.comment?.replace(/(.+)\n\s*(-{3,})/g, '$1\n\n$2')}
                                </ReactMarkdown>
                            </div>
                        }
                        color="#1e293b"
                        overlayStyle={{ maxWidth: 'min(500px, 90vw)' }}
                        autoAdjustOverflow
                        getPopupContainer={(triggerNode) => triggerNode.parentElement || document.body}
                    >
                        {highlightSpan}
                    </Tooltip>
                )
            } else {
                nodes.push(highlightSpan)
            }

            lastIndex = ann.end
        })

        // 添加剩余文本 (尝试搜索高亮)
        if (lastIndex < text.length) {
            const subText = text.slice(lastIndex)
            const regex = highlightQuery ? getHighlightRegex(highlightQuery) : null
            let content: React.ReactNode = subText

            if (regex && subText) {
                const parts = subText.split(regex)
                if (parts.length > 1) {
                    content = parts.map((part, idx) =>
                        idx % 2 === 1 ? (
                            <Typography.Text key={`h-${lastIndex}-${idx}`} mark className="!p-0 !mx-0 rounded-[2px]">
                                {part}
                            </Typography.Text>
                        ) : (
                            part
                        )
                    )
                }
            }

            nodes.push(
                <span key={`text-${lastIndex}`} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                    {content}
                </span>
            )
        }

        return nodes
    }, [text, annotations, highlightQuery])

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

        // 忽略 Tooltip 内的选区，避免在 Tooltip 中选择文字时弹出颜色选择器
        const commonAncestor = range.commonAncestorContainer as HTMLElement
        if (commonAncestor.closest?.('.ant-tooltip') || (commonAncestor.parentElement?.closest?.('.ant-tooltip'))) return

        // 简便方案：使用 selection 的 anchorNode 和 focusNode 来计算
        // 规避复杂的跨节点 Range 计算

        const preSelectionRange = range.cloneRange()
        preSelectionRange.selectNodeContents(containerRef.current)
        preSelectionRange.setEnd(range.startContainer, range.startOffset)
        const start = preSelectionRange.toString().length
        const end = start + textContent.length

        // 检查重叠
        const isOverlap = annotations.some((a) => {
            return start < a.end && end > a.start && text.slice(a.start, a.end) === a.text
        })

        if (isOverlap) {
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

    // 更新现有高亮 (评论) - 即时保存
    const handleUpdateComment = useCallback((newComment: string) => {
        if (!selectionState?.activeAnnotationId) return
        const next = annotations.map((a) =>
            a.id === selectionState.activeAnnotationId ? { ...a, comment: newComment } : a
        )
        onChange(next)
    }, [selectionState?.activeAnnotationId, annotations, onChange])

    // 防抖自动保存
    useEffect(() => {
        if (!selectionState?.activeAnnotationId || selectionState.isNew) return
        const timer = setTimeout(() => {
            handleUpdateComment(commentDraft)
        }, 500)
        return () => clearTimeout(timer)
    }, [commentDraft, selectionState?.activeAnnotationId, selectionState?.isNew])

    // 删除高亮
    const handleDelete = () => {
        if (!selectionState?.activeAnnotationId) return
        const ann = annotations.find((a) => a.id === selectionState.activeAnnotationId)

        const doDelete = () => {
            const next = annotations.filter((a) => a.id !== selectionState.activeAnnotationId)
            onChange(next)
            handleClose()
        }

        // 有评论时需要确认
        if (ann?.comment) {
            Modal.confirm({
                title: '确认删除',
                content: '该高亮包含评论内容，删除后将无法恢复。确定要删除吗？',
                okText: '删除',
                okButtonProps: { danger: true },
                cancelText: '取消',
                onOk: doDelete,
            })
        } else {
            doDelete()
        }
    }

    // 监听全局点击以关闭 Popover (如果点击在外部)
    useEffect(() => {
        const onClickGlobal = (e: MouseEvent) => {
            if (!selectionState) return
            const target = e.target as HTMLElement

            // 点击 Popover 内部不关闭
            if (target.closest('.ant-popover')) return

            // 点击容器内：重置选区
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

    // Context Menu Handler
    const handleContextMenu = useCallback(
        (e: React.MouseEvent) => {
            const target = e.target as HTMLElement
            const annotationId = target.getAttribute('data-annotation-id')
            const selection = window.getSelection()
            const selectedText = selection?.toString().trim()

            const menuItems: any[] = []

            // 1. 高亮上下文
            if (annotationId) {
                const ann = annotations.find((a) => a.id === annotationId)
                if (ann) {
                    if (showViewDetails) {
                        menuItems.push({
                            key: 'view-details',
                            label: '查看详情',
                            icon: <EyeOutlined />,
                            onClick: () => onViewDetails?.(ann.id),
                        })
                    }

                    menuItems.push({
                        key: 'copy-highlight',
                        label: '复制高亮',
                        icon: <CopyOutlined />,
                        onClick: () => {
                            void navigator.clipboard.writeText(ann.text)
                            message.success('已复制')
                        }
                    })


                    if (!readOnly) {
                        menuItems.push({
                            key: 'delete',
                            label: '删除高亮',
                            icon: <DeleteOutlined />,
                            danger: true,
                            onClick: () => {
                                const doDelete = () => {
                                    const next = annotations.filter((a) => a.id !== annotationId)
                                    onChange(next)
                                }

                                // 有评论时需要确认
                                if (ann.comment) {
                                    Modal.confirm({
                                        title: '确认删除',
                                        content: '该高亮包含评论内容，删除后将无法恢复。确定要删除吗？',
                                        okText: '删除',
                                        okButtonProps: { danger: true },
                                        cancelText: '取消',
                                        onOk: doDelete,
                                    })
                                } else {
                                    doDelete()
                                }
                            },
                        })
                    }
                }
            }

            // 2. 选区上下文
            if (selectedText && !selection?.isCollapsed) {
                if (menuItems.length > 0) {
                    // 可选：添加分割线
                }

                menuItems.push({
                    key: 'copy',
                    label: '复制',
                    icon: <CopyOutlined />,
                    onClick: () => {
                        void navigator.clipboard.writeText(selectedText)
                        message.success('已复制')
                    }
                })

            }

            if (menuItems.length > 0) {
                e.preventDefault()
                e.stopPropagation()
                showMenu(menuItems, { x: e.clientX, y: e.clientY })
            }
        },
        [annotations, onChange, readOnly, showMenu, onViewDetails, showViewDetails]
    )

    return (
        <>
            <div
                ref={containerRef}
                onMouseUp={handleMouseUp}
                onContextMenu={handleContextMenu}
                className="relative outline-none"
                style={{ cursor: readOnly ? 'default' : 'text' }}
            >
                {renderContent}
            </div>

            {/* 创建/编辑 Popover */}
            {selectionState?.rect && (
                <Popover
                    open={true}
                    getPopupContainer={() => document.body}
                    destroyTooltipOnHide
                    content={
                        <div className={`flex flex-col gap-2 ${selectionState.isNew ? 'w-auto' : 'w-[420px]'}`}>
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
                                // 编辑模式：改颜色 + 评论 + 删除
                                <>
                                    <div className="flex gap-2 justify-between items-center pb-2 border-b border-slate-100">
                                        <div className="flex gap-2">
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
                                        <div className="flex gap-2">
                                            {commentDraft && (
                                                <Button
                                                    type="text"
                                                    size="small"
                                                    icon={<CopyOutlined />}
                                                    onClick={() => {
                                                        void navigator.clipboard.writeText(commentDraft)
                                                        message.success('已复制评论')
                                                    }}
                                                >
                                                    复制评论
                                                </Button>
                                            )}
                                            <Button
                                                type="text"
                                                danger
                                                size="small"
                                                icon={<DeleteOutlined />}
                                                onClick={handleDelete}
                                            >
                                                删除高亮
                                            </Button>
                                        </div>
                                    </div>
                                    <Input.TextArea
                                        placeholder="添加评论..."
                                        value={commentDraft}
                                        onChange={(e) => setCommentDraft(e.target.value)}
                                        autoSize={{ minRows: 2, maxRows: 24 }}
                                        className="text-xs"
                                    />
                                </>
                            )}
                        </div>
                    }
                >
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
