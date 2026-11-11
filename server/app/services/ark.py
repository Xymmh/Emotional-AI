"""火山方舟（Ark）调用封装：连接测试、模型测试、文本向量化。

模型 ID / 接口地址统一取自 services.model_config（运行时可改），不在这里写死。
"""

import asyncio
import time

import httpx
from volcenginesdkarkruntime import AsyncArk

from app.services.model_config import ModelConfig, get_model_config

# 多模态向量模型的指令：对齐「文本语义检索」场景；实测文档示例的
# "Compress the text into one word" 区分度最佳（gap+0.076，排序正确）
_MULTIMODAL_INSTRUCTIONS = (
    "Target_modality: text.\n"
    "Instruction:Compress the text into one word.\n"
    "Query:"
)
_TEXT_BATCH = 16  # 文本端点一次请求可带多条输入


def mask_key(key: str) -> str:
    """生成掩码展示，如 6dce...dc1d；空值返回空串。"""
    if not key:
        return ""
    if len(key) <= 8:
        return "*" * len(key)
    return f"{key[:4]}...{key[-4:]}"


def _short_error(exc: Exception) -> str:
    """把 SDK / HTTP 异常压成一句可读的话（错误体里不含 Key）。"""
    if isinstance(exc, httpx.HTTPStatusError):
        body = exc.response.text[:300]
        return f"HTTP {exc.response.status_code}：{body}"
    msg = str(exc)
    return f"{type(exc).__name__}: {msg[:300]}"


async def test_chat_model(api_key: str, model: str, base_url: str) -> tuple[bool, str, int]:
    """用一次极小的对话调用测试模型是否可用。返回 (成功, 说明, 耗时毫秒)。"""
    if not api_key:
        return False, "未配置 API Key", 0
    client = AsyncArk(api_key=api_key, base_url=base_url, timeout=30.0)
    t0 = time.perf_counter()
    try:
        resp = await client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": "你好，回复一个字：好"}],
            max_tokens=16,
        )
    except Exception as exc:  # noqa: BLE001 - 测试需要兜住所有错误并回传给界面
        return False, _short_error(exc), int((time.perf_counter() - t0) * 1000)
    finally:
        await client.close()
    ms = int((time.perf_counter() - t0) * 1000)
    if not resp.choices:
        return False, "模型返回为空，请检查模型 ID 是否已开通", ms
    return True, "可用", ms


async def verify_connection(api_key: str) -> tuple[bool, str | None]:
    """用当前辅助模型验证 Key 是否可用。"""
    cfg = get_model_config()
    ok, msg, _ = await test_chat_model(api_key, cfg.utility_model, cfg.base_url)
    return ok, None if ok else msg


async def embed_texts(
    api_key: str, texts: list[str], cfg: ModelConfig | None = None
) -> list[list[float]]:
    """批量文本向量化，返回与输入同序的向量列表；任何一条失败都抛异常。

    - 多模态端点 /embeddings/multimodal（doubao-embedding-vision 系列）：
      每次请求把所有 input 合并成一个向量，因此 N 条文本要 N 次请求，信号量限流并发；
    - 文本端点 /embeddings（OpenAI 兼容格式）：一次请求可批量多条。
    """
    if not texts:
        return []
    cfg = cfg or get_model_config()
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    api = cfg.resolved_embedding_api()

    def check(vec: list | None) -> list[float]:
        # 不能用零向量兜底：零向量的余弦相似度是 NaN，写进库会污染后续检索
        if not vec:
            raise ValueError("向量接口未返回向量")
        if cfg.embedding_dimensions and len(vec) != cfg.embedding_dimensions:
            raise ValueError(f"向量维度应为 {cfg.embedding_dimensions}，实际 {len(vec)}")
        return [float(x) for x in vec]

    async with httpx.AsyncClient(timeout=60.0) as client:
        if api == "multimodal":
            url = f"{cfg.base_url}/embeddings/multimodal"
            sem = asyncio.Semaphore(8)

            async def one(text: str) -> list[float]:
                body: dict = {
                    "model": cfg.embedding_model,
                    "encoding_format": "float",
                    "instructions": _MULTIMODAL_INSTRUCTIONS,
                    "input": [{"type": "text", "text": text}],
                }
                if cfg.embedding_dimensions:
                    body["dimensions"] = cfg.embedding_dimensions
                async with sem:
                    resp = await client.post(url, headers=headers, json=body)
                    resp.raise_for_status()
                    data = resp.json().get("data")
                # 多模态端点 data 通常是单个对象；兼容列表形式
                if isinstance(data, list) and data:
                    return check(data[0].get("embedding"))
                if isinstance(data, dict):
                    return check(data.get("embedding"))
                return check(None)

            return list(await asyncio.gather(*(one(t) for t in texts)))

        url = f"{cfg.base_url}/embeddings"
        out: list[list[float]] = []
        for i in range(0, len(texts), _TEXT_BATCH):
            batch = texts[i : i + _TEXT_BATCH]
            body = {"model": cfg.embedding_model, "input": batch, "encoding_format": "float"}
            if cfg.embedding_dimensions:
                body["dimensions"] = cfg.embedding_dimensions
            resp = await client.post(url, headers=headers, json=body)
            resp.raise_for_status()
            data = resp.json().get("data") or []
            if len(data) != len(batch):
                raise ValueError(f"向量接口返回 {len(data)} 条，期望 {len(batch)} 条")
            data = sorted(data, key=lambda d: d.get("index", 0))
            out.extend(check(d.get("embedding")) for d in data)
        return out


async def test_embedding_model(api_key: str, cfg: ModelConfig) -> tuple[bool, str, int, int]:
    """测试向量模型：返回 (成功, 说明, 耗时毫秒, 实际维度)。"""
    if not api_key:
        return False, "未配置 API Key", 0, 0
    t0 = time.perf_counter()
    try:
        vecs = await embed_texts(api_key, ["周末要不要一起去看展？"], cfg)
    except Exception as exc:  # noqa: BLE001
        return False, _short_error(exc), int((time.perf_counter() - t0) * 1000), 0
    ms = int((time.perf_counter() - t0) * 1000)
    dim = len(vecs[0])
    return True, f"可用（{cfg.resolved_embedding_api()} 接口，{dim} 维）", ms, dim
