import json
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from backend.app.auth import current_username, require_session
from backend.app.documents import UnsupportedFile, validate_upload
from backend.app.schemas import (
    BatchUploadResponse,
    Candidate,
    CriteriaSuggestionRequest,
    CriteriaSuggestionResponse,
    DecisionUpdate,
    EvidenceSpan,
    ImportDraft,
    ImportLinkRequest,
    Opening,
    OpeningCreate,
    OpeningSnapshot,
    OpeningUpdate,
    ReviewUpdate,
    WeightSuggestionRequest,
    WeightSuggestionResponse,
)

router = APIRouter(prefix="/api", dependencies=[Depends(require_session)])

_MATCH_LEVEL_FRACTION = {"not_found": 0.0, "partial": 0.5, "strong": 1.0}
_CHUNK_SIZE = 1 << 20
_IMPORT_SUFFIXES = {".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp"}


def _repository(request: Request):
    return request.app.state.repository


def _settings(request: Request):
    return request.app.state.settings


def _encode_sse(name: str, payload: dict) -> str:
    data = json.dumps(payload, separators=(",", ":"))
    return f"event: {name}\ndata: {data}\n\n"


async def _store_upload(
    file: UploadFile, destination: Path, max_bytes: int
) -> int:
    written = 0
    try:
        with open(destination, "wb") as out:
            while chunk := await file.read(_CHUNK_SIZE):
                written += len(chunk)
                if written > max_bytes:
                    raise UnsupportedFile(
                        f"File exceeds the {max_bytes} byte limit"
                    )
                out.write(chunk)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    return written


@router.post("/weight-suggestions", response_model=WeightSuggestionResponse)
async def suggest_weights(
    body: WeightSuggestionRequest, request: Request
) -> WeightSuggestionResponse:
    evaluator = request.app.state.evaluator
    suggestions = await evaluator.suggest_weights(body.criteria)
    return WeightSuggestionResponse(suggestions=suggestions)


@router.post("/criteria-suggestions", response_model=CriteriaSuggestionResponse)
async def suggest_criteria(
    body: CriteriaSuggestionRequest, request: Request
) -> CriteriaSuggestionResponse:
    evaluator = request.app.state.evaluator
    suggestions = await evaluator.suggest_criteria(body)
    return CriteriaSuggestionResponse(suggestions=suggestions)


# ---------- openings ----------


@router.post("/openings", status_code=201, response_model=Opening)
async def create_opening(body: OpeningCreate, request: Request) -> Opening:
    repository = _repository(request)
    opening_id = uuid.uuid4().hex
    await repository.create_opening(opening_id, body)
    opening = await repository.get_opening(opening_id)
    assert opening is not None
    return opening


@router.get("/openings", response_model=list[Opening])
async def list_openings(request: Request) -> list[Opening]:
    return await _repository(request).list_openings()


@router.get("/openings/{opening_id}", response_model=Opening)
async def get_opening(opening_id: str, request: Request) -> Opening:
    opening = await _repository(request).get_opening(opening_id)
    if opening is None:
        raise HTTPException(status_code=404, detail="Unknown opening")
    return opening


@router.patch("/openings/{opening_id}", response_model=Opening)
async def update_opening(
    opening_id: str, body: OpeningUpdate, request: Request
) -> Opening:
    updated = await _repository(request).update_opening(opening_id, body)
    if updated is None:
        raise HTTPException(status_code=404, detail="Unknown opening")
    return updated


# ---------- listing import ----------


def _importer(request: Request):
    importer = getattr(request.app.state, "importer", None)
    if importer is None:
        raise HTTPException(
            status_code=503,
            detail="Listing import is not configured "
            "(set OPENROUTER_API_KEY or SMARTCV_FAKE_IMPORTER=true)",
        )
    return importer


@router.post("/openings/import/link", response_model=ImportDraft)
async def import_link(
    body: ImportLinkRequest, request: Request
) -> ImportDraft:
    from backend.app.importer import (
        ImporterUnavailable,
        ImportProviderError,
        ImportSource,
        ListingNotReadable,
    )

    importer = _importer(request)
    try:
        return await importer.import_listing(ImportSource.link(body.url))
    except ImporterUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ListingNotReadable as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except ImportProviderError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.post("/openings/import/file", response_model=ImportDraft)
async def import_file(request: Request, file: UploadFile = File(...)):
    from backend.app.importer import (
        ImporterUnavailable,
        ImportProviderError,
        ImportSource,
        ListingNotReadable,
    )

    importer = _importer(request)
    settings = _settings(request)
    filename = file.filename or "listing"
    suffix = Path(filename).suffix.lower()
    if suffix not in _IMPORT_SUFFIXES:
        raise HTTPException(
            status_code=415,
            detail=(
                f"Unsupported file type '{suffix or '(none)'}'; "
                "drop a PDF, DOCX, or image"
            ),
        )
    staging = settings.data_dir / "import-tmp"
    staging.mkdir(parents=True, exist_ok=True)
    staged = staging / f"{uuid.uuid4().hex}{suffix}"
    try:
        await _store_upload(file, staged, settings.max_file_bytes)
        source = ImportSource.file(
            staged, filename, file.content_type or "application/octet-stream"
        )
        return await importer.import_listing(source)
    except ImporterUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ListingNotReadable as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except ImportProviderError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except UnsupportedFile as error:
        raise HTTPException(status_code=413, detail=str(error)) from error
    finally:
        staged.unlink(missing_ok=True)


# ---------- candidates ----------


@router.post(
    "/openings/{opening_id}/candidates",
    status_code=201,
    response_model=BatchUploadResponse,
)
async def upload_candidates(
    opening_id: str, request: Request, files: list[UploadFile] = File(...)
) -> BatchUploadResponse:
    repository = _repository(request)
    settings = _settings(request)
    if not await repository.opening_exists(opening_id):
        raise HTTPException(status_code=404, detail="Unknown opening")
    if len(files) > settings.max_batch_files:
        raise HTTPException(
            status_code=413,
            detail=f"Batch exceeds {settings.max_batch_files} files",
        )
    if not files:
        raise HTTPException(status_code=422, detail="No files uploaded")

    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    queued: list[str] = []
    batch_ids: list[str] = []
    for upload_order, file in enumerate(files):
        candidate_id = uuid.uuid4().hex
        filename = file.filename or f"cv-{upload_order}"
        suffix = Path(filename).suffix.lower()
        stored_path = settings.uploads_dir / f"{candidate_id}{suffix}"
        error: str | None = None
        try:
            if suffix not in {".pdf", ".docx"}:
                raise UnsupportedFile(
                    f"Unsupported file type '{suffix or '(none)'}'; "
                    "upload PDF or DOCX"
                )
            await _store_upload(file, stored_path, settings.max_file_bytes)
            validate_upload(stored_path, filename, settings.max_file_bytes)
        except UnsupportedFile as exc:
            error = str(exc)
        await repository.add_candidates(
            opening_id,
            [
                {
                    "id": candidate_id,
                    "filename": filename,
                    "stored_path": str(stored_path),
                    "upload_order": upload_order,
                    "mime_type": file.content_type,
                }
            ],
        )
        batch_ids.append(candidate_id)
        if error is None:
            queued.append(candidate_id)
        else:
            await repository.mark_candidate_failed(
                candidate_id, error, retryable=False
            )
    if queued:
        pool = request.app.state.worker_pool
        for candidate_id in queued:
            pool.enqueue(candidate_id)
    await request.app.state.event_publisher.publish_opening_progress(
        opening_id
    )
    results = []
    for candidate_id in batch_ids:
        result = await repository.get_candidate_result(candidate_id)
        assert result is not None
        results.append(result)
    return BatchUploadResponse(candidates=results, total_count=len(results))


@router.get(
    "/openings/{opening_id}/candidates", response_model=list[Candidate]
)
async def list_candidates(
    opening_id: str, request: Request
) -> list[Candidate]:
    repository = _repository(request)
    if not await repository.opening_exists(opening_id):
        raise HTTPException(status_code=404, detail="Unknown opening")
    return await repository.list_candidates(opening_id)


async def opening_event_stream(
    repository, hub, opening_id: str
) -> AsyncIterator[str]:
    async with hub.subscribe(opening_id) as subscriber:
        snapshot = await repository.get_opening_snapshot(opening_id)
        yield _encode_sse(
            "snapshot", snapshot.model_dump(mode="json", by_alias=True)
        )
        if snapshot.opening.is_final:
            return
        async for event in subscriber:
            yield _encode_sse(event.name, event.payload)
            if event.name == "opening.complete":
                break


@router.get("/openings/{opening_id}/events")
async def stream_opening_events(
    opening_id: str, request: Request
) -> StreamingResponse:
    repository = _repository(request)
    if not await repository.opening_exists(opening_id):
        raise HTTPException(status_code=404, detail="Unknown opening")
    hub = request.app.state.event_hub
    return StreamingResponse(
        opening_event_stream(repository, hub, opening_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache"},
    )


@router.get(
    "/openings/{opening_id}/candidates/{candidate_id}/preview",
    response_class=FileResponse,
)
async def get_preview(
    opening_id: str, candidate_id: str, request: Request
) -> FileResponse:
    repository = _repository(request)
    work_item = await repository.get_candidate(candidate_id)
    if work_item is None or work_item.opening_id != opening_id:
        raise HTTPException(status_code=404, detail="Unknown candidate")
    preview_path = await repository.get_preview_path(candidate_id)
    if preview_path is None or not preview_path.exists():
        raise HTTPException(status_code=404, detail="No preview available")
    return FileResponse(preview_path, media_type="application/pdf")


@router.get(
    "/openings/{opening_id}/candidates/{candidate_id}/spans",
    response_model=list[EvidenceSpan],
)
async def get_spans(
    opening_id: str, candidate_id: str, request: Request
) -> list[EvidenceSpan]:
    repository = _repository(request)
    work_item = await repository.get_candidate(candidate_id)
    if work_item is None or work_item.opening_id != opening_id:
        raise HTTPException(status_code=404, detail="Unknown candidate")
    spans = await repository.get_candidate_spans(candidate_id)
    return spans or []


@router.patch(
    "/openings/{opening_id}/candidates/{candidate_id}/criteria/{criterion_id}",
    response_model=Candidate,
)
async def review_criterion(
    opening_id: str,
    candidate_id: str,
    criterion_id: str,
    body: ReviewUpdate,
    request: Request,
) -> Candidate:
    repository = _repository(request)
    work_item = await repository.get_candidate(candidate_id)
    if work_item is None or work_item.opening_id != opening_id:
        raise HTTPException(status_code=404, detail="Unknown candidate")
    if criterion_id not in {c.id for c in work_item.criteria}:
        raise HTTPException(status_code=404, detail="Unknown criterion")
    updated = await repository.update_manual_evaluation(
        candidate_id,
        criterion_id,
        manual_fraction=_MATCH_LEVEL_FRACTION[body.match_level],
        review_note=body.review_note,
        reviewed_by=current_username(request),
    )
    if updated is None:
        raise HTTPException(
            status_code=404, detail="No evaluation for this criterion"
        )
    await request.app.state.event_publisher.publish_candidate_update(
        opening_id, candidate_id
    )
    return updated


@router.patch(
    "/openings/{opening_id}/candidates/{candidate_id}/decision",
    response_model=Candidate,
)
async def decide_candidate(
    opening_id: str,
    candidate_id: str,
    body: DecisionUpdate,
    request: Request,
) -> Candidate:
    repository = _repository(request)
    work_item = await repository.get_candidate(candidate_id)
    if work_item is None or work_item.opening_id != opening_id:
        raise HTTPException(status_code=404, detail="Unknown candidate")
    updated = await repository.update_decision(candidate_id, body.decision)
    if updated is None:
        raise HTTPException(status_code=404, detail="Unknown candidate")
    await request.app.state.event_publisher.publish_candidate_update(
        opening_id, candidate_id
    )
    return updated


@router.post(
    "/openings/{opening_id}/candidates/{candidate_id}/retry",
    response_model=Candidate,
)
async def retry_candidate(
    opening_id: str, candidate_id: str, request: Request
) -> Candidate:
    repository = _repository(request)
    work_item = await repository.get_candidate(candidate_id)
    if work_item is None or work_item.opening_id != opening_id:
        raise HTTPException(status_code=404, detail="Unknown candidate")
    reset = await repository.reset_candidate_for_retry(candidate_id)
    if reset is None:
        raise HTTPException(
            status_code=409,
            detail="Candidate is not a retryable failure",
        )
    request.app.state.worker_pool.enqueue(candidate_id)
    result = await repository.get_candidate_result(candidate_id)
    assert result is not None
    return result
