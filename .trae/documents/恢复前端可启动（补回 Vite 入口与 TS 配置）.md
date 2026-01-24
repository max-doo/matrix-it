## 现状定位
- 当前 `frontend/` 目录缺少 Vite 必需入口文件 `index.html`（只有 `frontend/dist/index.html`），这会导致 `npm run dev` 直接无法启动（Vite 以 `index.html` 作为入口）。
- `frontend/` 同时缺少 `tsconfig.json / tsconfig.app.json / tsconfig.node.json`（仅残留 `*.tsbuildinfo`），这会导致 `npm run build` 的 `tsc -b` 无法执行，并可能引发 TS/IDE 与部分构建链路异常。

## 计划改动（为恢复启动做最小补齐）
### 1) 新增缺失的前端入口文件（需要新增文件）
- 新增 `frontend/index.html`：以 Vite 标准入口形式引用 `/src/main.tsx`，语言 `zh-CN`，并保留 `#root` 容器。

### 2) 补回 TypeScript 项目配置（需要新增文件）
- 新增 `frontend/tsconfig.json`：使用 project references，指向 app/node 两个配置，匹配当前 `tsc -b` 脚本。
- 新增 `frontend/tsconfig.app.json`：面向浏览器端代码（`src/**`），设置 `jsx: react-jsx`、`moduleResolution: bundler` 等 Vite/TS5 推荐项。
- 新增 `frontend/tsconfig.node.json`：面向 `vite.config.ts` 等 Node 侧配置。
- 新增 `frontend/src/vite-env.d.ts`：`/// <reference types="vite/client" />`（补齐 Vite 全局类型，避免类型报错）。

### 3) 启动验证并做“只修启动”的必要修复（可能需要编辑现有文件）
- 启动 `npm run dev` 观察首个报错点。
- 若出现 `Cannot find namespace 'React'`（当前代码里多处使用 `React.Key/React.CSSProperties/...`），则按最小改动方式处理：
  - 要么在涉及文件加 `import type React from 'react'`；
  - 要么改为从 `react` 显式 import type（如 `Key`, `CSSProperties`），并替换 `React.*`。
  - 目标是让 TypeScript 与 Vite 开发态稳定通过。

## 影响范围
- 仅影响 `frontend/` 的启动与 TS 构建链路；不触碰业务逻辑/后端/Tauri。

## 验证方式（我会在你确认后执行）
- `cd frontend && npm run dev`
- `cd frontend && npm run lint`
- `cd frontend && npm run build`（确保 `tsc -b` 恢复正常）

## 需要你同意的“新增文件”清单（按你的规则）
- `frontend/index.html`
- `frontend/tsconfig.json`
- `frontend/tsconfig.app.json`
- `frontend/tsconfig.node.json`
- `frontend/src/vite-env.d.ts`

确认后我会先补齐这些文件，然后立刻启动前端定位并修复剩余的阻塞错误，直到前端可以正常启动。