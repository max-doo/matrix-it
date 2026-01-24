---
trigger: always_on
---

# MatrixIt 项目规则
1. 原则：全仓库检索关联再改；最小改动；DRY；禁止写入/提交任何密钥、Token、隐私或真实数据
2. 技术栈（详见 README）：前端 React 19 + Vite 7 + Tailwind 4 + Ant Design 5/ProComponents；桌面 Tauri v2（Rust stable+MSVC，serde/serde_json）；后端 Python 3.11+（lark-oapi、pdfplumber；构建 pyinstaller）
3. 结构：`frontend/`(UI)；`src-tauri/`(IPC/sidecar/打包)；`backend/`(业务)。sidecar 逻辑只放 `backend/matrixit_backend/`；接口/JSON 变更需同步前端、Tauri 与文档；对项目进行较大调整后必须及时更新 README 说明（保持最新）
4. 依赖：Python 必须用项目虚拟环境（`.venv/`），禁止全局装包；Node 依赖仅在 `frontend/`；Rust 使用 stable+MSVC
5. 配置：可提交 `config.example.json`/`config.json`/`fields.json`；禁止提交 `config.local.json`、任何密钥文件与包含密钥的日志；新增配置项需同步示例与 README。
6. 路径：仓库内只用相对路径；跨平台用标准库（Python `pathlib/os.path`、Rust `std::path`）
7. 仓库卫生：禁止提交 `build/`、`dist/`、`.venv/`、`frontend/node_modules/`、`src-tauri/target/` 等产物；删除文件前必须检索引用并保证最小可运行链路可用。
8. 提交/分支：Conventional Commits（`feat/fix/docs/refactor/chore`）；单提交单主题；`main/develop` 必须 PR+至少 1 人 Review
9. 测试/门槛：合入前必须通过 `npm run lint`（0 error）；发版前必须通过 `npm run build` 与 `cargo test`；变更 sidecar/接口后至少执行一次 `python backend/matrixit_backend/sidecar.py load_library` 烟测并在 PR 记录输出要点
10. 禁止 API：前端禁止使用 Node/Electron API（如 `fs`/`child_process`）与 `eval/new Function`；禁止渲染未净化的 HTML（`dangerouslySetInnerHTML`）；Rust 禁止执行任意外部命令，仅允许调用固定 sidecar `matrixit-sidecar`；禁止在日志/错误信息中输出密钥与敏感配置
