from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import JSON, MetaData, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.types import TypeDecorator

from .config import get_settings


NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class EmbeddingVector(TypeDecorator[list[float]]):
    """Use pgvector in PostgreSQL and JSON in SQLite tests."""

    impl = JSON
    cache_ok = True

    def load_dialect_impl(self, dialect: Any) -> Any:
        if dialect.name == "postgresql":
            return dialect.type_descriptor(Vector())
        # Persist Python None as SQL NULL so `IS NOT NULL` correctly means
        # "this chunk has an embedding" in SQLite development and tests.
        return dialect.type_descriptor(JSON(none_as_null=True))


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


def build_engine(database_url: str | None = None) -> AsyncEngine:
    url = database_url or get_settings().database_url
    connect_args: dict[str, Any] = {}
    if url.startswith("sqlite"):
        connect_args["check_same_thread"] = False
    return create_async_engine(url, pool_pre_ping=True, connect_args=connect_args)


engine = build_engine()
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session


async def init_db(target_engine: AsyncEngine | None = None) -> None:
    active_engine = target_engine or engine
    if active_engine.dialect.name == "sqlite" and active_engine.url.database not in (None, "", ":memory:"):
        Path(active_engine.url.database).parent.mkdir(parents=True, exist_ok=True)
    async with active_engine.begin() as connection:
        if active_engine.dialect.name == "postgresql":
            await connection.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await connection.run_sync(Base.metadata.create_all)
        default_workspace = "00000000-0000-0000-0000-000000000001"
        additions: dict[str, dict[str, str]] = {
            "model_configs": {"workspace_id": f"VARCHAR(36) NOT NULL DEFAULT '{default_workspace}'"},
            "knowledge_bases": {
                "workspace_id": f"VARCHAR(36) NOT NULL DEFAULT '{default_workspace}'",
                "ocr_model_id": "VARCHAR(36) REFERENCES model_configs(id) ON DELETE SET NULL",
                "embedding_dimension": "INTEGER",
                "chunk_method": "VARCHAR(32) NOT NULL DEFAULT 'recursive'",
                "parent_chunk_size": "INTEGER NOT NULL DEFAULT 1600",
                "child_chunk_size": "INTEGER NOT NULL DEFAULT 400",
                "semantic_llm_model_id": "VARCHAR(36) REFERENCES model_configs(id) ON DELETE SET NULL",
                "metadata_llm_model_id": "VARCHAR(36) REFERENCES model_configs(id) ON DELETE SET NULL",
            },
            "knowledge_files": {"document_metadata": "JSON NOT NULL DEFAULT '{}'"},
            "qa_apps": {
                "workspace_id": f"VARCHAR(36) NOT NULL DEFAULT '{default_workspace}'",
                "scenario_type": "VARCHAR(32) NOT NULL DEFAULT 'qa'",
                "draft_manifest": "JSON NOT NULL DEFAULT '{}'",
                "published_version_id": "VARCHAR(36)",
                "status": "VARCHAR(24) NOT NULL DEFAULT 'draft'",
            },
            "conversations": {
                "workspace_id": f"VARCHAR(36) NOT NULL DEFAULT '{default_workspace}'",
                "user_id": "VARCHAR(36)",
            },
            "messages": {
                "simulated": "BOOLEAN NOT NULL DEFAULT FALSE",
                "input_values": "JSON NOT NULL DEFAULT '{}'",
                "output_json": "JSON",
                "app_version_id": "VARCHAR(36)",
            },
            "evaluation_suites": {"judge_config": "JSON NOT NULL DEFAULT '{}'"},
            "query_logs": {
                "workspace_id": f"VARCHAR(36) NOT NULL DEFAULT '{default_workspace}'",
                "app_version_id": "VARCHAR(36)",
                "channel": "VARCHAR(24) NOT NULL DEFAULT 'web'",
                "model_id": "VARCHAR(36)",
                "model_name": "VARCHAR(180)",
                "cost": "DOUBLE PRECISION",
                "message_id": "VARCHAR(36)",
                "run_metadata": "JSON NOT NULL DEFAULT '{}'",
            },
        }
        for table, columns in additions.items():
            if active_engine.dialect.name == "sqlite":
                existing = {str(column["name"]) for column in (await connection.execute(text(f"PRAGMA table_info({table})"))).mappings().all()}
                if not existing:
                    continue
                for column, definition in columns.items():
                    if column not in existing:
                        await connection.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {definition}"))
            else:
                for column, definition in columns.items():
                    await connection.execute(text(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {definition}"))


async def drop_db(target_engine: AsyncEngine | None = None) -> None:
    active_engine = target_engine or engine
    async with active_engine.begin() as connection:
        await connection.run_sync(Base.metadata.drop_all)

