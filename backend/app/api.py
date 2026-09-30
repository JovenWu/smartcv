import asyncio
import hashlib
import inspect
import json
import logging
import uuid
import zipfile
from collections.abc import AsyncIterator, Iterable
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import Field

from backend.app.auth import current_username, require_session
from backend.app.documents import UnsupportedFile, validate_upload
from backend.app.schemas import (
    ApiModel,
    BatchUploadResponse,
    Candidate,
    CandidateDecision,
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

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", dependencies=[Depends(require_session)])

_MATCH_LEVEL_FRACTION = {"not_found": 0.0, "partial": 0.5, "strong": 1.0}
_CHUNK_SIZE = 1 << 20
_IMPORT_SUFFIXES = {".pdf", ".docx", ".png", ".jpg", ".jpeg", ".webp"}
_SSE_HEARTBEAT_SECONDS = 15
_STREAM_END_EVENTS = {"opening.complete", "opening.deleted"}


class BulkDecisionUpdate(ApiModel):
    candidate_ids: list[str] = Field(default_factory=list)
    decision: CandidateDecision


class BulkDecisionResponse(ApiModel):
    updated: int


def _repository(request: Request):
    return request.app.state.repository


def _settings(request: Request):
    return request.app.state.settings


def _encode_sse(name: str, payload: dict) -> str:
    data = json.dumps(payload, separators=(",", ":"))
    return f"event: {name}\ndata: {data}\n\n"


async def _store_upload(
    file: UploadFile, destination: Path, max_bytes: int
) -> str:
    """Stream the upload to disk; return its SHA-256 hex digest."""
    written = 0
    hasher = hashlib.sha256()
    try:
        with open(destination, "wb") as out:
            while chunk := await file.read(_CHUNK_SIZE):
                written += len(chunk)
                if written > max_bytes:
                    raise UnsupportedFile(
                        f"File exceeds the {max_bytes} byte limit"
                    )
                hasher.update(chunk)
                out.write(chunk)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    return hasher.hexdigest()


def _unlink_paths(paths: Iterable[str | Path | None]) -> None:
    """Best-effort unlink; missing files are fine, the rest get logged."""
    seen: set[str] = set()
    for raw in paths:
        if not raw:
            continue
        key = str(raw)
        if key in seen:
            continue
        seen.add(key)
        try:
            Path(key).unlink(missing_ok=True)
        except OSError:
            log.warning("Could not delete stored file %s", key, exc_info=True)


def _worker_pool(request: Request):
    return getattr(request.app.state, "worker_pool", None)


def _discard_pending(request: Request, candidate_ids: Iterable[str]) -> None:
    pool = _worker_pool(request)
    discard = getattr(pool, "discard_pending", None)
    if discard is None:
        return
    for candidate_id in candidate_ids:
        discard(candidate_id)


async def _close_opening_stream(hub, opening_id: str) -> None:
    result = hub.close_opening(opening_id)
    if inspect.isawaitable(result):
        await result


@router.post("/weight-suggestions", response_model=WeightSuggestionResponse)
async def suggest_weights(
    body: WeightSuggestionRequest, request: Request
) -> WeightSuggestionResponse:
    from backend.app.typesafe_adapter import RetryableEvaluationError

    evaluator = request.app.state.evaluator
    try:
        suggestions = await evaluator.suggest_weights(body.criteria)
    except RetryableEvaluationError as error:
        log.warning("Weight suggestion failed: %s", error)
        raise HTTPException(
            status_code=502, detail="Suggestion request failed"
        ) from error
    return WeightSuggestionResponse(suggestions=suggestions)


@router.post("/criteria-suggestions", response_model=CriteriaSuggestionResponse)
async def suggest_criteria(
    body: CriteriaSuggestionRequest, request: Request
) -> CriteriaSuggestionResponse:
    from backend.app.typesafe_adapter import RetryableEvaluationError

    evaluator = request.app.state.evaluator
    try:
        suggestions = await evaluator.suggest_criteria(body)
    except RetryableEvaluationError as error:
        log.warning("Criteria suggestion failed: %s", error)
        raise HTTPException(
            status_code=502, detail="Suggestion request failed"
        ) from error
    return CriteriaSuggestionResponse(suggestions=suggestions)


# ---------- openings ----------


@router.post("/openings", status_code=201, response_model=Opening)
async def create_opening(body: OpeningCreate, request: Request) -> Opening:
    repository = _repository(request)
    opening_id = uuid.uuid4().hex
    await repository.create_opening(opening_id, body)
    opening = await repository.get_opening(opening_id)
    if opening is None:
        raise HTTPException(
            status_code=500, detail="Opening could not be loaded"
        )
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


@router.delete("/openings/{opening_id}", status_code=204)
async def delete_opening(opening_id: str, request: Request) -> None:
    repository = _repository(request)
    # Capture candidate ids up front so queued worker items can be
    # discarded once the rows are gone.
    candidate_ids = [
        candidate.id
        for candidate in await repository.list_candidates(opening_id)
    ]
    file_paths = await repository.delete_opening(opening_id)
    if file_paths is None:
        raise HTTPException(status_code=404, detail="Unknown opening")
    await asyncio.to_thread(
        _unlink_paths, (path for pair in file_paths for path in pair)
    )
    _discard_pending(request, candidate_ids)
    await _close_opening_stream(request.app.state.event_hub, opening_id)


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


def _import_http_error(error: Exception) -> HTTPException:
    """Map importer failures to generic responses; internals stay in logs."""
    from backend.app.importer import (
        ImporterUnavailable,
        ListingNotReadable,
    )

    if isinstance(error, ImporterUnavailable):
        status_code, detail = 503, "Listing import is unavailable"
    elif isinstance(error, ListingNotReadable):
        status_code, detail = 422, "Listing import failed"
    else:  # ImportProviderError
        status_code, detail = 502, "Listing import failed"
    log.warning(
        "Listing import failed (%s): %s", type(error).__name__, error
    )
    return HTTPException(status_code=status_code, detail=detail)


def _validate_import_signature(path: Path, suffix: str) -> None:
    """Magic-byte check for staged listing files, per _IMPORT_SUFFIXES."""
    with open(path, "rb") as handle:
        header = handle.read(1024)
    if suffix == ".pdf":
        valid = b"%PDF-" in header
    elif suffix == ".docx":
        valid = _is_docx(path)
    elif suffix == ".png":
        valid = header.startswith(b"\x89PNG\r\n\x1a\n")
    elif suffix in {".jpg", ".jpeg"}:
        valid = header.startswith(b"\xff\xd8\xff")
    elif suffix == ".webp":
        valid = (
            len(header) >= 12
            and header[:4] == b"RIFF"
            and header[8:12] == b"WEBP"
        )
    else:
        valid = False
    if not valid:
        raise UnsupportedFile(
            f"File content does not match '{suffix or '(none)'}'"
        )


def _is_docx(path: Path) -> bool:
    if not zipfile.is_zipfile(path):
        return False
    try:
        with zipfile.ZipFile(path) as archive:
            return "word/document.xml" in set(archive.namelist())
    except zipfile.BadZipFile:
        return False


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
    except (ImporterUnavailable, ListingNotReadable, ImportProviderError) as error:
        raise _import_http_error(error) from error


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
        try:
            await _store_upload(file, staged, settings.max_file_bytes)
        except UnsupportedFile as error:
            raise HTTPException(
                status_code=413, detail=str(error)
            ) from error
        try:
            await asyncio.to_thread(
                _validate_import_signature, staged, suffix
            )
        except UnsupportedFile as error:
            raise HTTPException(
                status_code=415, detail=str(error)
            ) from error
        source = ImportSource.file(
            staged, filename, file.content_type or "application/octet-stream"
        )
        try:
            return await importer.import_listing(source)
        except (
            ImporterUnavailable,
            ListingNotReadable,
            ImportProviderError,
        ) as error:
            raise _import_http_error(error) from error
    finally:
        await asyncio.to_thread(_unlink_paths, (staged,))


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
    duplicate_ids: list[str] = []
    failures: dict[str, str] = {}
    new_items: list[dict] = []
    seen_hashes: dict[str, str] = {}
    for upload_order, file in enumerate(files):
        candidate_id = uuid.uuid4().hex
        filename = file.filename or f"cv-{upload_order}"
        suffix = Path(filename).suffix.lower()
        stored_path = settings.uploads_dir / f"{candidate_id}{suffix}"
        error: str | None = None
        file_hash: str | None = None
        try:
            if suffix not in {".pdf", ".docx"}:
                raise UnsupportedFile(
                    f"Unsupported file type '{suffix or '(none)'}'; "
                    "upload PDF or DOCX"
                )
            file_hash = await _store_upload(
                file, stored_path, settings.max_file_bytes
            )
        except UnsupportedFile as exc:
            error = str(exc)
            await asyncio.to_thread(_unlink_paths, (stored_path,))
        if error is None and file_hash is not None:
            duplicate_id = seen_hashes.get(
                file_hash
            ) or await repository.find_candidate_by_file_hash(
                opening_id, file_hash
            )
            if duplicate_id is not None:
                await asyncio.to_thread(_unlink_paths, (stored_path,))
                duplicate_ids.append(duplicate_id)
                continue
            seen_hashes[file_hash] = candidate_id
            try:
                await asyncio.to_thread(
                    validate_upload,
                    stored_path,
                    filename,
                    settings.max_file_bytes,
                )
            except UnsupportedFile as exc:
                error = str(exc)
                await asyncio.to_thread(_unlink_paths, (stored_path,))
        new_items.append(
            {
                "id": candidate_id,
                "filename": filename,
                "stored_path": str(stored_path),
                "upload_order": upload_order,
                "mime_type": file.content_type,
                "file_hash": file_hash,
            }
        )
        batch_ids.append(candidate_id)
        if error is None:
            queued.append(candidate_id)
        else:
            failures[candidate_id] = error
    # Single commit for the whole batch; on failure every file written
    # above is an orphan and must be removed (no rows landed).
    if new_items:
        try:
            await repository.add_candidates(opening_id, new_items)
        except Exception:
            await asyncio.to_thread(
                _unlink_paths,
                (item["stored_path"] for item in new_items),
            )
            raise
    for candidate_id, error in failures.items():
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
        if result is None:
            raise HTTPException(
                status_code=500, detail="Uploaded candidate is missing"
            )
        results.append(result)
    duplicates = []
    for candidate_id in duplicate_ids:
        result = await repository.get_candidate_result(candidate_id)
        if result is not None:
            duplicates.append(result)
    return BatchUploadResponse(
        candidates=results,
        duplicates=duplicates,
        total_count=len(results) + len(duplicates),
    )


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


@router.delete(
    "/openings/{opening_id}/candidates/{candidate_id}", status_code=204
)
async def delete_candidate(
    opening_id: str, candidate_id: str, request: Request
) -> None:
    repository = _repository(request)
    work_item = await repository.get_candidate(candidate_id)
    if work_item is None or work_item.opening_id != opening_id:
        raise HTTPException(status_code=404, detail="Unknown candidate")
    deleted = await repository.delete_candidate(candidate_id)
    if deleted is None:
        raise HTTPException(status_code=404, detail="Unknown candidate")
    stored_path, preview_path, _opening_id = deleted
    await asyncio.to_thread(_unlink_paths, (stored_path, preview_path))
    _discard_pending(request, (candidate_id,))
    publisher = request.app.state.event_publisher
    publisher.publish_candidate_deleted(opening_id, candidate_id)
    # publish_opening_progress also runs the terminal check, which may
    # emit opening.complete when this was the last non-terminal row.
    await publisher.publish_opening_progress(opening_id)


@router.post(
    "/openings/{opening_id}/candidates/bulk-decision",
    response_model=BulkDecisionResponse,
)
async def bulk_decide_candidates(
    opening_id: str, body: BulkDecisionUpdate, request: Request
) -> BulkDecisionResponse:
    repository = _repository(request)
    if not await repository.opening_exists(opening_id):
        raise HTTPException(status_code=404, detail="Unknown opening")
    updated = await repository.bulk_set_decision(
        opening_id, body.candidate_ids, body.decision
    )
    await request.app.state.event_publisher.publish_candidates_updated(
        opening_id, body.candidate_ids
    )
    return BulkDecisionResponse(updated=updated)


async def opening_event_stream(
    repository, hub, opening_id: str
) -> AsyncIterator[str]:
    async with hub.subscribe(opening_id) as subscriber:
        snapshot = await repository.get_opening_snapshot(opening_id)
        if snapshot is None:
            # Opening was deleted between the route check and now —
            # close the stream instead of crashing on model_dump.
            return
        yield _encode_sse(
            "snapshot", snapshot.model_dump(mode="json", by_alias=True)
        )
        if snapshot.opening.is_final:
            return
        while True:
            try:
                event = await asyncio.wait_for(
                    anext(subscriber), timeout=_SSE_HEARTBEAT_SECONDS
                )
            except asyncio.TimeoutError:
                yield ": hb\n\n"
                continue
            except StopAsyncIteration:
                # Hub closed the subscriber (e.g. opening deleted).
                return
            name = getattr(event, "name", None)
            if name is None or name == "close":
                # Close sentinel from the hub — end the stream.
                return
            yield _encode_sse(name, event.payload)
            if name in _STREAM_END_EVENTS:
                return


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
    if result is None:
        raise HTTPException(
            status_code=500, detail="Candidate result is missing"
        )
    return result
