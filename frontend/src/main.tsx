/**
 * 模块名称: 应用程序入口
 * 功能描述: 前端应用的启动点，负责渲染 React 根组件并加载全局样式。
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './ui/App'
import './ui/styles.css'

// 应用入口：仅负责挂载 React Root 与引入全局样式
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
