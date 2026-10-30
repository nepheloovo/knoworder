from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any
from uuid import uuid4

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, LargeBinary, String, Table, Text, UniqueConstraint
from sqlalchemy import JSON as SAJSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base, EmbeddingVector
from .tenancy import DEFAULT_SCOPE, current_workspace_id


DEFAULT_WORKSPACE_ID = DEFAULT_SCOPE
DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001"


def new_id() -> str:
    return str(uuid4())


def utc_now() -> datetime:
    return datetime.now(UTC)


class ProviderName(StrEnum):
    OPENROUTER = "openrouter"
    AIHUBMIX = "aihubmix"
    DEEPSEEK = "deepseek"
    TONGYI = "tongyi"
    MOCK = "mock"


class ModelType(StrEnum):
    LLM = "llm"
    EMBEDDING = "embedding"
    RERANK = "rerank"
    OCR = "ocr"


class ConnectionStatus(StrEnum):
    UNTESTED = "untested"
    CONNECTED = "connected"
    ERROR = "error"
    MOCK = "mock"


class JobStatus(StrEnum):
    QUEUED = "queued"
    UPLOADING = "uploading"
    PARSING = "parsing"
    CHUNKING = "chunking"
    INDEXING = "indexing"
    COMPLETED = "completed"
    FAILED = "failed"


class RunStatus(StrEnum):
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"


class ChunkMethod(StrEnum):
    RECURSIVE = "recursive"
    HEADING = "heading"
    SEPARATOR = "separator"
    FIXED = "fixed"
    PARENT_CHILD = "parent_child"
    SEMANTIC = "semantic"
    PAGE = "page"
    TABLE_ROW = "table_row"
    QA = "qa"


class AppScenario(StrEnum):
    QA = "qa"
    REPORT = "report"
    CONTENT = "content"
    REVIEW = "review"
    CUSTOMER_SERVICE = "customer_service"


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, onupdate=utc_now, nullable=False)


class WorkspaceMixin:
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="CASCADE"), default=current_workspace_id, nullable=False, index=True
    )


class ModelConfig(Base, TimestampMixin, WorkspaceMixin):
    __tablename__ = "model_configs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    provider: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    model_type: Mapped[str] = mapped_column(String(24), nullable=False, index=True)
    model_name: Mapped[str] = mapped_column(String(180), nullable=False)
    base_url: Mapped[str] = mapped_column(String(500), nullable=False)
    api_key_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    connection_status: Mapped[str] = mapped_column(String(24), default=ConnectionStatus.UNTESTED, nullable=False)
    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    config: Mapped[dict[str, Any]] = mapped_column(SAJSON, default=dict, nullable=False)


class KnowledgeBase(Base, TimestampMixin, WorkspaceMixin):
    __tablename__ = "knowledge_bases"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(180), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    embedding_model_id: Mapped[str | None] = mapped_column(ForeignKey("model_configs.id", ondelete="SET NULL"), nullable=True)
    rerank_model_id: Mapped[str | None] = mapped_column(ForeignKey("model_configs.id", ondelete="SET NULL"), nullable=True)
    ocr_model_id: Mapped[str | None] = mapped_column(ForeignKey("model_configs.id", ondelete="SET NULL"), nullable=True)
    embedding_dimension: Mapped[int | None] = mapped_column(Integer, nullable=True)
    chunk_size: Mapped[int] = mapped_column(Integer, default=800, nullable=False)
    chunk_overlap: Mapped[int] = mapped_column(Integer, default=120, nullable=False)
    chunk_method: Mapped[str] = mapped_column(String(32), default=ChunkMethod.RECURSIVE, nullable=False)
    parent_chunk_size: Mapped[int] = mapped_column(Integer, default=1600, nullable=False)
    child_chunk_size: Mapped[int] = mapped_column(Integer, default=400, nullable=False)
    semantic_llm_model_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_configs.id", ondelete="SET NULL"), nullable=True
    )
    metadata_llm_model_id: Mapped[str | None] = mapped_column(
        ForeignKey("model_configs.id", ondelete="SET NULL"), nullable=True
    )

    embedding_model: Mapped[ModelConfig | None] = relationship(foreign_keys=[embedding_model_id])
    rerank_model: Mapped[ModelConfig | None] = relationship(foreign_keys=[rerank_model_id])
    ocr_model: Mapped[ModelConfig | None] = relationship(foreign_keys=[ocr_model_id])
    semantic_llm_model: Mapped[ModelConfig | None] = relationship(foreign_keys=[semantic_llm_model_id])
    metadata_llm_model: Mapped[ModelConfig | None] = relationship(foreign_keys=[metadata_llm_model_id])
    files: Mapped[list[KnowledgeFile]] = relationship(back_populates="knowledge_base", cascade="all, delete-orphan")
    chunks: Mapped[list[DocumentChunk]] = relationship(back_populates="knowledge_base", cascade="all, delete-orphan")


class KnowledgeFile(Base, TimestampMixin):
    __tablename__ = "knowledge_files"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    knowledge_base_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id", ondelete="CASCADE"), nullable=False, index=True)
    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    content_type: Mapped[str] = mapped_column(String(160), nullable=False)
    extension: Mapped[str] = mapped_column(String(24), nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    storage_key: Mapped[str] = mapped_column(String(700), nullable=False, unique=True)
    checksum_sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(24), default=JobStatus.QUEUED, nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    chunk_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    chunk_config: Mapped[dict[str, Any]] = mapped_column(SAJSON, default=dict, nullable=False)
    document_metadata: Mapped[dict[str, Any]] = mapped_column(SAJSON, default=dict, nullable=False)

    knowledge_base: Mapped[KnowledgeBase] = relationship(back_populates="files")
    chunks: Mapped[list[DocumentChunk]] = relationship(back_populates="file", cascade="all, delete-orphan")
    jobs: Mapped[list[ImportJob]] = relationship(back_populates="file", cascade="all, delete-orphan")


class ImportJob(Base, TimestampMixin):
    __tablename__ = "import_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    file_id: Mapped[str] = mapped_column(ForeignKey("knowledge_files.id", ondelete="CASCADE"), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(24), default=JobStatus.QUEUED, nullable=False)
    progress: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    current_stage: Mapped[str] = mapped_column(String(80), default="queued", nullable=False)
    stage_details: Mapped[list[dict[str, Any]]] = mapped_column(SAJSON, default=list, nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    file: Mapped[KnowledgeFile] = relationship(back_populates="jobs")


class DocumentChunk(Base, TimestampMixin):
    __tablename__ = "document_chunks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    knowledge_base_id: Mapped[str] = mapped_column(ForeignKey("knowledge_bases.id", ondelete="CASCADE"), nullable=False, index=True)
    file_id: Mapped[str] = mapped_column(ForeignKey("knowledge_files.id", ondelete="CASCADE"), nullable=False, index=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    page_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    char_count: Mapped[int] = mapped_column(Integer, nullable=False)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(SAJSON, default=dict, nullable=False)
    embedding: Mapped[list[float] | None] = mapped_column(EmbeddingVector(), nullable=True)

    knowledge_base: Mapped[KnowledgeBase] = relationship(back_populates="chunks")
    file: Mapped[KnowledgeFile] = relationship(back_populates="chunks")


app_knowledge_bases = Table(
    "app_knowledge_bases",
    Base.metadata,
    Column("app_id", String(36), ForeignKey("qa_apps.id", ondelete="CASCADE"), primary_key=True),
    Column("knowledge_base_id", String(36), ForeignKey("knowledge_bases.id", ondelete="CASCADE"), primary_key=True),
)


class QAApp(Base, TimestampMixin, WorkspaceMixin):
    __tablename__ = "qa_apps"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(180), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    scenario_type: Mapped[str] = mapped_column(String(32), default=AppScenario.QA, nullable=False)
    system_prompt: Mapped[str] = mapped_column(Text, nullable=False)
    llm_model_id: Mapped[str | None] = mapped_column(ForeignKey("model_configs.id", ondelete="SET NULL"), nullable=True)
    top_k: Mapped[int] = mapped_column(Integer, default=8, nullable=False)
    rerank_top_n: Mapped[int] = mapped_column(Integer, default=3, nullable=False)
    score_threshold: Mapped[float] = mapped_column(Float, default=0.35, nullable=False)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    draft_manifest: Mapped[dict[str, Any]] = mapped_column(SAJSON, default=dict, nullable=False)
    published_version_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="draft", nullable=False)

    llm_model: Mapped[ModelConfig | None] = relationship()
    knowledge_bases: Mapped[list[KnowledgeBase]] = relationship(secondary=app_knowledge_bases)
    versions: Mapped[list[AppVersion]] = relationship(back_populates="app", cascade="all, delete-orphan")


class Conversation(Base, TimestampMixin, WorkspaceMixin):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    app_id: Mapped[str] = mapped_column(ForeignKey("qa_apps.id", ondelete="CASCADE"), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(240), default="新对话", nullable=False)
    demo_role: Mapped[str] = mapped_column(String(32), default="user", nullable=False)
    user_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    app: Mapped[QAApp] = relationship()
    messages: Mapped[list[Message]] = relationship(back_populates="conversation", cascade="all, delete-orphan")


class Message(Base, TimestampMixin):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(24), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    citations: Mapped[list[dict[str, Any]]] = mapped_column(SAJSON, default=list, nullable=False)
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    simulated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    input_values: Mapped[dict[str, Any]] = mapped_column(SAJSON, default=dict, nullable=False)
    output_json: Mapped[dict[str, Any] | list[Any] | None] = mapped_column(SAJSON, nullable=True)
    app_version_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    conversation: Mapped[Conversation] = relationship(back_populates="messages")


class QueryLog(Base, WorkspaceMixin):
    __tablename__ = "query_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    trace_id: Mapped[str] = mapped_column(String(36), default=new_id, unique=True, nullable=False, index=True)
    app_id: Mapped[str | None] = mapped_column(ForeignKey("qa_apps.id", ondelete="SET NULL"), nullable=True)
    conversation_id: Mapped[str | None] = mapped_column(ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True)
    demo_role: Mapped[str] = mapped_column(String(32), nullable=False)
    query: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(24), default=RunStatus.RUNNING, nullable=False, index=True)
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # 可观测字段：一次运行对应的版本、渠道、模型、费用与回答消息
    app_version_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    channel: Mapped[str] = mapped_column(String(24), default="web", nullable=False, index=True)
    model_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    model_name: Mapped[str | None] = mapped_column(String(180), nullable=True)
    cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    message_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    run_metadata: Mapped[dict[str, Any]] = mapped_column(SAJSON, default=dict, nullable=False)
    traces: Mapped[list[TraceStep]] = relationship(back_populates="query_log", cascade="all, delete-orphan", order_by="TraceStep.ordinal")


class TraceStep(Base):
    __tablename__ = "trace_steps"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    query_log_id: Mapped[str] = mapped_column(ForeignKey("query_logs.id", ondelete="CASCADE"), nullable=False, index=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    status: Mapped[str] = mapped_column(String(24), nullable=False)
    duration_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    detail: Mapped[str] = mapped_column(Text, default="", nullable=False)
    metadata_json: Mapped[dict[str, Any]] = mapped_column(SAJSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    query_log: Mapped[QueryLog] = relationship(back_populates="traces")


class Workspace(Base, TimestampMixin):
    __tablename__ = "workspaces"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    slug: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String(120), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(512), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class Membership(Base, TimestampMixin):
    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("workspace_id", "user_id", name="uq_membership_workspace_user"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(24), default="user", nullable=False)


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)


class ApiClient(Base, TimestampMixin):
    __tablename__ = "api_clients"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    role: Mapped[str] = mapped_column(String(24), default="manager", nullable=False)
    scopes: Mapped[list[str]] = mapped_column(SAJSON, default=list, nullable=False)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AppVersion(Base):
    __tablename__ = "app_versions"
    __table_args__ = (UniqueConstraint("app_id", "version", name="uq_app_version_number"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    app_id: Mapped[str] = mapped_column(ForeignKey("qa_apps.id", ondelete="CASCADE"), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    manifest: Mapped[dict[str, Any]] = mapped_column(SAJSON, nullable=False)
    release_notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)
    app: Mapped[QAApp] = relationship(back_populates="versions")


class AppShare(Base, TimestampMixin):
    __tablename__ = "app_shares"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    app_id: Mapped[str] = mapped_column(ForeignKey("qa_apps.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), default="公开分享", nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    max_uses: Mapped[int | None] = mapped_column(Integer, nullable=True)
    use_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class EvaluationSuite(Base, TimestampMixin):
    __tablename__ = "evaluation_suites"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    app_id: Mapped[str] = mapped_column(ForeignKey("qa_apps.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(180), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    is_release_gate: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # LLM 评委：{"model_id", "rubric", "pass_score"}；model_id 为空表示只按规则判定
    judge_config: Mapped[dict[str, Any]] = mapped_column(SAJSON, default=dict, nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    cases: Mapped[list[EvaluationCase]] = relationship(back_populates="suite", cascade="all, delete-orphan")


class EvaluationCase(Base, TimestampMixin):
    __tablename__ = "evaluation_cases"
    __table_args__ = (
        UniqueConstraint("suite_id", "source_trace_id", name="uq_evaluation_case_suite_source_trace"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    suite_id: Mapped[str] = mapped_column(ForeignKey("evaluation_suites.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(180), nullable=False)
    input_values: Mapped[dict[str, Any]] = mapped_column(SAJSON, default=dict, nullable=False)
    message: Mapped[str] = mapped_column(Text, default="", nullable=False)
    expected_keywords: Mapped[list[str]] = mapped_column(SAJSON, default=list, nullable=False)
    forbidden_keywords: Mapped[list[str]] = mapped_column(SAJSON, default=list, nullable=False)
    require_citations: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    case_type: Mapped[str] = mapped_column(String(16), default="manual", nullable=False, index=True)
    readiness: Mapped[str] = mapped_column(String(24), default="ready", nullable=False, index=True)
    actual_output: Mapped[str] = mapped_column(Text, default="", nullable=False)
    expected_output: Mapped[str] = mapped_column(Text, default="", nullable=False)
    tags: Mapped[list[str]] = mapped_column(SAJSON, default=list, nullable=False)
    source_log_id: Mapped[str | None] = mapped_column(
        ForeignKey("query_logs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    source_trace_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    source_conversation_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    source_snapshot: Mapped[dict[str, Any]] = mapped_column(SAJSON, default=dict, nullable=False)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    suite: Mapped[EvaluationSuite] = relationship(back_populates="cases")


class EvaluationRun(Base, TimestampMixin):
    __tablename__ = "evaluation_runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    suite_id: Mapped[str] = mapped_column(ForeignKey("evaluation_suites.id", ondelete="CASCADE"), nullable=False, index=True)
    app_version_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    manifest_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(24), default=RunStatus.RUNNING, nullable=False)
    passed_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    failed_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    results: Mapped[list[dict[str, Any]]] = mapped_column(SAJSON, default=list, nullable=False)
    simulated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class Feedback(Base, TimestampMixin):
    __tablename__ = "feedback"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    message_id: Mapped[str] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    rating: Mapped[int] = mapped_column(Integer, nullable=False)
    comment: Mapped[str] = mapped_column(Text, default="", nullable=False)


class ToolConfig(Base, TimestampMixin, WorkspaceMixin):
    __tablename__ = "tool_configs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    config: Mapped[dict[str, Any]] = mapped_column(SAJSON, default=dict, nullable=False)
    secret_encrypted: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    connection_status: Mapped[str] = mapped_column(String(24), default=ConnectionStatus.UNTESTED, nullable=False)
    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    actor_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    action: Mapped[str] = mapped_column(String(120), nullable=False)
    resource_type: Mapped[str] = mapped_column(String(80), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(36), nullable=False)
    detail: Mapped[dict[str, Any]] = mapped_column(SAJSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utc_now, nullable=False)

