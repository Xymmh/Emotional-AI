"""向量记忆存储（LanceDB，嵌入式文件型，纯本地）。

业务层只依赖 VectorStore 的异步接口：
- append(persona_id, items)  追加记忆
- upsert(persona_id, items)  整体替换该人格的记忆
- search(persona_id, vec, k) 余弦相似度检索 top-k
- delete_by_persona(persona_id)

向量模型可在设置页更换，不同模型 / 维度的向量不可比较，因此：
- meta.json 记录当前索引由哪套向量设置（模型 / 接口 / 维度）生成；
- 设置变化后索引进入「待重建」：检索暂停（返回空，对话照常只是不带记忆），
  新写入的记忆以纯文本暂存进 pending.jsonl，不会丢；
- rebuild() 用新设置把全部记忆文本（表内 + 暂存）重新向量化，全部成功后才整体替换旧表，
  中途失败旧索引原样保留。每条记忆都存了原文，所以重建总是可行的。

LanceDB 调用是同步的，统一在线程里执行；表 / meta / 暂存文件的读写用同一把锁串行化。
"""

from __future__ import annotations

import asyncio
import json
import re
import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import lancedb
import pyarrow as pa

from app.config import get_settings, lancedb_dir_path
from app.services.model_config import ModelConfig, get_model_config

# 分析师洞察入库时的文本前缀，与原始对话行区分（主视角据此分组带入提示词）
INSIGHT_PREFIX = "【分析师洞察】"

# persona_id 是 uuid4().hex（纯十六进制），嵌入 SQL 谓词前做严格校验，杜绝注入风险
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")

TABLE = "memories"
REBUILD_CHUNK = 64


@dataclass
class VectorHit:
    text: str
    score: float
    created_at: str


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _check_id(persona_id: str) -> None:
    if not persona_id or not _SAFE_ID.match(persona_id):
        raise ValueError("非法的 persona_id")


def _legacy_signature() -> dict:
    """旧版本没有 meta.json：当时固定用 .env 里的向量模型、多模态接口、embedding_dim 维。"""
    s = get_settings()
    api = "multimodal" if "vision" in s.embedding_model.lower() else "text"
    return {"model": s.embedding_model, "api": api, "dimensions": s.embedding_dim or None}


class LanceDBVectorStore:
    def __init__(self, root: Path) -> None:
        self._root = root
        self._db: Any | None = None
        self._table: Any | None = None
        self._lock = threading.RLock()
        self._rebuilding = False
        self.rebuild_state: dict = {"running": False, "done": 0, "total": 0, "error": ""}

    # ---------------- 基础设施 ----------------

    @property
    def _meta_path(self) -> Path:
        return self._root / "meta.json"

    @property
    def _pending_path(self) -> Path:
        return self._root / "pending.jsonl"

    def _conn(self) -> Any:
        if self._db is None:
            self._root.mkdir(parents=True, exist_ok=True)
            self._db = lancedb.connect(str(self._root))
        return self._db

    def _open_table(self) -> Any | None:
        """打开已有表；不存在返回 None（首次写入时按向量维度建表）。"""
        if self._table is not None:
            return self._table
        try:
            self._table = self._conn().open_table(TABLE)
        except Exception:  # noqa: BLE001 - 表不存在
            self._table = None
        return self._table

    def _table_dim(self, tbl: Any) -> int:
        return int(tbl.schema.field("vector").type.list_size)

    @staticmethod
    def _schema(dim: int) -> pa.Schema:
        return pa.schema([
            pa.field("persona_id", pa.string()),
            pa.field("vector", pa.list_(pa.float32(), dim)),
            pa.field("text", pa.string()),
            pa.field("created_at", pa.string()),
        ])

    def _read_meta(self) -> dict | None:
        if self._meta_path.exists():
            try:
                return json.loads(self._meta_path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                return None
        tbl = self._open_table()
        if tbl is None:
            return None
        # 旧数据：补写 meta，按旧版固定设置推断
        meta = {"signature": _legacy_signature(), "dim": self._table_dim(tbl)}
        self._write_meta(meta)
        return meta

    def _write_meta(self, meta: dict) -> None:
        self._root.mkdir(parents=True, exist_ok=True)
        tmp = self._meta_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self._meta_path)

    def _read_pending(self) -> list[dict]:
        if not self._pending_path.exists():
            return []
        rows = []
        for line in self._pending_path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return rows

    def _write_pending(self, rows: list[dict]) -> None:
        if not rows:
            if self._pending_path.exists():
                self._pending_path.unlink()
            return
        self._root.mkdir(parents=True, exist_ok=True)
        tmp = self._pending_path.with_suffix(".jsonl.tmp")
        tmp.write_text(
            "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8"
        )
        tmp.replace(self._pending_path)

    def _add_pending(self, persona_id: str, texts: list[str]) -> None:
        self._root.mkdir(parents=True, exist_ok=True)
        now = _now()
        with self._pending_path.open("a", encoding="utf-8") as f:
            for t in texts:
                f.write(json.dumps({"persona_id": persona_id, "text": t, "created_at": now},
                                   ensure_ascii=False) + "\n")

    def _count_rows(self) -> int:
        tbl = self._open_table()
        return int(tbl.count_rows()) if tbl is not None else 0

    def _is_stale(self, cfg: ModelConfig) -> bool:
        """当前向量设置与索引不一致 → 待重建。空库直接改认新设置，无需重建。"""
        meta = self._read_meta()
        if meta is None:
            return False
        if meta.get("signature") == cfg.embedding_signature():
            return False
        if self._count_rows() == 0 and not self._read_pending():
            self._drop_table()
            self._meta_path.unlink(missing_ok=True)
            return False
        return True

    def _drop_table(self) -> None:
        try:
            self._conn().drop_table(TABLE)
        except Exception:  # noqa: BLE001 - 本来就不存在
            pass
        self._table = None

    # ---------------- 同步实现 ----------------

    def _append_sync(self, persona_id: str, items: list[tuple[str, list[float]]]) -> int:
        _check_id(persona_id)
        if not items:
            return 0
        cfg = get_model_config()
        with self._lock:
            if self._rebuilding or self._is_stale(cfg):
                # 索引待重建 / 重建中：先暂存原文，重建时统一用新模型向量化
                self._add_pending(persona_id, [t for t, _ in items])
                return 0
            dim = len(items[0][1])
            if any(len(v) != dim for _, v in items):
                raise ValueError("同一批向量维度不一致")
            tbl = self._open_table()
            if tbl is None:
                tbl = self._conn().create_table(TABLE, schema=self._schema(dim), mode="create")
                self._table = tbl
                self._write_meta({"signature": cfg.embedding_signature(), "dim": dim})
            elif self._table_dim(tbl) != dim:
                # 理论上 signature 相同维度就相同；兜底：暂存原文，等待重建
                self._add_pending(persona_id, [t for t, _ in items])
                return 0
            now = _now()
            tbl.add([
                {"persona_id": persona_id, "vector": vec, "text": text, "created_at": now}
                for text, vec in items
            ])
            return len(items)

    def _upsert_sync(self, persona_id: str, items: list[tuple[str, list[float]]]) -> int:
        _check_id(persona_id)
        with self._lock:
            self._delete_sync(persona_id)
            return self._append_sync(persona_id, items)

    def _search_sync(self, persona_id: str, query_vec: list[float], k: int) -> list[VectorHit]:
        _check_id(persona_id)
        cfg = get_model_config()
        with self._lock:
            if self._rebuilding or self._is_stale(cfg):
                return []
            tbl = self._open_table()
            if tbl is None or tbl.count_rows() == 0 or self._table_dim(tbl) != len(query_vec):
                return []
        # cosine：distance ∈ [0,2]，score = 1 - distance（越大越相似）
        rows = (
            tbl.search(query_vec)
            .metric("cosine")
            .where(f"persona_id = '{persona_id}'", prefilter=True)
            .limit(k)
            .to_list()
        )
        return [
            VectorHit(
                text=r.get("text", ""),
                score=max(0.0, 1.0 - float(r.get("_distance", 1.0))),
                created_at=r.get("created_at", ""),
            )
            for r in rows
        ]

    def _delete_sync(self, persona_id: str) -> None:
        _check_id(persona_id)
        with self._lock:
            tbl = self._open_table()
            if tbl is not None:
                tbl.delete(f"persona_id = '{persona_id}'")
            pending = self._read_pending()
            if pending:
                self._write_pending([r for r in pending if r.get("persona_id") != persona_id])

    def _status_sync(self) -> dict:
        cfg = get_model_config()
        with self._lock:
            stale = (not self._rebuilding) and self._is_stale(cfg)
            meta = self._read_meta()
            return {
                "count": self._count_rows(),
                "pending": len(self._read_pending()),
                "stale": stale or self._rebuilding,
                "built_with": (meta or {}).get("signature"),
                "dim": (meta or {}).get("dim"),
                "current": cfg.embedding_signature(),
                "rebuild": dict(self.rebuild_state),
            }

    def _snapshot_for_rebuild(self) -> tuple[list[dict], int]:
        with self._lock:
            self._rebuilding = True
            rows: list[dict] = []
            tbl = self._open_table()
            if tbl is not None and tbl.count_rows() > 0:
                rows = (
                    tbl.to_arrow().select(["persona_id", "text", "created_at"]).to_pylist()
                )
            pending = self._read_pending()
            return rows + pending, len(pending)

    def _commit_rebuild(
        self, rows: list[dict], vecs: list[list[float]], n_pending: int, cfg: ModelConfig
    ) -> None:
        with self._lock:
            if rows:
                dim = len(vecs[0])
                data = [
                    {**r, "vector": v} for r, v in zip(rows, vecs, strict=True)
                ]
                self._table = self._conn().create_table(
                    TABLE, data=data, schema=self._schema(dim), mode="overwrite"
                )
                self._write_meta({"signature": cfg.embedding_signature(), "dim": dim})
            else:
                self._drop_table()
                self._meta_path.unlink(missing_ok=True)
            # 去掉已纳入本次重建的暂存；重建期间新写入的暂存保留，稍后补写
            self._write_pending(self._read_pending()[n_pending:])
            self._rebuilding = False

    # ---------------- 异步对外接口 ----------------

    async def append(self, persona_id: str, items: list[tuple[str, list[float]]]) -> int:
        return await asyncio.to_thread(self._append_sync, persona_id, items)

    async def upsert(self, persona_id: str, items: list[tuple[str, list[float]]]) -> int:
        return await asyncio.to_thread(self._upsert_sync, persona_id, items)

    async def search(self, persona_id: str, query_vec: list[float], k: int = 5) -> list[VectorHit]:
        return await asyncio.to_thread(self._search_sync, persona_id, query_vec, k)

    async def delete_by_persona(self, persona_id: str) -> None:
        await asyncio.to_thread(self._delete_sync, persona_id)

    async def status(self) -> dict:
        return await asyncio.to_thread(self._status_sync)

    async def rebuild(
        self, embed: Callable[[list[str], ModelConfig], Awaitable[list[list[float]]]]
    ) -> None:
        """用当前向量设置重建全部记忆。失败时旧索引保持不变，错误写入 rebuild_state。"""
        if self.rebuild_state.get("running"):
            return
        cfg = get_model_config()
        self.rebuild_state = {"running": True, "done": 0, "total": 0, "error": ""}
        rows: list[dict] = []
        try:
            rows, n_pending = await asyncio.to_thread(self._snapshot_for_rebuild)
            self.rebuild_state["total"] = len(rows)
            vecs: list[list[float]] = []
            for i in range(0, len(rows), REBUILD_CHUNK):
                chunk = rows[i : i + REBUILD_CHUNK]
                vecs.extend(await embed([r["text"] for r in chunk], cfg))
                self.rebuild_state["done"] = len(vecs)
            if vecs and any(len(v) != len(vecs[0]) for v in vecs):
                raise ValueError("向量维度不一致，请检查向量模型设置")
            await asyncio.to_thread(self._commit_rebuild, rows, vecs, n_pending, cfg)
            # 重建期间暂存的新记忆：用新模型补写
            leftover = await asyncio.to_thread(self._read_pending)
            if leftover:
                await asyncio.to_thread(self._write_pending, [])
                by_persona: dict[str, list[str]] = {}
                for r in leftover:
                    by_persona.setdefault(r["persona_id"], []).append(r["text"])
                for pid, texts in by_persona.items():
                    pv = await embed(texts, cfg)
                    await self.append(pid, list(zip(texts, pv)))
            self.rebuild_state["running"] = False
            print(f"[memory] rebuilt {len(rows)} memories with {cfg.embedding_model}", flush=True)
        except Exception as exc:  # noqa: BLE001
            with self._lock:
                self._rebuilding = False
            self.rebuild_state.update(running=False, error=f"{type(exc).__name__}: {str(exc)[:300]}")
            print(f"[memory] rebuild failed: {exc!r}", flush=True)


_store: LanceDBVectorStore | None = None


def get_vector_store() -> LanceDBVectorStore:
    global _store
    if _store is None:
        _store = LanceDBVectorStore(lancedb_dir_path())
    return _store
