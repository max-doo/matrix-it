# Windows 安装程序打包指南

## 配置完成

✅ **已配置的功能**：
1. **自定义安装目录**：用户可在安装时选择安装位置
2. **桌面快捷方式**：自动创建桌面快捷方式
3. **开始菜单快捷方式**：Tauri 默认创建（无需额外配置）
4. **立即打开选项**：安装完成后提供"立即打开 MatrixIt"勾选框
5. **中文安装界面**：所有安装对话框显示中文

## 配置文件说明

### WiX Fragment 文件
- **路径**：`src-tauri/wix/fragments/ui-custom.wxs`
- **功能**：定义安装 UI、桌面快捷方式、立即打开功能

### 中文本地化文件
- **路径**：`src-tauri/wix/locales/zh-CN.wxl`
- **功能**：提供安装向导的中文文本

### Tauri 配置
- **文件**：`src-tauri/tauri.conf.json`
- **新增配置**：`bundle.windows.wix` 部分

## 打包命令

### 1. 确保前端已构建
```powershell
cd frontend
npm run build
```

### 2. 构建 Sidecar（如有更新）
```powershell
.\scripts\build_sidecar.ps1
```

### 3. 打包安装程序
```powershell
cd src-tauri
cargo tauri build
```

### 4. 安装包位置
打包成功后，安装程序位于：
```
src-tauri/target/release/bundle/msi/MatrixIt_0.1.0_x64_zh-CN.msi
```

## 测试清单

### 安装测试
1. ✅ 双击运行 `.msi` 文件
2. ✅ 验证安装向导为**中文界面**
3. ✅ 测试**自定义安装目录**功能（默认 `C:\Program Files\MatrixIt`）
4. ✅ 安装完成后检查桌面和开始菜单是否有快捷方式
5. ✅ 验证"立即打开 MatrixIt"勾选框是否出现
6. ✅ 勾选后点击完成，应用应自动启动

### 卸载测试
1. ✅ 通过"设置 → 应用"卸载 MatrixIt
2. ✅ 确认安装目录已删除
3. ✅ 确认桌面快捷方式已删除

## 常见问题

### Q: 打包时提示找不到 `matrixit-sidecar`？
**A**: 确保已执行 `.\scripts\build_sidecar.ps1` 构建 sidecar 二进制文件。

### Q: 安装程序语言不是中文？
**A**: 检查 `tauri.conf.json` 的 `bundle.windows.wix.language` 配置是否正确引用 `zh-CN.wxl` 文件。

### Q: 桌面快捷方式未创建？
**A**: 检查 `tauri.conf.json` 的 `componentRefs` 是否包含 `"DesktopShortcut"`。

### Q: 安装程序图标不正确？
**A**: 确保 `src-tauri/icons/icon.ico` 包含多种尺寸（16x16, 32x32, 48x48, 256x256）。

## 注意事项

1. **首次打包较慢**：Tauri 会自动下载 WiX Toolset（约 30-50MB），请耐心等待
2. **管理员权限**：安装到 `C:\Program Files` 需要管理员权限，用户选择其他目录则不需要
3. **卸载干净**：卸载时会自动清理所有文件和快捷方式（通过 `RemoveFolder` 和 `RegistryValue` 管理）
4. **版本升级**：如需发布新版本，请同步更新 `tauri.conf.json` 和 `Cargo.toml` 中的 `version` 字段

## 发布检查清单

发布前请确认：
- [ ] `tauri.conf.json` 和 `Cargo.toml` 的版本号已更新
- [ ] 前端代码已构建（`npm run build`）
- [ ] Sidecar 已重新构建（`.\scripts\build_sidecar.ps1`）
- [ ] 安装程序已测试（安装、运行、卸载流程完整无误）
- [ ] 安装程序文件名包含正确的版本号和语言标识
