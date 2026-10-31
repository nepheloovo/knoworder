from __future__ import annotations

import json

import pytest
from httpx import AsyncClient

from app.services.eval_judge import parse_verdict
from tests.test_fde_api import ADMIN
from tests.test_observability import content_app, priced_mock_llm
from tests.test_release_gate import _gate_suite


async def _judge(client: AsyncClient, reply: str) -> str:
    created = await client.post(
        "/api/v1/models", headers=ADMIN,
        json={"display_name": "评委", "provider": "mock", "model_type": "llm", "model_name": "judge", "config": {"response_text": reply}},
    )
    assert created.status_code == 201, created.text
    return created.json()["id"]


def test_verdict_parsing_clamps_score_and_rejects_garbage() -> None:
    assert parse_verdict('```json\n{"score": 7, "reason": "很好"}\n```') == (5.0, "很好")
    with pytest.raises(ValueError):
        parse_verdict("我觉得还行")


async def test_llm_judge_score_decides_pass_alongside_rules(client: AsyncClient) -> None:
    app_id = await content_app(client, await priced_mock_llm(client))
    suite_id = await _gate_suite(client, app_id, "质量", 1)

    low = await _judge(client, json.dumps({"score": 2, "reason": "没有突出地方特色"}, ensure_ascii=False))
    updated = await client.patch(f"/api/v1/evaluation-sets/{suite_id}", headers=ADMIN, json={"judge": {"model_id": low, "rubric": "必须突出地方特色", "pass_score": 4}})
    assert updated.status_code == 200, updated.text
    assert updated.json()["judge"]["model_id"] == low
    failed = (await client.post(f"/api/v1/evaluation-sets/{suite_id}/run", headers=ADMIN)).json()
    result = failed["results"][0]
    assert failed["failed_count"] == 1
    assert result["judge_score"] == 2 and result["judge_reason"] == "没有突出地方特色"
    assert any("低于及格线 4" in reason for reason in result["reasons"])

    high = await _judge(client, '{"score": 5, "reason": "要点齐全"}')
    await client.patch(f"/api/v1/evaluation-sets/{suite_id}", headers=ADMIN, json={"judge": {"model_id": high, "pass_score": 4}})
    passed = (await client.post(f"/api/v1/evaluation-sets/{suite_id}/run", headers=ADMIN)).json()
    assert passed["failed_count"] == 0 and passed["results"][0]["judge_score"] == 5

    broken = await _judge(client, "无法评分")
    await client.patch(f"/api/v1/evaluation-sets/{suite_id}", headers=ADMIN, json={"judge": {"model_id": broken}})
    errored = (await client.post(f"/api/v1/evaluation-sets/{suite_id}/run", headers=ADMIN)).json()
    assert errored["failed_count"] == 1 and errored["results"][0]["judge_score"] is None  # 评委失败不放行

    off = await client.patch(f"/api/v1/evaluation-sets/{suite_id}", headers=ADMIN, json={"judge": {"model_id": None}})
    assert off.json()["judge"]["model_id"] is None
    assert "judge_score" not in (await client.post(f"/api/v1/evaluation-sets/{suite_id}/run", headers=ADMIN)).json()["results"][0]


async def test_judge_model_must_be_an_enabled_llm(client: AsyncClient) -> None:
    app_id = await content_app(client, await priced_mock_llm(client))
    suite_id = await _gate_suite(client, app_id, "质量", 1)
    rejected = await client.patch(f"/api/v1/evaluation-sets/{suite_id}", headers=ADMIN, json={"judge": {"model_id": "not-a-model"}})
    assert rejected.status_code == 422
