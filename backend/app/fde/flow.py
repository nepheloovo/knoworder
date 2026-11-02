"""Chat Flow：按节点图执行多步骤流程。

- 节点之间用 ``{{节点ID.字段}}`` 引用上游输出，例如 ``{{start.query}}``、``{{outline.text}}``。
- 分类、判断、用户选择是分支节点，只激活命中分支（source_handle = b0、b1…）上的连线；没有任何激活入边的节点被跳过。
- 表单和用户选择会暂停流程：运行状态随这条回复保存，用户提交后从暂停处继续。评测等非交互运行用用例输入或默认值自动填写。
- 流程必须是有向无环图；重复执行的步骤用「批量生成」节点按列表逐项调用模型。
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import re
from collections import defaultdict
from time import monotonic
from typing import Any

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import KnowledgeBase, ModelConfig, ModelType, ToolConfig
from ..providers import build_gateway
from ..services.retrieval import RetrievedChunk, retrieve_knowledge_base
from ..services.tools import execute_http_tool
from .manifest import FlowNode, InputField, Manifest, validate_input_value

VAR = re.compile(r"\{\{\s*([A-Za-z][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_]+)*)\s*\}\}")
BRANCH_KINDS = {"classify", "ifelse", "choice"}
INTERACTIVE_KINDS = {"form", "choice"}
MODEL_KINDS = {"llm", "classify", "extract", "loop"}
LOOP_VARS = {"item", "index"}
SPAN_KIND = {"llm": "model", "classify": "model", "extract": "model", "loop": "model", "kb": "retrieval", "tool": "tool"}
NODE_LABEL = {
    "start": "流程开始", "llm": "AI 对话", "kb": "知识库搜索", "classify": "问题分类", "extract": "信息提取", "ifelse": "条件判断",
    "template": "文本拼接", "loop": "批量生成", "form": "表单输入", "choice": "用户选择", "tool": "调用工具", "answer": "指定回复",
}


# ---------------------------------------------------------------- 图结构与校验

def branch_handles(node: FlowNode) -> list[str]:
    if node.kind == "ifelse":
        return ["b0", "b1"]
    if node.kind == "classify":
        return [f"b{index}" for index in range(len(node.config["categories"]))]
    if node.kind == "choice":
        return [f"b{index}" for index in range(len(node.config["options"]))]
    return []


def output_fields(node: FlowNode, manifest: Manifest) -> list[str]:
    config = node.config
    return {
        "start": ["query", *(field.key for field in manifest.input_fields)],
        "llm": ["text"],
        "kb": ["context", "count"],
        "classify": ["category"],
        "extract": [*(field["key"] for field in config.get("fields", [])), "json"],
        "ifelse": ["result"],
        "template": ["text"],
        "loop": ["text", "results", "count"],
        "form": [field["key"] for field in config.get("fields", [])],
        "choice": ["choice"],
        "tool": ["result", "json"],
        "answer": ["text"],
    }[node.kind]


def _templates(node: FlowNode) -> list[tuple[str, str]]:
    """节点配置里所有可以写变量引用的文本：(配置路径, 文本)。"""
    config = node.config
    keys = {
        "llm": ["system_prompt", "prompt"], "kb": ["query"], "classify": ["input", "instruction"], "extract": ["input"],
        "template": ["template"], "loop": ["items", "system_prompt", "prompt"], "form": ["prompt"], "choice": ["prompt"], "answer": ["template"],
    }.get(node.kind, [])
    texts = [(key, str(config.get(key) or "")) for key in keys]
    if node.kind == "ifelse":
        for index, condition in enumerate(config["conditions"]):
            texts += [(f"conditions.{index}.left", condition["left"]), (f"conditions.{index}.right", condition["right"])]
    if node.kind == "tool":
        texts += [(f"arguments.{key}", value) for key, value in config["arguments"].items()]
    return texts


def graph_fingerprint(manifest: Manifest) -> str:
    graph = manifest.graph.model_dump(mode="json") if manifest.graph else {}
    for node in graph.get("nodes", []):
        node.pop("position", None)  # 只挪动节点位置不影响已暂停的流程
    return hashlib.sha256(json.dumps(graph, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def topological_order(manifest: Manifest) -> list[str] | None:
    """返回拓扑序；有环时返回 None。"""
    graph = manifest.graph
    assert graph is not None
    indegree = {node.id: 0 for node in graph.nodes}
    targets: dict[str, list[str]] = defaultdict(list)
    for edge in graph.edges:
        indegree[edge.target] += 1
        targets[edge.source].append(edge.target)
    # 按节点在画布上的横坐标排序，让并列节点的执行顺序与阅读顺序一致
    position = {node.id: (node.position.x, node.position.y) for node in graph.nodes}
    ready = sorted((node_id for node_id, degree in indegree.items() if degree == 0), key=position.get)
    order: list[str] = []
    while ready:
        current = ready.pop(0)
        order.append(current)
        for target in targets[current]:
            indegree[target] -= 1
            if indegree[target] == 0:
                ready.append(target)
                ready.sort(key=position.get)
    return order if len(order) == len(indegree) else None


def graph_issues(manifest: Manifest) -> list[dict[str, str]]:
    """结构与引用检查。草稿可以带着问题保存，存在 error 时不能运行和发布。"""
    graph = manifest.graph
    if graph is None:
        return [_issue("graph", "graph_required", "Chat Flow 应用缺少流程图")]
    issues: list[dict[str, str]] = []
    nodes = {node.id: node for node in graph.nodes}
    index_of = {node.id: index for index, node in enumerate(graph.nodes)}
    starts = [node for node in graph.nodes if node.kind == "start"]
    if len(starts) != 1:
        issues.append(_issue("graph.nodes", "flow_start", "流程必须有且只有一个「流程开始」节点"))
    if not any(node.kind == "answer" for node in graph.nodes):
        issues.append(_issue("graph.nodes", "flow_answer", "流程至少需要一个「指定回复」节点，否则用户看不到结果"))
    for node in graph.nodes:
        if node.id in LOOP_VARS:
            issues.append(_issue(f"graph.nodes.{index_of[node.id]}", "flow_node_id", f"节点 ID 不能使用保留字 {node.id}"))

    for index, edge in enumerate(graph.edges):
        source = nodes[edge.source]
        handles = branch_handles(source)
        path = f"graph.edges.{index}"
        if nodes[edge.target].kind == "start":
            issues.append(_issue(path, "flow_edge_start", "不能连线到「流程开始」节点"))
        if source.kind == "answer":
            issues.append(_issue(path, "flow_edge_answer", f"「{source.title}」是终点，不能再连出"))
        if handles and edge.source_handle not in handles:
            issues.append(_issue(path, "flow_edge_handle", f"「{source.title}」的连线没有对应的分支，请重新连接"))
        if not handles and edge.source_handle:
            issues.append(_issue(path, "flow_edge_handle", f"「{source.title}」不是分支节点，请重新连接"))

    order = topological_order(manifest)
    if order is None:
        issues.append(_issue("graph.edges", "flow_cycle", "流程不能有环；需要逐项重复执行时请使用「批量生成」节点"))
        return issues

    ancestors: dict[str, set[str]] = {node_id: set() for node_id in nodes}
    for node_id in order:
        for edge in graph.edges:
            if edge.source == node_id:
                ancestors[edge.target] |= ancestors[node_id] | {node_id}
    if len(starts) == 1:
        reachable = {node_id for node_id, upstream in ancestors.items() if starts[0].id in upstream} | {starts[0].id}
        for node in graph.nodes:
            if node.id not in reachable:
                issues.append(_issue(f"graph.nodes.{index_of[node.id]}", "flow_unreachable", f"「{node.title}」没有从「流程开始」连过来，不会被执行", "warning"))

    for node in graph.nodes:
        path = f"graph.nodes.{index_of[node.id]}"
        if node.kind in BRANCH_KINDS:
            used = {edge.source_handle for edge in graph.edges if edge.source == node.id}
            labels = _branch_labels(node)
            for handle, label in zip(branch_handles(node), labels, strict=False):
                if handle not in used:
                    issues.append(_issue(path, "flow_branch_open", f"「{node.title}」的分支「{label}」没有连线，命中时流程会直接结束", "warning"))
        for key, text in _templates(node):
            for match in VAR.finditer(text):
                ref, field = match.group(1), (match.group(2) or ".")[1:].split(".")[0]
                if ref in LOOP_VARS and node.kind == "loop" and key == "prompt":
                    continue
                if ref not in nodes:
                    issues.append(_issue(f"{path}.config.{key}", "flow_ref_unknown", f"「{node.title}」引用了不存在的节点：{match.group(0)}"))
                elif ref not in ancestors[node.id]:
                    issues.append(_issue(f"{path}.config.{key}", "flow_ref_downstream", f"「{node.title}」引用的「{nodes[ref].title}」不在它的上游：{match.group(0)}"))
                elif field and field not in output_fields(nodes[ref], manifest):
                    issues.append(_issue(f"{path}.config.{key}", "flow_ref_field", f"「{node.title}」引用的字段不存在：{match.group(0)}"))
        issues.extend(_node_issues(node, path))
    return issues


def _branch_labels(node: FlowNode) -> list[str]:
    if node.kind == "ifelse":
        return ["条件成立", "否则"]
    return list(node.config["categories"] if node.kind == "classify" else node.config["options"])


def _node_issues(node: FlowNode, path: str) -> list[dict[str, str]]:
    config = node.config
    title = node.title
    problems: list[tuple[str, str]] = []
    if node.kind == "llm" and not config["prompt"].strip():
        problems.append(("prompt", "用户提示词不能为空"))
    if node.kind == "kb" and not config["knowledge_base_ids"]:
        problems.append(("knowledge_base_ids", "请选择至少一个知识库"))
    if node.kind == "classify" and len([item for item in config["categories"] if item.strip()]) < 2:
        problems.append(("categories", "至少需要两个分类"))
    if node.kind == "extract" and not config["fields"]:
        problems.append(("fields", "请添加要提取的字段"))
    if node.kind == "ifelse" and not config["conditions"]:
        problems.append(("conditions", "请添加判断条件"))
    if node.kind == "ifelse" and any(not condition["left"].strip() for condition in config["conditions"]):
        problems.append(("conditions", "判断条件缺少比较对象"))
    if node.kind == "loop" and not config["items"].strip():
        problems.append(("items", "请指定要逐项处理的列表"))
    if node.kind == "form" and not config["fields"]:
        problems.append(("fields", "请添加表单字段"))
    if node.kind == "choice" and len([item for item in config["options"] if item.strip()]) < 2:
        problems.append(("options", "至少需要两个选项"))
    if node.kind == "tool" and not config["tool_id"]:
        problems.append(("tool_id", "请选择工具"))
    if node.kind in {"answer", "template"} and not config["template"].strip():
        problems.append(("template", "内容不能为空"))
    keys = [field["key"] for field in config.get("fields", [])] if node.kind in {"form", "extract"} else []
    if len(set(keys)) != len(keys):
        problems.append(("fields", "字段 key 不能重复"))
    return [_issue(f"{path}.config.{key}", f"flow_{node.kind}_config", f"「{title}」：{message}") for key, message in problems]


def _issue(path: str, code: str, message: str, severity: str = "error") -> dict[str, str]:
    return {"path": path, "code": code, "message": message, "severity": severity}


def referenced_model_ids(manifest: Manifest) -> list[str]:
    graph = manifest.graph
    return [node.config["model_id"] for node in graph.nodes if node.kind in MODEL_KINDS and node.config.get("model_id")] if graph else []


def referenced_tool_ids(manifest: Manifest) -> list[str]:
    graph = manifest.graph
    return [node.config["tool_id"] for node in graph.nodes if node.kind == "tool" and node.config.get("tool_id")] if graph else []


def form_fields(manifest: Manifest) -> list[InputField]:
    graph = manifest.graph
    if not graph:
        return []
    return [InputField.model_validate(field) for node in graph.nodes if node.kind == "form" for field in node.config["fields"]]


# ---------------------------------------------------------------- 变量

def _lookup(scope: dict[str, Any], ref: str, path: str) -> Any:
    value = scope.get(ref)
    for part in [item for item in path.split(".") if item]:
        if isinstance(value, dict):
            value = value.get(part)
        elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        else:
            return None
    return value


def stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, int | float):
        return str(value)
    if isinstance(value, list) and all(isinstance(item, str | int | float) for item in value):
        return "\n".join(str(item) for item in value)
    return json.dumps(value, ensure_ascii=False)


def render(text: str, scope: dict[str, Any]) -> str:
    return VAR.sub(lambda match: stringify(_lookup(scope, match.group(1), match.group(2))), text or "")


def resolve(text: str, scope: dict[str, Any]) -> Any:
    """整段只有一个变量引用时保留原始类型（列表、数字），否则按文本渲染。"""
    match = VAR.fullmatch((text or "").strip())
    return _lookup(scope, match.group(1), match.group(2)) if match else render(text, scope)


def as_items(value: Any, limit: int) -> list[Any]:
    """批量生成的输入：列表直接用；文本先尝试解析 JSON，再按行拆分（去掉序号和列表符号）。"""
    if isinstance(value, str):
        text = value.strip()
        try:
            value = json.loads(text) if text[:1] in "[{" else value
        except json.JSONDecodeError:
            pass
    if isinstance(value, dict):
        value = next((item for item in value.values() if isinstance(item, list)), [value])
    if isinstance(value, str):
        lines = [re.sub(r"^\s*(?:[-*•]|#+|\d+[.、)]|[一二三四五六七八九十]+、)\s*", "", line).strip() for line in value.splitlines()]
        value = [line for line in lines if line]
    if not isinstance(value, list):
        value = [] if value in (None, "") else [value]
    return value[:limit]


def compare(left: Any, operator: str, right: str) -> bool:
    if operator in {"empty", "not_empty"}:
        empty = left in (None, "", [], {})
        return empty if operator == "empty" else not empty
    if operator in {"contains", "not_contains"}:
        hit = any(stringify(item) == right for item in left) if isinstance(left, list) else right in stringify(left)
        return hit if operator == "contains" else not hit
    if operator in {"equals", "not_equals"}:
        same = stringify(left).strip() == right.strip()
        return same if operator == "equals" else not same
    try:
        number, target = float(stringify(left).strip()), float(right.strip())
    except ValueError:
        return False
    return {"gt": number > target, "gte": number >= target, "lt": number < target, "lte": number <= target}[operator]


# ---------------------------------------------------------------- 执行

class _Run:
    def __init__(self, session: AsyncSession, manifest: Manifest, *, workspace_id: str, history: list[Any], spans: list[dict[str, Any]] | None) -> None:
        self.session = session
        self.manifest = manifest
        self.workspace_id = workspace_id
        self.history = history
        self.spans = spans
        self.gateways: dict[str, Any] = {}
        self.model_info: dict[str, Any] | None = None
        self.tokens: dict[str, int | None] = {"input": None, "output": None, "total": None}
        self.simulated = False

    async def gateway(self, model_id: str | None) -> Any:
        from .runtime import model_snapshot

        model_id = model_id or self.manifest.llm_model_id
        if not model_id:
            raise ValueError("没有选择对话模型")
        if model_id not in self.gateways:
            model = await self.session.get(ModelConfig, model_id)
            if model is None or model.workspace_id != self.workspace_id or model.model_type != ModelType.LLM or not model.is_enabled:
                raise ValueError("节点使用的模型不存在、已停用或不属于当前空间")
            gateway = build_gateway(model)
            self.gateways[model_id] = gateway
            self.simulated = self.simulated or bool(gateway.is_simulated)
            if self.model_info is None or model_id == self.manifest.llm_model_id:
                self.model_info = model_snapshot(model, simulated=bool(gateway.is_simulated))
        return self.gateways[model_id]

    async def chat(self, gateway: Any, system: str, prompt: str, *, temperature: float | None = None, max_tokens: int | None = None, history: list[BaseMessage] | None = None) -> str:
        from .runtime import _content_text, _sum_usage, _usage

        model = gateway.chat_model(
            temperature=self.manifest.model.temperature if temperature is None else temperature,
            max_tokens=max_tokens or self.manifest.model.max_tokens,
        )
        response = await model.ainvoke([SystemMessage(content=system or "你是一个业务助手。"), *(history or []), HumanMessage(content=prompt)])
        _sum_usage(self.tokens, _usage(response))
        text = _content_text(response.content).strip()
        if not text:
            raise ValueError("模型返回了空内容")
        return text

    def system(self, node_prompt: str) -> str:
        return "\n\n".join(part for part in (self.manifest.system_prompt.strip(), node_prompt.strip()) if part)


def _echo(gateway: Any) -> bool:
    """测试替身没有配置固定回复时，用确定性的回显代替模型输出，方便看清每一步拿到了什么。"""
    return bool(gateway.is_simulated) and not getattr(gateway, "response_text", None)


async def _run_node(run: _Run, node: FlowNode, scope: dict[str, Any], state: dict[str, Any]) -> tuple[dict[str, Any], str | None, dict[str, Any]]:
    """执行一个节点，返回 (输出, 命中分支, Span 附加信息)。"""
    from .runtime import _citation, _context, _extract_json, _history

    config = node.config
    if node.kind == "llm":
        gateway = await run.gateway(config["model_id"])
        prompt = render(config["prompt"], scope)
        if _echo(gateway):
            text = f"【{node.title} · 测试替身】\n{prompt[:800]}"
            _add_mock_usage(run)
        else:
            history = _history(run.history, run.manifest.memory.max_turns) if config["history"] and run.manifest.memory.enabled else []
            text = await run.chat(gateway, run.system(render(config["system_prompt"], scope)), prompt, temperature=config["temperature"], max_tokens=config["max_tokens"], history=history)
        return {"text": text}, None, {"prompt": prompt[:2000]}

    if node.kind == "kb":
        query = render(config["query"], scope).strip() or str(scope["start"]["query"])
        bases = {item.id: item for item in await run.session.scalars(select(KnowledgeBase).where(KnowledgeBase.id.in_(config["knowledge_base_ids"]), KnowledgeBase.workspace_id == run.workspace_id))}
        if set(bases) != set(config["knowledge_base_ids"]):
            raise ValueError("所选知识库不存在或不属于当前空间")
        fusion: dict[str, float] = {}
        chunks: dict[str, RetrievedChunk] = {}
        recalls = []
        for knowledge_base_id in config["knowledge_base_ids"]:
            result = await retrieve_knowledge_base(
                run.session, bases[knowledge_base_id], query, top_k=config["top_k"], rerank_top_n=min(config["rerank_top_n"], config["top_k"]),
                score_threshold=config["score_threshold"], mode=config["mode"],
            )
            run.simulated = run.simulated or result.simulated
            recalls.append({"knowledge_base": bases[knowledge_base_id].name, "recalled": result.recalled_count, "returned": len(result.results)})
            for rank, item in enumerate(result.results, start=1):
                fusion[item.chunk_id] = fusion.get(item.chunk_id, 0.0) + 1.0 / (10 + rank)
                chunks[item.chunk_id] = item
        ranked = sorted(chunks.values(), key=lambda item: fusion[item.chunk_id], reverse=True)
        context, used = _context(ranked, config["max_context_chars"])
        known = {item["chunk_id"] for item in state["citations"]}
        state["citations"].extend(_citation(item) for item in used if item.chunk_id not in known)
        return {"context": context, "count": len(used)}, None, {"query": query, "mode": config["mode"], "recalls": recalls}

    if node.kind == "classify":
        categories = [item for item in config["categories"] if item.strip()]
        text = render(config["input"], scope)
        gateway = await run.gateway(config["model_id"])
        if _echo(gateway):
            index = next((position for position, name in enumerate(categories) if name in text), len(categories) - 1)
            _add_mock_usage(run)
        else:
            listing = "\n".join(f"{position + 1}. {name}" for position, name in enumerate(categories))
            answer = await run.chat(gateway, run.system("你是一个分类器。"), f"判断下面的内容属于哪一类，只输出类别编号。\n\n类别：\n{listing}\n\n{render(config['instruction'], scope)}\n\n内容：\n{text}", temperature=0, max_tokens=64)
            number = re.search(r"\d+", answer)
            index = int(number.group()) - 1 if number and 0 < int(number.group()) <= len(categories) else next((position for position, name in enumerate(categories) if name in answer), len(categories) - 1)
        return {"category": categories[index]}, f"b{config['categories'].index(categories[index])}", {"input": text[:1000]}

    if node.kind == "extract":
        text = render(config["input"], scope)
        fields = config["fields"]
        gateway = await run.gateway(config["model_id"])
        if _echo(gateway):
            raw: dict[str, Any] = {}
            for field in fields:
                found = re.search(rf"{re.escape(field['label'])}\s*[:：]\s*([^\n，。；;,]+)", text)
                raw[field["key"]] = found.group(1).strip() if found else None
            _add_mock_usage(run)
        else:
            spec = "\n".join(f"- {field['key']}（{field['label']}，{field['type']}）{field['description']}" for field in fields)
            answer = await run.chat(gateway, run.system("你负责从文本中提取结构化信息。"), f"从下面的内容中提取字段，只输出一个 JSON 对象，键为字段 key，找不到的填 null。\n\n字段：\n{spec}\n\n内容：\n{text}", temperature=0)
            parsed = _extract_json(answer)
            raw = parsed if isinstance(parsed, dict) else {}
        values = {field["key"]: _coerce(raw.get(field["key"]), field["type"]) for field in fields}
        return {**values, "json": values}, None, {"input": text[:1000]}

    if node.kind == "ifelse":
        results = [compare(resolve(item["left"], scope), item["operator"], render(item["right"], scope)) for item in config["conditions"]]
        passed = all(results) if config["logic"] == "and" else any(results)
        return {"result": passed}, "b0" if passed else "b1", {"conditions": results}

    if node.kind in {"template", "answer"}:
        text = render(config["template"], scope)
        if node.kind == "answer":
            state["answers"].append(text)
        return {"text": text}, None, {}

    if node.kind == "loop":
        items = as_items(resolve(config["items"], scope), config["max_items"])
        if not items:
            raise ValueError("要逐项处理的列表为空")
        gateway = await run.gateway(config["model_id"])
        system = run.system(render(config["system_prompt"], scope))
        semaphore = asyncio.Semaphore(config["parallel"])

        async def one(index: int, item: Any) -> str:
            prompt = render(config["prompt"], {**scope, "item": item, "index": index + 1})
            if _echo(gateway):
                _add_mock_usage(run)
                return f"【第 {index + 1} 项 · 测试替身】\n{prompt[:400]}"
            async with semaphore:
                return await run.chat(gateway, system, prompt)

        results = list(await asyncio.gather(*(one(index, item) for index, item in enumerate(items))))
        return {"results": results, "text": config["separator"].replace("\\n", "\n").join(results), "count": len(results)}, None, {"items": len(items)}

    if node.kind == "tool":
        tool = await run.session.scalar(select(ToolConfig).where(ToolConfig.id == config["tool_id"], ToolConfig.workspace_id == run.workspace_id, ToolConfig.is_enabled.is_(True)))
        if tool is None:
            raise ValueError("所选工具不存在、已停用或不属于当前空间")
        arguments = {key: resolve(value, scope) for key, value in config["arguments"].items()}
        result = await execute_http_tool(tool, arguments)
        return {"result": result["content"], "json": result.get("data")}, None, {"tool": tool.name, "arguments": arguments}

    if node.kind == "start":
        return dict(scope["start"]), None, {}
    raise ValueError(f"不支持的节点类型：{node.kind}")


def _add_mock_usage(run: _Run) -> None:
    from .runtime import _sum_usage

    _sum_usage(run.tokens, {"input": 12, "output": 16, "total": 28})


def _coerce(value: Any, kind: str) -> Any:
    if value in (None, ""):
        return [] if kind == "list" else None
    if kind == "number":
        try:
            number = float(re.sub(r"[^\d.\-]", "", str(value)))
            return int(number) if number.is_integer() else number
        except ValueError:
            return None
    if kind == "boolean":
        return value if isinstance(value, bool) else str(value).strip().lower() in {"true", "1", "是", "yes", "有"}
    if kind == "list":
        return value if isinstance(value, list) else [item.strip() for item in re.split(r"[、,，;；\n]", str(value)) if item.strip()]
    return value if isinstance(value, str) else stringify(value)


def _waiting(node: FlowNode, scope: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {"node_id": node.id, "kind": node.kind, "title": node.title, "prompt": render(node.config["prompt"], scope)}
    if node.kind == "form":
        payload["fields"] = node.config["fields"]
    else:
        payload["options"] = [item for item in node.config["options"] if item.strip()]
    return payload


def _submit(node: FlowNode, values: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
    """校验用户在表单 / 选择里提交的内容，返回 (节点输出, 命中分支)。"""
    if node.kind == "choice":
        choice = str(values.get("choice") or "")
        if choice not in node.config["options"]:
            raise ValueError("请选择一个有效选项")
        return {"choice": choice}, f"b{node.config['options'].index(choice)}"
    output: dict[str, Any] = {}
    for raw in node.config["fields"]:
        field = InputField.model_validate(raw)
        value = values.get(field.key, field.default)
        try:
            validate_input_value(field, value, path=field.label)
        except ValueError as exc:
            raise ValueError(str(exc).replace(f"{field.label} is required", f"请填写「{field.label}」")) from exc
        output[field.key] = value
    return output, None


def submission_summary(state: dict[str, Any], values: dict[str, Any]) -> str:
    """恢复运行时写进会话的用户消息，例如「主题：储能行业」。"""
    waiting = state.get("waiting_payload") or {}
    if waiting.get("kind") == "choice":
        return str(values.get("choice") or "")
    lines = [f"{field['label']}：{stringify(values.get(field['key'], field.get('default')))}" for field in waiting.get("fields", [])]
    return "\n".join(lines) or "已提交"


def _preview(output: dict[str, Any]) -> str:
    return stringify({key: value for key, value in output.items() if key != "json"} if len(output) > 1 else next(iter(output.values()), ""))[:2000]


async def execute_chatflow(
    session: AsyncSession,
    manifest: Manifest,
    *,
    query: str,
    input_values: dict[str, Any],
    history: list[Any],
    workspace_id: str,
    spans: list[dict[str, Any]] | None = None,
    resume: tuple[dict[str, Any], dict[str, Any]] | None = None,
    interactive: bool = True,
) -> dict[str, Any]:
    from .runtime import _span

    started = monotonic()
    graph = manifest.graph
    errors = [issue for issue in graph_issues(manifest) if issue["severity"] == "error"]
    if errors:
        raise ValueError(f"流程配置有误：{errors[0]['message']}")
    assert graph is not None
    order = topological_order(manifest) or []
    nodes = {node.id: node for node in graph.nodes}
    incoming: dict[str, list[Any]] = defaultdict(list)
    outgoing: dict[str, list[Any]] = defaultdict(list)
    for edge in graph.edges:
        incoming[edge.target].append(edge)
        outgoing[edge.source].append(edge)
    run = _Run(session, manifest, workspace_id=workspace_id, history=history, spans=spans)
    await run.gateway(None)  # 先校验默认模型，并确定计费归属

    def finish(node_id: str, output: dict[str, Any], handle: str | None) -> None:
        state["outputs"][node_id] = output
        state["status"][node_id] = "success"
        for edge in outgoing[node_id]:
            state["edges"][edge.id] = "active" if handle is None or edge.source_handle == handle else "inactive"

    if resume:
        state = copy.deepcopy(resume[0])
        node = nodes.get(state.get("waiting") or "")
        if node is None or state.get("graph") != graph_fingerprint(manifest):
            raise ValueError("流程已修改，这一步无法继续，请开始新对话")
        output, handle = _submit(node, resume[1])
        finish(node.id, output, handle)
        state.update(waiting=None, waiting_payload=None, answers=[])
        _span(spans, "flow", node.title, duration_ms=0, detail=_preview(output) or "已提交", node_id=node.id, node_kind=node.kind)
    else:
        state = {"graph": graph_fingerprint(manifest), "outputs": {}, "status": {}, "durations": {}, "edges": {}, "citations": [], "answers": [], "waiting": None, "waiting_payload": None}
        state["outputs"]["start"] = {"query": query, **input_values}

    for node_id in order:
        if node_id in state["status"]:
            continue
        node = nodes[node_id]
        if node.kind != "start" and not any(state["edges"].get(edge.id) == "active" for edge in incoming[node_id]):
            state["status"][node_id] = "skipped"
            for edge in outgoing[node_id]:
                state["edges"][edge.id] = "inactive"
            continue
        scope = {key: value for key, value in state["outputs"].items()}
        scope["start"] = state["outputs"].get("start", {})
        if node.kind in INTERACTIVE_KINDS:
            if interactive:
                state["status"][node_id] = "waiting"
                state["waiting"] = node_id
                state["waiting_payload"] = _waiting(node, scope)
                _span(spans, "flow", node.title, duration_ms=0, status="waiting", detail="等待用户" + ("填写表单" if node.kind == "form" else "选择"), node_id=node.id, node_kind=node.kind)
                break
            # 非交互运行（评测）：表单取用例输入或默认值，用户选择取第一个选项
            values = {"choice": node.config["options"][0] if node.config["options"] else ""} if node.kind == "choice" else {
                field["key"]: input_values.get(field["key"], field.get("default")) for field in node.config["fields"]
            }
            output, handle = _submit(node, values)
            finish(node_id, output, handle)
            _span(spans, "flow", node.title, duration_ms=0, detail=f"自动填写：{_preview(output)}", node_id=node.id, node_kind=node.kind)
            continue
        step_started = monotonic()
        before = dict(run.tokens)
        try:
            output, handle, extra = await _run_node(run, node, scope, state)
        except Exception as exc:
            _span(spans, SPAN_KIND.get(node.kind, "flow"), node.title, started=step_started, status="error", detail=str(exc), node_id=node.id, node_kind=node.kind)
            if isinstance(exc, ValueError):
                raise ValueError(f"「{node.title}」：{exc}") from exc
            raise
        state["durations"][node_id] = int((monotonic() - step_started) * 1000)
        finish(node_id, output, handle)
        used = {key: (run.tokens[key] or 0) - (before[key] or 0) for key in run.tokens} if node.kind in MODEL_KINDS else None
        _span(
            spans, SPAN_KIND.get(node.kind, "flow"), node.title, duration_ms=state["durations"][node_id], detail=_preview(output),
            node_id=node.id, node_kind=node.kind, branch=handle, **({"tokens": used} if used else {}), **extra,
        )

    waiting = state.get("waiting_payload")
    parts = [part for part in state["answers"] if part.strip()]
    if waiting and waiting.get("prompt"):
        parts.append(waiting["prompt"])
    content = "\n\n".join(parts) or ("请完成下面的步骤后继续。" if waiting else "流程已结束，这条分支没有设置回复内容。")

    blocked = next((topic for topic in manifest.guardrails.blocked_topics if topic.lower() in content.lower()), None)
    if blocked:
        content = "生成内容触及已配置的禁止主题，已停止输出。"
        _span(spans, "guardrail", "禁止话题拦截", status="blocked", detail=f"命中：{blocked}", topic=blocked)
    elif len(content) > manifest.guardrails.max_output_chars:
        _span(spans, "guardrail", "输出截断", status="warning", detail=f"超过 {manifest.guardrails.max_output_chars} 字，已截断")
        content = content[: manifest.guardrails.max_output_chars]
    tokens = dict(run.tokens)
    if tokens["total"] is None and tokens["input"] is not None and tokens["output"] is not None:
        tokens["total"] = tokens["input"] + tokens["output"]
    return {
        "content": content,
        "citations": list(state["citations"]),
        "tokens": tokens,
        "duration_ms": int((monotonic() - started) * 1000),
        "simulated": run.simulated,
        "output_json": None,
        "handoff": False,
        "agent_steps": [],
        "model": run.model_info,
        "flow": {
            "status": "waiting" if waiting else "completed",
            "waiting": waiting,
            "nodes": [{"id": node_id, "status": status, "duration_ms": state["durations"].get(node_id)} for node_id, status in state["status"].items()],
        },
        "flow_state": state if waiting else None,
    }
