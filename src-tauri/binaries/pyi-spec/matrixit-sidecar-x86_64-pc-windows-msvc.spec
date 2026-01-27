# -*- mode: python ; coding: utf-8 -*-
"""
MatrixIt Sidecar PyInstaller Spec 文件

构建命令（需在项目根目录运行）:
    .venv\Scripts\pyinstaller.exe src-tauri\binaries\pyi-spec\matrixit-sidecar-x86_64-pc-windows-msvc.spec

或使用构建脚本:
    .\scripts\build_sidecar.ps1
"""
import os
from pathlib import Path
from PyInstaller.utils.hooks import collect_all

# 动态计算项目根目录（spec 文件位于 src-tauri/binaries/pyi-spec/）
SPEC_DIR = Path(SPECPATH).resolve()
PROJECT_ROOT = SPEC_DIR.parents[2]  # 向上 3 级: pyi-spec -> binaries -> src-tauri -> root

datas = [(str(PROJECT_ROOT / 'backend' / 'docs'), 'docs')]
binaries = []
hiddenimports = []
tmp_ret = collect_all('citeproc')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('citeproc_styles')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('aiohttp')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('yarl')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('multidict')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('frozenlist')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('aiosignal')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]
tmp_ret = collect_all('async_timeout')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


a = Analysis(
    [str(PROJECT_ROOT / 'backend' / 'matrixit_backend' / 'sidecar.py')],
    pathex=[str(PROJECT_ROOT / 'backend')],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='matrixit-sidecar-x86_64-pc-windows-msvc',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
