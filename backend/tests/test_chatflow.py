from __future__ import annotations

from typing import Any

from httpx import AsyncClient

from app.fde.flow import as_items, compare, render, resolve
from tests.test_fde_api import ADMIN
from tests.test_observability import priced_mock_llm


def node(node_id: str, kind: str, x: float, **config: Any) -> dict[str, Any]:
    return {"id": node_id, "kind": kind, "title": node_id, "position": {"x": x, "y": 0}, "config": config}


def edge(source: str, target: str, handle: str | None = None) -> dict[str, Any]:
    return {"id": f"{source}-{handle or 'o'}-{target}", "source": source, "target": target, "source_handle": handle}


def flow_manifest(model_id: str, nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "type": "chatflow", "name": "流程测试", "template_key": "qa", "system_prompt": "你是业务助手。", "llm_model_id": model_id,
        "graph": {"nodes": nodes, "edges": edges},
    }


async def create_flow(client: AsyncClient, model_id: str, nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> str:
    created = await client.post("/api/v1/fde/apps", headers=ADMIN, json={"manifest": flow_manifest(model_id, nodes, edges)})
    assert created.status_code == 201, created.text
    return created.json()["id"]


SERVICE_NODES = [
    node("start", "start", 0),
    node("cls", "classify", 300, categories=["退款", "发票"]),
    node("refund", "answer", 600, template="退款流程：{{start.query}}"),
    node("confirm", "choice", 600, prompt="确认为「{{start.query}}」开票吗？", options=["确认", "取消"]),
    node("issued", "answer", 900, template="已为你开票（{{confirm.choice}}）"),
    node("cancelled", "answer", 900, template="已取消"),
]
SERVICE_EDGES = [edge("start", "cls"), edge("cls", "refund", "b0"), edge("cls", "confirm", "b1"), edge("confirm", "issued", "b0"), edge("confirm", "cancelled", "b1")]


async def test_branches_pause_on_choice_and_resume_once(client: AsyncClient) -> None:
    app_id = await create_flow(client, await priced_mock_llm(client), SERVICE_NODES, SERVICE_EDGES)

    refund = (await client.post(f"/api/v1/fde/apps/{app_id}/preview", headers=ADMIN, json={"message": "我要退款"})).json()
    assert refund["content"] == "退款流程：我要退款"
    statuses = {item["id"]: item["status"] for item in refund["flow"]["nodes"]}
    assert statuses["refund"] == "success" and statuses["confirm"] == "skipped" and statuses["issued"] == "skipped"
    assert "flow_state" not in refund

    first = await client.post(f"/api/v1/fde/apps/{app_id}/preview", headers=ADMIN, json={"message": "我要开发票"})
    assert first.status_code == 200, first.text
    body = first.json()
    assert body["flow"]["status"] == "waiting"
    assert body["flow"]["waiting"] == {"node_id": "confirm", "kind": "choice", "title": "confirm", "prompt": "确认为「我要开发票」开票吗？", "options": ["确认", "取消"]}
    assert body["content"] == "确认为「我要开发票」开票吗？"
    conversation_id, paused_id = body["conversation_id"], body["message_id"]

    restored = (await client.get(f"/api/v1/fde/conversations/{conversation_id}", headers=ADMIN)).json()
    assert restored["messages"][-1]["flow_waiting"]["node_id"] == "confirm"

    bad = await client.post(f"/api/v1/fde/apps/{app_id}/preview", headers=ADMIN, json={"conversation_id": conversation_id, "resume": {"message_id": paused_id, "values": {"choice": "随便"}}})
    assert bad.status_code == 422

    resumed = await client.post(f"/api/v1/fde/apps/{app_id}/preview", headers=ADMIN, json={"conversation_id": conversation_id, "resume": {"message_id": paused_id, "values": {"choice": "确认"}}})
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["content"] == "已为你开票（确认）"
    assert resumed.json()["flow"]["status"] == "completed"

    detail = (await client.get(f"/api/v1/fde/conversations/{conversation_id}", headers=ADMIN)).json()
    assert [(item["role"], item["content"]) for item in detail["messages"]] == [
        ("user", "我要开发票"), ("assistant", "确认为「我要开发票」开票吗？"), ("user", "确认"), ("assistant", "已为你开票（确认）"),
    ]
    assert all(item["flow_waiting"] is None for item in detail["messages"])

    again = await client.post(f"/api/v1/fde/apps/{app_id}/preview", headers=ADMIN, json={"conversation_id": conversation_id, "resume": {"message_id": paused_id, "values": {"choice": "取消"}}})
    assert again.status_code == 409

    trace = (await client.get(f"/api/v1/observability/runs/{resumed.json()['trace_id']}", headers=ADMIN)).json()
    assert [span["name"] for span in trace["spans"]] == ["confirm", "issued"]


REPORT_NODES = [
    node("start", "start", 0),
    node("brief", "form", 250, prompt="先告诉我报告主题", fields=[{"key": "topic", "label": "报告主题", "type": "text", "required": True}]),
    node("outline", "llm", 500, prompt="为「{{brief.topic}}」列出章节：\n1. 背景\n2. 现状"),
    node("chapters", "loop", 750, items="{{outline.text}}", prompt="撰写第 {{index}} 章：{{item}}（主题 {{brief.topic}}）", max_items=4),
    node("merge", "template", 1000, template="# {{brief.topic}}\n\n{{chapters.text}}"),
    node("out", "answer", 1250, template="{{merge.text}}"),
]
REPORT_EDGES = [edge("start", "brief"), edge("brief", "outline"), edge("outline", "chapters"), edge("chapters", "merge"), edge("merge", "out")]


async def test_form_then_batch_generation_and_evaluation_autofills_form(client: AsyncClient) -> None:
    app_id = await create_flow(client, await priced_mock_llm(client), REPORT_NODES, REPORT_EDGES)

    paused = (await client.post(f"/api/v1/fde/apps/{app_id}/preview", headers=ADMIN, json={"message": "写份报告"})).json()
    assert paused["flow"]["waiting"]["fields"][0]["key"] == "topic"
    missing = await client.post(f"/api/v1/fde/apps/{app_id}/preview", headers=ADMIN, json={"conversation_id": paused["conversation_id"], "resume": {"message_id": paused["message_id"], "values": {}}})
    assert missing.status_code == 422 and "报告主题" in missing.json()["detail"]["message"]

    # A failed submission leaves the step open, so the user can fix the form and submit again.
    done = await client.post(f"/api/v1/fde/apps/{app_id}/preview", headers=ADMIN, json={"conversation_id": paused["conversation_id"], "resume": {"message_id": paused["message_id"], "values": {"topic": "储能行业"}}})
    assert done.status_code == 200, done.text
    content = done.json()["content"]
    assert content.startswith("# 储能行业") and "第 4 项" in content and "第 5 项" not in content
    assert done.json()["tokens"]["total"] == 28 * 5  # outline + 4 chapters

    suite = (await client.post("/api/v1/evaluation-sets", headers=ADMIN, json={"app_id": app_id, "name": "报告回归"})).json()["id"]
    case = await client.post(f"/api/v1/evaluation-sets/{suite}/cases", headers=ADMIN, json={"name": "储能", "message": "写份报告", "input_values": {"topic": "储能行业"}, "expected_keywords": ["储能行业"]})
    assert case.status_code == 201, case.text
    ran = (await client.post(f"/api/v1/evaluation-sets/{suite}/run", headers=ADMIN)).json()
    assert ran["passed_count"] == 1, ran


async def test_validation_reports_cycles_dangling_refs_and_missing_answer(client: AsyncClient) -> None:
    model_id = await priced_mock_llm(client)
    nodes = [node("start", "start", 0), node("a", "llm", 300, prompt="{{b.text}}"), node("b", "template", 600, template="{{a.text}}")]
    app_id = await create_flow(client, model_id, nodes, [edge("start", "a"), edge("a", "b"), edge("b", "a")])
    codes = {item["code"] for item in (await client.post(f"/api/v1/fde/apps/{app_id}/validate", headers=ADMIN)).json()["issues"]}
    assert {"flow_cycle", "flow_answer"} <= codes

    nodes = [node("start", "start", 0), node("a", "llm", 300, prompt="{{b.text}} {{start.nope}}"), node("b", "answer", 600, template="{{a.text}}"), node("orphan", "template", 900, template="x")]
    app_id = await create_flow(client, model_id, nodes, [edge("start", "a"), edge("a", "b")])
    issues = (await client.post(f"/api/v1/fde/apps/{app_id}/validate", headers=ADMIN)).json()["issues"]
    codes = {item["code"]: item["severity"] for item in issues}
    assert codes["flow_ref_downstream"] == "error" and codes["flow_ref_field"] == "error" and codes["flow_unreachable"] == "warning"
    run = await client.post(f"/api/v1/fde/apps/{app_id}/preview", headers=ADMIN, json={"message": "hi"})
    assert run.status_code == 422 and "流程配置有误" in run.json()["detail"]["message"]

    broken = flow_manifest(model_id, [node("start", "start", 0)], [edge("start", "ghost")])
    assert (await client.post("/api/v1/fde/apps", headers=ADMIN, json={"manifest": broken})).status_code == 422
    simple_with_graph = {**flow_manifest(model_id, [node("start", "start", 0)], []), "type": "simple"}
    assert (await client.post("/api/v1/fde/apps", headers=ADMIN, json={"manifest": simple_with_graph})).status_code == 422


def test_variable_helpers() -> None:
    scope = {"start": {"query": "你好"}, "x": {"json": {"items": ["甲", "乙"], "n": 3}}}
    assert render("问：{{start.query}}，项：{{x.json.items}}，缺：{{x.none}}", scope) == "问：你好，项：甲\n乙，缺："
    assert resolve("{{x.json.items}}", scope) == ["甲", "乙"]
    assert resolve(" {{ x.json.n }} ", scope) == 3
    assert as_items("1. 背景\n- 现状\n\n## 展望", 10) == ["背景", "现状", "展望"]
    assert as_items('{"chapters": [{"title": "一"}]}', 10) == [{"title": "一"}]
    assert compare(3, "gt", "2") and not compare("abc", "gt", "1") and compare([], "empty", "") and compare(["高"], "contains", "高")
