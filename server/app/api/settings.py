"""设置相关接口：Key 状态、连接测试、运行时配置更新。"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.api.security import require_sidecar_token
from app.config import get_settings
from app.services import ark
from app.services.runtime import state

router = APIRouter(prefix="/api/settings", tags=["settings"])


class ModelOptions(BaseModel):
    chat: str
    analyst: str
    roleplay_lite: str
    roleplay_character: str
    embedding: str


class StatusResponse(BaseModel):
    has_key: bool
    key_hint: str
    # Key 字符数，仅用于前端生成等长的圆点占位符，不泄露内容
    key_length: int = 0
    roleplay_model: str
    models: ModelOptions


class VerifyResponse(BaseModel):
    ok: bool
    message: str


class VerifyRequest(BaseModel):
    # 为空时测试当前已生效的 Key；填写时测试表单里刚输入的 Key（不落盘）
    api_key: str | None = None


class RuntimeUpdateRequest(BaseModel):
    api_key: str | None = None
    roleplay_model: str | None = None


@router.get("/status", response_model=StatusResponse, dependencies=[Depends(require_sidecar_token)])
async def get_status() -> StatusResponse:
    settings = get_settings()
    key = state.api_key
    return StatusResponse(
        has_key=bool(key),
        key_hint=ark.mask_key(key),
        key_length=len(key),
        roleplay_model=state.roleplay_model,
        models=ModelOptions(
            chat=settings.chat_model,
            analyst=settings.analyst_model,
            roleplay_lite=settings.roleplay_model_lite,
            roleplay_character=settings.roleplay_model_character,
            embedding=settings.embedding_model,
        ),
    )


@router.post("/verify", response_model=VerifyResponse, dependencies=[Depends(require_sidecar_token)])
async def verify_key(body: VerifyRequest) -> VerifyResponse:
    key = body.api_key if body.api_key else state.api_key
    ok, error = ark.verify_connection(key)
    if ok:
        return VerifyResponse(ok=True, message="连接成功，API Key 可用")
    return VerifyResponse(ok=False, message=error or "连接失败")


@router.put("/runtime", response_model=StatusResponse, dependencies=[Depends(require_sidecar_token)])
async def update_runtime(body: RuntimeUpdateRequest) -> StatusResponse:
    state.update(api_key=body.api_key, roleplay_model=body.roleplay_model)
    return await get_status()
