"""向量记忆存储。

收敛在 VectorStore 抽象接口背后，业务层只依赖抽象；
当前实现是 LanceDB（嵌入式文件型，纯本地，Windows 有原生 wheel）。
后续若换 FAISS / Milvus Lite，只需新增一个子类。

接口语义（业务层约定）：
- upsert(persona_id, items)：用 items 整体替换该 persona 的全部记忆（先删后加）。
- search(persona_id, query_vec, k)：在该 persona 的记忆里做余弦相似度检索，返回 top-k。
- delete_by_persona(persona_id)：清空该 persona 的全部向量。

LanceDB 的调用是同步的，这里用 asyncio.to_thread 包成协程，
避免阻塞 FastAPI 事件循环（本地小数据量，开销可忽略）。
"""

from __future__ import annotations

import asyncio
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import pyarrow as pa
import lancedb

from app.config import get_settings, lancedb_dir_path

# persona_id 是 uuid4().hex（纯十六进制），嵌入 SQL 谓词前做严格校验，杜绝注入风险
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")


@dataclass
class VectorHit:
    text: str
    score: float
    created_at: str


class VectorStore(ABC):
    """抽象接口：业务层只依赖它。"""

    @abstractmethod
    async def upsert(self, persona_id: str, items: list[tuple[str, list[float]]]) -> int:
        """返回写入条数。items = [(text, vector), ...]"""

    @abstractmethod
    async def append(self, persona_id: str, items: list[tuple[str, list[float]]]) -> int:
        """追加记忆（不清空原有），返回写入条数。"""

    @abstractmethod
    async def search(self, persona_id: str, query_vec: list[float], k: int = 5) -> list[VectorHit]:
        ...

    @abstractmethod
    async def delete_by_persona(self, persona_id: str) -> None:
        ...


class LanceDBVectorStore(VectorStore):
    """LanceDB 实现。"""

    TABLE = "memories"

    def __init__(self, uri: str, dim: int) -> None:
        self._uri = uri
        self._dim = dim
        self._table: Any | None = None  # 延迟到首次使用才连接

    # ---- 内部同步实现 ----

    def _schema(self) -> pa.Schema:
        return pa.schema([
            pa.field("persona_id", pa.string()),
            pa.field("vector", pa.list_(pa.float32(), self._dim)),
            pa.field("text", pa.string()),
            pa.field("created_at", pa.string()),
        ])

    def _get_table(self) -> Any:
        if self._table is not None:
            return self._table
        path = lancedb_dir_path()
        path.mkdir(parents=True, exist_ok=True)
        db = lancedb.connect(str(path))
        # 优先 open；表不存在（首次运行）才 create。
        # 不依赖 list_tables()：崩溃后可能存在残留文件但 list 返回不一致。
        try:
            self._table = db.open_table(self.TABLE)
        except Exception:
            self._table = db.create_table(self.TABLE, schema=self._schema(), mode="create")
        return self._table

    def _check_id(self, persona_id: str) -> None:
        if not persona_id or not _SAFE_ID.match(persona_id):
            raise ValueError("非法的 persona_id")

    def _upsert_sync(self, persona_id: str, items: list[tuple[str, list[float]]]) -> int:
        self._check_id(persona_id)
        tbl = self._get_table()
        # 整体替换：先删该 persona 全部记忆，再批量写入
        tbl.delete(f"persona_id = '{persona_id}'")
        if not items:
            return 0
        now = datetime.now(timezone.utc).isoformat()
        rows = [
            {"persona_id": persona_id, "vector": vec, "text": text, "created_at": now}
            for text, vec in items
        ]
        tbl.add(rows)
        return len(rows)

    def _append_sync(self, persona_id: str, items: list[tuple[str, list[float]]]) -> int:
        self._check_id(persona_id)
        if not items:
            return 0
        tbl = self._get_table()
        now = datetime.now(timezone.utc).isoformat()
        rows = [
            {"persona_id": persona_id, "vector": vec, "text": text, "created_at": now}
            for text, vec in items
        ]
        tbl.add(rows)
        return len(rows)

    def _search_sync(self, persona_id: str, query_vec: list[float], k: int) -> list[VectorHit]:
        self._check_id(persona_id)
        tbl = self._get_table()
        if tbl.count_rows() == 0:
            return []
        # cosine：distance ∈ [0,2]，score = 1 - distance ∈ [-1,1]（越大越相似）
        rows = (
            tbl.search(query_vec)
            .metric("cosine")
            .where(f"persona_id = '{persona_id}'")
            .limit(k)
            .to_list()
        )
        hits: list[VectorHit] = []
        for r in rows:
            distance = r.get("_distance", 0.0)
            hits.append(
                VectorHit(
                    text=r.get("text", ""),
                    score=max(0.0, 1.0 - float(distance)),
                    created_at=r.get("created_at", ""),
                )
            )
        # LanceDB 已按 distance 升序返回，score 降序即相似度从高到低
        return hits

    def _delete_sync(self, persona_id: str) -> None:
        self._check_id(persona_id)
        tbl = self._get_table()
        tbl.delete(f"persona_id = '{persona_id}'")

    # ---- 异步对外接口 ----

    async def upsert(self, persona_id: str, items: list[tuple[str, list[float]]]) -> int:
        return await asyncio.to_thread(self._upsert_sync, persona_id, items)

    async def append(self, persona_id: str, items: list[tuple[str, list[float]]]) -> int:
        return await asyncio.to_thread(self._append_sync, persona_id, items)

    async def search(self, persona_id: str, query_vec: list[float], k: int = 5) -> list[VectorHit]:
        return await asyncio.to_thread(self._search_sync, persona_id, query_vec, k)

    async def delete_by_persona(self, persona_id: str) -> None:
        await asyncio.to_thread(self._delete_sync, persona_id)


# 模块级单例：进程内只建一个连接
_store: LanceDBVectorStore | None = None


def get_vector_store() -> VectorStore:
    global _store
    if _store is None:
        settings = get_settings()
        _store = LanceDBVectorStore(
            uri=str(lancedb_dir_path()),
            dim=settings.embedding_dim,
        )
    return _store
