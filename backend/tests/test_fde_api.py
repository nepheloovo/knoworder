from __future__ import annotations

from httpx import AsyncClient

from app.models import DEFAULT_WORKSPACE_ID, Membership, User, Workspace
from app.security import hash_password

ADMIN = {"X-Demo-Role": "admin"}
USER = {"X-Demo-Role": "user"}


async def create_mock_llm(client: AsyncClient) -> str:
    response = await client.post(
        "/api/v1/models",
        headers=ADMIN,
        json={"display_name": "FDE mock LLM", "provider": "mock", "model_type": "llm", "model_name": "test"},
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


async def design_content(client: AsyncClient, model_id: str) -> dict:
    response = await client.post(
        "/api/v1/fde/design",
        headers=ADMIN,
        json={"brief": "为餐饮业务设计特色菜文案生成应用，支持渠道和语气", "template_key": "content", "llm_model_id": model_id},
    )
    assert response.status_code == 200, response.text
    assert response.json()["simulated"] is True
    manifest = response.json()["manifest"]
    manifest["name"] = "特色菜文案助手"
    return manifest


def content_inputs() -> dict:
    return {
        "dish_name": "云南汽锅鸡",
        "ingredients_taste": "土鸡、菌菇，汤鲜味浓",
        "selling_points": "不加一滴水，蒸汽凝结成汤",
        "channel": "小红书",
        "tone": "亲切",
        "word_count": 300,
        "audience": "周末聚餐人群",
    }


async def test_fde_content_delivery_workflow(client: AsyncClient) -> None:
    model_id = await create_mock_llm(client)
    manifest = await design_content(client, model_id)
    created = await client.post("/api/v1/fde/apps", headers=ADMIN, json={"manifest": manifest})
    assert created.status_code == 201, created.text
    app_id = created.json()["id"]
    assert created.json()["status"] == "draft"
    admin_apps = await client.get("/api/v1/fde/apps", headers=ADMIN)
    assert admin_apps.status_code == 200, admin_apps.text
    assert admin_apps.json()[0]["id"] == app_id
    assert admin_apps.json()[0]["conversation_count"] == 0
    assert (await client.get("/api/v1/fde/apps", headers=USER)).json() == []

    preview = await client.post(f"/api/v1/fde/apps/{app_id}/preview", headers=ADMIN, json={"input_values": content_inputs()})
    assert preview.status_code == 200, preview.text
    assert "云南汽锅鸡" in preview.json()["content"]
    assert preview.json()["simulated"] is True

    unpublished = await client.post(f"/api/v1/fde/apps/{app_id}/run", headers=USER, json={"input_values": content_inputs()})
    assert unpublished.status_code == 404

    version = await client.post(f"/api/v1/fde/apps/{app_id}/versions", headers=ADMIN)
    assert version.status_code == 201, version.text
    assert version.json()["version"] == 1
    published = await client.post(f"/api/v1/fde/apps/{app_id}/publish", headers=ADMIN, json={})
    assert published.status_code == 200, published.text
    assert published.json()["published_version"]["version"] == 1

    run = await client.post(f"/api/v1/fde/apps/{app_id}/run", headers=USER, json={"input_values": content_inputs()})
    assert run.status_code == 200, run.text
    assert run.json()["app_version_id"] == version.json()["id"]
    user_apps = await client.get("/api/v1/fde/apps", headers=USER)
    assert user_apps.status_code == 200, user_apps.text
    assert user_apps.json()[0]["id"] == app_id
    # Draft previews and published runs are both persisted as executions.
    assert user_apps.json()[0]["conversation_count"] == 2
    feedback = await client.post(f"/api/v1/fde/messages/{run.json()['message_id']}/feedback", headers=USER, json={"rating": 1, "comment": "可用"})
    assert feedback.status_code == 201, feedback.text


async def test_fde_evaluation_gate_and_workspace_isolation(client: AsyncClient) -> None:
    model_id = await create_mock_llm(client)
    manifest = await design_content(client, model_id)
    created = await client.post("/api/v1/fde/apps", headers=ADMIN, json={"manifest": manifest})
    app_id = created.json()["id"]
    suite = {
        "name": "内容交付验收",
        "cases": [{
            "name": "包含菜品与测试标识",
            "input_values": content_inputs(),
            "expected_keywords": ["云南汽锅鸡", "测试替身"],
            "forbidden_keywords": ["绝对第一"],
        }],
    }
    saved = await client.put(f"/api/v1/fde/apps/{app_id}/evaluation-suite", headers=ADMIN, json=suite)
    assert saved.status_code == 200, saved.text
    evaluated = await client.post(f"/api/v1/fde/apps/{app_id}/evaluate", headers=ADMIN)
    assert evaluated.status_code == 200, evaluated.text
    assert evaluated.json()["passed_count"] == 1
    assert evaluated.json()["failed_count"] == 0
    await client.post(f"/api/v1/fde/apps/{app_id}/versions", headers=ADMIN)
    published = await client.post(f"/api/v1/fde/apps/{app_id}/publish", headers=ADMIN, json={})
    assert published.status_code == 200, published.text

    other = {"X-Demo-Role": "admin", "X-Workspace-ID": "00000000-0000-0000-0000-000000000099"}
    isolated = await client.get(f"/api/v1/fde/apps/{app_id}", headers=other)
    assert isolated.status_code == 404


async def test_fde_qa_requires_knowledge_and_capabilities(client: AsyncClient) -> None:
    model_id = await create_mock_llm(client)
    capabilities = await client.get("/api/v1/fde/capabilities", headers=USER)
    assert capabilities.status_code == 200
    assert len(capabilities.json()["templates"]) == 5
    designed = await client.post("/api/v1/fde/design", headers=ADMIN, json={"brief": "员工制度问答", "template_key": "qa", "llm_model_id": model_id})
    created = await client.post("/api/v1/fde/apps", headers=ADMIN, json={"manifest": designed.json()["manifest"]})
    app_id = created.json()["id"]
    invalid = await client.post(f"/api/v1/fde/apps/{app_id}/versions", headers=ADMIN)
    assert invalid.status_code == 422


async def test_fde_business_run_never_falls_back_to_an_enabled_legacy_draft(client: AsyncClient) -> None:
    model_id = await create_mock_llm(client)
    manifest = await design_content(client, model_id)
    created = await client.post("/api/v1/fde/apps", headers=ADMIN, json={"manifest": manifest})
    assert created.status_code == 201, created.text
    app_id = created.json()["id"]
    # Reproduce a legacy state: enabled flag set without an immutable version.
    legacy_enabled = await client.patch(f"/api/v1/apps/{app_id}", headers=ADMIN, json={"is_enabled": True})
    assert legacy_enabled.status_code == 200, legacy_enabled.text
    admin_apps = await client.get("/api/v1/fde/apps", headers=ADMIN)
    assert any(item["id"] == app_id and item["status"] == "draft" for item in admin_apps.json())
    assert all(item["id"] != app_id for item in (await client.get("/api/v1/fde/apps", headers=USER)).json())
    run = await client.post(
        f"/api/v1/fde/apps/{app_id}/run",
        headers=USER,
        json={"input_values": {"request": "测试"}},
    )
    assert run.status_code == 404
    assert run.json()["detail"] == "应用尚未发布"


async def test_real_login_and_api_client(client: AsyncClient, db_session) -> None:
    workspace = Workspace(id=DEFAULT_WORKSPACE_ID, name="默认", slug="default")
    user = User(email="owner@example.com", display_name="Owner", password_hash=hash_password("correct-horse"))
    db_session.add_all([workspace, user])
    await db_session.flush()
    db_session.add(Membership(workspace_id=workspace.id, user_id=user.id, role="admin"))
    await db_session.commit()
    logged = await client.post("/api/v1/auth/login", json={"email": "owner@example.com", "password": "correct-horse"})
    assert logged.status_code == 200, logged.text
    token = logged.json()["token"]
    me = await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["role"] == "admin"
    api_client = await client.post("/api/v1/auth/api-clients", headers={"Authorization": f"Bearer {token}"}, json={"name": "FDE Agent"})
    assert api_client.status_code == 201, api_client.text
    agent_token = api_client.json()["token"]
    capabilities = await client.get("/api/v1/fde/capabilities", headers={"Authorization": f"Bearer {agent_token}"})
    assert capabilities.status_code == 200


async def test_production_rejects_demo_role(client: AsyncClient, monkeypatch) -> None:
    from app.config import get_settings

    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("APP_AUTO_CREATE_DB", "false")
    monkeypatch.setenv("APP_ENCRYPTION_KEY", "production-test-key")
    monkeypatch.setenv("APP_BOOTSTRAP_ADMIN_PASSWORD", "production-test-password")
    monkeypatch.setenv("APP_S3_SECRET_KEY", "production-storage-secret")
    get_settings.cache_clear()
    response = await client.get("/api/v1/fde/capabilities", headers=ADMIN)
    assert response.status_code == 401


async def test_legacy_models_are_workspace_scoped(client: AsyncClient) -> None:
    model_id = await create_mock_llm(client)
    other = {"X-Demo-Role": "admin", "X-Workspace-ID": "00000000-0000-0000-0000-000000000099"}
    hidden = await client.get(f"/api/v1/models/{model_id}", headers=other)
    listed = await client.get("/api/v1/models", headers=other)
    assert hidden.status_code == 404
    assert listed.json() == []


async def test_app_lifecycle_release_notes_and_public_share_limits(client: AsyncClient) -> None:
    model_id = await create_mock_llm(client)
    manifest = await design_content(client, model_id)
    created = await client.post("/api/v1/fde/apps", headers=ADMIN, json={"manifest": manifest})
    assert created.status_code == 201, created.text
    app_id = created.json()["id"]

    duplicated = await client.post(f"/api/v1/fde/apps/{app_id}/duplicate", headers=ADMIN)
    assert duplicated.status_code == 201, duplicated.text
    duplicate_id = duplicated.json()["id"]
    assert duplicated.json()["name"] == f"{manifest['name']}（副本）"
    assert duplicated.json()["status"] == "draft"
    assert duplicated.json()["versions"] == []

    archived = await client.post(f"/api/v1/fde/apps/{duplicate_id}/archive", headers=ADMIN)
    assert archived.status_code == 200, archived.text
    assert archived.json()["status"] == "archived"
    restored = await client.post(f"/api/v1/fde/apps/{duplicate_id}/restore", headers=ADMIN)
    assert restored.status_code == 200, restored.text
    assert restored.json()["status"] == "draft"
    assert (await client.post(f"/api/v1/fde/apps/{duplicate_id}/restore", headers=ADMIN)).status_code == 409
    deleted = await client.delete(f"/api/v1/fde/apps/{duplicate_id}", headers=ADMIN)
    assert deleted.status_code == 204, deleted.text
    assert (await client.get(f"/api/v1/fde/apps/{duplicate_id}", headers=ADMIN)).status_code == 404

    version = await client.post(
        f"/api/v1/fde/apps/{app_id}/versions",
        headers=ADMIN,
        json={"release_notes": "首个可分享版本：开放特色菜文案生成。"},
    )
    assert version.status_code == 201, version.text
    assert version.json()["release_notes"] == "首个可分享版本：开放特色菜文案生成。"
    published = await client.post(f"/api/v1/fde/apps/{app_id}/publish", headers=ADMIN, json={})
    assert published.status_code == 200, published.text
    assert (await client.delete(f"/api/v1/fde/apps/{app_id}", headers=ADMIN)).status_code == 409

    created_share = await client.post(
        f"/api/v1/fde/apps/{app_id}/shares",
        headers=ADMIN,
        json={"name": "一次性验收", "expires_in_days": 7, "max_uses": 1},
    )
    assert created_share.status_code == 201, created_share.text
    token = created_share.json()["token"]
    share_id = created_share.json()["id"]
    assert token.startswith("zss_")

    shares = await client.get(f"/api/v1/fde/apps/{app_id}/shares", headers=ADMIN)
    assert shares.status_code == 200, shares.text
    assert shares.json()[0]["id"] == share_id
    assert "token" not in shares.json()[0]

    public_app = await client.get(f"/api/v1/fde/share/{token}")
    assert public_app.status_code == 200, public_app.text
    assert public_app.json()["id"] == app_id
    assert public_app.json()["published_version"]["release_notes"].startswith("首个可分享版本")

    first_run = await client.post(
        f"/api/v1/fde/share/{token}/run",
        json={"input_values": content_inputs()},
    )
    assert first_run.status_code == 200, first_run.text
    assert first_run.json()["app_version_id"] == version.json()["id"]
    exhausted = await client.post(
        f"/api/v1/fde/share/{token}/run",
        json={"input_values": content_inputs()},
    )
    assert exhausted.status_code == 410, exhausted.text

    revoked = await client.delete(f"/api/v1/fde/apps/{app_id}/shares/{share_id}", headers=ADMIN)
    assert revoked.status_code == 204, revoked.text
    assert (await client.get(f"/api/v1/fde/share/{token}")).status_code == 404


async def test_member_role_updates_and_removal_are_audited(client: AsyncClient) -> None:
    invited = await client.post(
        "/api/v1/auth/users",
        headers=ADMIN,
        json={
            "email": "reviewer@example.com",
            "display_name": "验收同事",
            "password": "reviewer-password",
            "role": "user",
        },
    )
    assert invited.status_code == 201, invited.text
    user_id = invited.json()["id"]

    updated = await client.patch(
        f"/api/v1/auth/users/{user_id}",
        headers=ADMIN,
        json={"role": "manager"},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["role"] == "manager"
    members = await client.get("/api/v1/auth/users", headers=ADMIN)
    assert members.status_code == 200, members.text
    assert any(item["id"] == user_id and item["role"] == "manager" for item in members.json())

    events = await client.get("/api/v1/audit-events?search=member", headers=ADMIN)
    assert events.status_code == 200, events.text
    assert {item["action"] for item in events.json()} >= {"member.invited", "member.role_updated"}
    role_event = next(item for item in events.json() if item["action"] == "member.role_updated")
    assert role_event["detail"] == {"from": "user", "to": "manager"}

    removed = await client.delete(f"/api/v1/auth/users/{user_id}", headers=ADMIN)
    assert removed.status_code == 204, removed.text
    assert all(item["id"] != user_id for item in (await client.get("/api/v1/auth/users", headers=ADMIN)).json())
    removed_events = await client.get("/api/v1/audit-events?action=member.removed", headers=ADMIN)
    assert any(item["resource_id"] == user_id for item in removed_events.json())


async def test_invalid_manifest_is_a_422_with_issues(client: AsyncClient) -> None:
    created = await client.post("/api/v1/fde/apps", headers=ADMIN, json={"manifest": {"name": "", "template_key": "Bad Key"}})
    assert created.status_code == 422, created.text
    detail = created.json()["detail"]
    assert detail["message"] == "应用配置不符合协议"
    assert {"name", "template_key", "system_prompt"} <= {issue["path"] for issue in detail["issues"]}


async def test_workbench_shows_month_stats_and_my_recent_conversations(client: AsyncClient, db_session) -> None:
    from app.models import DEFAULT_WORKSPACE_ID, Membership, User
    from app.security import hash_password
    from tests.test_observability import content_app, priced_mock_llm

    app_id = await content_app(client, await priced_mock_llm(client))
    assert (await client.post(f"/api/v1/fde/apps/{app_id}/versions", headers=ADMIN)).status_code == 201
    assert (await client.post(f"/api/v1/fde/apps/{app_id}/publish", headers=ADMIN, json={})).status_code == 200
    user = User(email="wb@example.com", display_name="业务", password_hash=hash_password("wb-password-1"))
    db_session.add(user)
    await db_session.flush()
    db_session.add(Membership(workspace_id=DEFAULT_WORKSPACE_ID, user_id=user.id, role="user"))
    await db_session.commit()
    token = (await client.post("/api/v1/auth/login", json={"email": "wb@example.com", "password": "wb-password-1"})).json()["token"]
    biz = {"Authorization": f"Bearer {token}"}

    await client.post(f"/api/v1/fde/apps/{app_id}/preview", headers=ADMIN, json={"input_values": content_inputs()})  # 调试不计入
    ran = await client.post(f"/api/v1/fde/apps/{app_id}/run", headers=biz, json={"input_values": content_inputs()})
    assert ran.status_code == 200, ran.text

    body = (await client.get("/api/v1/fde/workbench", headers=biz)).json()
    assert body["month"] == {"runs": 1, "users": 1, "apps": 1, "new_chunks": 0}
    assert [item["conversation_id"] for item in body["recent"]] == [ran.json()["conversation_id"]]
    assert (await client.get("/api/v1/fde/workbench", headers=ADMIN)).json()["recent"] == []  # 只看自己的对话
