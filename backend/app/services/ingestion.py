from __future__ import annotations

from datetime import UTC, datetime
from difflib import SequenceMatcher
from typing import Any
from uuid import UUID

from sqlalchemy import delete, select, text, update
from sqlalchemy.exc import InterfaceError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..config import get_settings
from ..models import DocumentChunk, ImportJob, JobStatus, KnowledgeBase, KnowledgeFile, ModelConfig
from ..providers import build_gateway
from .chunking import normalize_chunk_config, split_document
from .chunk_enhancement import chunk_index_text, enhance_chunks
from .metadata_extraction import build_embedding_text, extract_document_metadata
from .ocr import build_ocr, get_ocr
from .parsers import parse_bytes
from .storage import ObjectStorage, get_storage


class TransientImportError(ConnectionError):
    pass


async def ensure_vector_index(session: AsyncSession, knowledge_base_id: str, dimension: int) -> None:
    if session.bind and session.bind.dialect.name == "postgresql":
        # PostgreSQL 的 DDL 不接受绑定参数，部分索引条件只能内联；先校验为 UUID 防止注入。
        kb_uuid = str(UUID(knowledge_base_id))
        dimension = int(dimension)
        index_name = f"ix_chunks_{kb_uuid.replace('-', '')}_hnsw"
        await session.execute(text(
            f"CREATE INDEX IF NOT EXISTS {index_name} ON document_chunks USING hnsw "
            f"((embedding::vector({dimension})) vector_cosine_ops) WHERE knowledge_base_id = '{kb_uuid}'"
        ))
        await session.commit()


def is_transient_error(exc: BaseException) -> bool:
    pending: list[BaseException] = [exc]
    seen: set[int] = set()
    transient_names = {
        "apiconnectionerror",
        "apitimeouterror",
        "connecterror",
        "connecttimeouterror",
        "endpointconnectionerror",
        "pooltimeout",
        "readtimeout",
        "readtimeouterror",
        "writetimeout",
    }
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, (ConnectionError, TimeoutError, OSError, OperationalError, InterfaceError)):
            return True
        if type(current).__name__.lower() in transient_names:
            return True
        status_code = getattr(current, "status_code", None)
        response = getattr(current, "response", None)
        status_code = status_code or getattr(response, "status_code", None)
        if status_code in {408, 429} or (isinstance(status_code, int) and status_code >= 500):
            return True
        provider_response = getattr(current, "response", None)
        if isinstance(provider_response, dict):
            status_code = provider_response.get("status_code")
            if status_code in {408, 429} or (isinstance(status_code, int) and status_code >= 500):
                return True
        pending.extend(item for item in (current.__cause__, current.__context__) if item is not None)
    return False


def _stage(name: str, status: str, detail: str) -> dict[str, str]:
    return {"name": name, "status": status, "detail": detail}


def _finish_active_stages(
    stage_details: list[dict[str, str]],
    *,
    status: str,
) -> list[dict[str, str]]:
    return [
        {**item, "status": status} if item.get("status") == "active" else item
        for item in stage_details
    ]


def _normalized(text: str) -> str:
    return "".join(text.split())


def merge_manual_edits(documents: list[Any], manual_chunks: list[DocumentChunk]) -> list[Any]:
    """重新切块时保留人工编辑过的分块。

    新切出的块如果与某个人工分块编辑前的原文基本一致（相似度 ≥ 0.8），由该人工分块顶替它的位置；
    找不到对应新块的人工分块追加在末尾，内容不会丢。返回的序列里混合了新 Document 和保留的 DocumentChunk。
    """
    merged: list[Any] = list(documents)
    taken: set[int] = set()
    leftovers: list[DocumentChunk] = []
    for chunk in sorted(manual_chunks, key=lambda item: item.ordinal):
        original = _normalized(str((chunk.metadata_json or {}).get("original_content") or chunk.content))
        best_index, best_ratio = -1, 0.8
        for index, document in enumerate(documents):
            if index in taken:
                continue
            candidate = _normalized(document.page_content)
            if candidate == original:
                best_index = index
                break
            matcher = SequenceMatcher(None, original, candidate, autojunk=False)
            if matcher.real_quick_ratio() < best_ratio or matcher.quick_ratio() < best_ratio:
                continue
            ratio = matcher.ratio()
            if ratio >= best_ratio:
                best_index, best_ratio = index, ratio
        if best_index >= 0:
            taken.add(best_index)
            merged[best_index] = chunk
        else:
            leftovers.append(chunk)
    return merged + leftovers


async def _update_job(
    session: AsyncSession,
    job: ImportJob,
    file: KnowledgeFile,
    *,
    status: JobStatus,
    progress: int,
    stage: str,
    detail: str,
) -> None:
    job.status = status
    job.progress = progress
    job.current_stage = stage
    job.stage_details = [
        *_finish_active_stages(job.stage_details, status="success"),
        _stage(stage, "active", detail),
    ]
    file.status = status
    await session.commit()


async def process_import_job(
    job_id: str,
    session: AsyncSession,
    *,
    storage: ObjectStorage | None = None,
    retry_transient: bool = True,
) -> ImportJob:
    query = (
        select(ImportJob)
        .where(ImportJob.id == job_id)
        .options(selectinload(ImportJob.file).selectinload(KnowledgeFile.knowledge_base))
    )
    claimed = await session.execute(
        update(ImportJob)
        .where(ImportJob.id == job_id, ImportJob.status == JobStatus.QUEUED)
        .values(status=JobStatus.UPLOADING, started_at=datetime.now(UTC))
        .execution_options(synchronize_session="evaluate")
    )
    await session.commit()
    job = (await session.scalars(query)).one_or_none()
    if job is None:
        raise ValueError("Import job not found")
    if claimed.rowcount == 0:
        return job
    file = job.file
    knowledge_base = file.knowledge_base
    active_storage = storage or get_storage()

    try:
        await _update_job(
            session,
            job,
            file,
            status=JobStatus.UPLOADING,
            progress=12,
            stage="file_validation",
            detail="文件已写入对象存储，开始校验",
        )
        data = await active_storage.get_bytes(file.storage_key)

        await _update_job(
            session,
            job,
            file,
            status=JobStatus.PARSING,
            progress=34,
            stage="content_parsing",
            detail="提取文字、表格和图片内容",
        )
        active_ocr = get_ocr()
        if knowledge_base.ocr_model_id:
            ocr_model = await session.get(ModelConfig, knowledge_base.ocr_model_id)
            if ocr_model is None or not ocr_model.is_enabled or ocr_model.model_type != "ocr":
                raise ValueError("Configured OCR model is missing, disabled, or invalid")
            active_ocr = build_ocr(ocr_model)
        parsed = await parse_bytes(data, file.filename, ocr=active_ocr)
        file.page_count = parsed.page_count
        if parsed.warnings:
            file.document_metadata = {
                **(file.document_metadata or {}),
                "warnings": parsed.warnings,
                "processing_status": "warning",
            }
            job.stage_details = [
                *_finish_active_stages(job.stage_details, status="success"),
                _stage("ocr_extraction", "warning", "；".join(parsed.warnings)),
            ]

        await _update_job(
            session,
            job,
            file,
            status=JobStatus.PARSING,
            progress=48,
            stage="metadata_extraction",
            detail="抽取时间、版本、主体、负责人、关键词和可能问题",
        )
        if (file.document_metadata or {}).get("extraction_method") == "manual":
            document_metadata = dict(file.document_metadata)
            job.stage_details = [
                *_finish_active_stages(job.stage_details, status="success"),
                _stage("metadata_preserved", "success", "沿用人工修订的文档元数据"),
            ]
        else:
            metadata_gateway = None
            if knowledge_base.metadata_llm_model_id:
                metadata_model = await session.get(ModelConfig, knowledge_base.metadata_llm_model_id)
                if metadata_model is None or not metadata_model.is_enabled or metadata_model.model_type != "llm":
                    raise ValueError("Configured metadata extraction LLM is missing, disabled, or invalid")
                metadata_gateway = build_gateway(metadata_model)
            document_metadata = await extract_document_metadata(
                parsed,
                file.filename,
                gateway=metadata_gateway,
                model_id=knowledge_base.metadata_llm_model_id,
            )
            document_metadata = {
                **{key: value for key, value in (file.document_metadata or {}).items() if key.startswith("source_")},
                **document_metadata,
            }
            file.document_metadata = document_metadata
        if parsed.warnings:
            document_metadata = {
                **document_metadata,
                "warnings": parsed.warnings,
                "processing_status": "warning",
            }
            file.document_metadata = document_metadata

        await _update_job(
            session,
            job,
            file,
            status=JobStatus.CHUNKING,
            progress=62,
            stage="chunking",
            detail="使用 LangChain 结构化分块",
        )
        chunk_config = normalize_chunk_config(
            file.chunk_config,
            default_method=knowledge_base.chunk_method,
            default_chunk_size=knowledge_base.chunk_size,
            default_chunk_overlap=knowledge_base.chunk_overlap,
            default_parent_chunk_size=knowledge_base.parent_chunk_size,
            default_child_chunk_size=knowledge_base.child_chunk_size,
        )
        semantic_gateway = None
        if chunk_config["method"] == "semantic":
            if not knowledge_base.semantic_llm_model_id:
                raise ValueError("Semantic chunking requires an LLM model")
            semantic_model = await session.get(ModelConfig, knowledge_base.semantic_llm_model_id)
            if semantic_model is None or not semantic_model.is_enabled or semantic_model.model_type != "llm":
                raise ValueError("Configured semantic chunking LLM is missing, disabled, or invalid")
            semantic_gateway = build_gateway(semantic_model)
        documents = await split_document(
            parsed,
            chunk_method=chunk_config["method"],
            chunk_size=chunk_config["chunk_size"],
            chunk_overlap=chunk_config["chunk_overlap"],
            parent_chunk_size=chunk_config["parent_chunk_size"],
            child_chunk_size=chunk_config["child_chunk_size"],
            semantic_gateway=semantic_gateway,
            separators=chunk_config["separators"],
            heading_level=chunk_config["heading_level"],
            rows_per_chunk=chunk_config["rows_per_chunk"],
        )
        if not documents:
            raise ValueError("No chunks were produced from the parsed document")

        if chunk_config["enhance_keywords"] or chunk_config["enhance_qa"]:
            await _update_job(
                session,
                job,
                file,
                status=JobStatus.CHUNKING,
                progress=70,
                stage="chunk_enhancement",
                detail="为分块抽取关键词、生成问答对",
            )
            enhancement_gateway = None
            enhancement_model_id = knowledge_base.metadata_llm_model_id or knowledge_base.semantic_llm_model_id
            if enhancement_model_id:
                enhancement_model = await session.get(ModelConfig, enhancement_model_id)
                if enhancement_model is None or not enhancement_model.is_enabled or enhancement_model.model_type != "llm":
                    raise ValueError("Configured text understanding LLM is missing, disabled, or invalid")
                enhancement_gateway = build_gateway(enhancement_model)
            generated_pairs, failed_batches = await enhance_chunks(
                documents,
                qa=chunk_config["enhance_qa"],
                keywords=chunk_config["enhance_keywords"],
                qa_count=chunk_config["qa_per_chunk"],
                gateway=enhancement_gateway,
            )
            summary = [f"{len(documents)} 个分块"]
            if chunk_config["enhance_qa"]:
                summary.append(f"生成 {generated_pairs} 组问答对")
            if failed_batches:
                summary.append(f"{failed_batches} 批模型输出无法解析，已跳过问答对、关键词改用规则抽取")
            job.stage_details = [
                *(item for item in job.stage_details if item.get("name") != "chunk_enhancement"),
                _stage("chunk_enhancement", "warning" if failed_batches else "success", "；".join(summary)),
            ]

        if not knowledge_base.embedding_model_id:
            raise ValueError("Knowledge base has no embedding model configured")
        embedding_model = await session.get(ModelConfig, knowledge_base.embedding_model_id)
        if embedding_model is None or not embedding_model.is_enabled:
            raise ValueError("Configured embedding model is missing or disabled")

        await _update_job(
            session,
            job,
            file,
            status=JobStatus.INDEXING,
            progress=80,
            stage="embedding",
            detail=f"调用 {embedding_model.display_name} 生成向量",
        )
        gateway = build_gateway(embedding_model)
        manual_chunks = [
            chunk
            for chunk in await session.scalars(select(DocumentChunk).where(DocumentChunk.file_id == file.id))
            if (chunk.metadata_json or {}).get("manual_edit")
        ]
        documents = merge_manual_edits(documents, manual_chunks)
        texts = [
            build_embedding_text(
                chunk_index_text(item.content, item.metadata_json) if isinstance(item, DocumentChunk) else chunk_index_text(item.page_content, item.metadata),
                document_metadata,
            )
            for item in documents
        ]
        vectors: list[list[float]] = []
        batch_size = max(1, get_settings().embedding_batch_size)
        for start in range(0, len(texts), batch_size):
            vectors.extend(await gateway.embed_documents(texts[start : start + batch_size]))
        if len(vectors) != len(documents):
            raise ValueError("Embedding provider returned an unexpected vector count")
        dimensions = {len(vector) for vector in vectors}
        if len(dimensions) != 1 or not dimensions:
            raise ValueError("Embedding provider returned inconsistent vector dimensions")
        dimension = dimensions.pop()
        if dimension <= 0:
            raise ValueError("Embedding provider returned empty vectors")
        if knowledge_base.embedding_dimension is not None and knowledge_base.embedding_dimension != dimension:
            raise ValueError("Embedding dimension changed; rebuild is required with a compatible model and index version")
        knowledge_base.embedding_dimension = dimension

        kept_ids = [chunk.id for chunk in manual_chunks]
        await session.execute(delete(DocumentChunk).where(DocumentChunk.file_id == file.id, DocumentChunk.id.not_in(kept_ids)))
        for ordinal, (document, vector) in enumerate(zip(documents, vectors, strict=True), start=1):
            if isinstance(document, DocumentChunk):
                document.ordinal = ordinal
                document.embedding = vector
                document.metadata_json = {**(document.metadata_json or {}), "document_metadata": document_metadata}
                continue
            session.add(
                DocumentChunk(
                    knowledge_base_id=knowledge_base.id,
                    file_id=file.id,
                    ordinal=ordinal,
                    title=str(document.metadata.get("title", f"分块 {ordinal}")),
                    content=document.page_content,
                    page_number=document.metadata.get("page_number"),
                    char_count=len(document.page_content),
                    metadata_json={**document.metadata, "document_metadata": document_metadata},
                    embedding=vector,
                )
            )
        file.chunk_count = len(documents)
        file.status = JobStatus.COMPLETED
        file.error_message = None
        job.status = JobStatus.COMPLETED
        job.progress = 100
        job.current_stage = "completed"
        job.stage_details = [
            *_finish_active_stages(job.stage_details, status="success"),
            _stage(
                "completed", "success",
                f"生成 {len(documents)} 个分块并完成向量索引" + (f"，保留 {len(manual_chunks)} 个人工编辑的分块" if manual_chunks else ""),
            ),
        ]
        job.finished_at = datetime.now(UTC)
        job.error_message = None
        await session.commit()
        await ensure_vector_index(session, knowledge_base.id, dimension)
        await session.refresh(job)
        return job
    except Exception as exc:
        transient = retry_transient and is_transient_error(exc)
        await session.rollback()
        job = (await session.scalars(query)).one()
        file = job.file
        file.status = JobStatus.QUEUED if transient else JobStatus.FAILED
        file.error_message = str(exc)
        job.status = JobStatus.QUEUED if transient else JobStatus.FAILED
        job.current_stage = "retry_pending" if transient else "failed"
        job.stage_details = [
            *_finish_active_stages(job.stage_details, status="error"),
            _stage("retry_pending" if transient else "failed", "active" if transient else "error", str(exc)),
        ]
        job.error_message = str(exc)
        job.finished_at = None if transient else datetime.now(UTC)
        await session.commit()
        if transient:
            raise TransientImportError(str(exc)) from exc
        await session.refresh(job)
        return job

