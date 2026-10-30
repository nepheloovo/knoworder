from __future__ import annotations

import re
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ...db import get_session
from ...fde import Manifest, manifest_fingerprint, manifest_from_qa_app
from ...fde.runtime import execute_manifest
from ...providers import build_gateway
from ...services.eval_design import DESIGN_RULES, MAX_CASES, default_rule_keys, design_cases, template_cases
from ...models import (
    AppVersion,
    AuditEvent,
    DocumentChunk,
    EvaluationCase,
    EvaluationRun,
    EvaluationSuite,
    Message,
    ModelConfig,
    ProviderName,
    QAApp,
    QueryLog,
    RunStatus,
)
from ...security import AuthContext, require_roles


router = APIRouter(dependencies=[Depends(require_roles("admin", "manager"))])


class EvaluationSetCreate(BaseModel):
    app_id: str
    name: str = Field(min_length=1, max_length=180)
    description: str = Field(default="", max_length=4000)


class EvaluationDesignRequest(BaseModel):
    app_id: str
    name: str | None = Field(default=None, max_length=180)
    target_set_id: str | None = None
    rule_keys: list[str] = Field(default_factory=list, max_length=20)
    directions: str = Field(default="", max_length=4000)
    count: int = Field(default=10, ge=1, le=MAX_CASES)


class EvaluationSetUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=180)
    description: str | None = Field(default=None, max_length=4000)
    is_release_gate: bool | None = None


class EvaluationCaseCreate(BaseModel):
    name: str = Field(min_length=1, max_length=180)
    message: str = Field(min_length=1, max_length=12000)
    input_values: dict[str, Any] = Field(default_factory=dict)
    expected_output: str = Field(default="", max_length=30000)
    expected_keywords: list[str] = Field(default_factory=list, max_length=20)
    forbidden_keywords: list[str] = Field(default_factory=list, max_length=20)
    require_citations: bool = False
    tags: list[str] = Field(default_factory=list, max_length=20)


class CasesFromLogsRequest(BaseModel):
    trace_ids: list[str] = Field(min_length=1, max_length=100)
    case_type: Literal["good", "bad"]
    tags: list[str] = Field(default_factory=list, max_length=20)


class EvaluationCaseUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=180)
    case_type: Literal["good", "bad", "manual", "ai"] | None = None
    message: str | None = Field(default=None, max_length=12000)
    expected_output: str | None = Field(default=None, max_length=30000)
    expected_keywords: list[str] | None = Field(default=None, max_length=20)
    forbidden_keywords: list[str] | None = Field(default=None, max_length=20)
    require_citations: bool | None = None
    tags: list[str] | None = Field(default=None, max_length=20)


async def _app(session: AsyncSession, app_id: str, workspace_id: str) -> QAApp:
    app = await session.scalar(select(QAApp).where(QAApp.id == app_id, QAApp.workspace_id == workspace_id))
    if app is None:
        raise HTTPException(status_code=404, detail="应用不存在或不在当前业务空间")
    return app


async def _suite(session: AsyncSession, suite_id: str, workspace_id: str, *, with_cases: bool = False) -> tuple[EvaluationSuite, QAApp]:
    query = (
        select(EvaluationSuite, QAApp)
        .join(QAApp, QAApp.id == EvaluationSuite.app_id)
        .where(EvaluationSuite.id == suite_id, QAApp.workspace_id == workspace_id)
        .options(selectinload(QAApp.knowledge_bases))
    )
    if with_cases:
        query = query.options(selectinload(EvaluationSuite.cases))
    row = (await session.execute(query)).one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="评测集不存在或不在当前业务空间")
    return row[0], row[1]


def _case_readiness(case: EvaluationCase) -> str:
    has_assertion = bool(
        case.expected_output.strip()
        or case.expected_keywords
        or case.forbidden_keywords
        or case.require_citations
    )
    return "ready" if case.message.strip() and has_assertion else "needs_standard"


def _case_payload(case: EvaluationCase) -> dict[str, Any]:
    return {
        "id": case.id,
        "suite_id": case.suite_id,
        "name": case.name,
        "case_type": case.case_type,
        "readiness": case.readiness,
        "message": case.message,
        "input_values": case.input_values,
        "actual_output": case.actual_output,
        "expected_output": case.expected_output,
        "expected_keywords": case.expected_keywords,
        "forbidden_keywords": case.forbidden_keywords,
        "require_citations": case.require_citations,
        "tags": case.tags,
        "source_log_id": case.source_log_id,
        "source_trace_id": case.source_trace_id,
        "source_conversation_id": case.source_conversation_id,
        "source_snapshot": case.source_snapshot,
        "created_by": case.created_by,
        "created_at": case.created_at,
        "updated_at": case.updated_at,
    }


async def _set_payload(session: AsyncSession, suite: EvaluationSuite, app: QAApp, *, include_cases: bool = False) -> dict[str, Any]:
    if include_cases:
        cases = list(
            await session.scalars(
                select(EvaluationCase)
                .where(EvaluationCase.suite_id == suite.id)
                .order_by(EvaluationCase.created_at.desc())
            )
        )
        ready_count = sum(item.readiness == "ready" for item in cases)
        case_count = len(cases)
    else:
        case_count, ready_count = (
            await session.execute(
                select(
                    func.count(EvaluationCase.id),
                    func.count(EvaluationCase.id).filter(EvaluationCase.readiness == "ready"),
                ).where(EvaluationCase.suite_id == suite.id)
            )
        ).one()
        cases = []
    latest_run = await session.scalar(
        select(EvaluationRun)
        .where(EvaluationRun.suite_id == suite.id)
        .order_by(EvaluationRun.created_at.desc())
        .limit(1)
    )
    payload: dict[str, Any] = {
        "id": suite.id,
        "app_id": suite.app_id,
        "app_name": app.name,
        "name": suite.name,
        "description": suite.description,
        "is_release_gate": suite.is_release_gate,
        "case_count": case_count,
        "ready_count": ready_count,
        "needs_standard_count": case_count - ready_count,
        "created_by": suite.created_by,
        "created_at": suite.created_at,
        "updated_at": suite.updated_at,
        "latest_run": None if latest_run is None else {
            "id": latest_run.id,
            "status": latest_run.status,
            "passed_count": latest_run.passed_count,
            "failed_count": latest_run.failed_count,
            "simulated": latest_run.simulated,
            "results": latest_run.results,
            "created_at": latest_run.created_at,
            "done_count": len(latest_run.results),
            "matches_draft": latest_run.manifest_hash is not None and latest_run.manifest_hash == manifest_fingerprint(Manifest.model_validate(app.draft_manifest) if app.draft_manifest else manifest_from_qa_app(app)),
        },
    }
    if include_cases:
        payload["cases"] = [_case_payload(item) for item in cases]
    return payload


async def _source_snapshot(session: AsyncSession, log: QueryLog, app: QAApp) -> tuple[str, dict[str, Any], dict[str, Any]]:
    assistant = None
    context_messages: list[Message] = []
    if log.message_id:
        assistant = await session.get(Message, log.message_id)
    if assistant is None and log.conversation_id:
        assistant = await session.scalar(
            select(Message)
            .where(
                Message.conversation_id == log.conversation_id,
                Message.role == "assistant",
                Message.created_at >= log.started_at,
            )
            .order_by(Message.created_at)
            .limit(1)
        )
    if assistant and log.conversation_id:
        context_messages = list(
            await session.scalars(
                select(Message)
                .where(
                    Message.conversation_id == log.conversation_id,
                    Message.created_at <= assistant.created_at,
                )
                .order_by(Message.created_at.desc())
                .limit(50)
            )
        )
        context_messages.reverse()

    model_snapshot: dict[str, Any] | None = None
    if log.model_name:
        model_snapshot = {
            "provider": (log.run_metadata or {}).get("provider"),
            "model": log.model_name,
            "simulated": (log.run_metadata or {}).get("simulated"),
        }
    llm_trace = None if model_snapshot else next((item for item in log.traces if item.name in {"LLM 生成", "模型生成"}), None)
    if llm_trace:
        model_snapshot = {
            "provider": llm_trace.metadata_json.get("provider"),
            "model": llm_trace.metadata_json.get("model"),
            "simulated": llm_trace.metadata_json.get("simulated"),
        }
    elif not model_snapshot and app.llm_model_id:
        model = await session.get(ModelConfig, app.llm_model_id)
        if model:
            model_snapshot = {"provider": model.provider, "model": model.model_name, "simulated": model.provider == "mock"}

    version_snapshot = None
    version_id = log.app_version_id or (assistant.app_version_id if assistant else None)
    if version_id:
        version = await session.get(AppVersion, version_id)
        if version and version.app_id == app.id:
            version_snapshot = {"id": version.id, "version": version.version, "release_notes": version.release_notes}

    source_user_message = next(
        (item for item in reversed(context_messages) if item.role == "user" and item.content == log.query),
        None,
    )
    input_values = dict(source_user_message.input_values) if source_user_message else {}
    output = assistant.content if assistant else ""
    return output, {
        "captured_from": "online_log",
        "trace_id": log.trace_id,
        "query_log_id": log.id,
        "conversation_id": log.conversation_id,
        "query": log.query,
        "input_values": input_values,
        "output": output,
        "status": log.status,
        "error_message": log.error_message,
        "application": {"id": app.id, "name": app.name},
        "app_version": version_snapshot,
        "model": model_snapshot,
        "channel": log.channel or "online_chat",
        "demo_role": log.demo_role,
        "started_at": log.started_at.isoformat(),
        "finished_at": log.finished_at.isoformat() if log.finished_at else None,
        "tokens": {
            "input": log.input_tokens,
            "output": log.output_tokens,
            "total": log.total_tokens,
        },
        "duration_ms": log.duration_ms,
        "conversation": [
            {
                "id": item.id,
                "role": item.role,
                "content": item.content,
                "citations": item.citations,
                "created_at": item.created_at.isoformat(),
            }
            for item in context_messages
        ],
        "trace": [
            {
                "ordinal": item.ordinal,
                "name": item.name,
                "status": item.status,
                "duration_ms": item.duration_ms,
                "detail": item.detail,
                "metadata": item.metadata_json,
            }
            for item in log.traces
        ],
    }, input_values


@router.get("")
async def list_evaluation_sets(
    app_id: str | None = None,
    context: AuthContext = Depends(require_roles("admin", "manager")),
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, Any]]:
    query = (
        select(EvaluationSuite, QAApp)
        .join(QAApp, QAApp.id == EvaluationSuite.app_id)
        .where(QAApp.workspace_id == context.workspace_id)
        .order_by(EvaluationSuite.updated_at.desc())
    )
    if app_id:
        query = query.where(EvaluationSuite.app_id == app_id)
    rows = (await session.execute(query)).all()
    return [await _set_payload(session, suite, app) for suite, app in rows]


@router.post("", status_code=201)
async def create_evaluation_set(
    payload: EvaluationSetCreate,
    context: AuthContext = Depends(require_roles("admin", "manager")),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    app = await _app(session, payload.app_id, context.workspace_id)
    suite = EvaluationSuite(
        app_id=app.id,
        name=payload.name.strip(),
        description=payload.description.strip(),
        created_by=context.user_id,
        is_release_gate=False,
    )
    session.add(suite)
    await session.flush()
    session.add(AuditEvent(workspace_id=context.workspace_id, actor_id=context.user_id, action="evaluation_set.created", resource_type="evaluation_set", resource_id=suite.id, detail={"app_id": app.id}))
    await session.commit()
    return await _set_payload(session, suite, app, include_cases=True)


def _designs_with_model(model: ModelConfig | None) -> bool:
    """未配置预设回复的测试替身只会返回固定文案，设计不出用例，与没有模型一样按规则模板生成。"""
    if model is None or not model.is_enabled:
        return False
    return model.provider != ProviderName.MOCK or bool(model.config.get("response_text"))


@router.get("/design-rules")
async def evaluation_design_rules(
    app_id: str,
    context: AuthContext = Depends(require_roles("admin", "manager")),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """评测规则目录，以及按应用场景、是否关联知识库推荐的默认勾选。"""
    app = await _app(session, app_id, context.workspace_id)
    manifest = _draft_manifest(app)
    model = await session.get(ModelConfig, manifest.llm_model_id) if manifest.llm_model_id else None
    return {
        "rules": [{key: rule[key] for key in ("key", "name", "description")} | {"needs_knowledge": bool(rule.get("needs_knowledge"))} for rule in DESIGN_RULES],
        "recommended": default_rule_keys(manifest.template_key, bool(manifest.knowledge_base_ids)),
        "has_knowledge": bool(manifest.knowledge_base_ids),
        "has_model": _designs_with_model(model),
    }


@router.post("/ai-design", status_code=201)
async def ai_design_evaluation_set(
    payload: EvaluationDesignRequest,
    context: AuthContext = Depends(require_roles("admin", "manager")),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """用应用当前选择的对话模型，按规则与业务方向生成可直接运行的评测 Case；没有真实模型时按规则模板生成。"""
    app = await _app(session, payload.app_id, context.workspace_id)
    manifest = _draft_manifest(app)
    model = await session.get(ModelConfig, manifest.llm_model_id) if manifest.llm_model_id else None
    if manifest.llm_model_id and (model is None or not model.is_enabled):
        raise HTTPException(status_code=422, detail="应用的对话模型不存在或已停用")
    use_template = not _designs_with_model(model)
    samples: list[str] = []
    if manifest.knowledge_base_ids:
        rows = await session.scalars(
            select(DocumentChunk.content).where(DocumentChunk.knowledge_base_id.in_(manifest.knowledge_base_ids)).order_by(func.random()).limit(8)
        )
        samples = [item for item in rows if item and item.strip()]
    try:
        options = {"rule_keys": payload.rule_keys, "directions": payload.directions, "count": payload.count, "knowledge_samples": samples}
        cases = template_cases(manifest, **options) if use_template else await design_cases(build_gateway(model), manifest, **options)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if payload.target_set_id:
        suite, _ = await _suite(session, payload.target_set_id, context.workspace_id)
        if suite.app_id != app.id:
            raise HTTPException(status_code=422, detail="目标评测集不属于该应用")
    else:
        suite = EvaluationSuite(
            app_id=app.id, name=(payload.name or f"{app.name} · AI 设计评测集").strip()[:180],
            description=f"AI 按规则生成：{'、'.join(rule['name'] for rule in DESIGN_RULES if rule['key'] in payload.rule_keys) or '自定义方向'}"
            + (f"；业务方向：{payload.directions.strip()[:200]}" if payload.directions.strip() else ""),
            created_by=context.user_id, is_release_gate=False,
        )
        session.add(suite)
        await session.flush()
    for item in cases:
        case = EvaluationCase(suite_id=suite.id, case_type="ai", created_by=context.user_id, source_snapshot={"captured_from": "rule_template" if use_template else "ai_design", "model": None if use_template else model.model_name}, expected_output="", **item)
        case.readiness = _case_readiness(case)
        session.add(case)
    session.add(AuditEvent(workspace_id=context.workspace_id, actor_id=context.user_id, action="evaluation_set.ai_designed", resource_type="evaluation_set", resource_id=suite.id, detail={"count": len(cases), "rules": payload.rule_keys, "template": use_template}))
    await session.commit()
    return await _set_payload(session, suite, app, include_cases=True)


@router.get("/{suite_id}")
async def get_evaluation_set(
    suite_id: str,
    context: AuthContext = Depends(require_roles("admin", "manager")),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    suite, app = await _suite(session, suite_id, context.workspace_id, with_cases=True)
    return await _set_payload(session, suite, app, include_cases=True)


@router.patch("/{suite_id}")
async def update_evaluation_set(
    suite_id: str,
    payload: EvaluationSetUpdate,
    context: AuthContext = Depends(require_roles("admin", "manager")),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    suite, app = await _suite(session, suite_id, context.workspace_id, with_cases=True)
    changes = payload.model_dump(exclude_unset=True)
    for key, value in changes.items():
        setattr(suite, key, value.strip() if isinstance(value, str) else value)
    await session.commit()
    return await _set_payload(session, suite, app, include_cases=True)


@router.post("/{suite_id}/cases/from-logs", status_code=201)
async def create_cases_from_logs(
    suite_id: str,
    payload: CasesFromLogsRequest,
    context: AuthContext = Depends(require_roles("admin", "manager")),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    suite, app = await _suite(session, suite_id, context.workspace_id)
    trace_ids = list(dict.fromkeys(payload.trace_ids))
    logs = list(
        await session.scalars(
            select(QueryLog)
            .where(QueryLog.workspace_id == context.workspace_id, QueryLog.trace_id.in_(trace_ids))
            .options(selectinload(QueryLog.traces))
        )
    )
    if len(logs) != len(trace_ids):
        raise HTTPException(status_code=404, detail="部分 Trace 不存在或不在当前业务空间")
    if any(log.app_id != suite.app_id for log in logs):
        raise HTTPException(status_code=422, detail="Case 必须来自该评测集绑定的同一应用")
    duplicate = await session.scalar(
        select(EvaluationCase.source_trace_id)
        .where(EvaluationCase.suite_id == suite.id, EvaluationCase.source_trace_id.in_(trace_ids))
        .limit(1)
    )
    if duplicate:
        raise HTTPException(status_code=409, detail=f"Trace {duplicate[:8]} 已在该评测集中")

    created: list[EvaluationCase] = []
    for log in sorted(logs, key=lambda item: trace_ids.index(item.trace_id)):
        actual_output, snapshot, input_values = await _source_snapshot(session, log, app)
        case = EvaluationCase(
            suite_id=suite.id,
            name=log.query.strip()[:180] or f"Trace {log.trace_id[:8]}",
            message=log.query,
            input_values=input_values,
            expected_keywords=[],
            forbidden_keywords=[],
            require_citations=False,
            case_type=payload.case_type,
            actual_output=actual_output,
            expected_output=actual_output if payload.case_type == "good" else "",
            tags=list(dict.fromkeys(item.strip() for item in payload.tags if item.strip())),
            source_log_id=log.id,
            source_trace_id=log.trace_id,
            source_conversation_id=log.conversation_id,
            source_snapshot=snapshot,
            created_by=context.user_id,
        )
        case.readiness = _case_readiness(case)
        session.add(case)
        created.append(case)
    await session.flush()
    session.add(AuditEvent(workspace_id=context.workspace_id, actor_id=context.user_id, action="evaluation_case.returned", resource_type="evaluation_set", resource_id=suite.id, detail={"case_type": payload.case_type, "trace_ids": trace_ids, "count": len(created)}))
    await session.commit()
    return {"created_count": len(created), "cases": [_case_payload(item) for item in created]}


@router.patch("/{suite_id}/cases/{case_id}")
async def update_evaluation_case(
    suite_id: str,
    case_id: str,
    payload: EvaluationCaseUpdate,
    context: AuthContext = Depends(require_roles("admin", "manager")),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    suite, _app_row = await _suite(session, suite_id, context.workspace_id)
    case = await session.scalar(select(EvaluationCase).where(EvaluationCase.id == case_id, EvaluationCase.suite_id == suite.id))
    if case is None:
        raise HTTPException(status_code=404, detail="Case 不存在")
    changes = payload.model_dump(exclude_unset=True)
    for key, value in changes.items():
        if isinstance(value, str):
            value = value.strip()
        if isinstance(value, list):
            value = list(dict.fromkeys(item.strip() for item in value if item.strip()))
        setattr(case, key, value)
    case.readiness = _case_readiness(case)
    session.add(AuditEvent(workspace_id=context.workspace_id, actor_id=context.user_id, action="evaluation_case.updated", resource_type="evaluation_case", resource_id=case.id, detail={"readiness": case.readiness, "fields": list(changes)}))
    await session.commit()
    return _case_payload(case)


def _normalized(value: str) -> str:
    return re.sub(r"\s+", "", value).lower()


async def _evaluate_case(session: AsyncSession, manifest: Manifest, case: EvaluationCase, workspace_id: str) -> dict[str, Any]:
    reasons: list[str] = []
    try:
        input_values = dict(case.input_values)
        missing_required_text = [
            field
            for field in manifest.input_fields
            if field.required
            and field.type in {"text", "textarea"}
            and not input_values.get(field.key)
        ]
        if len(missing_required_text) == 1:
            input_values[missing_required_text[0].key] = case.message
        result = await execute_manifest(session, manifest, message=case.message, input_values=input_values, workspace_id=workspace_id)
        content = result["content"]
        lowered = content.lower()
        missing = [item for item in case.expected_keywords if item.lower() not in lowered]
        forbidden = [item for item in case.forbidden_keywords if item.lower() in lowered]
        if missing:
            reasons.append(f"缺少期望关键词：{'、'.join(missing)}")
        if forbidden:
            reasons.append(f"包含禁止关键词：{'、'.join(forbidden)}")
        if case.require_citations and not result["citations"]:
            reasons.append("没有引用来源")
        has_explicit_rules = bool(case.expected_keywords or case.forbidden_keywords or case.require_citations)
        if case.case_type != "good" and case.expected_output and not has_explicit_rules and _normalized(content) != _normalized(case.expected_output):
            reasons.append("输出与标准答案不一致")
        return {"case_id": case.id, "name": case.name, "passed": not reasons, "reasons": reasons, "output": content, "simulated": result["simulated"]}
    except Exception as exc:
        return {"case_id": case.id, "name": case.name, "passed": False, "reasons": [str(exc)], "output": "", "simulated": False}


def _ready_cases(suite: EvaluationSuite) -> list[EvaluationCase]:
    # 待补标准的 Case 不参与运行，也不计入发布门禁；全部待补时才拒绝运行
    ready = [item for item in suite.cases if item.readiness == "ready"]
    if not suite.cases:
        raise HTTPException(status_code=422, detail="评测集还没有 Case")
    if not ready:
        raise HTTPException(status_code=409, detail=f"{len(suite.cases)} 个 Case 都待补评测标准，补齐后才能运行")
    return ready


def _draft_manifest(app: QAApp) -> Manifest:
    return Manifest.model_validate(app.draft_manifest) if app.draft_manifest else manifest_from_qa_app(app)


def _run_payload(run: EvaluationRun, total: int) -> dict[str, Any]:
    return {
        "id": run.id, "status": run.status, "passed_count": run.passed_count, "failed_count": run.failed_count, "results": run.results,
        "simulated": run.simulated, "created_at": run.created_at, "matches_draft": True, "total_count": total, "done_count": len(run.results),
    }


def _finish(run: EvaluationRun, session: AsyncSession, context: AuthContext, suite: EvaluationSuite) -> None:
    run.passed_count = sum(item["passed"] for item in run.results)
    run.failed_count = len(run.results) - run.passed_count
    run.status = RunStatus.SUCCESS if not run.failed_count else RunStatus.FAILED
    session.add(AuditEvent(workspace_id=context.workspace_id, actor_id=context.user_id, action="evaluation_set.run", resource_type="evaluation_set", resource_id=suite.id, detail={"passed": run.passed_count, "failed": run.failed_count}))


@router.post("/{suite_id}/run")
async def run_evaluation_set(
    suite_id: str,
    context: AuthContext = Depends(require_roles("admin", "manager")),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """一次性运行全部可运行 Case（API 调用方使用；界面使用分步运行以展示进度）。"""
    suite, app = await _suite(session, suite_id, context.workspace_id, with_cases=True)
    ready_cases = _ready_cases(suite)
    manifest = _draft_manifest(app)
    run = EvaluationRun(suite_id=suite.id, status=RunStatus.RUNNING, manifest_hash=manifest_fingerprint(manifest))
    results = [await _evaluate_case(session, manifest, case, context.workspace_id) for case in ready_cases]
    run.results = results
    run.simulated = any(item["simulated"] for item in results)
    session.add(run)
    _finish(run, session, context, suite)
    await session.commit()
    return _run_payload(run, len(ready_cases))


@router.post("/{suite_id}/runs", status_code=201)
async def start_evaluation_run(
    suite_id: str,
    context: AuthContext = Depends(require_roles("admin", "manager")),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """开始分步运行：只创建运行记录，随后逐次调用 /step 评测一个 Case，界面据此显示进度。"""
    suite, app = await _suite(session, suite_id, context.workspace_id, with_cases=True)
    ready_cases = _ready_cases(suite)
    run = EvaluationRun(suite_id=suite.id, status=RunStatus.RUNNING, manifest_hash=manifest_fingerprint(_draft_manifest(app)), results=[])
    session.add(run)
    await session.commit()
    return _run_payload(run, len(ready_cases))


@router.post("/{suite_id}/runs/{run_id}/step")
async def step_evaluation_run(
    suite_id: str,
    run_id: str,
    context: AuthContext = Depends(require_roles("admin", "manager")),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    suite, app = await _suite(session, suite_id, context.workspace_id, with_cases=True)
    run = await session.scalar(select(EvaluationRun).where(EvaluationRun.id == run_id, EvaluationRun.suite_id == suite.id))
    if not run:
        raise HTTPException(status_code=404, detail="评测运行不存在")
    ready_cases = _ready_cases(suite)
    if run.status != RunStatus.RUNNING:
        return _run_payload(run, len(ready_cases))
    manifest = _draft_manifest(app)
    if manifest_fingerprint(manifest) != run.manifest_hash:
        raise HTTPException(status_code=409, detail="应用草稿在评测过程中被修改，请重新开始评测")
    done = {item["case_id"] for item in run.results}
    remaining = [case for case in ready_cases if case.id not in done]
    if remaining:
        result = await _evaluate_case(session, manifest, remaining[0], context.workspace_id)
        run.results = [*run.results, result]  # 重新赋值，确保 JSON 列被标记为已修改
        run.simulated = run.simulated or result["simulated"]
        run.passed_count = sum(item["passed"] for item in run.results)
        run.failed_count = len(run.results) - run.passed_count
    if len(remaining) <= 1:
        _finish(run, session, context, suite)
    await session.commit()
    return _run_payload(run, len(ready_cases))


@router.post("/{suite_id}/cases", status_code=201)
async def create_evaluation_case(
    suite_id: str,
    payload: EvaluationCaseCreate,
    context: AuthContext = Depends(require_roles("admin", "manager")),
    session: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    suite, _ = await _suite(session, suite_id, context.workspace_id)
    case = EvaluationCase(
        suite_id=suite.id,
        name=payload.name.strip(),
        message=payload.message,
        input_values=payload.input_values,
        expected_output=payload.expected_output,
        expected_keywords=[item.strip() for item in payload.expected_keywords if item.strip()],
        forbidden_keywords=[item.strip() for item in payload.forbidden_keywords if item.strip()],
        require_citations=payload.require_citations,
        tags=list(dict.fromkeys(item.strip() for item in payload.tags if item.strip())),
        case_type="manual",
        created_by=context.user_id,
        source_snapshot={},
    )
    case.readiness = _case_readiness(case)
    session.add(case)
    await session.commit()
    return _case_payload(case)


@router.delete("/{suite_id}/cases/{case_id}", status_code=204)
async def delete_evaluation_case(
    suite_id: str,
    case_id: str,
    context: AuthContext = Depends(require_roles("admin", "manager")),
    session: AsyncSession = Depends(get_session),
) -> None:
    suite, _ = await _suite(session, suite_id, context.workspace_id)
    case = await session.get(EvaluationCase, case_id)
    if not case or case.suite_id != suite.id:
        raise HTTPException(status_code=404, detail="Case 不存在")
    await session.delete(case)
    await session.commit()
