from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urlparse
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ...config import get_settings
from ...db import get_session
from ...models import ChunkMethod, DocumentChunk, ImportJob, JobStatus, KnowledgeBase, KnowledgeFile, ModelConfig, ModelType
from ...schemas import (
    ChunkResponse,
    ChunkUpdate,
    DocumentMetadataUpdate,
    FileUploadResponse,
    ImportJobResponse,
    KnowledgeBaseCreate,
    KnowledgeBaseResponse,
    KnowledgeBaseUpdate,
    KnowledgeFileResponse,
    WebImportRequest,
)
from ...security import require_roles
from ...services.ingestion import process_import_job
from ...services.chunking import normalize_chunk_config, split_document
from ...services.chunk_enhancement import chunk_index_text
from ...services.metadata_extraction import build_embedding_text, normalize_document_metadata
from ...services.ocr import OcrError, build_ocr, get_ocr
from ...services.parsers import SUPPORTED_EXTENSIONS, parse_bytes
from ...providers import build_gateway
from ...services.storage import ObjectStorage, get_storage
from ...services.tools import validate_target
from ...tasks import process_import_job_task
from ...tenancy import current_workspace_id

router = APIRouter(dependencies=[Depends(require_roles("admin", "manager"))])


class _ReadableHtml(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.title = ""
        self._in_title = False
        self._ignored_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript", "svg"}:
            self._ignored_depth += 1
        elif tag == "title":
            self._in_title = True
        elif tag in {"h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "li", "br", "tr"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg"} and self._ignored_depth:
            self._ignored_depth -= 1
        elif tag == "title":
            self._in_title = False
        elif tag in {"p", "div", "li", "tr"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if self._ignored_depth:
            return
        text = " ".join(data.split())
        if not text:
            return
        if self._in_title:
            self.title = f"{self.title} {text}".strip()
        self.parts.append(text)

    def markdown(self) -> str:
        lines = [" ".join(line.split()) for line in "".join(self.parts).splitlines()]
        return "\n\n".join(line for line in lines if line)


async def dispatch_import_job(
    session: AsyncSession,
    job: ImportJob,
    file: KnowledgeFile,
    *,
    storage: ObjectStorage | None = None,
) -> ImportJob:
    settings = get_settings()
    if settings.task_mode != "celery":
        return await process_import_job(job.id, session, storage=storage, retry_transient=False)
    try:
        process_import_job_task.delay(job.id)
    except Exception as exc:
        message = f"Celery dispatch failed ({type(exc).__name__}); the file can be retried"
        file.status = JobStatus.FAILED
        file.error_message = message
        job.status = JobStatus.FAILED
        job.current_stage = "dispatch_failed"
        job.stage_details = [
            *(job.stage_details or []),
            {"name": "dispatch_failed", "status": "error", "detail": message},
        ]
        job.error_message = message
        job.finished_at = datetime.now(UTC)
        await session.commit()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Task queue is unavailable; the file was marked failed and can be retried",
            headers={"Retry-After": "5"},
        ) from exc
    return job


async def get_kb_or_404(session: AsyncSession, knowledge_base_id: str) -> KnowledgeBase:
    knowledge_base = await session.get(KnowledgeBase, knowledge_base_id)
    if knowledge_base is None or knowledge_base.workspace_id != current_workspace_id():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Knowledge base not found")
    return knowledge_base


async def validate_model(
    session: AsyncSession,
    model_id: str | None,
    expected_type: ModelType,
) -> None:
    if model_id is None:
        return
    model = await session.get(ModelConfig, model_id)
    if model is None or model.workspace_id != current_workspace_id() or model.model_type != expected_type:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=f"{expected_type} model configuration not found",
        )


async def serialize_kb(session: AsyncSession, knowledge_base: KnowledgeBase) -> KnowledgeBaseResponse:
    file_count = await session.scalar(
        select(func.count()).select_from(KnowledgeFile).where(KnowledgeFile.knowledge_base_id == knowledge_base.id)
    )
    chunk_count = await session.scalar(
        select(func.count()).select_from(DocumentChunk).where(
            DocumentChunk.knowledge_base_id == knowledge_base.id,
            DocumentChunk.embedding.is_not(None),
        )
    )
    return KnowledgeBaseResponse.model_validate(knowledge_base).model_copy(
        update={"file_count": file_count or 0, "chunk_count": chunk_count or 0}
    )


def serialize_chunk(chunk: DocumentChunk) -> ChunkResponse:
    # `indexed` is computed state and is not persisted on the ORM entity.
    # Supplying a value during validation avoids a missing-field error.
    return ChunkResponse.model_validate(
        {
            "id": chunk.id,
            "knowledge_base_id": chunk.knowledge_base_id,
            "file_id": chunk.file_id,
            "ordinal": chunk.ordinal,
            "title": chunk.title,
            "content": chunk.content,
            "page_number": chunk.page_number,
            "char_count": chunk.char_count,
            "metadata_json": chunk.metadata_json,
            "indexed": chunk.embedding is not None,
            "created_at": chunk.created_at,
            "updated_at": chunk.updated_at,
        }
    )


def _require_enhancement_model(knowledge_base: KnowledgeBase, chunk_config: dict[str, Any]) -> None:
    """生成问答对必须有文本理解模型；在入队前就拒绝，避免任务进入后台后才失败。"""
    if chunk_config.get("enhance_qa") and not (knowledge_base.metadata_llm_model_id or knowledge_base.semantic_llm_model_id):
        raise HTTPException(status_code=422, detail="问答对生成需要先在知识库配置中设置文本理解模型")


@router.get("", response_model=list[KnowledgeBaseResponse])
async def list_knowledge_bases(session: AsyncSession = Depends(get_session)) -> list[KnowledgeBaseResponse]:
    result = await session.scalars(select(KnowledgeBase).where(KnowledgeBase.workspace_id == current_workspace_id()).order_by(KnowledgeBase.updated_at.desc()))
    return [await serialize_kb(session, item) for item in result]


@router.post("", response_model=KnowledgeBaseResponse, status_code=status.HTTP_201_CREATED)
async def create_knowledge_base(
    payload: KnowledgeBaseCreate,
    session: AsyncSession = Depends(get_session),
) -> KnowledgeBaseResponse:
    await validate_model(session, payload.embedding_model_id, ModelType.EMBEDDING)
    await validate_model(session, payload.rerank_model_id, ModelType.RERANK)
    await validate_model(session, payload.ocr_model_id, ModelType.OCR)
    await validate_model(session, payload.semantic_llm_model_id, ModelType.LLM)
    await validate_model(session, payload.metadata_llm_model_id, ModelType.LLM)
    knowledge_base = KnowledgeBase(**payload.model_dump())
    session.add(knowledge_base)
    await session.commit()
    await session.refresh(knowledge_base)
    return await serialize_kb(session, knowledge_base)


@router.get("/{knowledge_base_id}", response_model=KnowledgeBaseResponse)
async def get_knowledge_base(
    knowledge_base_id: str,
    session: AsyncSession = Depends(get_session),
) -> KnowledgeBaseResponse:
    return await serialize_kb(session, await get_kb_or_404(session, knowledge_base_id))


@router.patch("/{knowledge_base_id}", response_model=KnowledgeBaseResponse)
async def update_knowledge_base(
    knowledge_base_id: str,
    payload: KnowledgeBaseUpdate,
    session: AsyncSession = Depends(get_session),
) -> KnowledgeBaseResponse:
    knowledge_base = await get_kb_or_404(session, knowledge_base_id)
    values = payload.model_dump(exclude_unset=True)
    non_nullable = {
        "name",
        "description",
        "chunk_size",
        "chunk_overlap",
        "chunk_method",
        "parent_chunk_size",
        "child_chunk_size",
    }
    null_fields = sorted(key for key in non_nullable if key in values and values[key] is None)
    if null_fields:
        raise HTTPException(status_code=422, detail=f"Fields cannot be null: {', '.join(null_fields)}")
    await validate_model(session, values.get("embedding_model_id"), ModelType.EMBEDDING)
    await validate_model(session, values.get("rerank_model_id"), ModelType.RERANK)
    await validate_model(session, values.get("ocr_model_id"), ModelType.OCR)
    await validate_model(session, values.get("semantic_llm_model_id"), ModelType.LLM)
    await validate_model(session, values.get("metadata_llm_model_id"), ModelType.LLM)
    next_chunk_size = values.get("chunk_size", knowledge_base.chunk_size)
    next_overlap = values.get("chunk_overlap", knowledge_base.chunk_overlap)
    if next_overlap >= next_chunk_size:
        raise HTTPException(status_code=422, detail="chunk_overlap must be smaller than chunk_size")
    next_parent_size = values.get("parent_chunk_size", knowledge_base.parent_chunk_size)
    next_child_size = values.get("child_chunk_size", knowledge_base.child_chunk_size)
    if next_child_size >= next_parent_size:
        raise HTTPException(status_code=422, detail="child_chunk_size must be smaller than parent_chunk_size")
    next_method = values.get("chunk_method", knowledge_base.chunk_method)
    next_semantic_model = values.get("semantic_llm_model_id", knowledge_base.semantic_llm_model_id)
    if next_method == "semantic" and not next_semantic_model:
        raise HTTPException(status_code=422, detail="semantic_llm_model_id is required for semantic chunking")
    index_config_changed = (
        "embedding_model_id" in values
        and values["embedding_model_id"] != knowledge_base.embedding_model_id
    ) or any(
        key in values and values[key] != getattr(knowledge_base, key)
        for key in (
            "chunk_method",
            "chunk_size",
            "chunk_overlap",
            "parent_chunk_size",
            "child_chunk_size",
            "semantic_llm_model_id",
            "metadata_llm_model_id",
        )
    )
    for key, value in values.items():
        setattr(knowledge_base, key, value)
    if index_config_changed:
        knowledge_base.embedding_dimension = None
        await session.execute(
            update(DocumentChunk)
            .where(DocumentChunk.knowledge_base_id == knowledge_base.id)
            .values(embedding=None)
        )
    await session.commit()
    await session.refresh(knowledge_base)
    return await serialize_kb(session, knowledge_base)


@router.delete("/{knowledge_base_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_knowledge_base(
    knowledge_base_id: str,
    session: AsyncSession = Depends(get_session),
) -> Response:
    knowledge_base = await get_kb_or_404(session, knowledge_base_id)
    files = list(
        await session.scalars(select(KnowledgeFile).where(KnowledgeFile.knowledge_base_id == knowledge_base_id))
    )
    storage = get_storage()
    try:
        for file in files:
            await storage.delete(file.storage_key)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Object storage cleanup failed; knowledge base was not deleted",
            headers={"Retry-After": "5"},
        ) from exc
    await session.delete(knowledge_base)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{knowledge_base_id}/files", response_model=list[KnowledgeFileResponse])
async def list_files(
    knowledge_base_id: str,
    session: AsyncSession = Depends(get_session),
) -> list[KnowledgeFile]:
    await get_kb_or_404(session, knowledge_base_id)
    result = await session.scalars(
        select(KnowledgeFile)
        .where(KnowledgeFile.knowledge_base_id == knowledge_base_id)
        .order_by(KnowledgeFile.created_at.desc())
    )
    return list(result)


@router.patch("/{knowledge_base_id}/files/{file_id}/metadata", response_model=KnowledgeFileResponse)
async def update_file_metadata(
    knowledge_base_id: str,
    file_id: str,
    payload: DocumentMetadataUpdate,
    session: AsyncSession = Depends(get_session),
) -> KnowledgeFile:
    file = await session.get(KnowledgeFile, file_id)
    if file is None or file.knowledge_base_id != knowledge_base_id:
        raise HTTPException(status_code=404, detail="File not found")
    existing = dict(file.document_metadata or {})
    editable = payload.model_dump(exclude_unset=True)
    merged = {**existing, **editable}
    file.document_metadata = normalize_document_metadata(
        merged,
        extraction_method="manual",
        model_id=existing.get("model_id"),
    )
    chunks = list(
        await session.scalars(select(DocumentChunk).where(DocumentChunk.file_id == file.id))
    )
    for chunk in chunks:
        chunk.metadata_json = {
            **(chunk.metadata_json or {}),
            "document_metadata": file.document_metadata,
        }
        chunk.embedding = None
    await session.commit()
    await session.refresh(file)
    return file


@router.post("/{knowledge_base_id}/files", response_model=FileUploadResponse, status_code=status.HTTP_202_ACCEPTED)
async def upload_file(
    knowledge_base_id: str,
    upload: UploadFile = File(...),
    config: str = Form("{}"),
    session: AsyncSession = Depends(get_session),
) -> FileUploadResponse:
    knowledge_base = await get_kb_or_404(session, knowledge_base_id)
    settings = get_settings()
    safe_name = Path(upload.filename or "upload").name
    extension = Path(safe_name).suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=415, detail=f"Unsupported file extension: {extension or 'none'}")
    data = await upload.read(settings.max_upload_bytes + 1)
    if len(data) > settings.max_upload_bytes:
        raise HTTPException(status_code=413, detail="File exceeds configured upload size limit")
    if not data:
        raise HTTPException(status_code=422, detail="Uploaded file is empty")
    try:
        chunk_config = normalize_chunk_config(
            json.loads(config or "{}"),
            default_method=knowledge_base.chunk_method,
            default_chunk_size=knowledge_base.chunk_size,
            default_chunk_overlap=knowledge_base.chunk_overlap,
            default_parent_chunk_size=knowledge_base.parent_chunk_size,
            default_child_chunk_size=knowledge_base.child_chunk_size,
        )
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail="切块配置不是有效 JSON") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if chunk_config["method"] == ChunkMethod.SEMANTIC and not knowledge_base.semantic_llm_model_id:
        raise HTTPException(status_code=422, detail="语义分块需要先配置文本理解模型")
    _require_enhancement_model(knowledge_base, chunk_config)
    checksum = hashlib.sha256(data).hexdigest()
    duplicate = await session.scalar(
        select(KnowledgeFile).where(
            KnowledgeFile.knowledge_base_id == knowledge_base_id,
            KnowledgeFile.checksum_sha256 == checksum,
        )
    )
    if duplicate:
        raise HTTPException(status_code=409, detail="The same file content already exists in this knowledge base")

    file_id = str(uuid4())
    storage_key = f"knowledge-bases/{knowledge_base_id}/{file_id}/{safe_name}"
    storage = get_storage(settings)
    await storage.put_bytes(storage_key, data, upload.content_type or "application/octet-stream")
    file = KnowledgeFile(
        id=file_id,
        knowledge_base_id=knowledge_base_id,
        filename=safe_name,
        content_type=upload.content_type or "application/octet-stream",
        extension=extension,
        size_bytes=len(data),
        storage_key=storage_key,
        checksum_sha256=checksum,
        chunk_config=chunk_config,
        status=JobStatus.QUEUED,
    )
    job = ImportJob(file=file, status=JobStatus.QUEUED, progress=0, current_stage="queued")
    session.add_all([file, job])
    await session.commit()
    await session.refresh(file)
    await session.refresh(job)

    job = await dispatch_import_job(session, job, file, storage=storage)
    await session.refresh(file)
    return FileUploadResponse(file=KnowledgeFileResponse.model_validate(file), job=ImportJobResponse.model_validate(job))


@router.post("/{knowledge_base_id}/chunk-preview")
async def preview_chunks(
    knowledge_base_id: str,
    upload: UploadFile = File(...),
    config: str = Form("{}"),
    session: AsyncSession = Depends(get_session),
) -> dict:
    knowledge_base = await get_kb_or_404(session, knowledge_base_id)
    settings = get_settings()
    safe_name = Path(upload.filename or "preview").name
    extension = Path(safe_name).suffix.lower()
    if extension not in SUPPORTED_EXTENSIONS:
        raise HTTPException(status_code=415, detail=f"Unsupported file extension: {extension or 'none'}")
    data = await upload.read(settings.max_upload_bytes + 1)
    if not data or len(data) > settings.max_upload_bytes:
        raise HTTPException(status_code=413 if data else 422, detail="Preview file is empty or exceeds the upload limit")
    try:
        values = json.loads(config or "{}")
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail="切块配置不是有效 JSON") from exc
    try:
        chunk_config = normalize_chunk_config(
            values,
            default_method=knowledge_base.chunk_method,
            default_chunk_size=knowledge_base.chunk_size,
            default_chunk_overlap=knowledge_base.chunk_overlap,
            default_parent_chunk_size=knowledge_base.parent_chunk_size,
            default_child_chunk_size=knowledge_base.child_chunk_size,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    method = chunk_config["method"]
    ocr = get_ocr()
    if knowledge_base.ocr_model_id:
        ocr_model = await session.get(ModelConfig, knowledge_base.ocr_model_id)
        if ocr_model:
            ocr = build_ocr(ocr_model)
    try:
        parsed = await parse_bytes(data, safe_name, ocr=ocr)
        semantic_gateway = None
        if method == "semantic":
            if not knowledge_base.semantic_llm_model_id:
                raise ValueError("语义分块需要先配置文本理解模型")
            semantic_model = await session.get(ModelConfig, knowledge_base.semantic_llm_model_id)
            if not semantic_model:
                raise ValueError("语义分块模型不存在")
            semantic_gateway = build_gateway(semantic_model)
        chunks = await split_document(
            parsed,
            chunk_method=method,
            chunk_size=chunk_config["chunk_size"],
            chunk_overlap=chunk_config["chunk_overlap"],
            parent_chunk_size=chunk_config["parent_chunk_size"],
            child_chunk_size=chunk_config["child_chunk_size"],
            semantic_gateway=semantic_gateway,
            separators=chunk_config["separators"],
            heading_level=chunk_config["heading_level"],
            rows_per_chunk=chunk_config["rows_per_chunk"],
        )
    except (ValueError, OcrError) as exc:
        # 扫描件缺 OCR 模型等可预期的问题返回 422 和可操作的提示，而不是 500
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    preview = [{"ordinal": index, "title": str(item.metadata.get("title", f"分块 {index}")), "content": item.page_content, "char_count": len(item.page_content), "metadata": item.metadata} for index, item in enumerate(chunks[:100], start=1)]
    return {"filename": safe_name, "method": method, "total_chunks": len(chunks), "returned_chunks": len(preview), "page_count": parsed.page_count, "warnings": parsed.warnings, "chunks": preview}


@router.post("/{knowledge_base_id}/web-import", response_model=FileUploadResponse, status_code=status.HTTP_202_ACCEPTED)
async def import_web_page(
    knowledge_base_id: str,
    payload: WebImportRequest,
    session: AsyncSession = Depends(get_session),
) -> FileUploadResponse:
    knowledge_base = await get_kb_or_404(session, knowledge_base_id)
    url = str(payload.url)
    try:
        await validate_target(url, allow_private_network=False)
        async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
            response = await client.get(url, headers={"User-Agent": "KnowOrderKnowledgeImporter/1.0"})
        response.raise_for_status()
    except (ValueError, httpx.HTTPError) as exc:
        raise HTTPException(status_code=422, detail=f"网页抓取失败：{exc}") from exc
    content_type = response.headers.get("content-type", "").lower()
    if "text/html" not in content_type and "text/plain" not in content_type:
        raise HTTPException(status_code=415, detail="网页导入只支持 HTML 或纯文本响应")
    if len(response.content) > min(get_settings().max_upload_bytes, 5_000_000):
        raise HTTPException(status_code=413, detail="网页正文超过 5MB 导入上限")
    if "text/html" in content_type:
        parser = _ReadableHtml()
        parser.feed(response.text)
        body = parser.markdown()
        page_title = payload.title or parser.title
    else:
        body = response.text.strip()
        page_title = payload.title
    if len(body) < 20:
        raise HTTPException(status_code=422, detail="未从网页中提取到足够的正文")
    parsed_url = urlparse(url)
    fallback = (Path(parsed_url.path).stem or parsed_url.hostname or "web-page").strip()[:120]
    safe_title = "".join(character for character in (page_title or fallback) if character not in "/\\\0").strip()
    safe_name = f"{safe_title or 'web-page'}.md"
    data = f"# {page_title or fallback}\n\n来源：{url}\n\n{body}\n".encode()
    checksum = hashlib.sha256(data).hexdigest()
    duplicate = await session.scalar(
        select(KnowledgeFile).where(
            KnowledgeFile.knowledge_base_id == knowledge_base_id,
            KnowledgeFile.checksum_sha256 == checksum,
        )
    )
    if duplicate:
        raise HTTPException(status_code=409, detail="该网页内容已经导入当前知识库")
    try:
        chunk_config = normalize_chunk_config(
            payload.chunk_config,
            default_method=knowledge_base.chunk_method,
            default_chunk_size=knowledge_base.chunk_size,
            default_chunk_overlap=knowledge_base.chunk_overlap,
            default_parent_chunk_size=knowledge_base.parent_chunk_size,
            default_child_chunk_size=knowledge_base.child_chunk_size,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    _require_enhancement_model(knowledge_base, chunk_config)
    file_id = str(uuid4())
    storage_key = f"knowledge-bases/{knowledge_base_id}/{file_id}/{safe_name}"
    storage = get_storage()
    await storage.put_bytes(storage_key, data, "text/markdown")
    file = KnowledgeFile(
        id=file_id,
        knowledge_base_id=knowledge_base_id,
        filename=safe_name,
        content_type="text/markdown",
        extension=".md",
        size_bytes=len(data),
        storage_key=storage_key,
        checksum_sha256=checksum,
        status=JobStatus.QUEUED,
        chunk_config=chunk_config,
        document_metadata={"source_url": url},
    )
    job = ImportJob(file=file, status=JobStatus.QUEUED, progress=0, current_stage="queued")
    session.add_all([file, job])
    await session.commit()
    await session.refresh(file)
    await session.refresh(job)
    job = await dispatch_import_job(session, job, file, storage=storage)
    await session.refresh(file)
    return FileUploadResponse(file=KnowledgeFileResponse.model_validate(file), job=ImportJobResponse.model_validate(job))


@router.get("/import-jobs/{job_id}", response_model=ImportJobResponse)
async def get_import_job(job_id: str, session: AsyncSession = Depends(get_session)) -> ImportJob:
    job = await session.scalar(
        select(ImportJob)
        .join(KnowledgeFile, ImportJob.file_id == KnowledgeFile.id)
        .join(KnowledgeBase, KnowledgeFile.knowledge_base_id == KnowledgeBase.id)
        .where(ImportJob.id == job_id, KnowledgeBase.workspace_id == current_workspace_id())
    )
    if job is None:
        raise HTTPException(status_code=404, detail="Import job not found")
    return job


@router.get("/{knowledge_base_id}/import-jobs", response_model=list[ImportJobResponse])
async def list_import_jobs(
    knowledge_base_id: str,
    limit: int = 50,
    session: AsyncSession = Depends(get_session),
) -> list[ImportJob]:
    await get_kb_or_404(session, knowledge_base_id)
    safe_limit = max(1, min(limit, 200))
    query = (
        select(ImportJob)
        .join(KnowledgeFile, ImportJob.file_id == KnowledgeFile.id)
        .where(KnowledgeFile.knowledge_base_id == knowledge_base_id)
        .order_by(ImportJob.created_at.desc())
        .limit(safe_limit)
    )
    return list(await session.scalars(query))


@router.get("/{knowledge_base_id}/chunks", response_model=list[ChunkResponse])
async def list_chunks(
    knowledge_base_id: str,
    file_id: str | None = None,
    session: AsyncSession = Depends(get_session),
) -> list[ChunkResponse]:
    await get_kb_or_404(session, knowledge_base_id)
    query = select(DocumentChunk).where(DocumentChunk.knowledge_base_id == knowledge_base_id)
    if file_id:
        query = query.where(DocumentChunk.file_id == file_id)
    result = await session.scalars(query.order_by(DocumentChunk.file_id, DocumentChunk.ordinal))
    return [serialize_chunk(chunk) for chunk in result]


@router.patch("/{knowledge_base_id}/chunks/{chunk_id}", response_model=ChunkResponse)
async def update_chunk(
    knowledge_base_id: str,
    chunk_id: str,
    payload: ChunkUpdate,
    session: AsyncSession = Depends(get_session),
) -> ChunkResponse:
    chunk = await session.get(DocumentChunk, chunk_id)
    if chunk is None or chunk.knowledge_base_id != knowledge_base_id:
        raise HTTPException(status_code=404, detail="Chunk not found")
    values = payload.model_dump(exclude_unset=True)
    null_fields = sorted(key for key in ("title", "content") if key in values and values[key] is None)
    if null_fields:
        raise HTTPException(status_code=422, detail=f"Fields cannot be null: {', '.join(null_fields)}")
    metadata = dict(chunk.metadata_json or {})
    # 标记为人工编辑并留存首次编辑前的原文：重新切块时据此保留这一块，并找到它在新切块中的位置
    if not metadata.get("manual_edit"):
        metadata["original_content"] = chunk.content
    metadata["manual_edit"] = True
    for key in ("keywords", "qa_pairs"):
        if key in values:
            metadata[key] = values.pop(key) or []
    chunk.metadata_json = metadata
    for key, value in values.items():
        setattr(chunk, key, value)
    chunk.char_count = len(chunk.content)
    # 内容或增强信息变了：立即按新文本重新向量化；没有可用索引模型时标记为未向量化
    chunk.embedding = None
    knowledge_base = await session.get(KnowledgeBase, knowledge_base_id)
    embedding_model = await session.get(ModelConfig, knowledge_base.embedding_model_id) if knowledge_base and knowledge_base.embedding_model_id else None
    if embedding_model is not None and embedding_model.is_enabled:
        text = build_embedding_text(chunk_index_text(chunk.content, metadata), metadata.get("document_metadata"))
        vectors = await build_gateway(embedding_model).embed_documents([text])
        if knowledge_base.embedding_dimension in (None, len(vectors[0])):
            chunk.embedding = vectors[0]
    await session.commit()
    await session.refresh(chunk)
    return serialize_chunk(chunk)


@router.delete("/{knowledge_base_id}/files/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_file(
    knowledge_base_id: str,
    file_id: str,
    session: AsyncSession = Depends(get_session),
) -> Response:
    file = await session.get(KnowledgeFile, file_id)
    if file is None or file.knowledge_base_id != knowledge_base_id:
        raise HTTPException(status_code=404, detail="File not found")
    try:
        await get_storage().delete(file.storage_key)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Object storage cleanup failed; file was not deleted",
            headers={"Retry-After": "5"},
        ) from exc
    await session.delete(file)
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


class RechunkRequest(BaseModel):
    """重新处理单个文件；传入 chunk_config 时按新的切块方式重建该文件的索引。"""

    chunk_config: dict[str, Any] | None = None
    discard_manual_edits: bool = False


@router.post("/{knowledge_base_id}/files/{file_id}/retry", response_model=ImportJobResponse, status_code=status.HTTP_202_ACCEPTED)
async def retry_file(
    knowledge_base_id: str,
    file_id: str,
    payload: RechunkRequest | None = None,
    session: AsyncSession = Depends(get_session),
) -> ImportJobResponse:
    file = await session.get(KnowledgeFile, file_id)
    if file is None or file.knowledge_base_id != knowledge_base_id:
        raise HTTPException(status_code=404, detail="File not found")
    if payload and payload.chunk_config is not None:
        knowledge_base = await get_kb_or_404(session, knowledge_base_id)
        try:
            file.chunk_config = normalize_chunk_config(
                payload.chunk_config,
                default_method=knowledge_base.chunk_method,
                default_chunk_size=knowledge_base.chunk_size,
                default_chunk_overlap=knowledge_base.chunk_overlap,
                default_parent_chunk_size=knowledge_base.parent_chunk_size,
                default_child_chunk_size=knowledge_base.child_chunk_size,
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        _require_enhancement_model(knowledge_base, file.chunk_config)
    active_job = await session.scalar(
        select(ImportJob).where(
            ImportJob.file_id == file.id,
            ImportJob.status.not_in((JobStatus.COMPLETED, JobStatus.FAILED)),
        )
    )
    if active_job is not None:
        raise HTTPException(status_code=409, detail="File already has an active import job")
    if payload and payload.discard_manual_edits:
        for chunk in await session.scalars(select(DocumentChunk).where(DocumentChunk.file_id == file.id)):
            if (chunk.metadata_json or {}).get("manual_edit"):
                chunk.metadata_json = {key: value for key, value in chunk.metadata_json.items() if key not in {"manual_edit", "original_content"}}
    job = ImportJob(file_id=file.id, status=JobStatus.QUEUED, progress=0, current_stage="queued")
    session.add(job)
    await session.commit()
    await session.refresh(job)
    job = await dispatch_import_job(session, job, file)
    return ImportJobResponse.model_validate(job)


@router.post("/{knowledge_base_id}/rebuild", response_model=list[ImportJobResponse], status_code=status.HTTP_202_ACCEPTED)
async def rebuild_knowledge_base(
    knowledge_base_id: str,
    session: AsyncSession = Depends(get_session),
) -> list[ImportJobResponse]:
    await get_kb_or_404(session, knowledge_base_id)
    files = list(
        await session.scalars(select(KnowledgeFile).where(KnowledgeFile.knowledge_base_id == knowledge_base_id))
    )
    jobs: list[ImportJob] = []
    for file in files:
        job = ImportJob(file_id=file.id, status=JobStatus.QUEUED, progress=0, current_stage="queued")
        session.add(job)
        jobs.append(job)
    await session.commit()
    files_by_id = {file.id: file for file in files}
    dispatch_failed = False
    for job in jobs:
        await session.refresh(job)
        try:
            await dispatch_import_job(session, job, files_by_id[job.file_id])
        except HTTPException as exc:
            if exc.status_code != status.HTTP_503_SERVICE_UNAVAILABLE:
                raise
            dispatch_failed = True
    if dispatch_failed:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="One or more jobs could not be queued; failed files can be retried individually",
            headers={"Retry-After": "5"},
        )
    return [ImportJobResponse.model_validate(job) for job in jobs]

