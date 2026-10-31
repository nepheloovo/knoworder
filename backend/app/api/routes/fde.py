from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ...db import get_session
from ...fde import Manifest, list_templates, manifest_fingerprint, manifest_from_qa_app, validate_for_publish, validate_manifest
from ...fde.designer import DesignError, design_manifest
from ...fde.runtime import estimate_cost, execute_manifest
from ...models import (
    AppVersion,
    AppShare,
    AuditEvent,
    Conversation,
    DocumentChunk,
    EvaluationCase,
    EvaluationRun,
    EvaluationSuite,
    Feedback,
    KnowledgeBase,
    Message,
    ModelConfig,
    ModelType,
    QAApp,
    QueryLog,
    RunStatus,
    ToolConfig,
    TraceStep,
    utc_now,
)
from ...security import AuthContext, get_auth_context, hash_token, issue_token, require_roles

router = APIRouter()


class DesignRequest(BaseModel):
    brief: str = Field(min_length=4, max_length=12000)
    template_key: str = "content"
    llm_model_id: str | None = None
    base_manifest: dict[str, Any] | None = None


class ManifestRequest(BaseModel):
    manifest: dict[str, Any]


class AppCreateRequest(ManifestRequest):
    start_from_template: str | None = None


class VersionRequest(BaseModel):
    version_id: str | None = None


class VersionCreateRequest(BaseModel):
    release_notes: str = Field(default="", max_length=4000)


class ReleaseRequest(BaseModel):
    release_notes: str = Field(min_length=1, max_length=4000)


class RunRequest(BaseModel):
    message: str = Field(default="", max_length=12000)
    input_values: dict[str, Any] = Field(default_factory=dict)
    conversation_id: str | None = None
    confirmed_tool_names: list[str] = Field(default_factory=list, max_length=20)


class EvaluationCaseRequest(BaseModel):
    name: str = Field(min_length=1, max_length=180)
    message: str = Field(default="", max_length=12000)
    input_values: dict[str, Any] = Field(default_factory=dict)
    expected_keywords: list[str] = Field(default_factory=list, max_length=20)
    forbidden_keywords: list[str] = Field(default_factory=list, max_length=20)
    require_citations: bool = False


class EvaluationSuiteRequest(BaseModel):
    name: str = Field(default="默认发布验收", min_length=1, max_length=180)
    cases: list[EvaluationCaseRequest] = Field(min_length=1, max_length=100)


class FeedbackRequest(BaseModel):
    rating: Literal[-1, 1]
    comment: str = Field(default="", max_length=4000)


class ShareCreateRequest(BaseModel):
    name: str = Field(default="公开分享", min_length=1, max_length=120)
    expires_in_days: int | None = Field(default=30, ge=1, le=365)
    max_uses: int | None = Field(default=None, ge=1, le=1_000_000)


def _draft(app: QAApp) -> Manifest:
    return Manifest.model_validate(app.draft_manifest) if app.draft_manifest else manifest_from_qa_app(app)


def _parse_manifest(payload: dict[str, Any]) -> Manifest:
    try:
        return Manifest.model_validate(payload)
    except ValidationError as exc:
        issues = [{"path": ".".join(str(part) for part in error["loc"]) or "manifest", "message": error["msg"]} for error in exc.errors()]
        raise HTTPException(status_code=422, detail={"message": "应用配置不符合协议", "issues": issues}) from exc


async def _app(session: AsyncSession, app_id: str, workspace_id: str) -> QAApp:
    result = await session.scalars(
        select(QAApp)
        .where(QAApp.id == app_id, QAApp.workspace_id == workspace_id)
        .options(selectinload(QAApp.knowledge_bases), selectinload(QAApp.versions))
        # 同一请求里刚新增的版本不在已加载的 versions 集合中，必须刷新，否则发布响应里 published_version 为空
        .execution_options(populate_existing=True)
    )
    app = result.one_or_none()
    if not app:
        raise HTTPException(status_code=404, detail="应用不存在或不在当前业务空间")
    return app


async def _resource_ids(session: AsyncSession, workspace_id: str) -> tuple[set[str], set[str], set[str]]:
    models = set(await session.scalars(select(ModelConfig.id).where(ModelConfig.workspace_id == workspace_id, ModelConfig.model_type == ModelType.LLM, ModelConfig.is_enabled.is_(True))))
    knowledge = set(await session.scalars(select(KnowledgeBase.id).where(KnowledgeBase.workspace_id == workspace_id)))
    tools = set(await session.scalars(select(ToolConfig.id).where(ToolConfig.workspace_id == workspace_id, ToolConfig.is_enabled.is_(True))))
    return models, knowledge, tools


async def _audit(session: AsyncSession, context: AuthContext, action: str, app_id: str, detail: dict[str, Any] | None = None) -> None:
    session.add(AuditEvent(workspace_id=context.workspace_id, actor_id=context.user_id, action=action, resource_type="application", resource_id=app_id, detail=detail or {}))


def _version_payload(version: AppVersion) -> dict[str, Any]:
    return {"id": version.id, "version": version.version, "manifest": version.manifest, "release_notes": version.release_notes, "created_at": version.created_at}


def _app_payload(app: QAApp) -> dict[str, Any]:
    manifest = _draft(app)
    versions = sorted(app.versions, key=lambda item: item.version, reverse=True)
    return {
        "id": app.id,
        "name": app.name,
        "description": app.description,
        "scenario_type": app.scenario_type,
        "status": app.status,
        "is_enabled": app.is_enabled,
        "manifest": manifest.model_dump(mode="json"),
        "draft_manifest": manifest.model_dump(mode="json"),
        "published_version_id": app.published_version_id,
        "published_version": next((_version_payload(item) for item in versions if item.id == app.published_version_id), None),
        "versions": [_version_payload(item) for item in versions],
        "portal_path": f"/portal/apps/{app.id}",
        "created_at": app.created_at,
        "updated_at": app.updated_at,
    }


async def _save_manifest(session: AsyncSession, app: QAApp, manifest: Manifest) -> None:
    app.name = manifest.name
    app.description = manifest.description
    app.scenario_type = manifest.template_key
    app.system_prompt = manifest.system_prompt
    app.llm_model_id = manifest.llm_model_id
    app.draft_manifest = manifest.model_dump(mode="json")
    retrieval = next((item.config for item in manifest.tools if item.name == "knowledge_retrieval"), {})
    app.top_k = int(retrieval.get("top_k", app.top_k or 8))
    app.rerank_top_n = int(retrieval.get("rerank_top_n", app.rerank_top_n or 3))
    app.score_threshold = float(retrieval.get("score_threshold", app.score_threshold if app.score_threshold is not None else 0.35))
    if manifest.knowledge_base_ids:
        knowledge = list(await session.scalars(select(KnowledgeBase).where(KnowledgeBase.id.in_(manifest.knowledge_base_ids), KnowledgeBase.workspace_id == app.workspace_id)))
        if len(knowledge) != len(manifest.knowledge_base_ids):
            raise HTTPException(status_code=422, detail="包含不存在或跨空间的知识库")
        by_id = {item.id: item for item in knowledge}
        app.knowledge_bases = [by_id[item] for item in manifest.knowledge_base_ids]
    else:
        app.knowledge_bases = []


@router.get("/capabilities")
async def capabilities(_context: AuthContext = Depends(get_auth_context)) -> dict[str, Any]:
    return {
        "protocol": "fde.app/v2",
        "application_types": ["simple", "agent"],
        "workflow": ["discover", "design", "validate", "draft", "preview", "evaluate", "version", "publish", "run", "rollback"],
        "templates": [{"key": item.key, "name": item.name, "knowledge_bases": item.knowledge_bases.model_dump()} for item in list_templates()],
        "endpoints": {
            "design": "POST /api/v1/fde/design",
            "validate": "POST /api/v1/fde/validate",
            "create": "POST /api/v1/fde/apps",
            "preview": "POST /api/v1/fde/apps/{app_id}/preview",
            "evaluate": "POST /api/v1/fde/apps/{app_id}/evaluate",
            "publish": "POST /api/v1/fde/apps/{app_id}/publish",
            "run": "POST /api/v1/fde/apps/{app_id}/run",
        },
        "limits": {"external_http_tools": True, "agent_tool_loop": True, "chatflow": False, "streaming_fde_run": False, "evaluation_score": "binary"},
    }


@router.get("/templates")
async def templates(_context: AuthContext = Depends(get_auth_context)) -> list[dict[str, Any]]:
    return [item.model_dump(mode="json") for item in list_templates()]


@router.post("/validate")
async def validate(payload: ManifestRequest, context: AuthContext = Depends(get_auth_context), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    models, knowledge, tools = await _resource_ids(session, context.workspace_id)
    result = validate_manifest(payload.manifest, models, knowledge, tools)
    return result.model_dump()


@router.post("/design")
async def design(payload: DesignRequest, context: AuthContext = Depends(require_roles("admin", "manager")), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    model_id = payload.llm_model_id
    if not model_id:
        model_id = await session.scalar(select(ModelConfig.id).where(ModelConfig.workspace_id == context.workspace_id, ModelConfig.model_type == ModelType.LLM, ModelConfig.is_enabled.is_(True), ModelConfig.provider != "mock").limit(1))
    try:
        manifest, simulated = await design_manifest(session, brief=payload.brief, workspace_id=context.workspace_id, template_key=payload.template_key, llm_model_id=model_id, base_manifest=payload.base_manifest)
    except DesignError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    models, knowledge, tools = await _resource_ids(session, context.workspace_id)
    result = validate_manifest(manifest, models, knowledge, tools)
    return {"manifest": manifest.model_dump(mode="json"), "simulated": simulated, "issues": result.issues, "publish_ready": result.publish_ready}


@router.post("/apps", status_code=201)
async def create_app(payload: AppCreateRequest, context: AuthContext = Depends(require_roles("admin", "manager")), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    manifest = _parse_manifest(payload.manifest)
    app = QAApp(workspace_id=context.workspace_id, status="draft", is_enabled=False)
    await _save_manifest(session, app, manifest)
    session.add(app)
    await session.flush()
    await _audit(session, context, "application.created", app.id, {"template": manifest.template_key})
    await session.commit()
    return _app_payload(await _app(session, app.id, context.workspace_id))


@router.get("/workbench")
async def workbench(context: AuthContext = Depends(get_auth_context), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """工作台右栏：当前用户最近使用的对话，以及本业务空间本月的业务沉淀（不含编排调试运行）。"""
    now = datetime.now(UTC)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    live = (QueryLog.workspace_id == context.workspace_id, QueryLog.started_at >= month_start, QueryLog.channel != "debug")
    runs, apps_used = (await session.execute(select(func.count(QueryLog.id), func.count(func.distinct(QueryLog.app_id))).where(*live))).one()
    users = await session.scalar(
        select(func.count(func.distinct(Conversation.user_id))).join(QueryLog, QueryLog.conversation_id == Conversation.id).where(*live, Conversation.user_id.is_not(None))
    ) or 0
    chunks = await session.scalar(
        select(func.count(DocumentChunk.id)).join(KnowledgeBase, KnowledgeBase.id == DocumentChunk.knowledge_base_id)
        .where(KnowledgeBase.workspace_id == context.workspace_id, DocumentChunk.created_at >= month_start)
    ) or 0
    recent: list[dict[str, Any]] = []
    if context.user_id:
        rows = (
            await session.execute(
                select(Conversation.id, Conversation.title, Conversation.app_id, Conversation.updated_at, QAApp.name, QAApp.scenario_type)
                .join(QAApp, QAApp.id == Conversation.app_id)
                .where(Conversation.workspace_id == context.workspace_id, Conversation.user_id == context.user_id)
                .order_by(Conversation.updated_at.desc())
                .limit(6)
            )
        ).all()
        recent = [
            {"conversation_id": row.id, "title": row.title, "app_id": row.app_id, "app_name": row.name, "template_key": row.scenario_type, "updated_at": row.updated_at}
            for row in rows
        ]
    return {"month": {"runs": runs, "users": users, "apps": apps_used, "new_chunks": chunks}, "recent": recent}


@router.get("/apps")
async def list_apps(context: AuthContext = Depends(get_auth_context), session: AsyncSession = Depends(get_session)) -> list[dict[str, Any]]:
    query = (
        select(QAApp)
        .where(QAApp.workspace_id == context.workspace_id)
        .options(selectinload(QAApp.knowledge_bases), selectinload(QAApp.versions))
        .order_by(QAApp.updated_at.desc())
    )
    if context.role == "user":
        query = query.where(QAApp.is_enabled.is_(True), QAApp.published_version_id.is_not(None))
    apps = list(await session.scalars(query))
    if not apps:
        return []
    conversation_rows = await session.execute(
        select(Conversation.app_id, func.count(Conversation.id))
        .where(Conversation.app_id.in_([app.id for app in apps]))
        .group_by(Conversation.app_id)
    )
    conversation_counts = {app_id: count for app_id, count in conversation_rows.all()}
    return [
        {**_app_payload(app), "conversation_count": conversation_counts.get(app.id, 0)}
        for app in apps
    ]


@router.get("/apps/{app_id}")
async def get_app(app_id: str, context: AuthContext = Depends(get_auth_context), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    app = await _app(session, app_id, context.workspace_id)
    if context.role != "user":
        return _app_payload(app)
    # 业务使用者只能看到已发布版本，不暴露草稿与版本历史。
    if not app.is_enabled or not app.published_version_id:
        raise HTTPException(status_code=404, detail="应用尚未发布")
    payload = _app_payload(app)
    published = payload["published_version"]
    return {**payload, "manifest": published["manifest"], "draft_manifest": published["manifest"], "versions": [published]}


def _conversation_scope(context: AuthContext) -> list[Any]:
    filters: list[Any] = [Conversation.workspace_id == context.workspace_id]
    if context.role == "user" or context.user_id:
        filters.append(Conversation.user_id == context.user_id)
    return filters


@router.get("/apps/{app_id}/my-conversations")
async def my_conversations(app_id: str, context: AuthContext = Depends(get_auth_context), session: AsyncSession = Depends(get_session)) -> list[dict[str, Any]]:
    # 编排页调试产生的会话不出现在业务端历史中
    online = select(QueryLog.id).where(QueryLog.conversation_id == Conversation.id, QueryLog.channel != "debug").exists()
    rows = await session.scalars(
        select(Conversation).where(Conversation.app_id == app_id, online, *_conversation_scope(context)).order_by(Conversation.updated_at.desc()).limit(30)
    )
    return [{"id": item.id, "title": item.title, "updated_at": item.updated_at} for item in rows]


@router.get("/conversations/{conversation_id}")
async def my_conversation(conversation_id: str, context: AuthContext = Depends(get_auth_context), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    conversation = await session.scalar(select(Conversation).where(Conversation.id == conversation_id, *_conversation_scope(context)))
    if not conversation:
        raise HTTPException(status_code=404, detail="会话不存在")
    messages = list(await session.scalars(select(Message).where(Message.conversation_id == conversation.id).order_by(Message.created_at)))
    return {
        "id": conversation.id,
        "app_id": conversation.app_id,
        "title": conversation.title,
        "messages": [
            {"id": item.id, "role": item.role, "content": item.content, "citations": item.citations, "input_values": item.input_values, "created_at": item.created_at}
            for item in messages
        ],
    }


@router.post("/apps/{app_id}/duplicate", status_code=201)
async def duplicate_app(app_id: str, context: AuthContext = Depends(require_roles("admin", "manager")), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    source = await _app(session, app_id, context.workspace_id)
    manifest = _draft(source).model_copy(deep=True)
    manifest.name = f"{manifest.name}（副本）"
    duplicate = QAApp(workspace_id=context.workspace_id, status="draft", is_enabled=False)
    await _save_manifest(session, duplicate, manifest)
    session.add(duplicate)
    await session.flush()
    await _audit(session, context, "application.duplicated", duplicate.id, {"source_app_id": source.id})
    await session.commit()
    return _app_payload(await _app(session, duplicate.id, context.workspace_id))


@router.post("/apps/{app_id}/archive")
async def archive_app(app_id: str, context: AuthContext = Depends(require_roles("admin", "manager")), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    app = await _app(session, app_id, context.workspace_id)
    app.is_enabled = False
    app.status = "archived"
    await _audit(session, context, "application.archived", app.id)
    await session.commit()
    return _app_payload(await _app(session, app.id, context.workspace_id))


@router.post("/apps/{app_id}/restore")
async def restore_app(app_id: str, context: AuthContext = Depends(require_roles("admin", "manager")), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    app = await _app(session, app_id, context.workspace_id)
    if app.status != "archived":
        raise HTTPException(status_code=409, detail="只有已归档应用可以恢复")
    app.status = "draft"
    await _audit(session, context, "application.restored", app.id)
    await session.commit()
    return _app_payload(await _app(session, app.id, context.workspace_id))


@router.delete("/apps/{app_id}", status_code=204)
async def delete_app(app_id: str, context: AuthContext = Depends(require_roles("admin", "manager")), session: AsyncSession = Depends(get_session)) -> None:
    app = await _app(session, app_id, context.workspace_id)
    if app.is_enabled:
        raise HTTPException(status_code=409, detail="请先下线或归档应用，再永久删除")
    await _audit(session, context, "application.deleted", app.id, {"name": app.name})
    await session.delete(app)
    await session.commit()


@router.get("/apps/{app_id}/shares")
async def list_shares(app_id: str, context: AuthContext = Depends(require_roles("admin", "manager")), session: AsyncSession = Depends(get_session)) -> list[dict[str, Any]]:
    await _app(session, app_id, context.workspace_id)
    shares = list(await session.scalars(select(AppShare).where(AppShare.app_id == app_id).order_by(AppShare.created_at.desc())))
    return [{"id": item.id, "name": item.name, "expires_at": item.expires_at, "max_uses": item.max_uses, "use_count": item.use_count, "is_enabled": item.is_enabled, "created_at": item.created_at} for item in shares]


@router.post("/apps/{app_id}/shares", status_code=201)
async def create_share(app_id: str, payload: ShareCreateRequest, context: AuthContext = Depends(require_roles("admin", "manager")), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    app = await _app(session, app_id, context.workspace_id)
    if not app.is_enabled or not app.published_version_id:
        raise HTTPException(status_code=409, detail="应用发布后才能创建免登录分享链接")
    token = f"zss_{issue_token()}"
    share = AppShare(
        app_id=app.id,
        name=payload.name,
        token_hash=hash_token(token),
        expires_at=datetime.now(UTC) + timedelta(days=payload.expires_in_days) if payload.expires_in_days else None,
        max_uses=payload.max_uses,
    )
    session.add(share)
    await session.flush()
    await _audit(session, context, "application.share_created", app.id, {"share_id": share.id, "expires_at": share.expires_at.isoformat() if share.expires_at else None, "max_uses": share.max_uses})
    await session.commit()
    return {"id": share.id, "name": share.name, "token": token, "expires_at": share.expires_at, "max_uses": share.max_uses, "use_count": 0, "is_enabled": True, "created_at": share.created_at}


@router.delete("/apps/{app_id}/shares/{share_id}", status_code=204)
async def revoke_share(app_id: str, share_id: str, context: AuthContext = Depends(require_roles("admin", "manager")), session: AsyncSession = Depends(get_session)) -> None:
    app = await _app(session, app_id, context.workspace_id)
    share = await session.get(AppShare, share_id)
    if not share or share.app_id != app.id:
        raise HTTPException(status_code=404, detail="分享链接不存在")
    share.is_enabled = False
    await _audit(session, context, "application.share_revoked", app.id, {"share_id": share.id})
    await session.commit()


@router.put("/apps/{app_id}/manifest")
async def update_manifest(app_id: str, payload: ManifestRequest, context: AuthContext = Depends(require_roles("admin", "manager")), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    app = await _app(session, app_id, context.workspace_id)
    manifest = _parse_manifest(payload.manifest)
    await _save_manifest(session, app, manifest)
    app.status = "draft"
    await _audit(session, context, "application.draft_updated", app.id)
    await session.commit()
    return _app_payload(await _app(session, app.id, context.workspace_id))


@router.post("/apps/{app_id}/validate")
async def validate_app(app_id: str, context: AuthContext = Depends(get_auth_context), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    app = await _app(session, app_id, context.workspace_id)
    models, knowledge, tools = await _resource_ids(session, context.workspace_id)
    return validate_manifest(_draft(app), models, knowledge, tools).model_dump()


@router.post("/apps/{app_id}/versions", status_code=201)
async def create_version(app_id: str, payload: VersionCreateRequest | None = None, context: AuthContext = Depends(require_roles("admin", "manager")), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    app = await _app(session, app_id, context.workspace_id)
    models, knowledge, tools = await _resource_ids(session, context.workspace_id)
    validation = validate_for_publish(_draft(app), models, knowledge, tools)
    if not validation.valid:
        raise HTTPException(status_code=422, detail={"message": "草稿校验未通过", "issues": [item.model_dump() for item in validation.issues]})
    number = (await session.scalar(select(func.max(AppVersion.version)).where(AppVersion.app_id == app.id))) or 0
    version = AppVersion(app_id=app.id, version=number + 1, manifest=_draft(app).model_dump(mode="json"), release_notes=payload.release_notes if payload else "", created_by=context.user_id)
    session.add(version)
    app.status = "ready"
    await _audit(session, context, "application.version_created", app.id, {"version": version.version})
    await session.commit()
    await session.refresh(version)
    return _version_payload(version)


@router.post("/apps/{app_id}/release")
async def release(app_id: str, payload: ReleaseRequest, context: AuthContext = Depends(require_roles("admin", "manager")), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    """Freeze the draft and publish it in one step; nothing is persisted if validation or the gate fails.

    If the draft is identical to the latest version, that version is published instead of creating a duplicate.
    """
    app = await _app(session, app_id, context.workspace_id)
    draft = _draft(app).model_dump(mode="json")
    latest = await session.scalar(select(AppVersion).where(AppVersion.app_id == app.id).order_by(AppVersion.version.desc()).limit(1))
    if latest and manifest_fingerprint(latest.manifest) == manifest_fingerprint(draft):
        return await _publish(app, latest.id, context, session)
    models, knowledge, tools = await _resource_ids(session, context.workspace_id)
    validation = validate_for_publish(_draft(app), models, knowledge, tools)
    if not validation.valid:
        raise HTTPException(status_code=422, detail={"message": "草稿校验未通过", "issues": [item.model_dump() for item in validation.issues]})
    version = AppVersion(app_id=app.id, version=(latest.version if latest else 0) + 1, manifest=draft, release_notes=payload.release_notes, created_by=context.user_id)
    session.add(version)
    await session.flush()
    try:
        result = await _publish(app, version.id, context, session)
    except HTTPException:
        await session.rollback()
        raise
    await _audit(session, context, "application.version_created", app.id, {"version": version.version})
    await session.commit()
    return result


async def _publish(app: QAApp, version_id: str | None, context: AuthContext, session: AsyncSession, *, enforce_gate: bool = True) -> dict[str, Any]:
    version = await session.scalar(select(AppVersion).where(AppVersion.app_id == app.id, AppVersion.id == version_id)) if version_id else await session.scalar(select(AppVersion).where(AppVersion.app_id == app.id).order_by(AppVersion.version.desc()).limit(1))
    if not version:
        raise HTTPException(status_code=422, detail="请先创建应用版本")
    models, knowledge, tools = await _resource_ids(session, context.workspace_id)
    validation = validate_for_publish(version.manifest, models, knowledge, tools)
    if not validation.valid:
        raise HTTPException(status_code=422, detail={"message": "发布校验未通过", "issues": [item.model_dump() for item in validation.issues]})
    # 每个门禁评测集各自检查：最近一次运行必须覆盖该集全部 Case 且无失败。
    # 回滚切回的是已发布过的版本，不受当前草稿的评测结果约束。
    if enforce_gate:
        gate_suites = list(
            await session.scalars(
                select(EvaluationSuite).where(
                    EvaluationSuite.app_id == app.id,
                    EvaluationSuite.is_release_gate.is_(True),
                )
            )
        )
        for suite in gate_suites:
            latest = await session.scalar(select(EvaluationRun).where(EvaluationRun.suite_id == suite.id).order_by(EvaluationRun.created_at.desc()).limit(1))
            case_count = await session.scalar(select(func.count()).select_from(EvaluationCase).where(EvaluationCase.suite_id == suite.id, EvaluationCase.readiness == "ready")) or 0
            if not latest or latest.failed_count or latest.passed_count < case_count:
                raise HTTPException(status_code=409, detail=f"发布质量门禁未通过：请先运行评测集「{suite.name}」并确保全部通过")
            if latest.manifest_hash != manifest_fingerprint(version.manifest):
                raise HTTPException(status_code=409, detail=f"发布质量门禁未通过：评测集「{suite.name}」的最近结果不是基于当前配置，请重新运行")
    app.published_version_id = version.id
    app.is_enabled = True
    app.status = "published"
    await _audit(session, context, "application.published", app.id, {"version_id": version.id})
    await session.commit()
    return _app_payload(await _app(session, app.id, context.workspace_id))


@router.post("/apps/{app_id}/publish")
async def publish(app_id: str, payload: VersionRequest | None = None, context: AuthContext = Depends(require_roles("admin", "manager")), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    return await _publish(await _app(session, app_id, context.workspace_id), payload.version_id if payload else None, context, session)


@router.post("/apps/{app_id}/rollback")
async def rollback(app_id: str, payload: VersionRequest, context: AuthContext = Depends(require_roles("admin", "manager")), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    if not payload.version_id:
        raise HTTPException(status_code=422, detail="回滚必须指定 version_id")
    result = await _publish(await _app(session, app_id, context.workspace_id), payload.version_id, context, session, enforce_gate=False)
    await _audit(session, context, "application.rolled_back", app_id, {"version_id": payload.version_id})
    await session.commit()
    return result


@router.post("/apps/{app_id}/unpublish")
async def unpublish(app_id: str, context: AuthContext = Depends(require_roles("admin", "manager")), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    app = await _app(session, app_id, context.workspace_id)
    app.is_enabled = False
    app.status = "offline"
    await _audit(session, context, "application.unpublished", app.id)
    await session.commit()
    return _app_payload(app)


def _trace_steps(log: QueryLog, spans: list[dict[str, Any]]) -> list[TraceStep]:
    return [
        TraceStep(
            query_log_id=log.id,
            ordinal=ordinal,
            name=str(span.get("name") or span.get("kind") or "step")[:120],
            status=str(span.get("status") or "success")[:24],
            duration_ms=int(span.get("duration_ms") or 0),
            detail=str(span.get("detail") or "")[:4000],
            metadata_json={"kind": span.get("kind"), **(span.get("metadata") or {})},
        )
        for ordinal, span in enumerate(spans, start=1)
    ]


def _channel(context: AuthContext, requested: str) -> str:
    if requested == "run" and context.auth_type == "api_client":
        return "api"
    return {"run": "web", "preview": "debug", "share": "share"}.get(requested, requested)


async def _execute(app: QAApp, manifest: Manifest, version_id: str | None, payload: RunRequest, context: AuthContext, session: AsyncSession, *, channel: str = "run") -> dict[str, Any]:
    history: list[Message] = []
    conversation: Conversation | None = None
    if payload.conversation_id:
        conversation = await session.get(Conversation, payload.conversation_id)
        if not conversation or conversation.workspace_id != context.workspace_id or conversation.app_id != app.id:
            raise HTTPException(status_code=404, detail="会话不存在")
        if context.user_id and conversation.user_id and conversation.user_id != context.user_id:
            raise HTTPException(status_code=404, detail="会话不存在")
        history = list(await session.scalars(select(Message).where(Message.conversation_id == conversation.id).order_by(Message.created_at)))
    query = payload.message.strip() or next(iter(payload.input_values.values()), app.name)
    # 用户确认副作用工具后会重发同一条消息：替换上一轮「待确认」的回复，而不是在会话里再追加一轮
    awaiting_confirmation: Message | None = None
    if payload.confirmed_tool_names and len(history) >= 2 and history[-2].role == "user" and history[-2].content == str(query) and history[-1].role == "assistant":
        awaiting_confirmation = history[-1]
        history = history[:-2]
    spans: list[dict[str, Any]] = []
    started_at = datetime.now(UTC)
    run_channel = _channel(context, channel)
    app_id = app.id
    conversation_id = conversation.id if conversation else None
    try:
        result = await execute_manifest(
            session,
            manifest,
            message=payload.message,
            input_values=payload.input_values,
            history=history,
            workspace_id=context.workspace_id,
            confirmed_tool_names=set(payload.confirmed_tool_names),
            spans=spans,
        )
    except Exception as exc:
        # 失败运行同样进入可观测：保留已完成的步骤和错误原因。
        await session.rollback()
        expected = isinstance(exc, ValueError)
        detail = str(exc) if expected else f"模型或工具调用失败：{type(exc).__name__}: {exc}"
        model = await session.get(ModelConfig, manifest.llm_model_id) if manifest.llm_model_id else None
        spans.append({"kind": "error", "name": "运行失败", "status": "error", "duration_ms": 0, "detail": detail, "metadata": {"exception": type(exc).__name__}})
        log = QueryLog(
            workspace_id=context.workspace_id, app_id=app_id, conversation_id=conversation_id,
            demo_role=context.role, query=str(query), status=RunStatus.FAILED, error_message=detail[:4000],
            duration_ms=int((datetime.now(UTC) - started_at).total_seconds() * 1000), started_at=started_at, finished_at=datetime.now(UTC),
            app_version_id=version_id, channel=run_channel, model_id=model.id if model else None, model_name=model.model_name if model else None,
            run_metadata={"input_values": payload.input_values, "app_type": manifest.type},
        )
        session.add(log)
        await session.flush()
        session.add_all(_trace_steps(log, spans))
        await session.commit()
        raise HTTPException(status_code=422 if expected else 502, detail={"message": detail, "trace_id": log.trace_id}) from exc
    if not conversation:
        conversation = Conversation(app_id=app.id, workspace_id=context.workspace_id, user_id=context.user_id, title=str(query)[:60], demo_role=context.role)
        session.add(conversation)
        await session.flush()
    conversation.updated_at = utc_now()
    assistant_message = Message(conversation_id=conversation.id, role="assistant", content=result["content"], citations=result["citations"], input_tokens=result["tokens"]["input"], output_tokens=result["tokens"]["output"], duration_ms=result["duration_ms"], simulated=result["simulated"], output_json=result["output_json"], app_version_id=version_id)
    if awaiting_confirmation is not None:
        await session.delete(awaiting_confirmation)
        session.add(assistant_message)
    else:
        user_message = Message(conversation_id=conversation.id, role="user", content=str(query), input_values=payload.input_values, app_version_id=version_id)
        session.add_all([user_message, assistant_message])
    await session.flush()
    model_info = result.get("model") or {}
    log = QueryLog(
        workspace_id=context.workspace_id, app_id=app.id, conversation_id=conversation.id, demo_role=context.role, query=str(query),
        status=RunStatus.SUCCESS, input_tokens=result["tokens"]["input"], output_tokens=result["tokens"]["output"], total_tokens=result["tokens"]["total"],
        duration_ms=result["duration_ms"], started_at=started_at, finished_at=datetime.now(UTC),
        app_version_id=version_id, channel=run_channel, model_id=model_info.get("id"), model_name=model_info.get("name"),
        cost=estimate_cost(result["tokens"], model_info.get("pricing")), message_id=assistant_message.id,
        run_metadata={
            "input_values": payload.input_values,
            "app_type": manifest.type,
            "simulated": result["simulated"],
            "handoff": result["handoff"],
            "citation_count": len(result["citations"]),
            "pricing": model_info.get("pricing"),
            "provider": model_info.get("provider"),
        },
    )
    session.add(log)
    await session.flush()
    session.add_all(_trace_steps(log, spans))
    await session.commit()
    return {**result, "conversation_id": conversation.id, "message_id": assistant_message.id, "trace_id": log.trace_id, "app_version_id": version_id, "portal_path": f"/portal/apps/{app.id}"}


async def _public_share(token: str, session: AsyncSession) -> tuple[AppShare, QAApp, AppVersion]:
    share = await session.scalar(select(AppShare).where(AppShare.token_hash == hash_token(token), AppShare.is_enabled.is_(True)))
    if not share:
        raise HTTPException(status_code=404, detail="分享链接不存在或已撤销")
    if share.expires_at:
        expires_at = share.expires_at if share.expires_at.tzinfo else share.expires_at.replace(tzinfo=UTC)
        if expires_at <= datetime.now(UTC):
            raise HTTPException(status_code=410, detail="分享链接已过期")
    if share.max_uses is not None and share.use_count >= share.max_uses:
        raise HTTPException(status_code=410, detail="分享链接访问次数已用尽")
    app = await session.scalar(
        select(QAApp)
        .where(QAApp.id == share.app_id, QAApp.is_enabled.is_(True), QAApp.published_version_id.is_not(None))
        .options(selectinload(QAApp.knowledge_bases), selectinload(QAApp.versions))
    )
    if not app:
        raise HTTPException(status_code=404, detail="分享应用已下线")
    version = await session.get(AppVersion, app.published_version_id)
    if not version:
        raise HTTPException(status_code=409, detail="分享应用的发布版本不可用")
    return share, app, version


def _public_manifest(manifest: Manifest) -> dict[str, Any]:
    """匿名访问只需要渲染界面的字段，不暴露提示词、模型、知识库与工具配置。"""
    data = manifest.model_dump(mode="json")
    data.update(system_prompt="", llm_model_id=None, knowledge_base_ids=[], tools=[])
    data["guardrails"] = {**data["guardrails"], "blocked_topics": []}
    return data


@router.get("/share/{token}")
async def get_public_share(token: str, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    _share, app, version = await _public_share(token, session)
    public = _public_manifest(Manifest.model_validate(version.manifest))
    return {
        "id": app.id,
        "name": app.name,
        "description": app.description,
        "scenario_type": app.scenario_type,
        "status": "published",
        "is_enabled": True,
        "manifest": public,
        "published_version_id": version.id,
        "published_version": {**_version_payload(version), "manifest": public},
        "versions": [],
        "portal_path": f"/share/{token}",
        "updated_at": app.updated_at,
    }


@router.post("/share/{token}/run")
async def run_public_share(token: str, payload: RunRequest, session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    share, app, version = await _public_share(token, session)
    claimed = await session.execute(
        update(AppShare)
        .where(
            AppShare.id == share.id,
            AppShare.is_enabled.is_(True),
            or_(AppShare.max_uses.is_(None), AppShare.use_count < AppShare.max_uses),
        )
        .values(use_count=AppShare.use_count + 1)
    )
    if claimed.rowcount != 1:
        await session.rollback()
        raise HTTPException(status_code=410, detail="分享链接访问次数已用尽")
    await session.commit()
    context = AuthContext(role="user", workspace_id=app.workspace_id, user_id=None, auth_type="public_share")
    return await _execute(app, Manifest.model_validate(version.manifest), version.id, payload, context, session, channel="share")


@router.post("/apps/{app_id}/preview")
async def preview(app_id: str, payload: RunRequest, context: AuthContext = Depends(require_roles("admin", "manager")), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    app = await _app(session, app_id, context.workspace_id)
    return await _execute(app, _draft(app), None, payload, context, session, channel="preview")


@router.post("/apps/{app_id}/run")
async def run(app_id: str, payload: RunRequest, context: AuthContext = Depends(get_auth_context), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    app = await _app(session, app_id, context.workspace_id)
    if not app.is_enabled or not app.published_version_id:
        raise HTTPException(status_code=404, detail="应用尚未发布")
    version = await session.get(AppVersion, app.published_version_id)
    if not version or version.app_id != app.id:
        raise HTTPException(status_code=409, detail="发布版本不可用")
    return await _execute(app, Manifest.model_validate(version.manifest), version.id, payload, context, session)


@router.put("/apps/{app_id}/evaluation-suite")
async def save_suite(app_id: str, payload: EvaluationSuiteRequest, context: AuthContext = Depends(require_roles("admin", "manager")), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    app = await _app(session, app_id, context.workspace_id)
    suites = list(
        await session.scalars(
            select(EvaluationSuite).where(
                EvaluationSuite.app_id == app.id,
                EvaluationSuite.is_release_gate.is_(True),
            )
        )
    )
    for suite in suites:
        await session.delete(suite)
    suite = EvaluationSuite(
        app_id=app.id,
        name=payload.name,
        description="由应用发布流程维护的质量门禁",
        is_release_gate=True,
        created_by=context.user_id,
    )
    session.add(suite)
    await session.flush()
    for item in payload.cases:
        session.add(EvaluationCase(suite_id=suite.id, **item.model_dump()))
    await session.commit()
    return {"id": suite.id, "name": suite.name, "case_count": len(payload.cases)}


@router.get("/apps/{app_id}/evaluation-suite")
async def get_suite(app_id: str, context: AuthContext = Depends(get_auth_context), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    app = await _app(session, app_id, context.workspace_id)
    suite = await session.scalar(select(EvaluationSuite).where(EvaluationSuite.app_id == app.id, EvaluationSuite.is_release_gate.is_(True)).options(selectinload(EvaluationSuite.cases)).order_by(EvaluationSuite.updated_at.desc()).limit(1))
    if not suite:
        return {"suite": None, "latest_run": None}
    latest = await session.scalar(select(EvaluationRun).where(EvaluationRun.suite_id == suite.id).order_by(EvaluationRun.created_at.desc()).limit(1))
    return {"suite": {"id": suite.id, "name": suite.name, "cases": [{"id": item.id, "name": item.name, "message": item.message, "input_values": item.input_values, "expected_keywords": item.expected_keywords, "forbidden_keywords": item.forbidden_keywords, "require_citations": item.require_citations} for item in suite.cases]}, "latest_run": latest.results if latest else None, "latest_summary": {"passed": latest.passed_count, "failed": latest.failed_count, "simulated": latest.simulated} if latest else None}


@router.post("/apps/{app_id}/evaluate")
async def evaluate(app_id: str, context: AuthContext = Depends(require_roles("admin", "manager")), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    app = await _app(session, app_id, context.workspace_id)
    suite = await session.scalar(select(EvaluationSuite).where(EvaluationSuite.app_id == app.id, EvaluationSuite.is_release_gate.is_(True)).options(selectinload(EvaluationSuite.cases)).order_by(EvaluationSuite.updated_at.desc()).limit(1))
    if not suite or not suite.cases:
        raise HTTPException(status_code=422, detail="请先创建评测集")
    manifest = _draft(app)
    run = EvaluationRun(suite_id=suite.id, status=RunStatus.RUNNING, manifest_hash=manifest_fingerprint(manifest))
    results: list[dict[str, Any]] = []
    for case in suite.cases:
        reasons: list[str] = []
        try:
            result = await execute_manifest(session, manifest, message=case.message, input_values=case.input_values, workspace_id=context.workspace_id)
            content = result["content"].lower()
            missing = [item for item in case.expected_keywords if item.lower() not in content]
            forbidden = [item for item in case.forbidden_keywords if item.lower() in content]
            if missing:
                reasons.append(f"缺少期望关键词：{'、'.join(missing)}")
            if forbidden:
                reasons.append(f"包含禁止关键词：{'、'.join(forbidden)}")
            if case.require_citations and not result["citations"]:
                reasons.append("没有引用来源")
            results.append({"case_id": case.id, "name": case.name, "passed": not reasons, "reasons": reasons, "output": result["content"], "simulated": result["simulated"]})
            run.simulated = run.simulated or result["simulated"]
        except Exception as exc:
            results.append({"case_id": case.id, "name": case.name, "passed": False, "reasons": [str(exc)], "output": ""})
    run.passed_count = sum(1 for item in results if item["passed"])
    run.failed_count = len(results) - run.passed_count
    run.status = RunStatus.SUCCESS if not run.failed_count else RunStatus.FAILED
    run.results = results
    session.add(run)
    await _audit(session, context, "application.evaluated", app.id, {"passed": run.passed_count, "failed": run.failed_count})
    await session.commit()
    return {"id": run.id, "status": run.status, "passed_count": run.passed_count, "failed_count": run.failed_count, "results": results, "simulated": run.simulated}


@router.post("/messages/{message_id}/feedback", status_code=201)
async def feedback(message_id: str, payload: FeedbackRequest, context: AuthContext = Depends(get_auth_context), session: AsyncSession = Depends(get_session)) -> dict[str, Any]:
    message = await session.get(Message, message_id)
    conversation = await session.get(Conversation, message.conversation_id) if message else None
    if not message or not conversation or conversation.workspace_id != context.workspace_id or message.role != "assistant":
        raise HTTPException(status_code=404, detail="回答不存在")
    session.add(Feedback(message_id=message.id, user_id=context.user_id, rating=payload.rating, comment=payload.comment))
    await session.commit()
    return {"ok": True, "rating": payload.rating}
