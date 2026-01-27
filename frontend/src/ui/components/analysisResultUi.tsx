import type { ReactNode } from 'react'
import { Button, Collapse } from 'antd'
import type { AnalysisReport } from '../../types'

type ModalLike = {
  info: (opts: { title: string; width?: number; okText?: string; content: ReactNode }) => unknown
}

type MessageLike = {
  success: (opts: { key?: string; duration?: number; content: ReactNode } | string) => unknown
  error: (opts: { content: string; key?: string } | string) => unknown
}

const formatMs = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

const buildItemLines = (items: AnalysisReport['items']) => {
  return items
    .map((it) => {
      const dur =
        typeof it.started_at === 'number' && typeof it.ended_at === 'number'
          ? ` ${formatMs(it.ended_at - it.started_at)}`
          : ''
      const err = it.error ? ` | ${it.error}` : ''
      return `${it.status.toUpperCase()}${dur} | ${it.item_key}${err}`
    })
    .join('\n')
}

export function createAnalysisResultUi(modal: ModalLike, message: MessageLike) {
  const showDetails = (report: AnalysisReport) => {
    const raw = JSON.stringify(report.raw_events, null, 2)
    const failedLines =
      report.items
        .filter((x) => x.status === 'failed')
        .map((x) => `${x.item_key} | ${x.error ?? ''}`)
        .join('\n') || '无'

    void modal.info({
      title: '分析详情（本次）',
      width: 760,
      okText: '关闭',
      content: (
        <div className="space-y-3">
          <div className="text-sm">
            <div>
              {report.total} 篇 · 成功 {report.finished} / 失败 {report.failed} / 取消 {report.cancelled} · 用时{' '}
              {formatMs(report.duration_ms)}
            </div>
          </div>
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(raw)
                message.success('日志已复制')
              } catch {
                message.error('复制失败')
              }
            }}
          >
            复制日志
          </Button>
          <Collapse
            size="small"
            items={[
              {
                key: 'failed',
                label: <span className="text-slate-600">失败明细（{report.failed}）</span>,
                children: (
                  <pre className="text-xs whitespace-pre-wrap break-words max-h-56 overflow-auto bg-slate-50 p-3 rounded">
                    {failedLines}
                  </pre>
                ),
              },
              {
                key: 'items',
                label: <span className="text-slate-600">条目明细（全部）</span>,
                children: (
                  <pre className="text-xs whitespace-pre-wrap break-words max-h-56 overflow-auto bg-slate-50 p-3 rounded">
                    {buildItemLines(report.items)}
                  </pre>
                ),
              },
              {
                key: 'raw',
                label: <span className="text-slate-600">原始日志</span>,
                children: (
                  <pre className="text-xs whitespace-pre-wrap break-words max-h-56 overflow-auto bg-slate-50 p-3 rounded">
                    {raw}
                  </pre>
                ),
              },
            ]}
          />
        </div>
      ),
    })
  }

  const showToast = (report: AnalysisReport) => {
    message.success({
      key: 'analysis',
      duration: 6,
      content: (
        <span className="flex items-center gap-2">
          <span>
            {report.total} 篇 · 成功 {report.finished} / 失败 {report.failed} / 取消 {report.cancelled} · 用时{' '}
            {formatMs(report.duration_ms)}
          </span>
          <Button type="link" size="small" onClick={() => showDetails(report)}>
            查看详情
          </Button>
        </span>
      ),
    })
  }

  return { showToast, showDetails }
}

