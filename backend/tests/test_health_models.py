from __future__ import annotations

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ModelConfig
from app.security import decrypt_secret


async def test_health_reports_database(client: AsyncClient) -> None:
    response = await client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json()["database"] == "ok"


async def test_development_cors_allows_local_private_network_preflight(client: AsyncClient) -> None:
    response = await client.options(
        "/api/v1/fde/apps",
        headers={
            # Chromium Local Network Access currently serializes the
            # preflight Origin without the Vite development-server port.
            "Origin": "http://127.0.0.1",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "x-demo-role",
            "Access-Control-Request-Private-Network": "true",
        },
    )
    assert response.status_code == 200, response.text
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1"
    assert response.headers["access-control-allow-private-network"] == "true"


async def test_model_configuration_encrypts_key_and_never_returns_plaintext(
    client: AsyncClient,
    db_session: AsyncSession,
) -> None:
    response = await client.post(
        "/api/v1/models",
        headers={"X-Demo-Role": "admin"},
        json={
            "display_name": "OpenRouter Chat",
            "provider": "openrouter",
            "model_type": "llm",
            "model_name": "openai/gpt-4.1-mini",
            "api_key": "sk-test-secret-value",
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["api_key_masked"].startswith("sk-t")
    assert "sk-test-secret-value" not in response.text

    stored = (await db_session.scalars(select(ModelConfig))).one()
    assert stored.api_key_encrypted != b"sk-test-secret-value"
    assert decrypt_secret(stored.api_key_encrypted) == "sk-test-secret-value"


async def test_mock_model_connection_is_explicitly_simulated(client: AsyncClient) -> None:
    created = await client.post(
        "/api/v1/models",
        headers={"X-Demo-Role": "admin"},
        json={
            "display_name": "Test embedding",
            "provider": "mock",
            "model_type": "embedding",
            "model_name": "deterministic-test-vector",
        },
    )
    assert created.status_code == 201
    model_id = created.json()["id"]
    tested = await client.post(f"/api/v1/models/{model_id}/test", headers={"X-Demo-Role": "admin"})
    assert tested.status_code == 200
    assert tested.json()["ok"] is True
    assert tested.json()["simulated"] is True
    assert "未发起任何外部网络请求" in tested.json()["detail"]


async def test_mock_ocr_connection_is_explicitly_simulated(client: AsyncClient) -> None:
    created = await client.post(
        "/api/v1/models",
        headers={"X-Demo-Role": "admin"},
        json={
            "display_name": "Test OCR",
            "provider": "mock",
            "model_type": "ocr",
            "model_name": "deterministic-test-ocr",
        },
    )
    assert created.status_code == 201
    tested = await client.post(
        f"/api/v1/models/{created.json()['id']}/test",
        headers={"X-Demo-Role": "admin"},
    )
    assert tested.status_code == 200
    assert tested.json()["ok"] is True
    assert tested.json()["simulated"] is True
    assert "OCR 测试替身" in tested.json()["detail"]


async def test_non_admin_cannot_manage_models(client: AsyncClient) -> None:
    response = await client.get("/api/v1/models", headers={"X-Demo-Role": "manager"})
    assert response.status_code == 403
    response = await client.get("/api/v1/models", headers={"X-Demo-Role": "user"})
    assert response.status_code == 403



def test_relative_data_paths_resolve_from_project_root(monkeypatch) -> None:
    from app.config import PROJECT_ROOT, Settings

    monkeypatch.setenv("APP_DATABASE_URL", "sqlite+aiosqlite:///./backend/data/knowledge_hub.db")
    monkeypatch.setenv("APP_LOCAL_STORAGE_PATH", "./backend/data/uploads")
    settings = Settings()
    assert settings.database_url == f"sqlite+aiosqlite:///{PROJECT_ROOT / 'backend/data/knowledge_hub.db'}"
    assert settings.local_storage_path == PROJECT_ROOT / "backend/data/uploads"
    monkeypatch.setenv("APP_DATABASE_URL", "postgresql+asyncpg://rag:rag@127.0.0.1/rag")
    assert Settings().database_url == "postgresql+asyncpg://rag:rag@127.0.0.1/rag"


async def test_init_db_creates_the_sqlite_directory(tmp_path) -> None:
    from app.db import build_engine, init_db

    engine = build_engine(f"sqlite+aiosqlite:///{tmp_path / 'nested' / 'dir' / 'app.db'}")
    await init_db(engine)
    await engine.dispose()
    assert (tmp_path / "nested" / "dir" / "app.db").exists()
