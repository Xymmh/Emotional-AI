"""会话 CRUD。"""

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.exc import IntegrityError

from app.api.security import require_sidecar_token
from app.db import crud
from app.db.models import ConversationCreate

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


@router.get("", dependencies=[Depends(require_sidecar_token)])
async def list_conversations(persona_id: str | None = Query(default=None)) -> list[dict]:
    rows = await asyncio.to_thread(crud.list_conversations, persona_id)
    return [r.model_dump(mode="json") for r in rows]


@router.post("", dependencies=[Depends(require_sidecar_token)])
async def create_conversation(body: ConversationCreate) -> dict:
    # 校验 persona 存在
    persona = await asyncio.to_thread(crud.get_persona, body.persona_id)
    if persona is None:
        raise HTTPException(status_code=404, detail="关联的人格不存在")
    try:
        conv = await asyncio.to_thread(crud.create_conversation, body)
    except IntegrityError as exc:  # 外键约束兜底
        raise HTTPException(status_code=404, detail="关联的人格不存在") from exc
    return conv.model_dump(mode="json")


@router.get("/{conversation_id}", dependencies=[Depends(require_sidecar_token)])
async def get_conversation(conversation_id: str) -> dict:
    conv = await asyncio.to_thread(crud.get_conversation, conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    return conv.model_dump(mode="json")


@router.delete("/{conversation_id}", dependencies=[Depends(require_sidecar_token)])
async def delete_conversation(conversation_id: str) -> dict:
    ok = await asyncio.to_thread(crud.delete_conversation, conversation_id)
    if not ok:
        raise HTTPException(status_code=404, detail="会话不存在")
    return {"deleted": True, "conversation_id": conversation_id}
