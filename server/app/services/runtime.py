"""运行时状态：保存前端在设置页提交、但不落盘到后端的临时覆盖值。

密钥的唯一持久化位置在 Electron 侧（safeStorage / Windows DPAPI）。
后端只在进程内存里持有当前生效的 key：
- 启动时来自环境变量（主进程注入或开发态 .env）；
- 用户在设置页保存后，主进程通过 /api/settings/runtime 推送新值，立即生效、无需重启。
"""

from threading import Lock

from app.config import Settings, get_settings


class RuntimeState:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._api_key: str | None = None
        self._roleplay_model: str | None = None
        self._lock = Lock()

    @property
    def api_key(self) -> str:
        with self._lock:
            return self._api_key if self._api_key is not None else self._settings.ark_api_key

    @property
    def roleplay_model(self) -> str:
        with self._lock:
            if self._roleplay_model is not None:
                return self._roleplay_model
            return self._settings.roleplay_model_lite

    def update(
        self,
        api_key: str | None = None,
        roleplay_model: str | None = None,
    ) -> None:
        with self._lock:
            if api_key is not None:
                self._api_key = api_key.strip()
            if roleplay_model is not None:
                self._roleplay_model = roleplay_model.strip()


state = RuntimeState(get_settings())
