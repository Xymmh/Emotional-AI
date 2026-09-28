"""画像塑造：从第三视角对话中汇总生成最新人格画像并回写。

触发方式：
- 手动：POST /api/personas/{id}/profile/refresh（用户点「更新画像」立即执行）
- 自动：第三视角每累计 PROFILE_EVERY 条用户消息，后台静默触发一次（无感知，失败仅记日志）
- 主视角对话始终读取 persona 表中最近保存的画像，无需等待任何更新完成。
"""

import asyncio
import json

from volcenginesdkarkruntime import AsyncArk

from app.config import get_settings
from app.db import crud
from app.db.models import PersonaUpdate
from app.services.runtime import state

PROFILE_EVERY = 4  # 每累计多少条第三视角用户消息，自动重塑一次画像
HISTORY_LIMIT = 16


class ProfileError(Exception):
    """画像生成失败（无素材 / 模型调用失败），message 可直接展示给用户。"""


def _profile_prompt(persona, dialog: str) -> str:
    try:
        traits = json.loads(persona.traits_json or "[]")
        traits = "、".join(str(t) for t in traits)
    except Exception:  # noqa: BLE001
        traits = ""
    return (
        f"基于下面的分析对话，输出「{persona.name}」的最新人物画像。\n"
        "现有画像（合并更新，不要丢失仍然成立的信息；如内容已过时请修正）：\n"
        f"- 概述：{persona.summary or '（无）'}\n"
        f"- 特征：{traits or '（无）'}\n"
        f"- 背景：{persona.background or '（无）'}\n"
        f"分析对话（最近，用户=「我」，分析对象=「{persona.name}」）：\n{dialog}\n"
        '只输出一个 JSON 对象，格式：{"summary": "一句话性格概述", '
        '"traits": ["特征1", "特征2"], "background": "身份与关系背景，一两句"}。'
        "不要输出其他任何内容。"
    )


async def build_profile(persona_id: str) -> dict:
    """生成并回写画像；失败抛 ProfileError。返回 {summary, traits, background}。"""
    settings = get_settings()
    persona = await asyncio.to_thread(crud.get_persona, persona_id)
    if persona is None:
        raise ProfileError("人格不存在")
    convs = await asyncio.to_thread(crud.list_conversations, persona_id)
    conv_id = next((c.id for c in convs if c.mode == "analyst"), None)
    if conv_id is None:
        raise ProfileError("还没有第三视角对话，先去分析一些记录吧")
    msgs = await asyncio.to_thread(crud.list_messages, conv_id)
    if not msgs:
        raise ProfileError("还没有第三视角对话，先去分析一些记录吧")
    dialog = "\n".join(
        f"{'用户' if m.role == 'user' else '分析师'}：{m.content[:400]}"
        for m in msgs[-HISTORY_LIMIT:]
    )

    client = AsyncArk(api_key=state.api_key, base_url=settings.ark_base_url, timeout=60.0)
    try:
        resp = await client.chat.completions.create(
            model=settings.analyst_model,
            messages=[{"role": "user", "content": _profile_prompt(persona, dialog)}],
            max_tokens=400,
            temperature=0.3,
        )
        text = (resp.choices[0].message.content or "").strip()
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end <= start:
            raise ProfileError("模型没有返回有效画像，请重试")
        try:
            data = json.loads(text[start : end + 1])
        except json.JSONDecodeError as exc:
            raise ProfileError("模型返回的画像格式无效，请重试") from exc
        traits = [str(t)[:30] for t in (data.get("traits") or [])[:8] if str(t).strip()]
        summary = str(data.get("summary", "")).strip()[:200]
        background = str(data.get("background", "")).strip()[:500]
        if not summary and not traits:
            raise ProfileError("模型返回的画像为空，请重试")
        await asyncio.to_thread(
            crud.update_persona,
            persona_id,
            PersonaUpdate(
                summary=summary or None,
                traits_json=json.dumps(traits, ensure_ascii=False),
                background=background or None,
            ),
        )
        return {"summary": summary, "traits": traits, "background": background}
    except ProfileError:
        raise
    except Exception as exc:  # noqa: BLE001 - 上游网络/模型错误
        raise ProfileError(f"画像生成失败：{type(exc).__name__}") from exc
    finally:
        await client.close()


async def maybe_auto_profile(persona_id: str) -> None:
    """自动塑造入口：每 PROFILE_EVERY 条第三视角用户消息触发一次；静默失败。"""
    try:
        convs = await asyncio.to_thread(crud.list_conversations, persona_id)
        conv_id = next((c.id for c in convs if c.mode == "analyst"), None)
        if conv_id is None:
            return
        msgs = await asyncio.to_thread(crud.list_messages, conv_id)
        n_user = sum(1 for m in msgs if m.role == "user")
        if n_user == 0 or n_user % PROFILE_EVERY != 0:
            return
        await build_profile(persona_id)
        print(f"[profile] auto updated persona={persona_id}", flush=True)
    except Exception as exc:  # noqa: BLE001 - 自动更新无感知，失败仅记日志
        print(f"[profile] auto update failed: {exc!r}", flush=True)


def schedule_maybe_auto_profile(persona_id: str) -> None:
    """在事件循环上挂后台任务，不阻塞当前响应。"""
    asyncio.create_task(maybe_auto_profile(persona_id))
