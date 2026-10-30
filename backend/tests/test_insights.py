from __future__ import annotations

from httpx import AsyncClient

from app.api.routes.insights import cluster_questions
from tests.test_fde_api import ADMIN, content_inputs
from tests.test_observability import USER, content_app, priced_mock_llm


def test_similar_questions_are_clustered_into_one_gap() -> None:
    from datetime import UTC, datetime

    now = datetime.now(UTC)
    items = [
        {"query": "出差深圳住宿标准是多少", "reason": "nohit", "app_id": "a", "at": now},
        {"query": "深圳出差住宿标准多少钱", "reason": "downvote", "app_id": "a", "at": now},
        {"query": "年假怎么申请", "reason": "nohit", "app_id": "a", "at": now},
    ]
    clusters = cluster_questions(items)
    assert [cluster["count"] for cluster in clusters] == [2, 1]
    assert dict(clusters[0]["reasons"]) == {"nohit": 1, "downvote": 1}


async def test_insights_summarize_runs_feedback_and_exclude_debug(client: AsyncClient) -> None:
    app_id = await content_app(client, await priced_mock_llm(client))
    assert (await client.post(f"/api/v1/fde/apps/{app_id}/versions", headers=ADMIN)).status_code == 201
    assert (await client.post(f"/api/v1/fde/apps/{app_id}/publish", headers=ADMIN, json={})).status_code == 200
    await client.post(f"/api/v1/fde/apps/{app_id}/preview", headers=ADMIN, json={"input_values": content_inputs()})  # 调试不计入
    first = (await client.post(f"/api/v1/fde/apps/{app_id}/run", headers=USER, json={"input_values": content_inputs()})).json()
    second = (await client.post(f"/api/v1/fde/apps/{app_id}/run", headers=USER, json={"input_values": content_inputs()})).json()
    assert (await client.post(f"/api/v1/fde/messages/{first['message_id']}/feedback", headers=USER, json={"rating": 1})).status_code == 201
    assert (await client.post(f"/api/v1/fde/messages/{second['message_id']}/feedback", headers=USER, json={"rating": -1, "comment": "跑题"})).status_code == 201

    body = (await client.get("/api/v1/insights", headers=ADMIN, params={"days": 7})).json()
    assert body["current"]["runs"] == 2
    assert body["current"]["satisfaction"] == 0.5
    assert body["current"]["hit_rate"] is None  # 内容应用没有知识库，不参与命中率
    assert body["ranking"][0]["app_id"] == app_id and body["ranking"][0]["runs"] == 2
    assert body["gaps"][0]["count"] == 1 and body["gaps"][0]["reasons"] == {"downvote": 1}
    assert body["recent_issues"][0]["reasons"] == ["downvote"]
    assert sum(item["runs"] for item in body["daily"]) == 2
    assert (await client.get("/api/v1/insights", headers=USER)).status_code == 403
