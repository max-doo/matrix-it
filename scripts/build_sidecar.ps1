# UTF-8 BOM 不能删除，删除会导致运行失败
# MatrixIt Sidecar 构建脚本
# 用法: 在项目根目录运行 .\scripts\build_sidecar.ps1

$ErrorActionPreference = "Stop"

# 获取项目根目录
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir

Write-Host "=== MatrixIt Sidecar 构建 ===" -ForegroundColor Cyan
Write-Host "项目根目录: $ProjectRoot"

# 检查虚拟环境
$VenvPython = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPython)) {
    Write-Error "未找到虚拟环境，请先运行: python -m venv .venv && .venv\Scripts\pip install -r backend\requirements.txt pyinstaller"
    exit 1
}

# 确保后端依赖已安装（尤其是 aiohttp，用于并行 LLM）
try {
    & $VenvPython -c "import aiohttp" *> $null
} catch {
    Write-Host "正在安装后端依赖 (backend/requirements.txt)..." -ForegroundColor Yellow
    & $VenvPython -m pip install -r (Join-Path $ProjectRoot "backend\\requirements.txt")
}

# 检查 PyInstaller
$PyInstaller = Join-Path $ProjectRoot ".venv\Scripts\pyinstaller.exe"
if (-not (Test-Path $PyInstaller)) {
    Write-Host "正在安装 PyInstaller..." -ForegroundColor Yellow
    & $VenvPython -m pip install pyinstaller
}

# 构建 sidecar
$SpecFile = Join-Path $ProjectRoot "src-tauri\binaries\pyi-spec\matrixit-sidecar-x86_64-pc-windows-msvc.spec"
Write-Host "使用 spec 文件: $SpecFile" -ForegroundColor Green

$DistPath = Join-Path $ProjectRoot "src-tauri\binaries"
$WorkPath = Join-Path $ProjectRoot "src-tauri\binaries\pyi-work"
$OutName = "matrixit-sidecar-x86_64-pc-windows-msvc.exe"

Push-Location $ProjectRoot
try {
    & $PyInstaller --clean --distpath $DistPath --workpath $WorkPath $SpecFile
    if ($LASTEXITCODE -ne 0) {
        Write-Error "PyInstaller 构建失败"
        exit 1
    }
    Write-Host "`n✅ 构建成功！" -ForegroundColor Green
    Write-Host "输出: src-tauri\binaries\$OutName"

    $SidecarExe = Join-Path $DistPath $OutName
    if (-not (Test-Path $SidecarExe)) {
        Write-Error "未找到构建产物: $SidecarExe"
        exit 1
    }

    $TargetDebug = Join-Path $ProjectRoot "src-tauri\target\debug\matrixit-sidecar.exe"
    if (Test-Path (Split-Path -Parent $TargetDebug)) {
        Copy-Item -Force $SidecarExe $TargetDebug -ErrorAction SilentlyContinue
    }

    $TargetRelease = Join-Path $ProjectRoot "src-tauri\target\release\matrixit-sidecar.exe"
    if (Test-Path (Split-Path -Parent $TargetRelease)) {
        Copy-Item -Force $SidecarExe $TargetRelease -ErrorAction SilentlyContinue
    }
} finally {
    Pop-Location
}
