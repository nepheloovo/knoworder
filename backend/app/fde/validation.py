from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Literal

from pydantic import BaseModel, ValidationError

from .flow import form_fields, graph_issues, referenced_model_ids, referenced_tool_ids
from .manifest import Manifest, Tool, validate_input_value
from .templates import create_manifest, get_template


class Issue(BaseModel):
    path: str
    code: str
    message: str
    severity: Literal["error", "warning"] = "error"


class ValidationResult(BaseModel):
    issues: list[Issue]
    publish_ready: bool

    @property
    def valid(self) -> bool:
        return not any(issue.severity == "error" for issue in self.issues)


def _result(issues: list[Issue]) -> ValidationResult:
    return ValidationResult(
        issues=issues,
        publish_ready=not any(issue.severity == "error" for issue in issues),
    )


def _path(parts: Iterable[str | int]) -> str:
    return ".".join(str(part) for part in parts) or "manifest"


def validate_schema(payload: Manifest | Mapping[str, Any]) -> ValidationResult:
    if isinstance(payload, Manifest):
        return _result([])
    try:
        Manifest.model_validate(payload)
    except ValidationError as exc:
        issues = [
            Issue(
                path=_path(error["loc"]),
                code=str(error["type"]),
                message=str(error["msg"]),
            )
            for error in exc.errors()
        ]
        return _result(issues)
    return _result([])


def validate_business(
    manifest: Manifest,
    available_model_ids: Iterable[str] | None = None,
    available_knowledge_base_ids: Iterable[str] | None = None,
    available_tool_ids: Iterable[str] | None = None,
) -> ValidationResult:
    issues: list[Issue] = []
    template = get_template(manifest.template_key)
    if template is None:
        issues.append(
            Issue(
                path="template_key",
                code="unknown_template",
                message=f"未知模板：{manifest.template_key}",
            )
        )
    if not manifest.llm_model_id:
        issues.append(Issue(path="llm_model_id", code="model_required", message="发布前必须选择模型"))
    elif available_model_ids is not None and manifest.llm_model_id not in set(available_model_ids):
        issues.append(Issue(path="llm_model_id", code="model_invalid", message="所选模型不存在或不可用"))

    knowledge_ids = set(available_knowledge_base_ids) if available_knowledge_base_ids is not None else None
    if knowledge_ids is not None:
        for index, knowledge_base_id in enumerate(manifest.knowledge_base_ids):
            if knowledge_base_id not in knowledge_ids:
                issues.append(
                    Issue(
                        path=f"knowledge_base_ids.{index}",
                        code="knowledge_base_invalid",
                        message="所选知识库不存在或不可用",
                    )
                )
    if template is not None:
        rule = template.knowledge_bases
        if len(manifest.knowledge_base_ids) < rule.min_items:
            issues.append(
                Issue(
                    path="knowledge_base_ids",
                    code="knowledge_base_required",
                    message=f"{template.name}至少需要 {rule.min_items} 个知识库",
                )
            )
        if len(manifest.knowledge_base_ids) > rule.max_items:
            issues.append(
                Issue(
                    path="knowledge_base_ids",
                    code="too_many_knowledge_bases",
                    message=f"{template.name}最多支持 {rule.max_items} 个知识库",
                )
            )
    tool_ids = set(available_tool_ids) if available_tool_ids is not None else None
    if tool_ids is not None:
        for index, tool in enumerate(manifest.tools):
            if tool.tool_id and tool.tool_id not in tool_ids:
                issues.append(Issue(path=f"tools.{index}.tool_id", code="tool_invalid", message="所选工具不存在、未启用或不可用"))
    if manifest.type == "agent" and not any(tool.enabled for tool in manifest.tools):
        issues.append(Issue(path="tools", code="agent_tool_required", message="Agent 至少需要一个可用工具", severity="warning"))
    if manifest.type == "chatflow":
        issues.extend(Issue.model_validate(item) for item in graph_issues(manifest))
        model_ids = set(available_model_ids) if available_model_ids is not None else None
        if model_ids is not None:
            for model_id in sorted(set(referenced_model_ids(manifest)) - model_ids):
                issues.append(Issue(path="graph.nodes", code="model_invalid", message=f"流程节点使用的模型不存在或不可用：{model_id}"))
        if tool_ids is not None:
            for tool_id in sorted(set(referenced_tool_ids(manifest)) - tool_ids):
                issues.append(Issue(path="graph.nodes", code="tool_invalid", message=f"流程节点使用的工具不存在、未启用或不可用：{tool_id}"))
    if manifest.agent.long_term_memory:
        issues.append(Issue(path="agent.long_term_memory", code="long_term_memory_unavailable", message="跨会话长期记忆尚未启用，请关闭后发布"))
    return _result(issues)


def validate_inputs(manifest: Manifest, values: Mapping[str, Any]) -> ValidationResult:
    issues: list[Issue] = []
    fields = {field.key: field for field in manifest.input_fields}
    # Chat Flow 的表单节点字段也可以随请求预先传入（评测用例靠它自动填写表单）
    flow_keys = {field.key for field in form_fields(manifest)} if manifest.type == "chatflow" else set()
    for key in values.keys() - fields.keys() - flow_keys:
        issues.append(Issue(path=f"inputs.{key}", code="unknown_input", message=f"未定义的输入字段：{key}"))
    for key, field in fields.items():
        value = values.get(key, field.default)
        try:
            validate_input_value(field, value)
        except ValueError as exc:
            code = "input_required" if value is None or value == "" else "input_invalid"
            issues.append(Issue(path=f"inputs.{key}", code=code, message=str(exc)))
    return _result(issues)


def validate_manifest(
    payload: Manifest | Mapping[str, Any],
    available_model_ids: Iterable[str] | None = None,
    available_knowledge_base_ids: Iterable[str] | None = None,
    available_tool_ids: Iterable[str] | None = None,
    input_values: Mapping[str, Any] | None = None,
) -> ValidationResult:
    schema_result = validate_schema(payload)
    if not schema_result.valid:
        return schema_result
    manifest = payload if isinstance(payload, Manifest) else Manifest.model_validate(payload)
    issues = list(
        validate_business(
            manifest,
            available_model_ids=available_model_ids,
            available_knowledge_base_ids=available_knowledge_base_ids,
            available_tool_ids=available_tool_ids,
        ).issues
    )
    if input_values is not None:
        issues.extend(validate_inputs(manifest, input_values).issues)
    return _result(issues)


def validate_for_publish(
    payload: Manifest | Mapping[str, Any],
    available_model_ids: Iterable[str],
    available_knowledge_base_ids: Iterable[str],
    available_tool_ids: Iterable[str] | None = None,
) -> ValidationResult:
    return validate_manifest(
        payload,
        available_model_ids=available_model_ids,
        available_knowledge_base_ids=available_knowledge_base_ids,
        available_tool_ids=available_tool_ids,
    )


def _get(source: Any, key: str, default: Any = None) -> Any:
    if isinstance(source, Mapping):
        return source.get(key, default)
    return getattr(source, key, default)


def manifest_from_qa_app(app: Any, template_key: str | None = None) -> Manifest:
    scenario = template_key or _get(app, "scenario_type", "qa")
    scenario = getattr(scenario, "value", scenario)
    knowledge_base_ids = _get(app, "knowledge_base_ids")
    if knowledge_base_ids is None:
        knowledge_base_ids = [
            _get(knowledge_base, "id") for knowledge_base in _get(app, "knowledge_bases", [])
        ]
    manifest = create_manifest(
        str(scenario),
        name=_get(app, "name"),
        description=_get(app, "description", ""),
        system_prompt=_get(app, "system_prompt"),
        llm_model_id=_get(app, "llm_model_id"),
        knowledge_base_ids=list(knowledge_base_ids or []),
    )
    retrieval_config = {
        key: _get(app, key)
        for key in ("top_k", "rerank_top_n", "score_threshold")
        if _get(app, key) is not None
    }
    if retrieval_config:
        retrieval_tools = [tool for tool in manifest.tools if tool.name == "knowledge_retrieval"]
        if not retrieval_tools:
            retrieval_tools = [Tool(name="knowledge_retrieval")]
            manifest.tools.extend(retrieval_tools)
        for tool in retrieval_tools:
            tool.config.update(retrieval_config)
    return manifest


from_qa_app = manifest_from_qa_app
