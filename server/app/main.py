"""FastAPI 侧车入口。

开发：uvicorn app.main:app --reload --port 8765 --app-dir server
生产：由 PyInstaller 打包，Electron 主进程 spawn 启动。
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api import analyst as analyst_api
from app.api import chat as chat_api
from app.api import conversations as conversations_api
from app.api import imports as imports_api
from app.api import messages as messages_api
from app.api import personas as personas_api
from app.api import settings as settings_api
from app.db.engine import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时建表（SQLite 文件首次创建 + 建表）
    init_db()
    yield


app = FastAPI(title="Emotional AI Sidecar", version="1.0.1", lifespan=lifespan)

app.include_router(settings_api.router)
app.include_router(personas_api.router)
app.include_router(conversations_api.router)
app.include_router(messages_api.router)
app.include_router(imports_api.router)
app.include_router(chat_api.router)
app.include_router(analyst_api.router)


@app.get("/health")
async def health() -> dict[str, str]:
    """健康检查，无需鉴权，供主进程探测侧车是否启动完成。"""
    return {"status": "ok"}
