from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# 默认路径写成 ./backend/... 是相对仓库根目录的；统一按仓库根目录解析，从哪个目录启动都指向同一份数据
PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="APP_",
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    env: Literal["development", "test", "production"] = "development"
    app_name: str = "知序 KnowOrder AI 应用中台"
    api_prefix: str = "/api/v1"
    bootstrap_admin_email: str = "admin@fde.local"
    bootstrap_admin_password: str = "fde-dev-admin"
    allowed_tool_hosts: list[str] = Field(default_factory=list)
    database_url: str = "sqlite+aiosqlite:///./backend/data/knowledge_hub.db"
    redis_url: str = "redis://127.0.0.1:57379/0"
    cors_origins: list[str] = Field(
        default_factory=lambda: [
            "http://127.0.0.1:4173",
            "http://127.0.0.1:4174",
            "http://localhost:4173",
            "http://localhost:4174",
        ]
    )
    auto_create_db: bool = True
    task_mode: Literal["inline", "celery"] = "inline"
    encryption_key: str = "development-only-change-me"

    storage_backend: Literal["local", "s3"] = "local"
    local_storage_path: Path = Path("./backend/data/uploads")
    s3_endpoint_url: str = "http://127.0.0.1:59000"
    s3_access_key: str = "rag-minio"
    s3_secret_key: str = "change-this-minio-secret"
    s3_bucket: str = "rag-documents"
    s3_region: str = "us-east-1"

    ocr_provider: Literal["disabled", "vision"] = "disabled"
    ocr_model_name: str = "qwen-vl-max"
    ocr_base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    ocr_api_key: str | None = None

    max_upload_bytes: int = 50 * 1024 * 1024
    default_chunk_size: int = 800
    default_chunk_overlap: int = 120
    embedding_batch_size: int = 64
    request_timeout_seconds: float = 45.0

    @field_validator("cors_origins", mode="before")
    @classmethod
    def split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [item.strip() for item in value.split(",") if item.strip()]
        return value

    @field_validator("database_url")
    @classmethod
    def anchor_sqlite_path(cls, value: str) -> str:
        prefix, sep, path = value.partition(":///")
        if not prefix.startswith("sqlite") or not sep or not path or path.startswith(":memory:") or Path(path).is_absolute():
            return value
        return f"{prefix}:///{(PROJECT_ROOT / path).resolve()}"

    @field_validator("local_storage_path")
    @classmethod
    def anchor_storage_path(cls, value: Path) -> Path:
        return value if value.is_absolute() else (PROJECT_ROOT / value).resolve()

    def assert_safe_for_production(self) -> None:
        if self.env != "production":
            return
        if self.encryption_key == "development-only-change-me":
            raise RuntimeError("APP_ENCRYPTION_KEY must be changed in production")
        if self.bootstrap_admin_password == "fde-dev-admin":
            raise RuntimeError("APP_BOOTSTRAP_ADMIN_PASSWORD must be changed in production")
        if self.auto_create_db:
            raise RuntimeError("APP_AUTO_CREATE_DB must be false in production; run Alembic migrations instead")
        if self.s3_secret_key == "change-this-minio-secret":
            raise RuntimeError("APP_S3_SECRET_KEY must be changed in production")


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.assert_safe_for_production()
    return settings

