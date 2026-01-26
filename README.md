# MatrixIt

面向科研场景的「Zotero → 本地矩阵 → 一键分析 → 飞书多维表格」自动化工具（桌面端）。

## 目录结构与职责

- `frontend/`：React + Vite + Tailwind + Ant Design 前端
- `src-tauri/`：Tauri（Rust）主进程（负责 IPC、Sidecar 调用与打包）
- `backend/`：Python 侧后端（读取 Zotero、提取 PDF 文本、同步飞书、Sidecar）

## 项目结构树与代码作用

下面是“关键源码/配置”的结构树（已省略构建产物与体积较大的目录，例如 `frontend/node_modules/`、`frontend/dist/`、`src-tauri/target/`、`.venv/` 等）：

```text
matrix-it/
├─ frontend/                      # 前端（React + Vite + Tailwind + Ant Design）
│  ├─ src/
│  │  ├─ main.tsx                 # 前端入口：挂载 React 应用
│  │  ├─ types.ts                 # 前后端共享的数据结构定义（文献/集合/事件等）
│  │  ├─ lib/
│  │  │  ├─ backend.ts            # 前端调用 Tauri command 的封装（invoke）
│  │  │  └─ mock.ts               # 本地 mock 数据（无后端/调 UI 时使用）
│  │  └─ ui/
│  │     ├─ App.tsx               # 主界面：布局组装 + 状态 glue（核心逻辑下沉到 hooks）
│  │     ├─ styles.css            # Tailwind 基础样式 + 少量全局样式
│  │     ├─ defaults/
│  │     │  └─ analysisFields.ts  # 默认解析字段定义
│  │     ├─ hooks/                # 状态管理 hooks（库刷新/引用/分析/设置/筛选/列配置/详情保存/详情导航）
│  │     ├─ lib/                  # UI 侧轻量工具（storage/theme/collection utils）
│  │     ├─ utils/
│  │     │  └─ ui-formatters.tsx  # UI 格式化工具（作者名处理、文献类型映射/着色）
│  │     └─ components/
│  │        ├─ AppSidebar.tsx      # 左侧集合树：搜索、展开/收起、选中态
│  │        ├─ ColumnSettingsPopover.tsx # 字段设置弹层：列显隐/顺序，拖拽排序（带滚动/限高）
│  │        ├─ WorkbenchToolbar.tsx # 工作台顶部工具条：搜索/筛选/列设置/分析/删除
│  │        ├─ SettingsSidebar.tsx # 设置页侧边栏：分区导航 + 返回
│  │        ├─ LiteratureDetailDrawer.tsx # 详情抽屉：Zotero 只读 / 矩阵可编辑解析字段
│  │        ├─ LiteratureTable.tsx # 文献表格：排序、拖拽调列宽、分页与选中态
│  │        ├─ LiteratureFilterPopover.tsx # 文献筛选弹层：状态/年份/类型/出版物
│  │        ├─ SettingsPage.tsx    # 设置页：单页滚动（LLM/飞书/字段），读写 config/config.json
│  │        └─ TitleBar.tsx        # 自定义标题栏：拖拽区域 + 窗口控制按钮
│  ├─ vite.config.ts              # Vite 配置（开发端口固定 5174）
│  ├─ tailwind.config.ts          # Tailwind 配置（主题色 tiffany 等）
│  └─ package.json                # 前端依赖与脚本（dev/build/lint）
│
├─ src-tauri/                     # 桌面壳（Tauri v2 / Rust）
│  ├─ src/
│  │  └─ main.rs                  # Tauri 命令入口：调用 sidecar 并向前端回传事件
│  ├─ tauri.conf.json             # 桌面窗口配置（最小宽高、无系统标题栏等）
│  ├─ capabilities/
│  │  └─ default.json             # Tauri capabilities（允许调用/执行 sidecar 等）
│  ├─ binaries/                   # sidecar 二进制与 PyInstaller spec（dev/打包用）
│  ├─ icons/                      # 应用图标
│  └─ Cargo.toml                  # Rust 依赖与应用元信息
│
├─ backend/                       # Python 后端（sidecar 逻辑）
│  ├─ matrixit_backend/
│  │  ├─ sidecar.py               # sidecar CLI 入口：load_library/analyze/sync_feishu/update_item/format_citations
│  │  ├─ zotero.py                # Zotero：读取数据库、定位 storage PDF（不导出）、组装文献信息
│  │  ├─ citation.py              # 引用：按 CSL 生成 GB/T 7714-2015（顺序编码）
│  │  ├─ pdf.py                   # PDF：文本提取（pdfplumber）
│  │  ├─ feishu.py                # 飞书：多维表格字段与数据同步（含附件上传）
│  │  ├─ llm.py                   # LLM：OpenAI-Style Chat Completions 封装（返回 JSON）
│  │  ├─ prompt_builder.py        # Prompt：读取 prompts.md + config 中的 fields 组装分析提示词
│  │  ├─ config.py                # 配置：读取与校验（config/config.json + config/config.local.json 等）
│  │  └─ jsonio.py                # JSON：读写本地状态文件（literature.json 等）
│  ├─ requirements.txt            # Python 运行依赖
│  └─ requirements-dev.txt        # Python 开发/构建依赖（PyInstaller 等）
│
├─ config/                         # 配置目录（推荐）
│  ├─ config.json                  # 默认配置（可提交，包含 fields 定义与 UI 列配置）
│  └─ config.local.json            # 本机覆盖配置（不要提交；已在 .gitignore 中忽略）
├─ config.example.json            # 配置示例（可提交）
├─ config.json                    # 旧版配置（兼容读取，建议逐步迁移到 config/config.json）
├─ fields.json                    # 旧版字段定义（兼容读取，建议逐步迁移到 config/config.json 的 fields）
├─ data/                          # 本地数据目录（默认；可通过环境变量覆盖）
│  ├─ matrixit.db                 # 本地 SQLite 主存（items 表存 JSON）
│  └─ literature.json             # 导出快照（便于前端加载/迁移/排障）
├─ PRD.md                         # 产品需求文档
├─ UI_DESIGN_SYSTEM.md            # UI 设计系统（颜色/排版/组件规范）
└─ .trae/                         # Trae IDE 配置（规则/技能/内部文档）
```

### 前端表格组件复用

文献列表表格已封装为独立组件：[`LiteratureTable`](./frontend/src/ui/components/LiteratureTable.tsx)。

字段显示配置弹层已抽离为独立组件（字段显隐/顺序拖拽；菜单限高可滚动）：[`ColumnSettingsPopover`](./frontend/src/ui/components/ColumnSettingsPopover.tsx)。

设置页面已抽离为独立组件（便于维护与复用）：[`SettingsPage`](./frontend/src/ui/components/SettingsPage.tsx)。

在页面中复用时，传入数据源、选中行状态与回调即可：

```tsx
<LiteratureTable
  data={items}
  selectedRowKeys={selectedRowKeys}
  onSelectedRowKeysChange={setSelectedRowKeys}
  onOpenDetail={(itemKey) => setActiveItemKey(itemKey)}
  onRefresh={handleRefresh}
/>
```

### 各模块协作关系（从界面到数据）

1) 前端页面调用 `frontend/src/lib/backend.ts`，通过 Tauri `invoke()` 触发 Rust Command。  
2) `src-tauri/src/main.rs` 接收命令后，通过 `tauri_plugin_shell` 执行 `binaries/` 中的 sidecar（`matrixit-sidecar`）。  
3) sidecar（由 `backend/matrixit_backend/sidecar.py` 打包）读取 Zotero 数据、直接从 Zotero storage 定位 PDF（不导出）、调用 LLM 生成结构化字段、同步飞书；并可按需生成 GB/T 7714 引用。结果写入本地 SQLite（主存），同时导出 `data/literature.json` 快照。  
4) sidecar 输出 JSON（或进度事件），Rust 将其转发给前端渲染表格与详情。  

### 5) 健壮的分析流程（2025.1 新增）

为应对长时间的 LLM 分析任务，系统实现了完整的生命周期管理：

- **中途终止**：前端可随时中断分析。后端使用 `taskkill /F /T /PID` 强制终止 sidecar 进程树（Windows），确保无残留后台进程。中断后，前端状态会自动回滚（新分析 → 未处理，重新分析 → 已完成）。
- **重新分析 (Reanalyze)**：支持对"已完成"条目发起重新分析。状态会标记为 `reanalyzing`（橙色），与首次分析 (`processing`) 区分。
- **开始/终止一体化**：分析启动后，“开始分析”按钮会切换为“终止分析”（危险样式），点击后弹出警示确认弹窗，确认按钮为红色。
- **混合策略**：当同时选中"已完成"和"未处理"条目时，系统会弹出策略选择框，允许用户"全部重新分析"或"仅分析未处理"（高亮按钮，且放在最右侧）。
- **状态保护**：刷新动作 (`refreshLibrary`) 能够智能识别当前是否有正在进行的分析，防止后端旧数据覆盖前端的实时进度状态。  

### 6) UI 状态解耦与视图隔离（2026.1 更新）

为降低 `App.tsx` 的复杂度并避免状态串扰，前端进行了进一步解耦：

- **筛选与选项生成下沉**：集合命中、筛选条件 predicates、以及年份/类型/标签/关键词/bibType 选项生成已下沉到 `useFilterState.ts` 中的 hooks（`useCollectionItems` / `useFilterOptions` / `useFilteredItems`）。
- **详情导航下沉**：详情抽屉的上一条/下一条导航由 `useDetailNavigation.ts` 接管，并兼容表格排序后的导航顺序。
- **引用预取下沉**：详情引用生成与列表页引用预取由 `useCitationManager.ts` 内部 effect 管理，`App.tsx` 仅消费 `detailCitationState`。
- **确认弹窗复用**：分析/删除/终止确认弹窗统一复用 `ConfirmModal.tsx`，减少页面内 JSX 分支。
- **工具条组件化**：工作台顶部工具条拆分为 `WorkbenchToolbar.tsx`，负责搜索/筛选/列配置/分析/删除的 UI 组装。
- **视图选中状态隔离**：Zotero 视图与矩阵视图的表格选中行状态独立保存，切换视图互不影响。

## 开发服务器启动指南

### 环境要求（Windows）

- Node.js：建议 18.18+（Vite 需要较新的 Node 版本）
- Rust：stable toolchain（MSVC）
  - Windows 通常需要安装 Visual Studio Build Tools（C++ 桌面开发）以提供链接器
- Tauri CLI：使用 `cargo tauri`（需要安装 tauri-cli，例如 `cargo install tauri-cli --locked`）
- Python：建议 3.11+（项目使用虚拟环境，不做全局安装）

### 1) 拉取代码

确保你的版本控制环境可用（Git / 其他 VCS 均可）。所有删除/重构/接口变更必须以提交记录留痕（见下方“项目规则说明”）。

### 2) 配置文件

项目推荐使用 `config/` 目录下的统一配置文件：

- `config/config.json`：默认配置（可提交，包含 `fields` 定义与 UI 列配置）
- `config/config.local.json`：本机覆盖配置（建议不要提交）

复制 [config.local.example.json](./config/config.local.example.json) 为 `config/config.local.json`，至少填写：

- Zotero：`zotero.data_dir`（需包含 `zotero.sqlite` 与 `storage/`）
- 飞书：`feishu.app_id` / `feishu.app_secret` / `feishu.bitable_url`
  - `llm.base_url` / `llm.model` / `llm.api_key`（OpenAI-Style Chat Completions）
  - 可选：`llm.parallel_count` 设置并行分析数量（建议 3-5，默认为 1 串行）
  - 可选：`llm.parallel_count_max` 设置并行数量强制上限（防止误配）
  - 可选：`llm.multimodal=true` 启用“多模态优先 + 文本回退”（会尝试 OpenAI-Style Responses 的 PDF 上传）
  - 可选：`llm.multimodal_parallel_count_max` 设置多模态并行上限（建议 1-2，后端会强制裁剪）
  - 可选：`llm.max_pdf_bytes` 限制上传 PDF 的最大字节数
  - 可选：`llm.max_input_chars` 限制文本回退的最大字符数
  - 本地 SQLite：默认生成在 `data/matrixit.db`（可用环境变量 `MATRIXIT_DB` 覆盖路径）
  - 数据目录：默认在 `data/`（可用环境变量 `MATRIXIT_DATA_DIR` 覆盖目录）

UI 表格列配置说明（`config/config.json` → `ui.table_columns`）：
- 仅使用 `visible` 数组表示“显示字段 + 显示顺序”
- 旧版 `order/hidden` 配置仍可读取，但保存时会自动写回为 `visible`

### 3) 安装依赖

#### 前端依赖（React/Vite）

```bash
cd frontend
npm install
```

#### Python 依赖（backend）

建议使用项目虚拟环境安装依赖，避免污染全局环境。

PowerShell 示例：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r backend/requirements.txt
```

引用格式（GB/T 7714）相关依赖已包含在 `backend/requirements.txt` 中：
- `citeproc-py`、`citeproc-py-styles`（安装后模块名分别为 `citeproc`、`citeproc_styles`）
- `aiohttp`（用于并行 LLM 分析）

如需构建 sidecar 可执行文件（PyInstaller）：

```powershell
pip install -r backend/requirements-dev.txt
```

### 4) 启动流程（开发）

#### 方案 A：仅启动前端开发服务器（调 UI）

```bash
cd frontend
npm run dev
```

前端开发服务器固定运行在：

- http://127.0.0.1:5174

#### 方案 B：启动桌面端（Tauri + 前端 + Sidecar）

1) 启动前端开发服务器（保持运行）：

```bash
cd frontend
npm run dev
```

2) 确保存在 sidecar 可执行文件：

- Tauri v2 运行/调试侧会在 `src-tauri/binaries/` 下寻找 `matrixit-sidecar-<target-triple>.exe`（Windows）

**推荐方式（使用构建脚本）：**

```powershell
.\scripts\build_sidecar.ps1
```

**手动构建（使用 spec 文件）：**

```powershell
.venv\Scripts\pyinstaller.exe src-tauri\binaries\pyi-spec\matrixit-sidecar-x86_64-pc-windows-msvc.spec
```

> **注意**：spec 文件已包含 CSL 引擎（`citeproc`/`citeproc_styles`）和提示词模板（`backend/docs/prompts.md`）的资源收集配置。
> 若新增/更新相关依赖或提示词，需重新执行构建以生效。

3) 启动 Tauri：

PowerShell（推荐，避免本机未配置 PATH 时找不到 cargo）：

```powershell
cd src-tauri
& "$env:USERPROFILE\.cargo\bin\cargo.exe" tauri dev
```

如果你的 `cargo` 已加入环境变量 PATH，也可以直接：

```powershell
cd src-tauri
cargo tauri dev
```

### 5) 本地验证（Python）

不依赖 Tauri 的情况下，可直接运行 sidecar 命令（会读取 `config/config.json` + `config/config.local.json`）。默认会在 `data/` 生成：
- `data/matrixit.db`：SQLite 主存
- `data/literature.json`：导出快照

```bash
python backend/matrixit_backend/sidecar.py load_library
```

分析选中文献（会逐条输出 `started/finished/failed` 事件；需要正确配置 `llm.*`）：

```bash
python backend/matrixit_backend/sidecar.py analyze "[\"<item_key>\",\"<item_key2>\"]"
```

### 解析字段顺序（LLM 输出顺序）

LLM 解析字段的“顺序控制”推荐使用：

- `config.ui.table_columns.matrix.analysis.order: string[]`

后端会将该数组作为 `preferred_order` 传入 prompt 生成器，从而决定发送给大模型的 keys 顺序；这是稳定的有序结构，不依赖 JSON 对象键的物理排列。

默认回退逻辑：

- 若 `analysis.order` 缺失，则按 `config.fields.analysis_fields` 的键顺序生成（不建议依赖该顺序，因配置被重写时键顺序可能变化）。

### 字段设置（拖拽排序 + 还原默认）

桌面端设置页 → 字段设置 → 解析字段：

- 支持拖拽调整解析字段顺序（用于生成 `analysis.order`，从而影响 LLM 输出键顺序）
- 提供“还原默认”按钮：一键恢复预设的“先 A 后 B”默认顺序与字段定义，并自动保存到 `config/config.json`

预设默认顺序（先 A 后 B）：

- A（客观提取）：`tldr → key_word → bib_type → research_question → methods → logic → key_findings → contribution`
- B（专家批判）：`highlights → inspiration → limitations`

### LLM 解析调试日志（终端可见）

为方便排查“模型未按字段输出 / JSON 解析失败 / 输出键不完整”等问题，分析流程支持输出调试事件到终端（不包含 API Key；不会输出 PDF 全文）。

- 默认开启：调试事件默认开启（仅影响终端日志，不会在 UI 展示）
- 关闭方式（推荐，本地文件，不随构建打包）：在 `config/config.local.json` 中写入：
  - `{"debug": {"enabled": false}}`
- 开关方式（环境变量优先级最高）：设置 `MATRIXIT_DEBUG=1`（开启）或 `MATRIXIT_DEBUG=0`（关闭）

开启后，终端会打印 `type=debug` 的 JSON 行，包含：字段 keys 顺序、输入长度裁剪信息、请求/响应字节数、模型输出预览（截断）、解析出的键集合等。

同步到飞书（会按 `config/config.json` 的 `fields` 自动创建字段并上传附件）：

```bash
python backend/matrixit_backend/sidecar.py sync_feishu "[\"<item_key>\"]"
```

更详细的 Sidecar 接口说明见：[`后端 Sidecar API 文档.md`](./后端%20Sidecar%20API%20文档.md)

如需在本地对单个 PDF 做文本提取（调试工具）：

```bash
python backend/matrixit_backend/pdf.py <pdf_path> all
```

### Sidecar 命令速查（含常见问题）

- 前端端口占用导致 Tauri 白屏：前端固定使用 5174 端口（见 `frontend/vite.config.ts`），请释放端口或停止冲突进程
- `cargo tauri dev` 找不到 sidecar：确认 `src-tauri/binaries/` 下存在 `matrixit-sidecar-<target-triple>.exe`，且 capabilities 中允许执行 `binaries/matrixit-sidecar`
- PowerShell 激活虚拟环境失败：需要调整脚本执行策略；或使用 `cmd` 的 `.\.venv\Scripts\activate.bat`
- 读取与刷新本地库：
  ```bash
  python backend/matrixit_backend/sidecar.py load_library
  ```
  - Zotero 读不到：检查 `config/config.local.json` 的 `zotero.data_dir`，确认存在 `zotero.sqlite`
  - 返回包含 `collections/items` 的 JSON；异常将以 `error.code/message` 表达
- 分析选中文献：
  ```bash
  python backend/matrixit_backend/sidecar.py analyze "[\"<item_key>\",\"<item_key2>\"]"
  ```
  - 事件流：stdout 按条输出 `started/finished/failed`（含 `error_code`）
  - PDF 定位策略：优先 `pdf_path`（按项目根目录解析相对路径），否则用 Zotero storage 路径
  - LLM：按 `config/config.local.json` 的 `llm.base_url/model/api_key` 调用（OpenAI-Style）
  - 并行：若 `config` 中设置 `llm.parallel_count > 1`，则启用并行加速（使用 `aiohttp + asyncio`）；实际并发会被 `llm.parallel_count_max` 与（多模态时）`llm.multimodal_parallel_count_max` 强制限制
- 同步到飞书：
  ```bash
  python backend/matrixit_backend/sidecar.py sync_feishu "[\"<item_key>\"]"
  ```
  - 读取 `config/config.json` 的 `fields` 自动创建缺失字段（映射 `name`）
  - 附件上传：按 PDF 定位策略直接上传 storage 中的 PDF
  - 配置检查：`feishu.app_id/app_secret/bitable_url`（或 `app_token/table_id`）
- 局部更新条目：
  ```bash
  python backend/matrixit_backend/sidecar.py update_item "<item_key>" "{\"tldr\":\"...\"}"
  ```
  - 保护字段：`item_key/attachments/collections/date_modified/item_type` 不允许覆盖
- 生成引用（GB/T 7714-2015，顺序编码）：
  ```bash
  python backend/matrixit_backend/sidecar.py format_citations -
  ```
  - stdin 输入：JSON 数组 `["<item_key>", "..."]`
  - stdout 输出：`{ "citations": { "<item_key>": "[1]作者. 题名[文献类型]. ..." } }`
  - 副作用：后端对成功生成的条目批量写入 SQLite（更新 `citation` 字段），并导出 `data/literature.json`；前端无需逐条写回
  - Windows 直传 argv 容易被引号转义影响，建议使用 `-` 从 stdin 读 JSON（或用 Python 生成参数字符串）。

## 项目规则说明

### 代码提交规范

- 使用 Conventional Commits：
  - `feat:` 新功能
  - `fix:` 修复缺陷
  - `docs:` 文档变更
  - `refactor:` 重构（不改变功能）
  - `chore:` 构建/工具链/杂项
- 提交信息必须包含清晰的动机与影响范围，避免无意义描述

### 分支管理策略

- `main`：随时可发布（只通过合并 PR 更新）
- `develop`：日常集成分支（功能合并到这里进行联调）
- `feat/*`、`fix/*`：从 `develop` 拉出，完成后提 PR 合回 `develop`
- 发布时：从 `develop` 合并到 `main`，并打 tag（例如 `v0.1.0`）

### 测试要求

- 前端：
  - 必须通过 `npm run lint`
  - 发版前必须通过 `npm run build`
- Tauri（Rust）：
  - 发版前必须通过 `cargo test`
- Python：
  - 变更后至少执行一次 `python backend/matrixit_backend/sidecar.py` 做导入/参数烟测

### 代码审查流程

- 所有合并到 `main/develop` 的变更必须走 PR
- PR 至少 1 人 Review 通过
- PR 必须包含：
  - 变更动机（为什么改）
  - 影响范围（哪些模块受影响）
  - 验证方式（本地如何验证/跑了哪些命令）

### 版本发布规范

- 版本号遵循 SemVer：`MAJOR.MINOR.PATCH`
- 发版前同步更新：
  - `src-tauri/tauri.conf.json` 的 `version`
  - `src-tauri/Cargo.toml` 的 `version`
- 发版产物必须包含匹配平台的 sidecar 二进制，并确保 `src-tauri/capabilities/*.json` 与 `tauri.conf.json` 配置一致

## UI 设计系统

见 [UI_DESIGN_SYSTEM.md](./UI_DESIGN_SYSTEM.md)。
