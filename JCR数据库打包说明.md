# JCR 数据库打包配置说明

## 配置目的

`data/jcr.db` 是 MatrixIt 的核心参考数据库，包含期刊影响因子（IF）和分区信息。该数据库必须随应用一起打包，确保安装后用户无需额外配置即可使用期刊数据查询功能。

## 配置步骤

### 1. 复制数据库到资源目录
```powershell
Copy-Item "data\jcr.db" -Destination "src-tauri\resources\jcr.db"
```

### 2. 配置 Tauri 打包规则
在 `src-tauri/tauri.conf.json` 的 `bundle` 部分添加：
```json
"resources": [
  "resources/jcr.db"
]
```

### 3. 更新代码路径解析
修改 `backend/matrixit_backend/jcr.py` 的 `get_jcr_db_path()` 函数，增加打包后路径支持：

```python
# 打包后路径：sidecar 同级 resources/jcr.db
import sys
if getattr(sys, 'frozen', False):
    bundled_path = Path(sys.executable).parent / "resources" / "jcr.db"
    if bundled_path.exists():
        return str(bundled_path.resolve())
```

### 4. 重新构建 Sidecar
```powershell
.\scripts\build_sidecar.ps1
```

## 路径解析优先级

打包后应用的 JCR 数据库查找优先级：

1. **自定义路径**（`config.json` 中的 `jcr.db_path`）
2. **打包资源路径**（`<安装目录>/resources/jcr.db`）- **新增**
3. **开发环境路径**（项目根目录 `data/jcr.db`）
4. **开发回退路径**（绝对路径 `d:/Project/matrix-it/data/jcr.db`）

## 安装后文件结构

```
C:\Program Files\MatrixIt\
├── MatrixIt.exe              # 主应用程序
├── matrixit-sidecar.exe      # Python Sidecar
└── resources/
    └── jcr.db                # 期刊数据库（约 XX MB）
```

## 验证方法

打包后测试：
1. 安装应用到自定义目录（如 `D:\Test\MatrixIt`）
2. 检查 `D:\Test\MatrixIt\resources\jcr.db` 文件是否存在
3. 运行应用，查询任意期刊（如 "Nature"）的 IF 和分区
4. 确认数据正确返回

## 注意事项

- **数据库只读**：应用以只读模式打开 `jcr.db`，不会修改原文件
- **更新策略**：如需更新 JCR 数据，需替换 `src-tauri/resources/jcr.db` 并重新打包
- **文件大小**：`jcr.db` 会增加安装包体积，打包前确认文件大小合理
- **同步要求**：每次更新 `data/jcr.db` 后，必须执行以下操作：
  ```powershell
  # 1. 复制到资源目录
  Copy-Item "data\jcr.db" -Destination "src-tauri\resources\jcr.db" -Force
  
  # 2. 重新构建 sidecar（包含更新后的路径解析代码）
  .\scripts\build_sidecar.ps1
  
  # 3. 重新打包应用
  cd src-tauri
  cargo tauri build
  ```
