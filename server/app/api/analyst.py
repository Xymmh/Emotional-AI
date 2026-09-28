"""第三视角（分析师）：消化用户发来的聊天记录，流式给出分析。

- 消息持久化在该人格 mode=analyst 的会话里
- 每条记录按行追加进向量记忆（塑造「对方」的语料）
- 画像自动塑造：每累计 PROFILE_EVERY 条用户消息后台静默触发（services/profile.py）；
  用户也可在界面上点「更新画像」立即执行
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
from app.db.models import ConversationCreate, MessageCreate
from app.services import ark
from app.services.profile import schedule_maybe_auto_profile
from app.services.runtime import state
from app.services.vectorstore import get_vector_store

router = APIRouter(prefix="/api/analyst", tags=["analyst"])

HISTORY_LIMIT = 16
MEMORY_MAX_LINES = 60
MEMORY_LINE_CHARS = 200


class AnalystStreamRequest(BaseModel):
    persona_id: str
    content: str


async def _ensure_analyst_conversation(persona_id: str) -> str:
    convs = await asyncio.to_thread(crud.list_conversations, persona_id)
    for conv in convs:
        if conv.mode == "analyst":
            return conv.id
    conv = await asyncio.to_thread(
        crud.create_conversation,
        ConversationCreate(persona_id=persona_id, mode="analyst", title="第三视角"),
    )
    return conv.id


def _analyst_system_prompt(persona_name: str, persona_summary: str) -> str:
    known = f"目前已掌握的画像：{persona_summary or '（暂无，需要从记录中归纳）'}"
    return (
        f"你是一位冷静、敏锐的社交关系分析师。用户会把与「{persona_name}」之间的"
        "真实聊天记录粘贴给你，或描述与对方相关的情况。\n"
        "聊天记录格式说明：每行形如「说话人：内容」，冒号前的名字即说话人；"
        f"说话人为「我」的行是用户本人说的，说话人为「{persona_name}」或其他人名的行"
        f"都是对方（及在场者）说的。分析对象是「{persona_name}」，不是用户。\n"
        f"{known}\n"
        "你的任务：\n"
        "1. 结合记录中「" + persona_name + "」的原话，分析 TA 的性格、依恋风格、"
        "沟通模式与情绪状态；\n"
        "2. 解读对方心理、预测对方接下来的可能反应；\n"
        "3. 给用户具体、可执行的沟通建议。\n"
        "要求：中文，口语化但专业，简明（不超过200字），分点清晰。你只做分析，绝不扮演对方。"
    )


def _classify_prompt(persona_name: str, content: str) -> str:
    return (
        "判断用户发给关系分析师的这条消息属于哪种类型：\n"
        f'- record：包含与「{persona_name}」的聊天记录、TA 的原话，或双方互动过程的描述；\n'
        "- chat：只是向分析师提问（如「TA 现在是怎么想的？」）、表达感受、谈心，"
        "没有任何 TA 的新素材。\n"
        "只输出一个单词：record 或 chat。\n"
        "消息：\n"
        f"{content[:2000]}"
    )


async def _classify_input(persona_name: str, content: str) -> str:
    """分类节点：极短输出（一个词），决定是否需要调用整理 Agent。失败按 record。"""
    settings = get_settings()
    client = AsyncArk(api_key=state.api_key, base_url=settings.ark_base_url, timeout=30.0)
    try:
        resp = await client.chat.completions.create(
            model=settings.chat_model,
            messages=[{"role": "user", "content": _classify_prompt(persona_name, content)}],
            max_tokens=8,
            temperature=0.0,
        )
        word = (resp.choices[0].message.content or "").strip().lower()
        return "chat" if "chat" in word else "record"
    except Exception as exc:  # noqa: BLE001 - 分类失败按素材处理（多数输入是素材）
        print(f"[analyst] classify failed, assume record: {exc!r}", flush=True)
        return "record"
    finally:
        await client.close()


def _normalize_prompt(persona_name: str, content: str) -> str:
    return (
        "你是对话整理助手。用户会给你一段 TA 与「" + persona_name + "」之间的聊天记录"
        "（也可能是混合了描述、截图转写、分段不清的原始粘贴），格式五花八门、不一定规范。\n"
        "你的任务：判断每一句话是谁说的，整理成按时间排序的对话行数组。规则：\n"
        f"- 用户本人一律标注为「我」；用户要分析的「{persona_name}」原样使用这个名字；\n"
        "- 记录里如果出现别的说话人名字，保留那个名字标注；\n"
        "- 不是对话的描述性内容标注为「旁白」；\n"
        "- 保留原话语气，不要改写、不要总结、不要遗漏；\n"
        "- 说话人名可能是「我」以外的任何昵称（例如小名、字母、表情），靠上下文判断谁是谁；\n"
        '只输出 JSON 数组，每项形如 "我：…"、"其他名字：…" 或 "旁白：…"。不要输出其他内容。\n'
        "原始输入：\n"
        f"{content}"
    )


async def _normalize_dialog(persona_name: str, content: str) -> list[str]:
    """整理 Agent：LLM 判断说话人并整理对话行。失败时回退为整段原文一行。"""
    settings = get_settings()
    client = AsyncArk(api_key=state.api_key, base_url=settings.ark_base_url, timeout=60.0)
    try:
        resp = await client.chat.completions.create(
            model=settings.chat_model,
            messages=[{"role": "user", "content": _normalize_prompt(persona_name, content)}],
            max_tokens=2000,
            temperature=0.1,
        )
        text = (resp.choices[0].message.content or "").strip()
        start, end = text.find("["), text.rfind("]")
        if start == -1 or end <= start:
            raise ValueError("no array")
        data = json.loads(text[start : end + 1])
        lines = [str(x).strip()[:MEMORY_LINE_CHARS] for x in data if str(x).strip()]
        return lines[:MEMORY_MAX_LINES] or [f"用户输入：{content[:MEMORY_LINE_CHARS]}"]
    except Exception as exc:  # noqa: BLE001 - 整理失败不阻塞分析，回退原文
        print(f"[analyst] normalize failed, fallback to raw: {exc!r}", flush=True)
        return [f"用户输入：{content[:MEMORY_LINE_CHARS]}"]
    finally:
        await client.close()


async def _append_memories(persona_id: str, lines: list[str]) -> None:
    """把整理后的对话行追加进向量记忆（塑造「对方」的语料，含说话人标注）。"""
    lines = [ln.strip()[:MEMORY_LINE_CHARS] for ln in lines]
    lines = [ln for ln in lines if ln][:MEMORY_MAX_LINES]
    if not lines:
        return
    try:
        vecs = await ark.embed_texts(state.api_key, lines)
        await get_vector_store().append(persona_id, list(zip(lines, vecs)))
    except Exception as exc:  # noqa: BLE001 - 记忆失败不阻塞分析
        print(f"[analyst] append memories failed: {exc!r}", flush=True)


@router.post("/stream", dependencies=[Depends(require_sidecar_token)])
async def analyst_stream(body: AnalystStreamRequest):
    settings = get_settings()
    if not state.api_key:
        raise HTTPException(status_code=400, detail="未配置 API Key，请先到设置页保存")

    persona = await asyncio.to_thread(crud.get_persona, body.persona_id)
    if persona is None:
        raise HTTPException(status_code=404, detail="人格不存在")
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="内容不能为空")

    conv_id = await _ensure_analyst_conversation(persona.id)
    await asyncio.to_thread(
        crud.add_message,
        MessageCreate(conversation_id=conv_id, role="user", content=content),
    )

    async def gen():
        client = AsyncArk(
            api_key=state.api_key, base_url=settings.ark_base_url, timeout=120.0
        )
        acc: list[str] = []
        dialog_lines: list[str] = []

        def sse(obj: dict) -> str:
            return "data: " + json.dumps(obj, ensure_ascii=False) + "\n\n"

        try:
            # ---- Agent 链路（每步都流式上报状态，像 IDE 里的 agent 反馈） ----
            yield sse({"type": "status", "text": "判断输入类型"})
            kind = await _classify_input(persona.name, content)
            if kind == "record":
                yield sse({"type": "status", "text": "整理对话记录"})
                dialog_lines = await _normalize_dialog(persona.name, content)
                yield sse({"type": "status", "text": f"识别出 {len(dialog_lines)} 条对话，开始分析"})
                user_view = "【整理后的对话】\n" + "\n".join(dialog_lines)
            else:
                user_view = content

            history = await asyncio.to_thread(crud.list_messages, conv_id)
            chat_history = [
                {"role": m.role, "content": m.content}
                for m in history[-HISTORY_LIMIT - 1 : -1]  # 最后一条是刚发的原文，按类型替换
                if m.role in ("user", "assistant")
            ]
            chat_history.append({"role": "user", "content": user_view})
            messages = [
                {"role": "system", "content": _analyst_system_prompt(persona.name, persona.summary)}
            ]
            messages.extend(chat_history)

            # ---- 分析师流式生成 ----
            stream = await client.chat.completions.create(
                model=settings.analyst_model,
                messages=messages,  # type: ignore[arg-type]
                stream=True,
                max_tokens=800,
                temperature=0.6,
            )
            async for chunk in stream:
                if not chunk.choices:
                    continue
                text = getattr(chunk.choices[0].delta, "content", None)
                if text:
                    acc.append(text)
                    yield sse({"type": "delta", "text": text})
        except Exception as exc:  # noqa: BLE001
            yield sse({"type": "error", "text": f"{type(exc).__name__}: {exc}"})
        finally:
            text = "".join(acc).strip()
            if text:
                try:
                    await asyncio.to_thread(
                        crud.add_message,
                        MessageCreate(conversation_id=conv_id, role="assistant", content=text),
                    )
                except Exception:  # noqa: BLE001
                    pass
            yield sse({"type": "done"})
            # 流结束后异步收尾（不阻塞 SSE）：仅素材类输入追加记忆；画像照常按轮次触发
            if dialog_lines:
                asyncio.create_task(_append_memories(persona.id, dialog_lines))
            schedule_maybe_auto_profile(persona.id)
            await client.close()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
