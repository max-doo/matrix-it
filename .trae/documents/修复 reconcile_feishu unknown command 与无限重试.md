## 根因解释
- 终端输出 `unknown command: reconcile_feishu` 来自 **sidecar 可执行文件**（PyInstaller 打包产物）内部的命令分发：它当前运行的版本里还没有包含我们新增的 `reconcile_feishu` 分支，所以收到参数后直接走兜底 `unknown command` 并退出。
- 同步按钮一直转圈，是因为前端有“启动后自动校验（reconcile）”逻辑：reconcile 失败后会很快再次触发（由于 `lastReconcileAt` 不会更新），导致反复调用 sidecar、终端刷屏、按钮持续处于 loading 状态。

## 解决方案
### 1) 先让 sidecar 真正包含新命令（根治 unknown command）
- 使用项目内置脚本重建 sidecar（它会把 `backend/matrixit_backend/sidecar.py` 打进 exe）：`scripts/build_sidecar.ps1`。
- 重建后重启 `cargo tauri dev`，确保 Tauri 运行时加载的是新 exe（通常来自 `src-tauri/binaries/matrixit-sidecar-x86_64-pc-windows-msvc.exe`）。

### 2) 给前端自动校验加“失败冷却/禁用”防抖（根治无限转圈/刷屏）
- 在 `handleReconcileFeishuRequest` 捕获到错误时：
  - 仍然 `finally` 里结束 loading
  - 但同时写入一次“最后尝试时间”（即使失败也更新），避免立即再次触发
  - 若错误包含 `unknown command: reconcile_feishu`，则设置更长冷却（例如 60 分钟）并提示“sidecar 需要重建”。
- 这样即使用户没重建 sidecar，也不会出现无限重试。

### 3) 快速验证
- 直接运行构建产物验证命令是否存在：执行 sidecar exe 并传 `reconcile_feishu`，确认不再输出 unknown command。
- 在 UI：进入矩阵视图后，按钮应在一次校验后停止转圈；终端不再刷屏。

## 我将做的改动（你确认后立即执行）
- 运行 `scripts/build_sidecar.ps1` 并重启 tauri dev 验证（会产生/覆盖 sidecar exe）。
- 修改前端自动校验逻辑加入失败冷却与“unknown command”禁用提示，确保不会无限转圈。
