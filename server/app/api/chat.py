"""主视角对话：流式扮演回复（SSE）。

流程：持久化用户消息 → 组装上下文（人格设定 + RAG 记忆 + 最近历史）
→ AsyncArk 流式生成 → SSE 逐块下发 → 结束后持久化助手消息。
嵌入失败不阻塞对话（记忆只是增强，不是必需）。
"""

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from volcenginesdkarkruntime import AsyncArk

from app.api.security import require_sidecar_token
from app.config import get_settings
from app.db import crud
from app.db.models import MessageCreate
from app.services import ark
from app.services.context import collect_history
from app.services.runtime import state
from app.services.vectorstore import get_vector_store

router = APIRouter(prefix="/api/chat", tags=["chat"])

HISTORY_BUDGET_TOKENS = 6000  # 历史窗口 token 预算（按预算从最新往回收集，条数不设上限）
MEMORY_TOP_K = 5        # 检索的记忆条数
MEMORY_MIN_SCORE = 0.35  # 低于该相似度的记忆不带入


class ChatStreamRequest(BaseModel):
    conversation_id: str
    content: str


def _build_system_prompt(persona, memories: list[str]) -> str:
    import json as _json

    try:
        traits = _json.loads(persona.traits_json or "[]")
        traits = [str(t) for t in traits if str(t).strip()]
    except Exception:  # noqa: BLE001 - traits 解析失败不致命
        traits = []

    lines = [
        f"你正在扮演「{persona.name}」，以第一人称与用户进行真实的聊天对话。",
        "用户就是你们聊天中的「我」。你收到每条消息都是用户以本人身份说的。",
        "人物设定：",
        f"- 一句话概述：{persona.summary or '（暂无）'}",
        f"- 性格特征：{'、'.join(traits) if traits else '（暂无）'}",
        f"- 背景：{persona.background or '（暂无）'}",
    ]
    if memories:
        lines.append("相关记忆（来自过往聊天记录，供把握语气与事件，禁止逐字复读）：")
        lines.extend(f"- {m}" for m in memories)
    lines.extend([
        "要求：",
        "- 始终保持人物性格与说话习惯一致",
        "- 口语化、简短自然（通常1~3句），符合中文聊天习惯",
        "- 不要跳出角色，不要解释自己是AI或模型",
        "输出格式（严格遵守）：",
        "第一行直接输出「对方」说的话（只有对话内容，不要任何前缀）；",
        "然后输出一个 <thought> 标签块，内容是分析师视角注解「对方」说这句话的心路历程："
        "TA 此刻真实的想法、情绪与顾虑，为什么这样回，简短 1~2 句。格式：",
        "<thought>",
        "（心路历程，1~2句）",
        "</thought>",
        "示例：",
        "再说吧，最近有点累",
        "<thought>",
        "TA 其实想去，但最近加班太多精力耗尽，用模糊推脱来避免直接拒绝伤害关系。",
        "</thought>",
    ])
    return "\n".join(lines)


@router.post("/stream", dependencies=[Depends(require_sidecar_token)])
async def chat_stream(body: ChatStreamRequest):
    settings = get_settings()
    if not state.api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key，请先到设置页保存")

    conv = await asyncio.to_thread(crud.get_conversation, body.conversation_id)
    if conv is None:
        raise HTTPException(status_code=404, detail="会话不存在")
    persona = await asyncio.to_thread(crud.get_persona, conv.persona_id)
    if persona is None:
        raise HTTPException(status_code=404, detail="会话关联的人格不存在")

    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="消息内容不能为空")

    # 1. 先持久化用户消息（即使后续流中断也不丢）
    await asyncio.to_thread(
        crud.add_message,
        MessageCreate(conversation_id=conv.id, role="user", content=content),
    )

    # 2. 最近历史（含刚写入的用户消息）：token 预算内从最新往回收集
    history = await asyncio.to_thread(crud.list_messages, conv.id)
    chat_history = [
        {"role": m.role, "content": m.content}
        for m in collect_history(history, HISTORY_BUDGET_TOKENS)
        if m.role in ("user", "assistant")
    ]

    # 3. RAG 记忆（失败不阻塞）
    memories: list[str] = []
    try:
        vecs = await ark.embed_texts(state.api_key, [content])
        hits = await get_vector_store().search(persona.id, vecs[0], MEMORY_TOP_K)
        memories = [h.text for h in hits if h.score >= MEMORY_MIN_SCORE]
    except Exception:  # noqa: BLE001
        memories = []

    messages = [{"role": "system", "content": _build_system_prompt(persona, memories)}]
    messages.extend(chat_history)

    async def gen():
        client = AsyncArk(
            api_key=state.api_key,
            base_url=settings.ark_base_url,
            timeout=120.0,
        )
        acc: list[str] = []
        try:
            stream = await client.chat.completions.create(
                model=state.roleplay_model,
                messages=messages,  # type: ignore[arg-type]
                stream=True,
                max_tokens=1500,
                temperature=0.9,
            )
            async for chunk in stream:
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                text = getattr(delta, "content", None)
                if text:
                    acc.append(text)
                    yield "data: " + json.dumps(
                        {"type": "delta", "text": text}, ensure_ascii=False
                    ) + "\n\n"
        except Exception as exc:  # noqa: BLE001 - 上游错误转 SSE 事件
            yield "data: " + json.dumps(
                {"type": "error", "text": f"{type(exc).__name__}: {exc}"},
                ensure_ascii=False,
            ) + "\n\n"
        finally:
            text = "".join(acc).strip()
            if text:
                try:
                    await asyncio.to_thread(
                        crud.add_message,
                        MessageCreate(conversation_id=conv.id, role="assistant", content=text),
                    )
                except Exception:  # noqa: BLE001 - 持久化失败不影响已下发内容
                    pass
            yield "data: " + json.dumps({"type": "done"}) + "\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class RollbackRequest(BaseModel):
    """中断生成后的回滚参数。按 conversation_id 定位会话；
    分析师面板的会话由服务端创建、客户端拿不到ID，故也支持 persona_id + mode。"""

    conversation_id: str | None = None
    persona_id: str | None = None
    mode: str | None = None
    keep: int


@router.post("/rollback", dependencies=[Depends(require_sidecar_token)])
async def chat_rollback(body: RollbackRequest):
    conv = None
    if body.conversation_id:
        conv = await asyncio.to_thread(crud.get_conversation, body.conversation_id)
    elif body.persona_id and body.mode:
        conv = await asyncio.to_thread(
            crud.get_conversation_by_persona_mode, body.persona_id, body.mode
        )
    if conv is None:
        # 会话尚不存在说明本轮未落库任何内容，无需回滚
        return {"removed": 0}
    removed = await asyncio.to_thread(crud.rollback_messages, conv.id, body.keep)
    return {"removed": removed}
