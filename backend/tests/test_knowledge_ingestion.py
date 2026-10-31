from __future__ import annotations

import io
import json

from httpx import AsyncClient
from PIL import Image


ADMIN_HEADERS = {"X-Demo-Role": "admin"}
MANAGER_HEADERS = {"X-Demo-Role": "manager"}


async def _create_mock_embedding(client: AsyncClient) -> str:
    response = await client.post(
        "/api/v1/models",
        headers=ADMIN_HEADERS,
        json={
            "display_name": "测试 Embedding",
            "provider": "mock",
            "model_type": "embedding",
            "model_name": "deterministic-test-vector",
        },
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _create_mock_ocr(client: AsyncClient) -> str:
    response = await client.post(
        "/api/v1/models",
        headers=ADMIN_HEADERS,
        json={
            "display_name": "测试 OCR",
            "provider": "mock",
            "model_type": "ocr",
            "model_name": "deterministic-test-ocr",
        },
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _create_mock_metadata_llm(client: AsyncClient) -> str:
    response_text = json.dumps(
        {
            "document_time": "2026-10-01",
            "version": "V1.4",
            "subjects": ["华北销售团队", "客户报价制度"],
            "owner": "销售运营部",
            "keywords": ["客户报价", "折扣审批", "销售运营"],
            "likely_questions": ["折扣超过多少需要审批？", "报价制度由哪个部门负责？"],
        },
        ensure_ascii=False,
    )
    response = await client.post(
        "/api/v1/models",
        headers=ADMIN_HEADERS,
        json={
            "display_name": "测试元数据 LLM",
            "provider": "mock",
            "model_type": "llm",
            "model_name": "metadata-test-double",
            "config": {"response_text": response_text},
        },
    )
    assert response.status_code == 201
    return response.json()["id"]


async def test_markdown_import_builds_editable_vectorized_chunks(client: AsyncClient) -> None:
    embedding_model_id = await _create_mock_embedding(client)
    created = await client.post(
        "/api/v1/knowledge-bases",
        headers=MANAGER_HEADERS,
        json={
            "name": "企业制度库",
            "description": "测试导入链路",
            "embedding_model_id": embedding_model_id,
            "chunk_size": 100,
            "chunk_overlap": 20,
        },
    )
    assert created.status_code == 201, created.text
    knowledge_base_id = created.json()["id"]

    content = "# 差旅制度\n\n员工出差前需要提交审批。\n\n## 报销\n\n发票应在三十天内提交。"
    uploaded = await client.post(
        f"/api/v1/knowledge-bases/{knowledge_base_id}/files",
        headers=MANAGER_HEADERS,
        files={"upload": ("travel.md", content.encode(), "text/markdown")},
    )
    assert uploaded.status_code == 202, uploaded.text
    body = uploaded.json()
    assert body["file"]["status"] == "completed"
    assert body["file"]["chunk_count"] >= 1
    assert body["job"]["status"] == "completed"
    assert body["job"]["progress"] == 100
    assert all(stage["status"] == "success" for stage in body["job"]["stage_details"])

    jobs = await client.get(
        f"/api/v1/knowledge-bases/{knowledge_base_id}/import-jobs",
        headers=MANAGER_HEADERS,
    )
    assert jobs.status_code == 200
    assert [job["id"] for job in jobs.json()] == [body["job"]["id"]]

    chunks = await client.get(
        f"/api/v1/knowledge-bases/{knowledge_base_id}/chunks",
        headers=MANAGER_HEADERS,
    )
    assert chunks.status_code == 200, chunks.text
    chunk = chunks.json()[0]
    assert chunk["indexed"] is True
    assert "差旅制度" in chunk["content"]

    edited = await client.patch(
        f"/api/v1/knowledge-bases/{knowledge_base_id}/chunks/{chunk['id']}",
        headers=MANAGER_HEADERS,
        json={"content": "人工修订后的制度内容"},
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["content"] == "人工修订后的制度内容"
    assert edited.json()["char_count"] == len("人工修订后的制度内容")
    assert edited.json()["indexed"] is True  # 人工修订后立即重新向量化

    duplicate = await client.post(
        f"/api/v1/knowledge-bases/{knowledge_base_id}/files",
        headers=MANAGER_HEADERS,
        files={"upload": ("renamed.md", content.encode(), "text/markdown")},
    )
    assert duplicate.status_code == 409

    detail = await client.get(
        f"/api/v1/knowledge-bases/{knowledge_base_id}",
        headers=MANAGER_HEADERS,
    )
    assert detail.status_code == 200
    assert detail.json()["file_count"] == 1
    assert detail.json()["chunk_count"] == len(chunks.json())

    replacement_embedding_id = await _create_mock_embedding(client)
    changed_model = await client.patch(
        f"/api/v1/knowledge-bases/{knowledge_base_id}",
        headers=MANAGER_HEADERS,
        json={"embedding_model_id": replacement_embedding_id},
    )
    assert changed_model.status_code == 200
    assert changed_model.json()["chunk_count"] == 0
    invalidated = await client.get(
        f"/api/v1/knowledge-bases/{knowledge_base_id}/chunks",
        headers=MANAGER_HEADERS,
    )
    assert all(chunk["indexed"] is False for chunk in invalidated.json())


async def test_image_import_uses_knowledge_base_ocr_model(client: AsyncClient) -> None:
    embedding_model_id = await _create_mock_embedding(client)
    ocr_model_id = await _create_mock_ocr(client)
    created = await client.post(
        "/api/v1/knowledge-bases",
        headers=MANAGER_HEADERS,
        json={
            "name": "图片资料库",
            "embedding_model_id": embedding_model_id,
            "ocr_model_id": ocr_model_id,
            "chunk_size": 100,
            "chunk_overlap": 20,
        },
    )
    assert created.status_code == 201, created.text
    assert created.json()["ocr_model_id"] == ocr_model_id

    payload = io.BytesIO()
    Image.new("RGB", (80, 40), color="white").save(payload, format="PNG")
    uploaded = await client.post(
        f"/api/v1/knowledge-bases/{created.json()['id']}/files",
        headers=MANAGER_HEADERS,
        files={"upload": ("scan.png", payload.getvalue(), "image/png")},
    )
    assert uploaded.status_code == 202, uploaded.text
    assert uploaded.json()["job"]["status"] == "completed"

    chunks = await client.get(
        f"/api/v1/knowledge-bases/{created.json()['id']}/chunks",
        headers=MANAGER_HEADERS,
    )
    assert chunks.status_code == 200
    assert "OCR 测试替身" in chunks.json()[0]["content"]


async def test_metadata_llm_is_persisted_indexed_and_manually_editable(client: AsyncClient) -> None:
    embedding_model_id = await _create_mock_embedding(client)
    metadata_llm_model_id = await _create_mock_metadata_llm(client)
    created = await client.post(
        "/api/v1/knowledge-bases",
        headers=MANAGER_HEADERS,
        json={
            "name": "销售制度库",
            "embedding_model_id": embedding_model_id,
            "metadata_llm_model_id": metadata_llm_model_id,
            "chunk_size": 100,
            "chunk_overlap": 20,
        },
    )
    assert created.status_code == 201, created.text
    knowledge_base_id = created.json()["id"]

    uploaded = await client.post(
        f"/api/v1/knowledge-bases/{knowledge_base_id}/files",
        headers=MANAGER_HEADERS,
        files={"upload": ("报价制度.md", "# 报价制度\n折扣超过八折需要审批。".encode(), "text/markdown")},
    )
    assert uploaded.status_code == 202, uploaded.text
    body = uploaded.json()
    assert body["job"]["status"] == "completed"
    assert "metadata_extraction" in [stage["name"] for stage in body["job"]["stage_details"]]
    metadata = body["file"]["document_metadata"]
    assert metadata["version"] == "V1.4"
    assert metadata["owner"] == "销售运营部"
    assert metadata["extraction_method"] == "llm"
    assert metadata["model_id"] == metadata_llm_model_id

    chunks = await client.get(
        f"/api/v1/knowledge-bases/{knowledge_base_id}/chunks",
        headers=MANAGER_HEADERS,
    )
    assert chunks.status_code == 200
    assert chunks.json()[0]["metadata_json"]["document_metadata"]["keywords"] == [
        "客户报价",
        "折扣审批",
        "销售运营",
    ]
    assert chunks.json()[0]["indexed"] is True

    updated = await client.patch(
        f"/api/v1/knowledge-bases/{knowledge_base_id}/files/{body['file']['id']}/metadata",
        headers=MANAGER_HEADERS,
        json={
            "owner": "大客户业务部",
            "keywords": ["重点客户", "报价审批"],
            "likely_questions": ["重点客户报价由谁审批？"],
        },
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["document_metadata"]["owner"] == "大客户业务部"
    assert updated.json()["document_metadata"]["extraction_method"] == "manual"

    invalidated = await client.get(
        f"/api/v1/knowledge-bases/{knowledge_base_id}/chunks",
        headers=MANAGER_HEADERS,
    )
    assert invalidated.json()[0]["indexed"] is False
    assert invalidated.json()[0]["metadata_json"]["document_metadata"]["keywords"] == [
        "重点客户",
        "报价审批",
    ]

    rebuilt = await client.post(
        f"/api/v1/knowledge-bases/{knowledge_base_id}/rebuild",
        headers=MANAGER_HEADERS,
    )
    assert rebuilt.status_code == 202, rebuilt.text
    assert rebuilt.json()[0]["status"] == "completed"
    refreshed_files = await client.get(
        f"/api/v1/knowledge-bases/{knowledge_base_id}/files",
        headers=MANAGER_HEADERS,
    )
    assert refreshed_files.json()[0]["document_metadata"]["owner"] == "大客户业务部"
    refreshed_chunks = await client.get(
        f"/api/v1/knowledge-bases/{knowledge_base_id}/chunks",
        headers=MANAGER_HEADERS,
    )
    assert refreshed_chunks.json()[0]["indexed"] is True
    assert refreshed_chunks.json()[0]["metadata_json"]["document_metadata"]["owner"] == "大客户业务部"


async def test_file_chunk_config_is_persisted_and_used_for_ingestion(client: AsyncClient) -> None:
    embedding_model_id = await _create_mock_embedding(client)
    created = await client.post(
        "/api/v1/knowledge-bases",
        headers=MANAGER_HEADERS,
        json={
            "name": "逐文件切块验收库",
            "embedding_model_id": embedding_model_id,
            "chunk_size": 800,
            "chunk_overlap": 120,
        },
    )
    assert created.status_code == 201, created.text
    knowledge_base_id = created.json()["id"]
    chunk_config = {
        "method": "fixed",
        "chunk_size": 100,
        "chunk_overlap": 0,
        "parent_chunk_size": 500,
        "child_chunk_size": 100,
        "separators": ["\n\n", "\n"],
        "heading_level": 2,
        "rows_per_chunk": 1,
        "enhance_keywords": False,
        "enhance_qa": False,
        "qa_per_chunk": 3,
    }
    content = "# 验收文档\n\n" + "A" * 260

    preview = await client.post(
        f"/api/v1/knowledge-bases/{knowledge_base_id}/chunk-preview",
        headers=MANAGER_HEADERS,
        files={"upload": ("preview.md", content.encode(), "text/markdown")},
        data={"config": json.dumps(chunk_config)},
    )
    assert preview.status_code == 200, preview.text
    assert preview.json()["method"] == "fixed"
    assert preview.json()["total_chunks"] >= 3

    uploaded = await client.post(
        f"/api/v1/knowledge-bases/{knowledge_base_id}/files",
        headers=MANAGER_HEADERS,
        files={"upload": ("fixed.md", content.encode(), "text/markdown")},
        data={"config": json.dumps(chunk_config)},
    )
    assert uploaded.status_code == 202, uploaded.text
    assert uploaded.json()["file"]["chunk_config"] == chunk_config
    assert uploaded.json()["file"]["chunk_count"] == preview.json()["total_chunks"]
    listed = await client.get(
        f"/api/v1/knowledge-bases/{knowledge_base_id}/files",
        headers=MANAGER_HEADERS,
    )
    assert listed.status_code == 200, listed.text
    assert listed.json()[0]["chunk_config"] == chunk_config


async def test_web_import_rejects_private_network_urls(client: AsyncClient) -> None:
    embedding_model_id = await _create_mock_embedding(client)
    created = await client.post(
        "/api/v1/knowledge-bases",
        headers=MANAGER_HEADERS,
        json={"name": "网页安全验收库", "embedding_model_id": embedding_model_id},
    )
    assert created.status_code == 201, created.text
    response = await client.post(
        f"/api/v1/knowledge-bases/{created.json()['id']}/web-import",
        headers=MANAGER_HEADERS,
        json={"url": "http://127.0.0.1:9999/internal", "title": "不应导入"},
    )
    assert response.status_code == 422, response.text
    assert "内网或保留地址" in response.json()["detail"]


async def test_rechunk_keeps_manual_edits_unless_discarded(client: AsyncClient) -> None:
    embedding_id = await _create_mock_embedding(client)
    created = await client.post(
        "/api/v1/knowledge-bases", headers=MANAGER_HEADERS,
        json={"name": "制度库", "embedding_model_id": embedding_id, "chunk_size": 100, "chunk_overlap": 0},
    )
    kb_id = created.json()["id"]
    content = "# 差旅\n\n员工出差前需要提交审批，住宿标准按城市分级。\n\n# 报销\n\n报销需提供发票和行程单，30 日内提交。"
    uploaded = await client.post(f"/api/v1/knowledge-bases/{kb_id}/files", headers=MANAGER_HEADERS, files={"upload": ("policy.md", content.encode(), "text/markdown")})
    file_id = uploaded.json()["file"]["id"]
    chunks = (await client.get(f"/api/v1/knowledge-bases/{kb_id}/chunks", headers=MANAGER_HEADERS)).json()
    target = next(chunk for chunk in chunks if "报销" in chunk["content"])
    edited = await client.patch(f"/api/v1/knowledge-bases/{kb_id}/chunks/{target['id']}", headers=MANAGER_HEADERS, json={"content": "报销需提供发票和行程单，15 日内提交（人工修订）。"})
    assert edited.json()["metadata_json"]["manual_edit"] is True

    rechunked = await client.post(f"/api/v1/knowledge-bases/{kb_id}/files/{file_id}/retry", headers=MANAGER_HEADERS, json={"chunk_config": {"method": "recursive", "chunk_size": 100, "chunk_overlap": 0}})
    assert rechunked.status_code == 202, rechunked.text
    after = (await client.get(f"/api/v1/knowledge-bases/{kb_id}/chunks", headers=MANAGER_HEADERS)).json()
    contents = [chunk["content"] for chunk in after]
    assert any("人工修订" in item for item in contents)
    assert not any("30 日内" in item for item in contents)  # 对应的新切块被人工版本顶替，没有重复
    assert sorted(chunk["ordinal"] for chunk in after) == list(range(1, len(after) + 1))

    discarded = await client.post(f"/api/v1/knowledge-bases/{kb_id}/files/{file_id}/retry", headers=MANAGER_HEADERS, json={"chunk_config": {"method": "recursive", "chunk_size": 100, "chunk_overlap": 0}, "discard_manual_edits": True})
    assert discarded.status_code == 202, discarded.text
    final = [chunk["content"] for chunk in (await client.get(f"/api/v1/knowledge-bases/{kb_id}/chunks", headers=MANAGER_HEADERS)).json()]
    assert not any("人工修订" in item for item in final) and any("30 日内" in item for item in final)
