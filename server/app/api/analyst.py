"""第三视角（分析师）：消化用户发来的聊天记录，流式给出分析。

- 消息持久化在该人格 mode=analyst 的会话里
- 每条记录按行追加进向量记忆（塑造「对方」的语料）
- 每轮分析完成后后台沉淀：提炼 2~3 条观察短句回写 persona.observations
  （长期观察日志，供后续分析参考），并以【分析师洞察】前缀入向量记忆，
  让主视角 RAG 能召回分析师的结论
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
from app.db.models import ConversationCreate, MessageCreate, PersonaUpdate
from app.services import ark
from app.services.context import collect_history
from app.services.profile import schedule_maybe_auto_profile
from app.services.runtime import state
from app.services.vectorstore import get_vector_store

router = APIRouter(prefix="/api/analyst", tags=["analyst"])

HISTORY_BUDGET_TOKENS = 12000  # 历史窗口 token 预算（聊天记录粘贴可能很长，按预算收集更稳）
MEMORY_MAX_LINES = 60
MEMORY_LINE_CHARS = 200

INSIGHT_PREFIX = "【分析师洞察】"  # 入向量库的分析洞察前缀，与原始对话行区分
OBS_LINE_CHARS = 60   # 单条观察短句上限
OBS_MAX_CHARS = 2000  # persona.observations 总长上限，超长丢最旧


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


def _analyst_system_prompt(
    persona_name: str, persona_summary: str, observations: str
) -> str:
    known = f"目前已掌握的画像：{persona_summary or '（暂无，需要从记录中归纳）'}"
    obs_lines = [ln.strip() for ln in (observations or "").splitlines() if ln.strip()]
    obs_block = ""
    if obs_lines:
        obs_block = (
            "\n近期观察记录（历次分析的沉淀，按时间序、越靠下越新，供交叉参考）：\n"
            + "\n".join(f"- {ln}" for ln in obs_lines)
        )
    return (
        f"你是一位冷静、敏锐的社交关系分析师。用户会把与「{persona_name}」之间的"
        "真实聊天记录粘贴给你，或描述与对方相关的情况。\n"
        "聊天记录格式说明：每行形如「说话人：内容」，冒号前的名字即说话人；"
        f"说话人为「我」的行是用户本人说的，说话人为「{persona_name}」或其他人名的行"
        f"都是对方（及在场者）说的。分析对象是「{persona_name}」，不是用户。\n"
        f"{known}{obs_block}\n"
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


def _observation_prompt(persona_name: str, analysis_text: str) -> str:
    return (
        f"下面是关系分析师关于「{persona_name}」的一段分析结论。"
        f"请从中提炼 2~3 条关于「{persona_name}」本人稳定特质的结构化短句"
        "（性格、依恋风格、沟通模式、情绪触发点等）。\n"
        "要求：每条不超过 40 字；只陈述对方本人的稳定特质，不要给用户的建议、"
        "不要一次性的预测措辞；若没有可靠的新信息，输出空数组 []。\n"
        '只输出 JSON 字符串数组，如 ["敏感，被忽视时倾向冷战"]，不要输出其他内容。\n'
        f"分析结论：\n{analysis_text[:2000]}"
    )


async def _extract_observations(persona_name: str, analysis_text: str) -> list[str]:
    """从分析师结论中提炼 2~3 条结构化观察短句；失败返回空列表。"""
    if not analysis_text:
        return []
    settings = get_settings()
    client = AsyncArk(api_key=state.api_key, base_url=settings.ark_base_url, timeout=30.0)
    try:
        resp = await client.chat.completions.create(
            model=settings.chat_model,
            messages=[
                {"role": "user", "content": _observation_prompt(persona_name, analysis_text)}
            ],
            max_tokens=200,
            temperature=0.2,
        )
        text = (resp.choices[0].message.content or "").strip()
        start, end = text.find("["), text.rfind("]")
        if start == -1 or end <= start:
            return []
        data = json.loads(text[start : end + 1])
        return [str(x).strip()[:OBS_LINE_CHARS] for x in data if str(x).strip()][:3]
    except Exception as exc:  # noqa: BLE001 - 提炼失败不影响主流程
        print(f"[analyst] extract observations failed: {exc!r}", flush=True)
        return []
    finally:
        await client.close()


def _merge_observations(existing: str, round_no: int, new_lines: list[str]) -> str:
    """把本轮观察带轮次号追加到已有记录末尾；总长超限丢最旧。"""
    lines = [ln.strip() for ln in (existing or "").splitlines() if ln.strip()]
    lines.extend(f"#{round_no} {ln}" for ln in new_lines)
    while lines and sum(len(ln) + 1 for ln in lines) > OBS_MAX_CHARS:
        lines.pop(0)
    return "\n".join(lines)


async def _post_turn_insights(
    persona_id: str,
    round_no: int,
    persona_name: str,
    dialog_lines: list[str],
    analysis_text: str,
) -> None:
    """一轮完整分析后的后台沉淀（不阻塞 SSE）：
    1. 原始对话行入向量记忆（对方的语料）；
    2. 从分析结论提炼观察短句，回写 persona.observations（长期观察日志）；
    3. 观察短句以【分析师洞察】前缀入向量记忆，主视角 RAG 可自然召回。
    """
    try:
        if dialog_lines:
            await _append_memories(persona_id, dialog_lines)
        obs = await _extract_observations(persona_name, analysis_text)
        if not obs:
            return
        persona = await asyncio.to_thread(crud.get_persona, persona_id)
        if persona is None:
            return
        merged = _merge_observations(persona.observations, round_no, obs)
        await asyncio.to_thread(
            crud.update_persona, persona_id, PersonaUpdate(observations=merged)
        )
        insight_texts = [f"{INSIGHT_PREFIX}{ln}" for ln in obs]
        vecs = await ark.embed_texts(state.api_key, insight_texts)
        await get_vector_store().append(persona_id, list(zip(insight_texts, vecs)))
        print(f"[analyst] insights stored persona={persona_id} round={round_no}", flush=True)
    except Exception as exc:  # noqa: BLE001 - 沉淀失败不影响已下发的分析
        print(f"[analyst] post-turn insights failed: {exc!r}", flush=True)


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
        history: list = []  # 供 finally 计算轮次号；未取到时按首轮处理
        failed = False

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
            # 最后一条是刚发的原文，按输入类型替换成整理后的 user_view，不进窗口
            window = collect_history(history[:-1], HISTORY_BUDGET_TOKENS)
            chat_history = [
                {"role": m.role, "content": m.content}
                for m in window
                if m.role in ("user", "assistant")
            ]
            chat_history.append({"role": "user", "content": user_view})
            messages = [
                {
                    "role": "system",
                    "content": _analyst_system_prompt(
                        persona.name, persona.summary, persona.observations
                    ),
                }
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
            failed = True
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
            # 流结束后异步收尾（不阻塞 SSE）：完整分析 → 提炼观察短句并沉淀入库；
            # 中断/失败的轮次只回填原始对话行记忆。画像照常按轮次触发。
            round_no = sum(1 for m in history if m.role == "assistant") + 1
            if text and not failed:
                asyncio.create_task(
                    _post_turn_insights(
                        persona.id, round_no, persona.name, dialog_lines, text
                    )
                )
            elif dialog_lines:
                asyncio.create_task(_append_memories(persona.id, dialog_lines))
            schedule_maybe_auto_profile(persona.id)
            await client.close()

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
