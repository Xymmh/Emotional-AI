"""同步 CRUD：每个函数自管 Session，路由层用 asyncio.to_thread 调用。

把 DB 逻辑收敛在这里，路由保持薄；后续若换异步引擎只改本文件。
"""

import uuid
from datetime import datetime, timezone

from sqlmodel import Session, delete, select

from app.db.engine import get_engine
from app.db.models import (
    Conversation,
    ConversationCreate,
    ImportRecord,
    Message,
    MessageCreate,
    Persona,
    PersonaCreate,
    PersonaUpdate,
)


def _new_id() -> str:
    return uuid.uuid4().hex


# ---------------- Persona ----------------


def create_persona(data: PersonaCreate) -> Persona:
    persona = Persona(id=_new_id(), **data.model_dump())
    with Session(get_engine()) as session:
        session.add(persona)
        session.commit()
        session.refresh(persona)
        return persona


def list_personas() -> list[Persona]:
    with Session(get_engine()) as session:
        rows = session.exec(select(Persona).order_by(Persona.updated_at.desc())).all()
        return list(rows)


def get_persona(persona_id: str) -> Persona | None:
    with Session(get_engine()) as session:
        return session.get(Persona, persona_id)


def update_persona(persona_id: str, data: PersonaUpdate) -> Persona | None:
    with Session(get_engine()) as session:
        persona = session.get(Persona, persona_id)
        if persona is None:
            return None
        changed = False
        for field, value in data.model_dump(exclude_unset=True).items():
            if value is not None and getattr(persona, field) != value:
                setattr(persona, field, value)
                changed = True
        if changed:
            persona.updated_at = datetime.now(timezone.utc)
            session.add(persona)
            session.commit()
            session.refresh(persona)
        return persona


def delete_persona(persona_id: str) -> bool:
    """删除人格及其所有会话/消息（向量由 API 层另行清理）。"""
    with Session(get_engine()) as session:
        persona = session.get(Persona, persona_id)
        if persona is None:
            return False
        # 级联：先删消息，再删会话，最后删人格
        conv_ids = session.exec(
            select(Conversation.id).where(Conversation.persona_id == persona_id)
        ).all()
        if conv_ids:
            session.exec(delete(Message).where(Message.conversation_id.in_(conv_ids)))
            session.exec(delete(Conversation).where(Conversation.persona_id == persona_id))
        session.exec(delete(ImportRecord).where(ImportRecord.persona_id == persona_id))
        session.delete(persona)
        session.commit()
        return True


# ---------------- Conversation ----------------


def create_conversation(data: ConversationCreate) -> Conversation:
    conv = Conversation(id=_new_id(), **data.model_dump())
    with Session(get_engine()) as session:
        session.add(conv)
        session.commit()
        session.refresh(conv)
        return conv


def list_conversations(persona_id: str | None = None) -> list[Conversation]:
    with Session(get_engine()) as session:
        stmt = select(Conversation)
        if persona_id is not None:
            stmt = stmt.where(Conversation.persona_id == persona_id)
        stmt = stmt.order_by(Conversation.updated_at.desc())
        return list(session.exec(stmt).all())


def get_conversation(conversation_id: str) -> Conversation | None:
    with Session(get_engine()) as session:
        return session.get(Conversation, conversation_id)


def get_conversation_by_persona_mode(persona_id: str, mode: str) -> Conversation | None:
    with Session(get_engine()) as session:
        stmt = select(Conversation).where(
            Conversation.persona_id == persona_id,
            Conversation.mode == mode,
        )
        return session.exec(stmt).first()


def rollback_messages(conversation_id: str, keep: int) -> int:
    """回退到第 keep 条消息之后：删除其后所有消息，返回删除条数。

    供「中断生成」使用：客户端传入发送前的消息数，服务端把本轮
    用户消息与未完成的助手回复一并删除，恢复到上一轮结束的状态。
    """
    with Session(get_engine()) as session:
        rows = session.exec(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at, Message.id)
        ).all()
        stale = rows[max(0, keep):]
        for m in stale:
            session.delete(m)
        session.commit()
        return len(stale)


def touch_conversation(conversation_id: str) -> None:
    """更新会话时间戳，供追加消息后调用。"""
    with Session(get_engine()) as session:
        conv = session.get(Conversation, conversation_id)
        if conv is not None:
            conv.updated_at = datetime.now(timezone.utc)
            session.add(conv)
            session.commit()


def delete_conversation(conversation_id: str) -> bool:
    with Session(get_engine()) as session:
        conv = session.get(Conversation, conversation_id)
        if conv is None:
            return False
        session.exec(delete(Message).where(Message.conversation_id == conversation_id))
        session.delete(conv)
        session.commit()
        return True


# ---------------- Message ----------------


def add_message(data: MessageCreate) -> Message:
    msg = Message(id=_new_id(), **data.model_dump())
    with Session(get_engine()) as session:
        session.add(msg)
        session.commit()
        session.refresh(msg)
    touch_conversation(data.conversation_id)
    return msg


def list_messages(conversation_id: str) -> list[Message]:
    with Session(get_engine()) as session:
        rows = session.exec(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.asc())
        ).all()
        return list(rows)


# ---------------- ImportRecord ----------------


def create_import_record(
    persona_id: str,
    my_name: str,
    their_name: str,
    raw_text: str,
    parsed_json: str,
    message_count: int,
) -> ImportRecord:
    rec = ImportRecord(
        id=_new_id(),
        persona_id=persona_id,
        my_name=my_name,
        their_name=their_name,
        raw_text=raw_text,
        parsed_json=parsed_json,
        message_count=message_count,
    )
    with Session(get_engine()) as session:
        session.add(rec)
        session.commit()
        session.refresh(rec)
        return rec


def get_import_record(record_id: str) -> ImportRecord | None:
    with Session(get_engine()) as session:
        return session.get(ImportRecord, record_id)


def list_import_records(persona_id: str) -> list[ImportRecord]:
    with Session(get_engine()) as session:
        rows = session.exec(
            select(ImportRecord)
            .where(ImportRecord.persona_id == persona_id)
            .order_by(ImportRecord.created_at.desc())
        ).all()
        return list(rows)


def update_persona_source(persona_id: str, source_import_id: str) -> Persona | None:
    """把 persona.source_import_id 指向某次导入记录。"""
    with Session(get_engine()) as session:
        persona = session.get(Persona, persona_id)
        if persona is None:
            return None
        persona.source_import_id = source_import_id
        persona.updated_at = datetime.now(timezone.utc)
        session.add(persona)
        session.commit()
        session.refresh(persona)
        return persona
