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
export function TitleBar() {
  let appWindow: ReturnType<typeof getCurrentWindow> | null = null
  try {
    appWindow = getCurrentWindow()
  } catch {
    appWindow = null
  }

  return (
    <div className="fixed top-0 right-0 h-8 flex items-center z-50 select-none">
      <div className="flex h-full">
        <div
          data-tauri-drag-region="false"
          className="inline-flex justify-center items-center w-10 h-full hover:bg-black/5 cursor-pointer transition-colors"
          onClick={async () => {
            if (!appWindow) return
            try {
              await appWindow.minimize()
            } catch {
              return
            }
          }}
        >
          <MinusOutlined className="text-xs" />
        </div>
        <div
          data-tauri-drag-region="false"
          className="inline-flex justify-center items-center w-10 h-full hover:bg-black/5 cursor-pointer transition-colors"
          onClick={async () => {
            if (!appWindow) return
            try {
              await appWindow.toggleMaximize()
            } catch {
              return
            }
          }}
        >
          <BorderOutlined className="text-xs scale-75" />
        </div>
        <div
          data-tauri-drag-region="false"
          className="inline-flex justify-center items-center w-10 h-full hover:bg-red-500 hover:text-white cursor-pointer transition-colors"
          onClick={async () => {
            if (!appWindow) return
            try {
              await appWindow.close()
            } catch {
              return
            }
          }}
        >
          <CloseOutlined className="text-xs" />
        </div>
      </div>
    </div>
  )
}
