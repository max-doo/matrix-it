---
trigger: always_on
---

# MatrixIt 项目规则

**核心原则** ：全仓库检索关联再改 | 最小改动 | DRY | 禁止提交密钥/Token/隐私数据

## 1. 结构约定（详见 README）
- `frontend/`（React+Vite+Tailwind+AntD）| `src-tauri/`（Rust Tauri v2）| `backend/`（Python 3.11+）
- Sidecar 逻辑仅放 `backend/matrixit_backend/`；接口/JSON 变更需同步前端、Rust 及文档

## 2. 依赖与环境
- Python 必须用 `.venv/`，禁止全局安装
- Node 依赖仅限 `frontend/`；Rust 使用 stable+MSVC

## 3. 配置与数据
- 可提交：`config.example.json`、`config/config.json`、`fields.json`
- 禁提交：`config.local.json`、密钥文件、含密钥日志、`data/` 目录内容
- 新增配置项需同步示例与 README

## 4. 路径与产物
- 仓库内只用相对路径；跨平台用 `pathlib/os.path`、`std::path`
- 禁提交：`build/`、`dist/`、`.venv/`、`node_modules/`、`target/`
- 删除文件前必须检索引用

## 5. 提交与审查
- Conventional Commits（feat/fix/docs/refactor/chore）；单提交单主题
- `main/develop` 必须 PR + ≥1 Review

## 6. 测试门槛
- 合入前：`npm run lint`（0 error）
- 发版前：`npm run build` + `cargo test`
- 变更 sidecar/接口后：运行 `python backend/matrixit_backend/sidecar.py load_library` 并记录输出

## 7. 禁止 API
- 前端禁用：Node/Electron API（`fs`/`child_process`）、`eval/new Function`、`dangerouslySetInnerHTML`
- Rust 禁执行任意命令，仅允许调用 `matrixit-sidecar`
- 禁在日志/错误中输出密钥

## 8. 文档同步
- 较大变更后及时更新 README