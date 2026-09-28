"""人格档案 CRUD + 向量记忆读写。

向量记忆端点接收「预计算好的向量」（由后续导入流程在调用方算好
Embedding 再传入），便于把向量生成与存储解耦，也方便本步用随机向量验证。
"""

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.api.security import require_sidecar_token
from app.config import get_settings
from app.db import crud
from app.db.models import PersonaCreate, PersonaUpdate
from app.services.vectorstore import get_vector_store

router = APIRouter(prefix="/api/personas", tags=["personas"])


# ---------- CRUD ----------


@router.get("", dependencies=[Depends(require_sidecar_token)])
async def list_personas() -> list[dict]:
    rows = await asyncio.to_thread(crud.list_personas)
    return [r.model_dump(mode="json") for r in rows]


@router.post("", dependencies=[Depends(require_sidecar_token)])
async def create_persona(body: PersonaCreate) -> dict:
    persona = await asyncio.to_thread(crud.create_persona, body)
    return persona.model_dump(mode="json")


@router.get("/{persona_id}", dependencies=[Depends(require_sidecar_token)])
async def get_persona(persona_id: str) -> dict:
    persona = await asyncio.to_thread(crud.get_persona, persona_id)
    if persona is None:
        raise HTTPException(status_code=404, detail="人格不存在")
    return persona.model_dump(mode="json")


@router.patch("/{persona_id}", dependencies=[Depends(require_sidecar_token)])
async def update_persona(persona_id: str, body: PersonaUpdate) -> dict:
    persona = await asyncio.to_thread(crud.update_persona, persona_id, body)
    if persona is None:
        raise HTTPException(status_code=404, detail="人格不存在")
    return persona.model_dump(mode="json")


@router.post("/{persona_id}/profile/refresh", dependencies=[Depends(require_sidecar_token)])
async def refresh_profile(persona_id: str) -> dict:
    """手动触发画像重塑（立即执行、同步等待），返回最新画像。"""
    from app.services.profile import ProfileError, build_profile

    try:
        profile = await build_profile(persona_id)
    except ProfileError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"画像生成失败：{type(exc).__name__}") from exc
    return {"updated": True, "profile": profile}


@router.delete("/{persona_id}", dependencies=[Depends(require_sidecar_token)])
async def delete_persona(persona_id: str) -> dict:
    ok = await asyncio.to_thread(crud.delete_persona, persona_id)
    if not ok:
        raise HTTPException(status_code=404, detail="人格不存在")
    # 同步清理向量记忆
    store = get_vector_store()
    await store.delete_by_persona(persona_id)
    return {"deleted": True, "persona_id": persona_id}


# ---------- 向量记忆（预计算向量） ----------


class MemoryItem(BaseModel):
    text: str
    vector: list[float]


class MemoryUpsertRequest(BaseModel):
    items: list[MemoryItem]


class MemorySearchRequest(BaseModel):
    vector: list[float]
    k: int = 5


@router.post("/{persona_id}/memories", dependencies=[Depends(require_sidecar_token)])
async def upsert_memories(persona_id: str, body: MemoryUpsertRequest) -> dict:
    """整体替换该 persona 的全部向量记忆。"""
    settings = get_settings()
    expected_dim = settings.embedding_dim
    for item in body.items:
        if len(item.vector) != expected_dim:
            raise HTTPException(
                status_code=400,
                detail=f"向量维度应为 {expected_dim}，实际 {len(item.vector)}",
            )
    store = get_vector_store()
    count = await store.upsert(
        persona_id, [(item.text, item.vector) for item in body.items]
    )
    return {"upserted": count, "persona_id": persona_id}


@router.post(
    "/{persona_id}/memories/search",
    dependencies=[Depends(require_sidecar_token)],
)
async def search_memories(persona_id: str, body: MemorySearchRequest) -> list[dict]:
    store = get_vector_store()
    hits = await store.search(persona_id, body.vector, body.k)
    return [
        {"text": h.text, "score": round(h.score, 4), "created_at": h.created_at}
        for h in hits
    ]
