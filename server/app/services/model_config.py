"""模型配置：各角色使用哪个模型、接口地址与生成参数，运行时可改并持久化。

火山方舟的模型版本会更新下线，模型 ID 不能写死在代码 / .env 里：
用户在设置页修改后立即生效，保存在数据目录的 model_settings.json（与数据库同目录，
开发态与安装版各自独立）。.env / 环境变量只提供首次运行时的默认值。

角色划分：
- roleplay   主视角扮演「对方」
- analyst    第三视角分析师、画像生成
- utility    辅助任务：输入分类、对话整理、观察提炼（量大、要求低，适合便宜快速的模型）
- embedding  向量记忆
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.config import db_file_path, get_settings

EmbeddingApi = Literal["auto", "multimodal", "text"]

RECENT_MAX = 12


class ModelConfig(BaseModel):
    base_url: str
    roleplay_model: str
    analyst_model: str
    utility_model: str
    embedding_model: str
    # auto：模型名含 vision 走多模态端点 /embeddings/multimodal，否则走文本端点 /embeddings
    embedding_api: EmbeddingApi = "auto"
    # 请求的输出维度；None 表示用模型默认维度（部分文本向量模型不支持 dimensions 参数）
    embedding_dimensions: int | None = None
    roleplay_temperature: float = Field(default=0.9, ge=0.0, le=2.0)
    analyst_temperature: float = Field(default=0.6, ge=0.0, le=2.0)
    # 用过的模型 ID，供设置页下拉建议
    recent_models: list[str] = Field(default_factory=list)

    @field_validator("base_url")
    @classmethod
    def _url(cls, v: str) -> str:
        v = v.strip().rstrip("/")
        if not (v.startswith("https://") or v.startswith("http://")):
            raise ValueError("必须以 http:// 或 https:// 开头")
        return v

    @field_validator("roleplay_model", "analyst_model", "utility_model", "embedding_model")
    @classmethod
    def _model_id(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("不能为空")
        if len(v) > 200 or any(c.isspace() for c in v):
            raise ValueError("格式不正确（不能包含空格）")
        return v

    @field_validator("embedding_dimensions")
    @classmethod
    def _dims(cls, v: int | None) -> int | None:
        if v is None or v == 0:
            return None
        if not 64 <= v <= 8192:
            raise ValueError("应在 64 ~ 8192 之间，或留空使用模型默认")
        return v

    def resolved_embedding_api(self) -> Literal["multimodal", "text"]:
        if self.embedding_api != "auto":
            return self.embedding_api
        return "multimodal" if "vision" in self.embedding_model.lower() else "text"

    def embedding_signature(self) -> dict:
        """决定向量是否可比的要素：变了就必须重建记忆库。"""
        return {
            "model": self.embedding_model,
            "api": self.resolved_embedding_api(),
            "dimensions": self.embedding_dimensions,
        }


class ModelConfigPatch(BaseModel):
    base_url: str | None = None
    roleplay_model: str | None = None
    analyst_model: str | None = None
    utility_model: str | None = None
    embedding_model: str | None = None
    embedding_api: EmbeddingApi | None = None
    embedding_dimensions: int | None = None
    # embedding_dimensions 显式置空（用模型默认维度）时传 true
    clear_embedding_dimensions: bool = False
    roleplay_temperature: float | None = None
    analyst_temperature: float | None = None


def defaults() -> ModelConfig:
    """出厂默认值：来自 .env / 环境变量（未配置时用 config.py 内置值）。"""
    s = get_settings()
    return ModelConfig(
        base_url=s.ark_base_url,
        roleplay_model=s.roleplay_model_lite,
        analyst_model=s.analyst_model,
        utility_model=s.chat_model,
        embedding_model=s.embedding_model,
        embedding_api="auto",
        embedding_dimensions=s.embedding_dim or None,
    )


def suggested_models() -> list[str]:
    """内置建议：出厂配置里出现过的模型 ID。"""
    s = get_settings()
    seen: list[str] = []
    for m in (
        s.roleplay_model_lite,
        s.roleplay_model_character,
        s.analyst_model,
        s.chat_model,
    ):
        if m and m not in seen:
            seen.append(m)
    return seen


def _path() -> Path:
    return db_file_path().parent / "model_settings.json"


_lock = threading.Lock()
_cache: ModelConfig | None = None


def get_model_config() -> ModelConfig:
    global _cache
    with _lock:
        if _cache is None:
            _cache = _load()
        return _cache


def _load() -> ModelConfig:
    base = defaults()
    path = _path()
    if not path.exists():
        return base
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        # 与默认值合并：新版本增加的字段用默认值补齐；单个字段非法则丢弃该字段
        merged = base.model_dump()
        for k, v in data.items():
            if k in merged:
                try:
                    ModelConfig(**{**merged, k: v})
                    merged[k] = v
                except Exception:  # noqa: BLE001
                    print(f"[models] ignore invalid saved field {k}={v!r}", flush=True)
        return ModelConfig(**merged)
    except Exception as exc:  # noqa: BLE001 - 配置文件损坏时回退默认，不让服务起不来
        print(f"[models] failed to load {path}: {exc!r}", flush=True)
        return base


def _save(cfg: ModelConfig) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)  # 原子替换，写一半崩溃也不会留下残缺文件


def update_model_config(patch: ModelConfigPatch) -> ModelConfig:
    """校验并保存；非法值抛 ValueError（pydantic ValidationError 是其子类）。"""
    global _cache
    with _lock:
        current = _cache or _load()
        data = current.model_dump()
        for k, v in patch.model_dump(exclude={"clear_embedding_dimensions"}).items():
            if v is not None:
                data[k] = v
        if patch.clear_embedding_dimensions:
            data["embedding_dimensions"] = None
        cfg = ModelConfig(**data)
        recent = [
            m for m in (cfg.roleplay_model, cfg.analyst_model, cfg.utility_model)
            if m
        ] + [m for m in current.recent_models]
        dedup: list[str] = []
        for m in recent:
            if m not in dedup:
                dedup.append(m)
        cfg.recent_models = dedup[:RECENT_MAX]
        _save(cfg)
        _cache = cfg
        return cfg


def reset_cache_for_tests() -> None:
    global _cache
    with _lock:
        _cache = None
