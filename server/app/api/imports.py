"""聊天记录导入：解析 → 嵌入对方消息 → 写向量库 + 持久化导入记录。

第三方分析师（下一步）通过 GET /api/import/{id} 读取原文与结构化消息来归纳性格。
"""

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from app.api.security import require_sidecar_token
from app.db import crud
from app.db.models import ImportChatRequest, PersonaCreate
from app.services import ark
from app.services.importer import parse_chat, them_texts
from app.services.runtime import state
from app.services.vectorstore import get_vector_store

router = APIRouter(prefix="/api/import", tags=["import"])


class ImportResult(BaseModel):
    persona_id: str
    import_id: str
    my_name: str
    their_name: str
    parsed: list[dict]
    message_count: int
    them_count: int
    embedded_count: int


@router.post(
    "/chat",
    response_model=ImportResult,
    dependencies=[Depends(require_sidecar_token)],
)
async def import_chat(body: ImportChatRequest) -> ImportResult:
    raw = body.raw_text.strip()
    if not raw:
        raise HTTPException(status_code=400, detail="raw_text 不能为空")
    if body.my_name.strip() == body.their_name.strip():
        raise HTTPException(status_code=400, detail="my_name 与 their_name 不能相同")

    # 人格：复用或新建
    persona_id = body.persona_id
    if persona_id:
        persona = await asyncio.to_thread(crud.get_persona, persona_id)
        if persona is None:
            raise HTTPException(status_code=404, detail="指定的人格不存在")
        created_new = False
    else:
        persona = await asyncio.to_thread(
            crud.create_persona,
            PersonaCreate(name=body.their_name, summary="（待分析师生成）"),
        )
        persona_id = persona.id
        created_new = True

    # 解析
    msgs = parse_chat(raw, body.my_name, body.their_name)
    if not msgs:
        raise HTTPException(
            status_code=400,
            detail="未能解析出任何消息，请使用「名字：内容」格式",
        )
    parsed_json = json.dumps(
        [{"speaker": m.speaker, "text": m.text} for m in msgs], ensure_ascii=False
    )

    # 持久化导入记录
    rec = await asyncio.to_thread(
        crud.create_import_record,
        persona_id, body.my_name, body.their_name, raw, parsed_json, len(msgs),
    )
    if created_new:
        await asyncio.to_thread(crud.update_persona_source, persona_id, rec.id)

    # 嵌入对方消息 → 向量库
    texts = them_texts(msgs)
    embedded = 0
    if texts:
        api_key = state.api_key
        if not api_key:
            raise HTTPException(status_code=400, detail="未配置 API Key，无法生成嵌入")
        try:
            vecs = await ark.embed_texts(api_key, texts)
        except Exception as exc:  # noqa: BLE001 - 把上游失败转成 502 给前端
            raise HTTPException(
                status_code=502,
                detail=f"嵌入调用失败：{type(exc).__name__}: {exc}",
            ) from exc
        store = get_vector_store()
        await store.upsert(persona_id, list(zip(texts, vecs)))
        embedded = len(vecs)

    return ImportResult(
        persona_id=persona_id,
        import_id=rec.id,
        my_name=body.my_name,
        their_name=body.their_name,
        parsed=[{"speaker": m.speaker, "text": m.text} for m in msgs],
        message_count=len(msgs),
        them_count=len(texts),
        embedded_count=embedded,
    )


@router.get("", dependencies=[Depends(require_sidecar_token)])
async def list_imports(persona_id: str = Query(...)) -> list[dict]:
    rows = await asyncio.to_thread(crud.list_import_records, persona_id)
    return [
        {
            "id": r.id,
            "persona_id": r.persona_id,
            "my_name": r.my_name,
            "their_name": r.their_name,
            "message_count": r.message_count,
            "created_at": r.created_at.isoformat(),
        }
        for r in rows
    ]


@router.get("/{record_id}", dependencies=[Depends(require_sidecar_token)])
async def get_import(record_id: str) -> dict:
    rec = await asyncio.to_thread(crud.get_import_record, record_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="导入记录不存在")
    parsed = json.loads(rec.parsed_json) if rec.parsed_json else []
    return {
        "id": rec.id,
        "persona_id": rec.persona_id,
        "my_name": rec.my_name,
        "their_name": rec.their_name,
        "raw_text": rec.raw_text,
        "parsed": parsed,
        "message_count": rec.message_count,
        "created_at": rec.created_at.isoformat(),
    }
