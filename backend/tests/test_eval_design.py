from __future__ import annotations

import json

from httpx import AsyncClient

from tests.test_fde_api import ADMIN, content_inputs
from tests.test_observability import content_app, priced_mock_llm


async def _app_with_designer(client: AsyncClient, cases: list[dict]) -> str:
    app_id = await content_app(client, await priced_mock_llm(client))
    designer = await client.post(
        "/api/v1/models", headers=ADMIN,
        json={"display_name": "设计 LLM", "provider": "mock", "model_type": "llm", "model_name": "designer", "config": {"response_text": json.dumps(cases, ensure_ascii=False)}},
    )
    manifest = (await client.get(f"/api/v1/fde/apps/{app_id}", headers=ADMIN)).json()["manifest"]
    manifest["llm_model_id"] = designer.json()["id"]
    assert (await client.put(f"/api/v1/fde/apps/{app_id}/manifest", headers=ADMIN, json={"manifest": manifest})).status_code == 200
    return app_id


async def test_rules_are_recommended_by_scene(client: AsyncClient) -> None:
    app_id = await content_app(client, await priced_mock_llm(client))
    body = (await client.get("/api/v1/evaluation-sets/design-rules", headers=ADMIN, params={"app_id": app_id})).json()
    assert {"format", "generation_quality"} <= set(body["recommended"])
    assert "knowledge_fact" not in body["recommended"]  # content app has no knowledge base


async def test_ai_design_keeps_only_runnable_cases_and_they_run(client: AsyncClient) -> None:
    valid = {"rule": "generation_quality", "name": "汽锅鸡小红书文案", "message": "", "input_values": content_inputs(), "expected_keywords": ["汽锅鸡"], "forbidden_keywords": [], "require_citations": False}
    no_standard = {**valid, "name": "没有判定标准", "expected_keywords": []}
    missing_input = {**valid, "name": "缺必填", "input_values": {"tone": "亲切"}}
    app_id = await _app_with_designer(client, [valid, no_standard, missing_input])

    created = await client.post(
        "/api/v1/evaluation-sets/ai-design", headers=ADMIN,
        json={"app_id": app_id, "rule_keys": ["generation_quality", "format"], "directions": "突出地方特色", "count": 5},
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert [case["name"] for case in body["cases"]] == ["汽锅鸡小红书文案"]
    case = body["cases"][0]
    assert case["case_type"] == "ai" and case["readiness"] == "ready"
    assert case["tags"] == ["AI 设计", "生成质量"]

    ran = await client.post(f"/api/v1/evaluation-sets/{body['id']}/run", headers=ADMIN)
    assert ran.status_code == 200, ran.text
    assert ran.json()["failed_count"] + ran.json()["passed_count"] == 1


async def test_ai_design_requires_rules_or_directions_and_a_model(client: AsyncClient) -> None:
    app_id = await _app_with_designer(client, [])
    empty = await client.post("/api/v1/evaluation-sets/ai-design", headers=ADMIN, json={"app_id": app_id, "rule_keys": [], "directions": ""})
    assert empty.status_code == 422 and "规则" in empty.json()["detail"]
    nothing = await client.post("/api/v1/evaluation-sets/ai-design", headers=ADMIN, json={"app_id": app_id, "rule_keys": ["format"]})
    assert nothing.status_code == 422  # model produced no runnable cases


async def test_ai_design_falls_back_to_rule_templates_without_a_real_model(client: AsyncClient) -> None:
    app_id = await content_app(client, await priced_mock_llm(client))
    manifest = (await client.get(f"/api/v1/fde/apps/{app_id}", headers=ADMIN)).json()["manifest"]
    manifest["llm_model_id"] = None
    assert (await client.put(f"/api/v1/fde/apps/{app_id}/manifest", headers=ADMIN, json={"manifest": manifest})).status_code == 200
    rules = (await client.get("/api/v1/evaluation-sets/design-rules", headers=ADMIN, params={"app_id": app_id})).json()
    assert rules["has_model"] is False

    created = await client.post(
        "/api/v1/evaluation-sets/ai-design", headers=ADMIN,
        json={"app_id": app_id, "rule_keys": ["generation_quality", "safety"], "directions": "", "count": 4},
    )
    assert created.status_code == 201, created.text
    cases = created.json()["cases"]
    assert cases and all("规则模板" in case["tags"] for case in cases)
    assert all(case["expected_keywords"] or case["forbidden_keywords"] or case["require_citations"] for case in cases)
