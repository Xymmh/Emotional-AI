"""SQLite 引擎与表初始化。

SQLite 用内置 sqlite3 驱动，单文件、嵌入式，符合纯本地分发要求。
路径由 config.db_file_path() 决定（开发态 server/data，生产态主进程注入）。
"""

from collections.abc import Iterator

from sqlmodel import Session, SQLModel, create_engine

from app.config import db_file_path

# 模块级引擎：进程内单例，连接池复用。
_engine = None


def get_engine():
    global _engine
    if _engine is None:
        path = db_file_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False：FastAPI 多线程（asyncio.to_thread）会跨线程用同一引擎，
        # SQLite 的并发由其自身的写锁保证，单用户本地场景足够安全。
        _engine = create_engine(
            f"sqlite:///{path.as_posix()}",
            echo=False,
            connect_args={"check_same_thread": False},
        )
    return _engine


def init_db() -> None:
    """建表。应用启动时调用一次。"""
    # 导入以注册表的元数据
    from app.db import models  # noqa: F401

    SQLModel.metadata.create_all(get_engine())
    _migrate_schema()


def _migrate_schema() -> None:
    """轻量迁移：create_all 不会给已存在的表补列，这里按需 ALTER。

    SQLite 的 ALTER TABLE ADD COLUMN 是元数据操作，瞬间完成。
    """
    with get_engine().connect() as conn:
        cols = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(personas)")}
        if cols and "observations" not in cols:
            conn.exec_driver_sql(
                "ALTER TABLE personas ADD COLUMN observations TEXT NOT NULL DEFAULT ''"
            )
            conn.commit()


def get_session() -> Iterator[Session]:
    """供需要依赖注入的场景使用（本工程主要走 crud 同步函数 + to_thread）。"""
    with Session(get_engine()) as session:
        yield session
