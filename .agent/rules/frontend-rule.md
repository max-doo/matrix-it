---
trigger: model_decision
description: 前端开发规范，当进行前端开发时必须遵守
---

# 前端规范 (React+Tauri)

## 1. 性能 (React)
1. 状态聚合：关联状态合并为对象，禁止分散 setState
2. 列表优化：render 内禁止匿名函数，使用 useCallback + data-key 委托
3. 非阻塞：视图切换使用 startTransition

## 2. 交互 (Tauri)
1. 物理隔离：拖拽层严禁覆盖点击元素。顶部拖拽层必须显式避让右上角按钮 (right: 140px)
2. Portal 防护：全局 CSS 禁用 Antd 弹窗拖拽 (.ant-popover { -webkit-app-region: no-drag })
3. 容器纯净：含交互控件的父容器禁设拖拽属性

## 3. 基础
1. 样式：Tailwind 为主，组件覆盖加特异性类名
2. 路径：强制相对路径
3. 图标：统一 @ant-design/icons