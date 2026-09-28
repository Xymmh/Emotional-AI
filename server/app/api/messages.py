"""消息读写：追加消息、列出某会话的全部消息。"""

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.exc import IntegrityError

from app.api.security import require_sidecar_token
from app.db import crud
from app.db.models import MessageCreate

router = APIRouter(prefix="/api/messages", tags=["messages"])


@router.get("", dependencies=[Depends(require_sidecar_token)])
async def list_messages(conversation_id: str = Query(...)) -> list[dict]:
    rows = await asyncio.to_thread(crud.list_messages, conversation_id)
    return [r.model_dump(mode="json") for r in rows]


@router.post("", dependencies=[Depends(require_sidecar_token)])
async def add_message(body: MessageCreate) -> dict:
    conv = await asyncio.to_thread(crud.get_conversation, body.conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="关联的会话不存在")
    try:
        msg = await asyncio.to_thread(crud.add_message, body)
    except IntegrityError as exc:  # 外键约束兜底
        raise HTTPException(status_code=404, detail="关联的会话不存在") from exc
    return msg.model_dump(mode="json")
