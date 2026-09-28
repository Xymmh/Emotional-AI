"""上下文组装工具：token 粗估与预算内历史收集。

不追求精确分词——本地估算只用于「决定带多少历史」，偏高一点更安全
（宁可少带几条，也不要挤爆模型上下文窗口）：
- 中日韩字符 ≈ 0.6 token/字
- 其他字符（ASCII/数字/符号）≈ 0.25 token/字符（约 4 字符 1 token）
"""

from __future__ import annotations

from typing import Any

# 每条消息的固定开销：role 标记、分隔符、对话模板包裹等
_PER_MESSAGE_OVERHEAD = 8


def _is_cjk(ch: str) -> bool:
    code = ord(ch)
    return (
        0x4E00 <= code <= 0x9FFF      # CJK 统一表意文字
        or 0x3400 <= code <= 0x4DBF   # 扩展 A
        or 0x3000 <= code <= 0x303F   # CJK 标点
        or 0xFF00 <= code <= 0xFFEF   # 全角形式
    )


def estimate_tokens(text: str) -> int:
    """粗略估算一段文本的 token 数。"""
    if not text:
        return 0
    cjk = sum(1 for ch in text if _is_cjk(ch))
    other = len(text) - cjk
    return max(1, int(cjk * 0.6 + other * 0.25))


def collect_history(messages: list[Any], budget_tokens: int) -> list[Any]:
    """在 token 预算内从最新往回收集历史消息，返回按时间正序的子集。

    - 最新一条永远保留（即使单独超预算，由上游 max_tokens / 服务端截断兜底）；
    - 更早的消息一旦装不下就整体停止，保证窗口内对话从头到尾完整连续，
      避免出现「半条上下文」导致的答非所问。
    """
    picked: list[Any] = []
    used = 0
    for m in reversed(messages):
        cost = estimate_tokens(getattr(m, "content", "")) + _PER_MESSAGE_OVERHEAD
        if picked and used + cost > budget_tokens:
            break
        picked.append(m)
        used += cost
    picked.reverse()
    return picked
