"""数据访问层。

- SQLite：结构化数据（人格、会话、消息）。
- LanceDB：向量记忆（见 services.vectorstore）。

业务层只依赖本模块的 CRUD 函数和 VectorStore 抽象，
不直接接触 SQLModel / LanceDB SDK，便于后续替换实现。
"""
