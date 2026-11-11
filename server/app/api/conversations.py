"""会话 CRUD。"""

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError

from app.api.security import require_sidecar_token
from app.db import crud
from app.db.models import ConversationCreate

router = APIRouter(prefix="/api/conversations", tags=["conversations"])

VALID_MODES = ("analyst", "roleplay")
DEFAULT_TITLES = {"analyst": "第三视角", "roleplay": "主视角"}


class EnsureRequest(BaseModel):
    persona_id: str
    mode: str


@router.get("", dependencies=[Depends(require_sidecar_token)])
async def list_conversations(persona_id: str | None = Query(default=None)) -> list[dict]:
    rows = await asyncio.to_thread(crud.list_conversations, persona_id)
    return [r.model_dump(mode="json") for r in rows]


@router.post("", dependencies=[Depends(require_sidecar_token)])
async def create_conversation(body: ConversationCreate) -> dict:
    if body.mode not in VALID_MODES:
        raise HTTPException(status_code=400, detail="mode 只能是 analyst 或 roleplay")
    # 校验 persona 存在
    persona = await asyncio.to_thread(crud.get_persona, body.persona_id)
    if persona is None:
        raise HTTPException(status_code=404, detail="关联的人格不存在")
    try:
        conv = await asyncio.to_thread(crud.create_conversation, body)
    except IntegrityError as exc:  # 外键约束兜底
        raise HTTPException(status_code=404, detail="关联的人格不存在") from exc
    return conv.model_dump(mode="json")


@router.post("/ensure", dependencies=[Depends(require_sidecar_token)])
async def ensure_conversation(body: EnsureRequest) -> dict:
    """取或建：每个人格每种模式只用一个会话，客户端据此拿到稳定的会话 ID。"""
    if body.mode not in VALID_MODES:
        raise HTTPException(status_code=400, detail="mode 只能是 analyst 或 roleplay")
    persona = await asyncio.to_thread(crud.get_persona, body.persona_id)
    if persona is None:
        raise HTTPException(status_code=404, detail="关联的人格不存在")
    conv = await asyncio.to_thread(
        crud.ensure_conversation, body.persona_id, body.mode, DEFAULT_TITLES[body.mode]
    )
    return conv.model_dump(mode="json")


@router.get("/{conversation_id}", dependencies=[Depends(require_sidecar_token)])
async def get_conversation(conversation_id: str) -> dict:
    conv = await asyncio.to_thread(crud.get_conversation, conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    return conv.model_dump(mode="json")


@router.delete("/{conversation_id}/messages", dependencies=[Depends(require_sidecar_token)])
async def clear_conversation(conversation_id: str) -> dict:
    """清空会话消息（保留会话、画像与向量记忆），用于「重新开始」。"""
    conv = await asyncio.to_thread(crud.get_conversation, conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    removed = await asyncio.to_thread(crud.clear_messages, conversation_id)
    await asyncio.to_thread(crud.touch_conversation, conversation_id)
    return {"removed": removed, "conversation_id": conversation_id}


@router.delete("/{conversation_id}", dependencies=[Depends(require_sidecar_token)])
async def delete_conversation(conversation_id: str) -> dict:
    ok = await asyncio.to_thread(crud.delete_conversation, conversation_id)
    if not ok:
        raise HTTPException(status_code=404, detail="会话不存在")
    return {"deleted": True, "conversation_id": conversation_id}
