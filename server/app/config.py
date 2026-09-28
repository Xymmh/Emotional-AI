"""应用配置。

开发环境：从 server/.env 读取（该文件已被 .gitignore 排除，不入库）。
生产环境：由 Electron 主进程以环境变量注入，打包后用户机器上不存在 .env 文件。
"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# 固定指向 server/.env，不受 uvicorn 启动时工作目录影响
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"

# 本地数据目录：开发态放在 server/data；生产态由主进程通过
# DB_PATH / LANCEDB_PATH 环境变量覆盖到 Electron userData。
DATA_DIR = Path(__file__).resolve().parent.parent / "data"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # 火山方舟
    ark_api_key: str = ""
    ark_base_url: str = "https://ark.cn-beijing.volces.com/api/v3"

    # 侧车访问令牌：所有 /api/* 接口都要携带 X-Sidecar-Token 头
    sidecar_token: str = ""

    # 模型 ID
    chat_model: str = "doubao-seed-2-0-lite-260428"
    analyst_model: str = "doubao-seed-2-0-lite-260428"
    roleplay_model_lite: str = "doubao-seed-2-0-lite-260428"
    roleplay_model_character: str = "doubao-seed-character"
    embedding_model: str = "doubao-embedding-vision-251215"
    embedding_dim: int = 1024

    # 本地存储路径：空值回退到 DATA_DIR 下默认位置
    db_path: str = ""
    lancedb_path: str = ""


def db_file_path() -> Path:
    """SQLite 文件绝对路径。"""
    s = get_settings()
    return Path(s.db_path) if s.db_path else DATA_DIR / "emotional_ai.db"


def lancedb_dir_path() -> Path:
    """LanceDB 数据目录绝对路径。"""
    s = get_settings()
    return Path(s.lancedb_path) if s.lancedb_path else DATA_DIR / "lancedb"


@lru_cache
def get_settings() -> Settings:
    return Settings()
