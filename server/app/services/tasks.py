"""后台任务工具。

asyncio.create_task 返回的 Task 只被事件循环弱引用，若调用方不保存引用，
任务可能在执行途中被垃圾回收（官方文档明确警告）。这里统一持有强引用，
任务结束后自动释放，并把未捕获异常打到日志，避免「静默失败」。
"""

import asyncio
from collections.abc import Coroutine
from typing import Any

_background: set[asyncio.Task] = set()


def _on_done(task: asyncio.Task) -> None:
    _background.discard(task)
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        print(f"[task] background task failed: {exc!r}", flush=True)


def spawn(coro: Coroutine[Any, Any, Any]) -> asyncio.Task:
    """在当前事件循环挂一个后台任务，并保持强引用直到结束。"""
    task = asyncio.create_task(coro)
    _background.add(task)
    task.add_done_callback(_on_done)
    return task
