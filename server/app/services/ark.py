"""火山方舟（Ark）调用封装。

所有调用都收敛在这一层，上层只依赖这里的函数，
后续接入分析师 / 角色扮演 / Embedding 时都在此扩展。
"""

import asyncio

import httpx
from volcenginesdkarkruntime import Ark

from app.config import get_settings


def _build_client(api_key: str) -> Ark:
    settings = get_settings()
    return Ark(
        api_key=api_key,
        base_url=settings.ark_base_url,
        timeout=30.0,
    )


def verify_connection(api_key: str, model: str | None = None) -> tuple[bool, str | None]:
    """用一次最小成本的对话调用验证 Key 是否可用。

    返回 (是否成功, 失败原因)。失败原因只含异常类型与消息，
    SDK 错误体中不含 Key 本身；任何异常都不向上抛。
    """
    settings = get_settings()
    target_model = model or settings.chat_model
    if not api_key:
        return False, "未配置 API Key"

    client = _build_client(api_key)
    try:
        completion = client.chat.completions.create(
            model=target_model,
            messages=[{"role": "user", "content": "ping"}],
            max_tokens=1,
        )
    except Exception as exc:  # noqa: BLE001 - 连接测试需要兜住所有错误并回传给界面
        return False, f"{type(exc).__name__}: {exc}"
    finally:
        client.close()

    if not completion.choices:
        return False, "模型返回为空，请检查模型 ID 是否已开通"
    return True, None


def mask_key(key: str) -> str:
    """生成掩码展示，如 6dce...dc1d；空值返回空串。"""
    if not key:
        return ""
    if len(key) <= 8:
        return "*" * len(key)
    return f"{key[:4]}...{key[-4:]}"


async def embed_texts(api_key: str, texts: list[str]) -> list[list[float]]:
    """批量文本嵌入，返回与输入同序的向量列表。

    doubao-embedding-vision 走「多模态向量化」端点 /embeddings/multimodal
    （而非文本端点 /embeddings），每次请求把所有 input 部分合并成单个向量，
    因此 N 条文本需 N 次请求；这里用信号量限流并发（默认 8）。
    纯文本输入格式：input=[{"type":"text","text":...}]。
    """
    if not texts:
        return []
    settings = get_settings()
    url = f"{settings.ark_base_url}/embeddings/multimodal"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    model = settings.embedding_model
    dim = settings.embedding_dim
    sem = asyncio.Semaphore(8)

    async def embed_one(client: httpx.AsyncClient, text: str) -> list[float]:
        body = {
            "model": model,
            "encoding_format": "float",
            # 强制输出维度与 config.embedding_dim 一致（251215 默认 2048，这里压成 1024）
            "dimensions": dim,
            # instructions 对齐「文本语义检索」场景；实测文档示例的
            # "Compress the text into one word" 区分度最佳（gap+0.076，排序正确）
            "instructions": (
                "Target_modality: text.\n"
                "Instruction:Compress the text into one word.\n"
                "Query:"
            ),
            "input": [{"type": "text", "text": text}],
        }
        async with sem:
            resp = await client.post(url, headers=headers, json=body, timeout=30.0)
            resp.raise_for_status()
            payload = resp.json()
        data = payload.get("data")
        # 多模态端点 data 通常是单个对象；文本端点是列表。两种都兜住。
        if isinstance(data, list) and data:
            emb = data[0].get("embedding")
        elif isinstance(data, dict):
            emb = data.get("embedding")
        else:
            emb = None
        return list(emb) if emb else [0.0] * dim

    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(*(embed_one(client, t) for t in texts))
    return [list(v) for v in results]

