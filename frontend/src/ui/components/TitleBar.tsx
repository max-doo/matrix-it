/**
 * 模块名称: 自定义标题栏
 * 功能描述: 适配 Windows 风格的无边框窗口控制按钮（最小化、最大化/还原、关闭）。
 *           仅在 Tauri 桌面端环境有效。
 */
import { getCurrentWindow } from '@tauri-apps/api/window'
import { CloseOutlined, MinusOutlined, BorderOutlined } from '@ant-design/icons'

/**
 * Tauri 桌面端自定义标题栏按钮：
 * - 在纯 Web 环境下 getCurrentWindow 可能不可用，因此做 try/catch 兜底
 * - 按钮区域需显式设置 data-tauri-drag-region="false"，避免与可拖拽区域冲突
 */
// 在组件外获取 window 实例，避免重复调用
let appWindow: ReturnType<typeof getCurrentWindow> | null = null
try {
  appWindow = getCurrentWindow()
} catch {
  appWindow = null
}

export function TitleBar() {
  return (
    <div data-tauri-drag-region="false" className="fixed top-0 right-0 h-8 flex items-center z-[9999] select-none">
      <div className="flex h-full">
        <div
          data-tauri-drag-region="false"
          className="inline-flex justify-center items-center w-10 h-full hover:bg-black/5 cursor-pointer transition-colors"
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={async () => {
            if (!appWindow) return
            try {
              await appWindow.minimize()
            } catch {
              // ignore
            }
          }}
        >
          <MinusOutlined className="text-xs pointer-events-none" />
        </div>
        <div
          data-tauri-drag-region="false"
          className="inline-flex justify-center items-center w-10 h-full hover:bg-black/5 cursor-pointer transition-colors"
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={async () => {
            if (!appWindow) return
            try {
              await appWindow.toggleMaximize()
            } catch {
              // ignore
            }
          }}
        >
          <BorderOutlined className="text-xs scale-75 pointer-events-none" />
        </div>
        <div
          data-tauri-drag-region="false"
          className="inline-flex justify-center items-center w-10 h-full hover:bg-red-500 hover:text-white cursor-pointer transition-colors"
          onMouseDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onPointerDown={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
          onClick={async () => {
            if (!appWindow) return
            try {
              await appWindow.close()
            } catch {
              // ignore
            }
          }}
        >
          <CloseOutlined className="text-xs pointer-events-none" />
        </div>
      </div>
    </div>
  )
}
