"""运行时状态：只在进程内存里持有当前生效的 API Key。

密钥的唯一持久化位置在 Electron 侧（safeStorage / Windows DPAPI）：
- 启动时来自环境变量（主进程注入或开发态 .env）；
- 用户在设置页保存后，主进程通过 /api/settings/runtime 推送新值，立即生效、无需重启。

模型选择等非敏感配置见 services/model_config.py（持久化在数据目录）。
"""

from threading import Lock

from app.config import Settings, get_settings


class RuntimeState:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._api_key: str | None = None
        self._lock = Lock()

    @property
    def api_key(self) -> str:
        with self._lock:
            return self._api_key if self._api_key is not None else self._settings.ark_api_key

    def update(self, api_key: str | None = None) -> None:
        with self._lock:
            if api_key is not None:
                self._api_key = api_key.strip()


state = RuntimeState(get_settings())
