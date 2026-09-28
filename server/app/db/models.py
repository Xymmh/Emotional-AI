"""SQLModel 表结构。

三张表承载核心数据：
- Persona        人格档案（对方是谁、性格特征、背景）
- Conversation   一次会话（分析师视角 / 扮演主视角）
- Message        会话内的单条消息

外键约束在 SQLite 里默认关闭，级联删除由 crud 层手动完成，
避免依赖 PRAGMA foreign_keys=ON 的隐式行为。
"""

from datetime import datetime, timezone

from sqlmodel import Field, SQLModel


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Persona(SQLModel, table=True):
    """对方的人格画像，由分析师视角生成或手工编辑。"""

    __tablename__ = "personas"

    id: str = Field(primary_key=True)
    name: str
    summary: str = ""          # 一句话性格概述
    traits_json: str = "[]"   # JSON 字符串：性格特征数组，如 ["敏感","回避型依恋"]
    background: str = ""      # 背景描述（年龄/职业/关系等，自由文本）
    avatar_color: str = "#4a90e2"  # 前端头像配色，默认蓝
    source_import_id: str | None = None  # 来源导入记录 id，可空
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)


class Conversation(SQLModel, table=True):
    """一次对话会话。"""

    __tablename__ = "conversations"

    id: str = Field(primary_key=True)
    persona_id: str = Field(foreign_key="personas.id", index=True)
    mode: str = Field(index=True)  # "analyst" | "roleplay"
    title: str = ""
    created_at: datetime = Field(default_factory=_utcnow)
    updated_at: datetime = Field(default_factory=_utcnow)


class Message(SQLModel, table=True):
    """会话内单条消息。"""

    __tablename__ = "messages"

    id: str = Field(primary_key=True)
    conversation_id: str = Field(foreign_key="conversations.id", index=True)
    role: str = Field(index=True)  # "user" | "assistant" | "system"
    content: str
    created_at: datetime = Field(default_factory=_utcnow)


# ---------- API I/O 模型（非表） ----------
# 用 SQLModel 当 Pydantic 模型，避免再引入一个 pydantic 依赖符号。


class PersonaCreate(SQLModel):
    name: str
    summary: str = ""
    traits_json: str = "[]"
    background: str = ""
    avatar_color: str = "#4a90e2"
    source_import_id: str | None = None


class PersonaUpdate(SQLModel):
    name: str | None = None
    summary: str | None = None
    traits_json: str | None = None
    background: str | None = None
    avatar_color: str | None = None


class ConversationCreate(SQLModel):
    persona_id: str
    mode: str  # "analyst" | "roleplay"
    title: str = ""


class MessageCreate(SQLModel):
    conversation_id: str
    role: str  # "user" | "assistant" | "system"
    content: str


class ImportRecord(SQLModel, table=True):
    """一次聊天记录导入：保存原文与解析结果，供第三方分析师读取。"""

    __tablename__ = "import_records"

    id: str = Field(primary_key=True)
    persona_id: str = Field(foreign_key="personas.id", index=True)
    my_name: str
    their_name: str
    raw_text: str          # 原始粘贴文本
    parsed_json: str      # JSON: [{speaker:"me"|"them", text:"..."}]
    message_count: int = 0
    created_at: datetime = Field(default_factory=_utcnow)


class ImportChatRequest(SQLModel):
    my_name: str
    their_name: str
    raw_text: str
    persona_id: str | None = None  # 不传则新建人格
