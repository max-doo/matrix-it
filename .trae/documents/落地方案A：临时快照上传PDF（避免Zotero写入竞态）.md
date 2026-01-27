## 目标
- 用“复制到临时文件后再上传”的方式，避免 Zotero 正在写 PDF 时导致上传失败/内容不完整。
- 维持现有 `upload_all` 路径与 `feishu_file_token/pdf_mtime` 缓存逻辑，改动最小。

## 现状与问题点
- 你遇到的 1062009（size 不一致）属于典型竞态：文件在读取/获取 size 的过程中变化。
- 目前我们已把 `size` 改为 `len(content)`，能解决“声明 size 与读到 bytes 不一致”的一类问题，但如果 PDF 正在写入，仍可能读到不完整内容（虽然 size 校验能过，但文件内容可能不完整/损坏）。

## 方案A实现细节（最佳实践版）
### 1) 在 upload_file 内做“稳定快照”
- 新增 `_make_stable_temp_copy(file_path)`：
  - 连续两次 `stat`（size + mtime）一致才认为文件稳定；否则短暂 sleep（如 200ms）重试 3 次。
  - 稳定后 `shutil.copy2` 复制到 `tempfile.TemporaryDirectory()` 下的同名文件。
  - 返回临时文件路径与清理句柄。
- `upload_file` 上传时读取临时文件 bytes，并用 `len(bytes)` 作为 size（保留你现在的修复）。
- 无论成功/失败都确保删除临时文件。

### 2) 可观测性
- 在 stderr 输出：
  - `[FEISHU] 使用临时快照上传: <original> -> <tmp>`
  - 若文件一直不稳定：`[FEISHU] ⚠ PDF 仍在写入，稍后重试`，并计入 pdf_failed。

### 3) 与缓存逻辑的配合
- `pdf_mtime` 仍以“原始文件”的 mtime 为准（这样同一份 PDF 不会重复上传）。
- 如果上传读取的是临时快照，不影响 token 写回。

## 需要修改的文件
- [feishu.py](file:///d:/Project/matrix-it/backend/matrixit_backend/feishu.py)：实现临时快照函数并接入 upload_file。

## 验证
- 重建 sidecar（PyInstaller）并重启 `cargo tauri dev`。
- 选一条有 PDF 的条目同步：
  - 终端出现“使用临时快照上传”日志。
  - 飞书记录附件字段出现 PDF。
  - 再次同步同一条目：命中 `pdf_skipped`，不重复上传。

我接下来会按上述步骤改代码、重建 sidecar，并在本地用一次同步日志验证附件上传流程与缓存是否生效。