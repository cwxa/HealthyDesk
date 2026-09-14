# -*- mode: python ; coding: utf-8 -*-
import os

# 动态解析 mediapipe 的 modules 目录，避免写死绝对路径——
# 之前硬编码 C:/Python312/... 会在换用干净 venv 构建时指向错误的解释器，
# 导致打包进去的是一份与运行时 protobuf 不匹配的模型资源。
import mediapipe as _mp

_MP_MODULES = os.path.join(os.path.dirname(_mp.__file__), 'modules')


a = Analysis(
    ['backend\\main.py'],
    pathex=[],
    binaries=[],
    datas=[(_MP_MODULES, 'mediapipe/modules')],
    hiddenimports=['uvicorn.logging', 'uvicorn.loops', 'uvicorn.loops.auto', 'uvicorn.protocols', 'uvicorn.protocols.http', 'uvicorn.protocols.http.auto', 'uvicorn.protocols.websockets', 'uvicorn.protocols.websockets.auto', 'uvicorn.lifespan', 'uvicorn.lifespan.on', 'aiosqlite', 'httpx'],
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
    [],
    exclude_binaries=True,
    name='neckguardian-backend',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='neckguardian-backend',
)
