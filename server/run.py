"""侧车可执行入口（PyInstaller 打包为 server.exe）。

Electron 主进程以 `server.exe --port <port>` 启动，并通过环境变量注入
SIDECAR_TOKEN / ARK_API_KEY / DB_PATH / LANCEDB_PATH。
开发态不走这里，直接用 uvicorn 命令行。
"""

import argparse
import multiprocessing
import sys


def main() -> None:
    parser = argparse.ArgumentParser(description="Emotional AI sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    # 打包后无控制台时 stdout/stderr 可能为 None，uvicorn 写日志会崩；兜底到空设备
    if sys.stdout is None or sys.stderr is None:
        import os

        devnull = open(os.devnull, "w", encoding="utf-8")  # noqa: SIM115
        sys.stdout = sys.stdout or devnull
        sys.stderr = sys.stderr or devnull

    import uvicorn

    from app.main import app

    # 直接传 app 对象（而非 "app.main:app" 字符串），冻结环境下无需按模块路径再导入
    uvicorn.run(app, host=args.host, port=args.port, log_level="info", access_log=False)


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
