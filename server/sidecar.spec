# -*- mode: python ; coding: utf-8 -*-
# PyInstaller 配置：把 FastAPI 侧车打成 dist/sidecar/server.exe（onedir）。
# 用法（在 server 目录）：.venv\Scripts\python.exe -m PyInstaller sidecar.spec --noconfirm
#
# 选 onedir 而不是 onefile：LanceDB / pyarrow 体积大，onefile 每次启动都要解压到临时目录，
# 冷启动慢好几秒。console=True 是为了让 stdout/stderr 能被 Electron 收进 sidecar.log；
# 主进程 spawn 时带 windowsHide，不会弹出黑框。

from PyInstaller.utils.hooks import collect_all, collect_submodules

datas, binaries, hiddenimports = [], [], []
for pkg in ("lancedb", "lance", "volcenginesdkarkruntime", "pyarrow"):
    try:
        d, b, h = collect_all(pkg)
    except Exception:  # 某些可选包不存在时跳过
        continue
    datas += d
    binaries += b
    hiddenimports += h

hiddenimports += collect_submodules("uvicorn")
hiddenimports += collect_submodules("app")
hiddenimports += ["sqlmodel", "sqlalchemy.dialects.sqlite", "pydantic_settings"]

a = Analysis(
    ["run.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "matplotlib", "IPython", "pytest", "PyInstaller"],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="server",
    console=True,
    upx=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    upx=False,
    name="sidecar",
)
