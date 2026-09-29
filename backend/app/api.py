import json
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from backend.app.auth import require_session
from backend.app.documents import UnsupportedFile, validate_upload
from backend.app.schemas import (
    BatchUploadResponse,
    CandidateResult,
    EvidenceSpan,
    JobCreate,
    JobSnapshot,
    ReviewUpdate,
    WeightSuggestionRequest,
    WeightSuggestionResponse,
)

router = APIRouter(prefix="/api", dependencies=[Depends(require_session)])

_MATCH_LEVEL_FRACTION = {"not_found": 0.0, "partial": 0.5, "strong": 1.0}
_CHUNK_SIZE = 1 << 20


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


@router.post("/jobs", status_code=201, response_model=JobSnapshot)
async def create_job(body: JobCreate, request: Request) -> JobSnapshot:
    repository = _repository(request)
    job_id = uuid.uuid4().hex
    await repository.create_job(job_id, body.title, body.criteria)
    snapshot = await repository.get_job_snapshot(job_id)
    assert snapshot is not None
    return snapshot


@router.post(
    "/jobs/{job_id}/cvs",
    status_code=201,
    response_model=BatchUploadResponse,
)
async def upload_cvs(
    job_id: str, request: Request, files: list[UploadFile] = File(...)
) -> BatchUploadResponse:
    repository = _repository(request)
    settings = _settings(request)
    if not await repository.job_exists(job_id):
        raise HTTPException(status_code=404, detail="Unknown job")
    if len(files) > settings.max_batch_files:
        raise HTTPException(
            status_code=413,
            detail=f"Batch exceeds {settings.max_batch_files} files",
        )
    if not files:
        raise HTTPException(status_code=422, detail="No files uploaded")

    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    queued: list[dict] = []
    results: list[CandidateResult] = []
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
        if error is None:
            queued.append(
                {
                    "id": candidate_id,
                    "filename": filename,
                    "stored_path": str(stored_path),
                    "upload_order": upload_order,
                }
            )
            results.append(
                CandidateResult(
                    id=candidate_id,
                    filename=filename,
                    upload_order=upload_order,
                    status="queued",
                )
            )
        else:
            await repository.add_candidates(
                job_id,
                [{
                    "id": candidate_id,
                    "filename": filename,
                    "stored_path": str(stored_path),
                    "upload_order": upload_order,
                }],
            )
            await repository.mark_candidate_failed(
                candidate_id, error, retryable=False
            )
            results.append(
                CandidateResult(
                    id=candidate_id,
                    filename=filename,
                    upload_order=upload_order,
                    status="failed",
                    error_message=error,
                    retryable=False,
                )
            )
    if queued:
        await repository.add_candidates(job_id, queued)
        pool = request.app.state.worker_pool
        for item in queued:
            pool.enqueue(item["id"])
    await request.app.state.event_publisher.publish_job_progress(job_id)
    return BatchUploadResponse(
        candidates=results, total_count=len(results)
    )


@router.get("/jobs/{job_id}", response_model=JobSnapshot)
async def get_job(job_id: str, request: Request) -> JobSnapshot:
    snapshot = await _repository(request).get_job_snapshot(job_id)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Unknown job")
    return snapshot


async def job_event_stream(
    repository, hub, job_id: str
) -> AsyncIterator[str]:
    async with hub.subscribe(job_id) as subscriber:
        snapshot = await repository.get_job_snapshot(job_id)
        yield _encode_sse("snapshot", snapshot.model_dump(mode="json"))
        if snapshot.is_final:
            return
        async for event in subscriber:
            yield _encode_sse(event.name, event.payload)
            if event.name == "job.complete":
                break


@router.get("/jobs/{job_id}/events")
async def stream_job_events(job_id: str, request: Request) -> StreamingResponse:
    repository = _repository(request)
    if not await repository.job_exists(job_id):
        raise HTTPException(status_code=404, detail="Unknown job")
    hub = request.app.state.event_hub
    return StreamingResponse(
        job_event_stream(repository, hub, job_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache"},
    )


@router.get(
    "/jobs/{job_id}/candidates/{candidate_id}/preview",
    response_class=FileResponse,
)
async def get_preview(
    job_id: str, candidate_id: str, request: Request
) -> FileResponse:
    repository = _repository(request)
    work_item = await repository.get_candidate(candidate_id)
    if work_item is None or work_item.job_id != job_id:
        raise HTTPException(status_code=404, detail="Unknown candidate")
    preview_path = await repository.get_preview_path(candidate_id)
    if preview_path is None or not preview_path.exists():
        raise HTTPException(status_code=404, detail="No preview available")
    return FileResponse(preview_path, media_type="application/pdf")


@router.get(
    "/jobs/{job_id}/candidates/{candidate_id}/spans",
    response_model=list[EvidenceSpan],
)
async def get_spans(
    job_id: str, candidate_id: str, request: Request
) -> list[EvidenceSpan]:
    repository = _repository(request)
    work_item = await repository.get_candidate(candidate_id)
    if work_item is None or work_item.job_id != job_id:
        raise HTTPException(status_code=404, detail="Unknown candidate")
    spans = await repository.get_candidate_spans(candidate_id)
    return spans or []


@router.patch(
    "/jobs/{job_id}/candidates/{candidate_id}/criteria/{criterion_id}",
    response_model=CandidateResult,
)
async def review_criterion(
    job_id: str,
    candidate_id: str,
    criterion_id: str,
    body: ReviewUpdate,
    request: Request,
) -> CandidateResult:
    repository = _repository(request)
    work_item = await repository.get_candidate(candidate_id)
    if work_item is None or work_item.job_id != job_id:
        raise HTTPException(status_code=404, detail="Unknown candidate")
    if criterion_id not in {c.id for c in work_item.criteria}:
        raise HTTPException(status_code=404, detail="Unknown criterion")
    updated = await repository.update_manual_evaluation(
        candidate_id,
        criterion_id,
        manual_fraction=_MATCH_LEVEL_FRACTION[body.match_level],
        review_note=body.review_note,
    )
    if updated is None:
        raise HTTPException(
            status_code=404, detail="No evaluation for this criterion"
        )
    await request.app.state.event_publisher.publish_candidate_update(
        job_id, candidate_id
    )
    return updated


@router.post(
    "/jobs/{job_id}/candidates/{candidate_id}/retry",
    response_model=CandidateResult,
)
async def retry_candidate(
    job_id: str, candidate_id: str, request: Request
) -> CandidateResult:
    repository = _repository(request)
    work_item = await repository.get_candidate(candidate_id)
    if work_item is None or work_item.job_id != job_id:
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
