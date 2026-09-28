"""侧车接口鉴权。

后端只监听 127.0.0.1，但本机任何进程都能访问端口，
因此再用一道共享令牌（X-Sidecar-Token）校验：
令牌由 Electron 主进程在启动侧车时通过环境变量注入，渲染进程拿不到。
"""

from fastapi import Header, HTTPException

from app.config import get_settings


async def require_sidecar_token(
    x_sidecar_token: str = Header(default="", alias="X-Sidecar-Token"),
) -> None:
    expected = get_settings().sidecar_token
    if not expected or x_sidecar_token != expected:
        raise HTTPException(status_code=401, detail="未授权")
