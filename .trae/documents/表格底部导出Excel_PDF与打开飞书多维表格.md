## 目标与现状
- 目标：在工作台文献表格底部右侧加入两个极简图标：导出（下拉：导出 Excel / 导出 PDF）与打开飞书多维表格；导出前弹窗确认（路径/文件名/导出范围）。
- 现状：前端暂无表格底部导出入口；“打开飞书多维表格”仅在设置页存在；后端 sidecar 暂无 Excel/PDF 导出命令。

## 前端改动（React + AntD）
- 在工作台表格容器（App.tsx 渲染 LiteratureTable 的区域）右下角新增一个小型浮层按钮组：
  - 图标 1：导出（仅图标），点击弹出 Dropdown 菜单：导出 Excel / 导出 PDF。
  - 图标 2：打开飞书多维表格（仅图标），点击后调用 openExternal 打开 `config.feishu.bitable_url`。
- 导出交互：
  - 点击“导出 Excel”→ 弹出 Modal：输入导出路径、Excel 文件名（默认：`<集合名>文献集.xlsx`），并提供单选框：导出“选中”或“当前合集”。
  - 点击“导出 PDF”→ 弹出 Modal：输入导出路径，并提供同样的单选框。
  - “当前合集”的数据源默认取当前选中集合及其子集合的所有条目（useCollectionItems 的结果），不受搜索/字段筛选影响；“选中”取 selectedRowKeys。
  - Excel 导出仅发送/导出 `processed_status === 'done'` 的条目（未分析条目在结果里计为 skipped）。
- 新增前端 IPC 封装：在 frontend/src/lib/backend.ts 增加 `exportExcel(...)` / `exportPdfs(...)` 两个函数（invoke 对应新 Tauri command）。

## Rust 改动（Tauri commands）
- 在 src-tauri/src/main.rs 新增两个命令：`export_excel`、`export_pdfs`：
  - 通过 tauri_plugin_shell 调用 sidecar `matrixit-sidecar`，分别传入子命令 `export_excel` / `export_pdfs` 与 JSON 参数。
  - 复用 sync_feishu 的 stdout/stderr 收集与 JSON 解析模式，返回给前端统计结果。
- 在 invoke_handler 中注册这两个命令。

## Python sidecar 改动（导出实现）
- 在 backend/matrixit_backend/sidecar.py 的 main 分发里新增两个子命令：
  - `export_excel <json>`：
    - 读取 SQLite（storage.get_items）获取条目数据，按 keys 过滤。
    - 仅导出 `processed_status == 'done'`。
    - 按“飞书同步字段要求”确定列顺序与列名：复用/抽取 feishu.py 中构建 `ordered_json_keys` 与 `mapping(json_key→字段name)` 的逻辑（不做任何网络请求）。
    - 使用 openpyxl 写出 xlsx：单表，首行为表头（字段 name），后续为数据行（数组→用分隔符拼接；对象→JSON 字符串；空值→空单元格）。
    - 返回 {written, skipped, output_path, failures[]}。
  - `export_pdfs <json>`：
    - 读取条目并逐条解析 PDF 源路径（优先 item.pdf_path，否则调用现有 zotero.resolve_pdf_path）。
    - 依据条目 collections 里的 path 构建目标子目录，sanitize Windows 非法字符，保持集合树结构；同名文件冲突时自动加后缀避免覆盖。
    - copy2 复制到目标目录。
    - 返回 {exported, skipped_no_pdf, skipped_missing, output_dir, failures[]}。

## 依赖与打包（PyInstaller sidecar）
- backend/requirements.txt 增加 openpyxl（及其运行所需依赖会随 pip 安装）。
- 更新 src-tauri/binaries/pyi-spec/matrixit-sidecar-x86_64-pc-windows-msvc.spec：增加对 openpyxl（以及 et_xmlfile 等）collect_all，确保打包后的 sidecar 可用。

## 文档同步
- 更新 后端 Sidecar API 文档.md：补充 export_excel / export_pdfs 的参数格式与返回值示例。

## 验收与验证
- 前端：运行 eslint 与 build，手动在工作台表格右下角验证：
  - 导出菜单/确认弹窗展示正确；路径与默认文件名正确；导出范围“选中/当前合集”生效。
  - “打开飞书多维表格”在配置存在时可打开，缺失时给出提示。
- 后端：本地用 python 直接运行 sidecar 两个新命令做一次导出自检；再用 build_sidecar.ps1 打包并用 `matrixit-sidecar.exe export_excel ...` 验证打包依赖齐全。