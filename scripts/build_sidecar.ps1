# scripts/build_sidecar.ps1
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

# 检查 PyInstaller
$PyInstaller = Join-Path $ProjectRoot ".venv\Scripts\pyinstaller.exe"
if (-not (Test-Path $PyInstaller)) {
    Write-Host "正在安装 PyInstaller..." -ForegroundColor Yellow
    & $VenvPython -m pip install pyinstaller
}

# 构建 sidecar
$SpecFile = Join-Path $ProjectRoot "src-tauri\binaries\pyi-spec\matrixit-sidecar-x86_64-pc-windows-msvc.spec"
Write-Host "使用 spec 文件: $SpecFile" -ForegroundColor Green

Push-Location $ProjectRoot
try {
    & $PyInstaller --clean $SpecFile
    if ($LASTEXITCODE -ne 0) {
        Write-Error "PyInstaller 构建失败"
        exit 1
    }
    Write-Host "`n✅ 构建成功！" -ForegroundColor Green
    Write-Host "输出: src-tauri\binaries\matrixit-sidecar-x86_64-pc-windows-msvc.exe"
} finally {
    Pop-Location
}
