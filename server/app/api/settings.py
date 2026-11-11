"""设置相关接口：Key 状态与测试、模型配置、记忆库（向量索引）状态与重建。"""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ValidationError

from app.api.security import require_sidecar_token
from app.services import ark
from app.services.model_config import (
    ModelConfig,
    ModelConfigPatch,
    defaults,
    get_model_config,
    suggested_models,
    update_model_config,
)
from app.services.runtime import state
from app.services.tasks import spawn
from app.services.vectorstore import get_vector_store

router = APIRouter(
    prefix="/api/settings", tags=["settings"], dependencies=[Depends(require_sidecar_token)]
)


class StatusResponse(BaseModel):
    has_key: bool
    key_hint: str
    # Key 字符数，仅用于前端生成等长的圆点占位符，不泄露内容
    key_length: int = 0
    roleplay_model: str


class VerifyRequest(BaseModel):
    # 为空时测试当前已生效的 Key；填写时测试表单里刚输入的 Key（不落盘）
    api_key: str | None = None


class VerifyResponse(BaseModel):
    ok: bool
    message: str


class RuntimeUpdateRequest(BaseModel):
    api_key: str | None = None
    # 兼容旧版本：Electron 本地 config.json 里存过的扮演模型，启动时迁移一次
    roleplay_model: str | None = None


def _status() -> StatusResponse:
    key = state.api_key
    return StatusResponse(
        has_key=bool(key),
        key_hint=ark.mask_key(key),
        key_length=len(key),
        roleplay_model=get_model_config().roleplay_model,
    )


@router.get("/status", response_model=StatusResponse)
async def get_status() -> StatusResponse:
    return _status()


@router.post("/verify", response_model=VerifyResponse)
async def verify_key(body: VerifyRequest) -> VerifyResponse:
    key = body.api_key.strip() if body.api_key else state.api_key
    ok, error = await ark.verify_connection(key)
    if ok:
        return VerifyResponse(ok=True, message="连接成功，API Key 可用")
    return VerifyResponse(ok=False, message=error or "连接失败")


@router.put("/runtime", response_model=StatusResponse)
async def update_runtime(body: RuntimeUpdateRequest) -> StatusResponse:
    state.update(api_key=body.api_key)
    if body.roleplay_model and body.roleplay_model.strip():
        try:
            update_model_config(ModelConfigPatch(roleplay_model=body.roleplay_model))
        except (ValueError, ValidationError):
            pass  # 旧配置里的无效值直接忽略
    return _status()


# ---------------- 模型配置 ----------------


class ModelsResponse(BaseModel):
    config: ModelConfig
    defaults: ModelConfig
    suggestions: list[str]
    memory: dict


async def _models_response() -> ModelsResponse:
    cfg = get_model_config()
    suggestions: list[str] = []
    for m in cfg.recent_models + suggested_models():
        if m not in suggestions:
            suggestions.append(m)
    return ModelsResponse(
        config=cfg,
        defaults=defaults(),
        suggestions=suggestions,
        memory=await get_vector_store().status(),
    )


_FIELD_LABELS = {
    "base_url": "接口地址",
    "roleplay_model": "扮演模型",
    "analyst_model": "分析师模型",
    "utility_model": "辅助模型",
    "embedding_model": "向量模型",
    "embedding_api": "接口类型",
    "embedding_dimensions": "输出维度",
    "roleplay_temperature": "扮演温度",
    "analyst_temperature": "分析师温度",
}


def _validation_message(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        err = exc.errors()[0]
        msg = str(err.get("msg", "")).removeprefix("Value error, ")
        loc = [str(x) for x in err.get("loc", ())]
        field = _FIELD_LABELS.get(loc[-1], loc[-1]) if loc else ""
        return f"{field}：{msg}" if field else msg
    return str(exc)


@router.get("/models", response_model=ModelsResponse)
async def get_models() -> ModelsResponse:
    return await _models_response()


@router.put("/models", response_model=ModelsResponse)
async def put_models(body: ModelConfigPatch) -> ModelsResponse:
    try:
        update_model_config(body)
    except (ValueError, ValidationError) as exc:
        raise HTTPException(status_code=400, detail=_validation_message(exc)) from exc
    return await _models_response()


@router.post("/models/reset", response_model=ModelsResponse)
async def reset_models() -> ModelsResponse:
    """恢复出厂模型设置（不影响 Key 与数据）。"""
    d = defaults()
    update_model_config(
        ModelConfigPatch(
            **d.model_dump(exclude={"recent_models", "embedding_dimensions"}),
            embedding_dimensions=d.embedding_dimensions,
            clear_embedding_dimensions=d.embedding_dimensions is None,
        )
    )
    return await _models_response()


class TestModelRequest(BaseModel):
    """用表单里尚未保存的值测试，测通了再保存。"""

    kind: Literal["chat", "embedding"]
    model: str
    base_url: str | None = None
    api_key: str | None = None
    embedding_api: Literal["auto", "multimodal", "text"] = "auto"
    embedding_dimensions: int | None = None


class TestModelResponse(BaseModel):
    ok: bool
    message: str
    latency_ms: int
    dim: int | None = None


@router.post("/models/test", response_model=TestModelResponse)
async def test_model(body: TestModelRequest) -> TestModelResponse:
    current = get_model_config()
    key = body.api_key.strip() if body.api_key else state.api_key
    try:
        cfg = ModelConfig(
            **{
                **current.model_dump(),
                "base_url": body.base_url or current.base_url,
                "embedding_model": body.model if body.kind == "embedding" else current.embedding_model,
                "embedding_api": body.embedding_api,
                "embedding_dimensions": body.embedding_dimensions,
            }
        )
        if body.kind == "chat":
            ModelConfig(**{**current.model_dump(), "utility_model": body.model})
    except (ValueError, ValidationError) as exc:
        return TestModelResponse(ok=False, message=_validation_message(exc), latency_ms=0)

    if body.kind == "chat":
        ok, msg, ms = await ark.test_chat_model(key, body.model.strip(), cfg.base_url)
        return TestModelResponse(ok=ok, message=msg, latency_ms=ms)
    ok, msg, ms, dim = await ark.test_embedding_model(key, cfg)
    return TestModelResponse(ok=ok, message=msg, latency_ms=ms, dim=dim or None)


# ---------------- 记忆库 ----------------


@router.get("/memory")
async def memory_status() -> dict:
    return await get_vector_store().status()


@router.post("/memory/rebuild")
async def memory_rebuild() -> dict:
    """用当前向量模型重建全部记忆（后台执行，前端轮询 /memory 查看进度）。"""
    if not state.api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key")
    store = get_vector_store()
    if not store.rebuild_state.get("running"):
        api_key = state.api_key

        async def embed(texts: list[str], cfg: ModelConfig) -> list[list[float]]:
            return await ark.embed_texts(api_key, texts, cfg)

        spawn(store.rebuild(embed))
    return await store.status()
