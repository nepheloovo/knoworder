from __future__ import annotations

from typing import Any

from httpx import AsyncClient

from app.api.routes import fde as fde_routes
from tests.test_fde_api import ADMIN
from tests.test_observability import content_app, priced_mock_llm


async def test_confirmed_rerun_replaces_pending_reply_instead_of_adding_a_turn(client: AsyncClient, monkeypatch) -> None:
    seen_history: list[int] = []

    async def fake_execute(session, manifest, *, message, input_values, history, workspace_id, confirmed_tool_names, spans, **_flow: Any) -> dict[str, Any]:
        seen_history.append(len(history))
        confirmed = bool(confirmed_tool_names)
        return {
            "content": "工单已创建" if confirmed else "需要确认后创建工单", "citations": [], "tokens": {"input": 1, "output": 1, "total": 2},
            "duration_ms": 1, "simulated": True, "output_json": None, "handoff": False, "model": {}, "agent_steps": [],
        }

    monkeypatch.setattr(fde_routes, "execute_manifest", fake_execute)
    app_id = await content_app(client, await priced_mock_llm(client))
    first = await client.post(f"/api/v1/fde/apps/{app_id}/preview", headers=ADMIN, json={"message": "帮我建工单", "input_values": {}})
    assert first.status_code == 200, first.text
    conversation_id = first.json()["conversation_id"]
    second = await client.post(
        f"/api/v1/fde/apps/{app_id}/preview", headers=ADMIN,
        json={"message": "帮我建工单", "input_values": {}, "conversation_id": conversation_id, "confirmed_tool_names": ["create_ticket"]},
    )
    assert second.status_code == 200, second.text
    assert seen_history == [0, 0]  # the pending turn is not fed back as history

    detail = (await client.get(f"/api/v1/fde/conversations/{conversation_id}", headers=ADMIN)).json()
    assert [(item["role"], item["content"]) for item in detail["messages"]] == [("user", "帮我建工单"), ("assistant", "工单已创建")]
