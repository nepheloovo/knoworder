from __future__ import annotations

from httpx import AsyncClient

from tests.test_fde_api import ADMIN, content_inputs
from tests.test_observability import content_app, priced_mock_llm


async def _gate_suite(client: AsyncClient, app_id: str, name: str, cases: int) -> str:
    suite_id = (await client.post("/api/v1/evaluation-sets", headers=ADMIN, json={"app_id": app_id, "name": name})).json()["id"]
    for index in range(cases):
        created = await client.post(
            f"/api/v1/evaluation-sets/{suite_id}/cases",
            headers=ADMIN,
            json={"name": f"{name}-{index}", "message": "写一段文案", "input_values": content_inputs(), "expected_keywords": ["汽锅鸡"]},
        )
        assert created.status_code == 201, created.text
    assert (await client.patch(f"/api/v1/evaluation-sets/{suite_id}", headers=ADMIN, json={"is_release_gate": True})).status_code == 200
    return suite_id


async def _publish(client: AsyncClient, app_id: str) -> int:
    assert (await client.post(f"/api/v1/fde/apps/{app_id}/versions", headers=ADMIN, json={"release_notes": "update"})).status_code == 201
    return (await client.post(f"/api/v1/fde/apps/{app_id}/publish", headers=ADMIN, json={})).status_code


async def test_each_gate_suite_is_checked_on_its_own(client: AsyncClient) -> None:
    app_id = await content_app(client, await priced_mock_llm(client))
    first = await _gate_suite(client, app_id, "A", 2)
    second = await _gate_suite(client, app_id, "B", 1)
    assert (await client.post(f"/api/v1/evaluation-sets/{first}/run", headers=ADMIN)).json()["passed_count"] == 2
    assert await _publish(client, app_id) == 409  # B never ran
    assert (await client.post(f"/api/v1/evaluation-sets/{second}/run", headers=ADMIN)).json()["passed_count"] == 1
    assert await _publish(client, app_id) == 200


async def test_gate_rejects_results_from_an_older_draft_but_rollback_ignores_gate(client: AsyncClient) -> None:
    app_id = await content_app(client, await priced_mock_llm(client))
    suite_id = await _gate_suite(client, app_id, "回归", 1)
    assert (await client.post(f"/api/v1/evaluation-sets/{suite_id}/run", headers=ADMIN)).status_code == 200
    assert await _publish(client, app_id) == 200
    first_version = (await client.get(f"/api/v1/fde/apps/{app_id}", headers=ADMIN)).json()["published_version_id"]

    draft = (await client.get(f"/api/v1/fde/apps/{app_id}", headers=ADMIN)).json()["manifest"]
    draft["system_prompt"] += "\n补充：语气更活泼。"
    assert (await client.put(f"/api/v1/fde/apps/{app_id}/manifest", headers=ADMIN, json={"manifest": draft})).status_code == 200
    detail = (await client.get(f"/api/v1/evaluation-sets/{suite_id}", headers=ADMIN)).json()
    assert detail["latest_run"]["matches_draft"] is False
    assert await _publish(client, app_id) == 409

    assert (await client.post(f"/api/v1/evaluation-sets/{suite_id}/run", headers=ADMIN)).status_code == 200
    assert await _publish(client, app_id) == 200

    # A failing gate must not block switching back to a version that already shipped.
    await client.post(
        f"/api/v1/evaluation-sets/{suite_id}/cases",
        headers=ADMIN,
        json={"name": "必然失败", "message": "写一段文案", "input_values": content_inputs(), "expected_keywords": ["不存在的词"]},
    )
    assert (await client.post(f"/api/v1/evaluation-sets/{suite_id}/run", headers=ADMIN)).json()["failed_count"] == 1
    rolled = await client.post(f"/api/v1/fde/apps/{app_id}/rollback", headers=ADMIN, json={"version_id": first_version})
    assert rolled.status_code == 200, rolled.text


async def test_release_is_atomic_and_reuses_unchanged_version(client: AsyncClient) -> None:
    app_id = await content_app(client, await priced_mock_llm(client))
    suite_id = await _gate_suite(client, app_id, "门禁", 1)
    blocked = await client.post(f"/api/v1/fde/apps/{app_id}/release", headers=ADMIN, json={"release_notes": "v1"})
    assert blocked.status_code == 409
    assert (await client.get(f"/api/v1/fde/apps/{app_id}", headers=ADMIN)).json()["versions"] == []

    await client.post(f"/api/v1/evaluation-sets/{suite_id}/run", headers=ADMIN)
    released = await client.post(f"/api/v1/fde/apps/{app_id}/release", headers=ADMIN, json={"release_notes": "v1"})
    assert released.status_code == 200, released.text
    assert released.json()["published_version"]["version"] == 1
    again = await client.post(f"/api/v1/fde/apps/{app_id}/release", headers=ADMIN, json={"release_notes": "无改动"})
    assert again.status_code == 200
    assert [item["version"] for item in again.json()["versions"]] == [1]


async def test_cases_waiting_for_standards_do_not_block_run_or_gate(client: AsyncClient) -> None:
    app_id = await content_app(client, await priced_mock_llm(client))
    suite_id = await _gate_suite(client, app_id, "门禁", 1)
    pending = await client.post(f"/api/v1/evaluation-sets/{suite_id}/cases", headers=ADMIN, json={"name": "待补", "message": "写一段文案", "input_values": content_inputs()})
    assert pending.json()["readiness"] == "needs_standard"
    ran = await client.post(f"/api/v1/evaluation-sets/{suite_id}/run", headers=ADMIN)
    assert ran.status_code == 200, ran.text
    assert ran.json()["passed_count"] == 1 and ran.json()["failed_count"] == 0
    assert await _publish(client, app_id) == 200


async def test_stepwise_run_reports_progress_and_satisfies_gate(client: AsyncClient) -> None:
    app_id = await content_app(client, await priced_mock_llm(client))
    suite_id = await _gate_suite(client, app_id, "分步", 3)
    started = await client.post(f"/api/v1/evaluation-sets/{suite_id}/runs", headers=ADMIN)
    assert started.status_code == 201, started.text
    run = started.json()
    assert (run["status"], run["done_count"], run["total_count"]) == ("running", 0, 3)

    step = await client.post(f"/api/v1/evaluation-sets/{suite_id}/runs/{run['id']}/step", headers=ADMIN)
    assert step.json()["done_count"] == 1 and step.json()["status"] == "running"
    assert await _publish(client, app_id) == 409  # an unfinished run never opens the gate

    for _ in range(2):
        step = await client.post(f"/api/v1/evaluation-sets/{suite_id}/runs/{run['id']}/step", headers=ADMIN)
    body = step.json()
    assert (body["status"], body["done_count"], body["passed_count"]) == ("success", 3, 3)
    assert await _publish(client, app_id) == 200


async def test_stepwise_run_stops_when_draft_changes(client: AsyncClient) -> None:
    app_id = await content_app(client, await priced_mock_llm(client))
    suite_id = await _gate_suite(client, app_id, "分步", 2)
    run = (await client.post(f"/api/v1/evaluation-sets/{suite_id}/runs", headers=ADMIN)).json()
    draft = (await client.get(f"/api/v1/fde/apps/{app_id}", headers=ADMIN)).json()["manifest"]
    draft["system_prompt"] += "\n改动"
    await client.put(f"/api/v1/fde/apps/{app_id}/manifest", headers=ADMIN, json={"manifest": draft})
    assert (await client.post(f"/api/v1/evaluation-sets/{suite_id}/runs/{run['id']}/step", headers=ADMIN)).status_code == 409
