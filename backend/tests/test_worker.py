import asyncio
import threading
import time
import uuid

import pytest

from backend.app import worker as worker_module
from backend.app.database import SQLiteRepository
from backend.app.events import EventHub, EventPublisher
from backend.app.schemas import (
    CandidateStatus,
    CriterionEvaluation,
    MatchStatus,
)
from backend.app.typesafe_adapter import (
    FakeEvaluator,
    RetryableEvaluationError,
)
from backend.app.worker import CandidateWorkerPool, build_candidate_result
from backend.tests.factories import make_criteria, write_pdf


@pytest.fixture
async def repository(tmp_path):
    repo = SQLiteRepository(tmp_path / "test.sqlite3")
    await repo.open()
    yield repo
    await repo.close()


@pytest.fixture
async def job(repository):
    job_id = uuid.uuid4().hex
    await repository.create_job(job_id, "Backend Engineer", make_criteria())
    return job_id


async def add_candidate(repository, job_id, tmp_path, filename="cv.pdf", text=""):
    stored = tmp_path / f"{uuid.uuid4().hex}"
    write_pdf(stored, text)
    candidate_id = uuid.uuid4().hex
    await repository.add_candidates(
        job_id,
        [
            {
                "id": candidate_id,
                "filename": filename,
                "stored_path": str(stored),
                "upload_order": 0,
            }
        ],
    )
    return candidate_id


def make_pool(repository, tmp_path, evaluator=None, worker_count=4, events=None):
    hub = events or EventHub()
    publisher = EventPublisher(hub, repository)
    pool = CandidateWorkerPool(
        repository=repository,
        evaluator=evaluator or FakeEvaluator(),
        event_publisher=publisher,
        worker_count=worker_count,
    )
    return pool


async def test_job_and_confirmed_weights_persist(repository, job):
    snapshot = await repository.get_job_snapshot(job)
    assert snapshot.title == "Backend Engineer"
    assert [c.id for c in snapshot.criteria] == ["python", "production", "postgresql"]
    assert [c.weight for c in snapshot.criteria] == [5, 4, 3]
    assert snapshot.total_count == 0
    assert snapshot.is_final is False


async def test_each_candidate_updates_independently(repository, job, tmp_path):
    candidate_a = await add_candidate(
        repository, job, tmp_path, text="Python and PostgreSQL production services"
    )
    candidate_b = await add_candidate(
        repository, job, tmp_path, text="customer support work"
    )
    await repository.set_candidate_status(candidate_a, CandidateStatus.FAILED)
    snapshot = await repository.get_job_snapshot(job)
    by_id = {c.id: c for c in snapshot.candidates}
    assert by_id[candidate_a].status == CandidateStatus.FAILED
    assert by_id[candidate_b].status == CandidateStatus.QUEUED


async def test_process_candidate_end_to_end(repository, job, tmp_path):
    candidate_id = await add_candidate(
        repository, job, tmp_path,
        text="Built Python and PostgreSQL production services for years",
    )
    pool = make_pool(repository, tmp_path)
    await pool.start()
    try:
        pool.enqueue(candidate_id)
        deadline = time.time() + 10
        while time.time() < deadline:
            result = await repository.get_candidate_result(candidate_id)
            if result.status in {
                CandidateStatus.COMPLETE,
                CandidateStatus.NEEDS_REVIEW,
                CandidateStatus.FAILED,
            }:
                break
            await asyncio.sleep(0.05)
        result = await repository.get_candidate_result(candidate_id)
        assert result.status == CandidateStatus.COMPLETE
        assert result.total_score is not None
        assert result.total_score > 0
        assert len(result.evaluations) == 3
    finally:
        await pool.stop()


async def test_image_pdf_routes_to_manual_review(repository, job, tmp_path):
    candidate_id = await add_candidate(
        repository, job, tmp_path, filename="scan.pdf", text=""
    )
    pool = make_pool(repository, tmp_path)
    await pool.start()
    try:
        pool.enqueue(candidate_id)
        deadline = time.time() + 10
        status = None
        while time.time() < deadline:
            result = await repository.get_candidate_result(candidate_id)
            status = result.status
            if status != CandidateStatus.QUEUED:
                break
            await asyncio.sleep(0.05)
        result = await repository.get_candidate_result(candidate_id)
        assert result.status == CandidateStatus.NEEDS_REVIEW
        assert result.total_score is None
        assert result.error_message
    finally:
        await pool.stop()


async def test_invalid_signature_fails_without_retry(repository, job, tmp_path):
    stored = tmp_path / uuid.uuid4().hex
    stored.write_bytes(b"garbage")
    candidate_id = uuid.uuid4().hex
    await repository.add_candidates(
        job_id=job,
        items=[{
            "id": candidate_id,
            "filename": "cv.pdf",
            "stored_path": str(stored),
            "upload_order": 0,
        }],
    )
    pool = make_pool(repository, tmp_path)
    await pool.start()
    try:
        pool.enqueue(candidate_id)
        deadline = time.time() + 10
        while time.time() < deadline:
            result = await repository.get_candidate_result(candidate_id)
            if result.status != CandidateStatus.QUEUED:
                break
            await asyncio.sleep(0.05)
        result = await repository.get_candidate_result(candidate_id)
        assert result.status == CandidateStatus.FAILED
        assert result.retryable is False
        assert result.total_score is None
    finally:
        await pool.stop()


async def test_evaluator_error_fails_retryable(repository, job, tmp_path):
    candidate_id = await add_candidate(
        repository, job, tmp_path, text="Python services"
    )

    class FailingEvaluator:
        async def evaluate_candidate(self, criteria, spans):
            raise RetryableEvaluationError("service down")

    pool = make_pool(repository, tmp_path, evaluator=FailingEvaluator())
    await pool.start()
    try:
        pool.enqueue(candidate_id)
        deadline = time.time() + 10
        while time.time() < deadline:
            result = await repository.get_candidate_result(candidate_id)
            if result.status != CandidateStatus.QUEUED:
                break
            await asyncio.sleep(0.05)
        result = await repository.get_candidate_result(candidate_id)
        assert result.status == CandidateStatus.FAILED
        assert result.retryable is True
    finally:
        await pool.stop()


async def test_worker_respects_concurrency_limit(repository, job, tmp_path):
    active = 0
    max_active = 0
    lock = threading.Lock()

    real_parse = worker_module.parse_cv

    def counted_parse(path, original_filename):
        nonlocal active, max_active
        with lock:
            active += 1
            max_active = max(max_active, active)
        try:
            time.sleep(0.05)
            return real_parse(path, original_filename)
        finally:
            with lock:
                active -= 1

    ids = []
    for index in range(8):
        stored = tmp_path / uuid.uuid4().hex
        write_pdf(stored, f"Python PostgreSQL production {index}")
        cid = uuid.uuid4().hex
        ids.append(cid)
        await repository.add_candidates(
            job,
            [{
                "id": cid,
                "filename": f"cv{index}.pdf",
                "stored_path": str(stored),
                "upload_order": index,
            }],
        )

    worker_module.parse_cv = counted_parse
    pool = make_pool(repository, tmp_path, worker_count=4)
    await pool.start()
    try:
        for cid in ids:
            pool.enqueue(cid)
        deadline = time.time() + 30
        while time.time() < deadline:
            snapshot = await repository.get_job_snapshot(job)
            if snapshot.completed_count == 8:
                break
            await asyncio.sleep(0.05)
        snapshot = await repository.get_job_snapshot(job)
        assert snapshot.completed_count == 8
        assert max_active <= 4
    finally:
        worker_module.parse_cv = real_parse
        await pool.stop()


async def test_resumable_candidates_are_reenqueued_on_start(
    repository, job, tmp_path
):
    candidate_id = await add_candidate(
        repository, job, tmp_path, text="Python PostgreSQL production"
    )
    await repository.set_candidate_status(candidate_id, CandidateStatus.EXTRACTING)
    resumable = await repository.list_resumable_candidates()
    assert [c.id for c in resumable] == [candidate_id]

    pool = make_pool(repository, tmp_path)
    await pool.start()
    try:
        deadline = time.time() + 10
        while time.time() < deadline:
            result = await repository.get_candidate_result(candidate_id)
            if result.status == CandidateStatus.COMPLETE:
                break
            await asyncio.sleep(0.05)
        result = await repository.get_candidate_result(candidate_id)
        assert result.status == CandidateStatus.COMPLETE
    finally:
        await pool.stop()


async def test_retry_is_idempotent(repository, job, tmp_path):
    candidate_id = await add_candidate(
        repository, job, tmp_path, text="Python PostgreSQL production"
    )
    pool = make_pool(repository, tmp_path)
    await pool.start()
    try:
        pool.enqueue(candidate_id)
        pool.enqueue(candidate_id)
        deadline = time.time() + 10
        while time.time() < deadline:
            result = await repository.get_candidate_result(candidate_id)
            if result.status == CandidateStatus.COMPLETE:
                break
            await asyncio.sleep(0.05)
        snapshot = await repository.get_job_snapshot(job)
        assert len(snapshot.candidates) == 1
        result = await repository.get_candidate_result(candidate_id)
        assert result.status == CandidateStatus.COMPLETE
    finally:
        await pool.stop()


async def test_manual_override_recalculates_total(repository, job, tmp_path):
    candidate_id = await add_candidate(
        repository, job, tmp_path, text="customer support only"
    )
    pool = make_pool(repository, tmp_path)
    await pool.start()
    try:
        pool.enqueue(candidate_id)
        deadline = time.time() + 10
        while time.time() < deadline:
            result = await repository.get_candidate_result(candidate_id)
            if result.status in {CandidateStatus.COMPLETE, CandidateStatus.NEEDS_REVIEW}:
                break
            await asyncio.sleep(0.05)
    finally:
        await pool.stop()

    result = await repository.get_candidate_result(candidate_id)
    before = result.total_score
    updated = await repository.update_manual_evaluation(
        candidate_id, "python", manual_fraction=1.0, review_note="Verified"
    )
    assert updated.evaluations[0].manual_fraction == 1.0
    assert updated.evaluations[0].status == MatchStatus.REVIEWED
    assert updated.total_score is not None
    assert updated.total_score != before


async def test_terminal_marker_is_atomic(repository, job, tmp_path):
    candidate_id = await add_candidate(
        repository, job, tmp_path, text="Python PostgreSQL production"
    )
    assert await repository.mark_job_complete_if_terminal(job) is False
    await repository.set_candidate_status(candidate_id, CandidateStatus.COMPLETE)
    assert await repository.mark_job_complete_if_terminal(job) is True
    assert await repository.mark_job_complete_if_terminal(job) is False


def test_build_candidate_result_flags_uncertain_evaluations():
    criteria = make_criteria()
    work_item = type(
        "WorkItem",
        (),
        {
            "id": "c1",
            "job_id": "j1",
            "filename": "cv.pdf",
            "stored_path": "/x",
            "upload_order": 0,
            "criteria": criteria,
        },
    )()
    evaluations = [
        CriterionEvaluation(
            criterion_id="python",
            status=MatchStatus.NEEDS_REVIEW,
            confidence=0.2,
            model_fraction=1.0,
        ),
        CriterionEvaluation(
            criterion_id="production",
            status=MatchStatus.STRONG,
            confidence=0.9,
            model_fraction=1.0,
        ),
        CriterionEvaluation(
            criterion_id="postgresql",
            status=MatchStatus.NOT_FOUND,
            confidence=0.9,
            model_fraction=0.0,
        ),
    ]
    result = build_candidate_result(work_item, evaluations)
    assert result.status == CandidateStatus.NEEDS_REVIEW
    assert result.total_score == round(100 * (5 * 1.0 + 4 * 1.0 + 3 * 0.0) / 12, 2)
