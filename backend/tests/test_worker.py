import asyncio
import threading
import time
import uuid

import pytest

from backend.app import worker as worker_module
from backend.app.config import Settings
from backend.app.database import SQLiteRepository
from backend.app.events import EventHub, EventPublisher
from backend.app.schemas import (
    CandidateStatus,
    CriterionEvaluation,
    MatchStatus,
    OpeningCreate,
)
from backend.app.typesafe_adapter import (
    FakeEvaluator,
    RetryableEvaluationError,
)
from backend.app.worker import CandidateWorkerPool, candidate_outcome
from backend.tests.factories import make_criteria, write_pdf


@pytest.fixture
async def repository(tmp_path):
    repo = SQLiteRepository(tmp_path / "test.sqlite3")
    await repo.open()
    yield repo
    await repo.close()


@pytest.fixture
async def opening(repository):
    opening_id = uuid.uuid4().hex
    await repository.create_opening(
        opening_id,
        OpeningCreate(title="Backend Engineer", criteria=make_criteria()),
    )
    return opening_id


async def add_candidate(
    repository, opening_id, tmp_path, filename="cv.pdf", text=""
):
    stored = tmp_path / f"{uuid.uuid4().hex}"
    write_pdf(stored, text)
    candidate_id = uuid.uuid4().hex
    await repository.add_candidates(
        opening_id,
        [
            {
                "id": candidate_id,
                "filename": filename,
                "stored_path": str(stored),
                "upload_order": 0,
                "mime_type": "application/pdf",
            }
        ],
    )
    return candidate_id


def make_pool(
    repository,
    tmp_path,
    evaluator=None,
    worker_count=4,
    events=None,
    reviewer=None,
):
    hub = events or EventHub()
    publisher = EventPublisher(hub, repository)
    pool = CandidateWorkerPool(
        repository=repository,
        evaluator=evaluator or FakeEvaluator(),
        event_publisher=publisher,
        worker_count=worker_count,
        reviewer=reviewer,
        settings=Settings(_env_file=None, data_dir=tmp_path / "data"),
    )
    return pool


class FlaggingEvaluator:
    async def evaluate_candidate(self, criteria, spans, opening=None):
        return [
            CriterionEvaluation(
                criterion_id=criterion.id,
                status=MatchStatus.NEEDS_REVIEW,
                confidence=0.2,
                model_fraction=0.5,
            )
            for criterion in criteria
        ]


async def test_opening_and_confirmed_weights_persist(repository, opening):
    snapshot = await repository.get_opening_snapshot(opening)
    assert snapshot.opening.title == "Backend Engineer"
    assert [c.id for c in snapshot.opening.criteria] == [
        "python",
        "production",
        "postgresql",
    ]
    assert [c.weight for c in snapshot.opening.criteria] == [5, 4, 3]
    assert snapshot.candidates == []
    assert snapshot.opening.is_final is False


async def test_each_candidate_updates_independently(
    repository, opening, tmp_path
):
    candidate_a = await add_candidate(
        repository,
        opening,
        tmp_path,
        text="Python and PostgreSQL production services",
    )
    candidate_b = await add_candidate(
        repository, opening, tmp_path, text="customer support work"
    )
    await repository.set_candidate_status(candidate_a, CandidateStatus.FAILED)
    snapshot = await repository.get_opening_snapshot(opening)
    by_id = {c.id: c for c in snapshot.candidates}
    assert by_id[candidate_a].status == CandidateStatus.FAILED
    assert by_id[candidate_b].status == CandidateStatus.QUEUED


async def test_process_candidate_end_to_end(repository, opening, tmp_path):
    candidate_id = await add_candidate(
        repository,
        opening,
        tmp_path,
        text="Jane Doe\njane@example.com\n"
        "Built Python and PostgreSQL production services for years",
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
        assert result.name == "Jane Doe"
        assert result.email == "jane@example.com"
        assert result.file.page_count == 1
        assert result.file.url.endswith("/preview")
    finally:
        await pool.stop()


async def test_image_pdf_routes_to_manual_review(repository, opening, tmp_path):
    candidate_id = await add_candidate(
        repository, opening, tmp_path, filename="scan.pdf", text=""
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
        assert result.status == CandidateStatus.NEEDS_REVIEW
        assert result.total_score is None
        assert result.error_message
    finally:
        await pool.stop()


async def test_invalid_signature_fails_without_retry(
    repository, opening, tmp_path
):
    stored = tmp_path / uuid.uuid4().hex
    stored.write_bytes(b"garbage")
    candidate_id = uuid.uuid4().hex
    await repository.add_candidates(
        opening_id=opening,
        items=[
            {
                "id": candidate_id,
                "filename": "cv.pdf",
                "stored_path": str(stored),
                "upload_order": 0,
            }
        ],
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
        assert result.status == CandidateStatus.FAILED
        assert result.retryable is False
        assert result.total_score is None
    finally:
        await pool.stop()


async def test_evaluator_error_fails_retryable(repository, opening, tmp_path):
    candidate_id = await add_candidate(
        repository, opening, tmp_path, text="Python services"
    )

    class FailingEvaluator:
        async def evaluate_candidate(self, criteria, spans, opening=None):
            raise RetryableEvaluationError("service down")

    pool = make_pool(repository, tmp_path, evaluator=FailingEvaluator())
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
        assert result.status == CandidateStatus.FAILED
        assert result.retryable is True
    finally:
        await pool.stop()


async def test_worker_respects_concurrency_limit(repository, opening, tmp_path):
    active = 0
    max_active = 0
    lock = threading.Lock()

    real_parse = worker_module.parse_cv

    def counted_parse(path, original_filename, settings=None):
        nonlocal active, max_active
        with lock:
            active += 1
            max_active = max(max_active, active)
        try:
            time.sleep(0.05)
            return real_parse(path, original_filename, settings)
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
            opening,
            [
                {
                    "id": cid,
                    "filename": f"cv{index}.pdf",
                    "stored_path": str(stored),
                    "upload_order": index,
                }
            ],
        )

    worker_module.parse_cv = counted_parse
    pool = make_pool(repository, tmp_path, worker_count=4)
    await pool.start()
    try:
        for cid in ids:
            pool.enqueue(cid)
        deadline = time.time() + 30
        while time.time() < deadline:
            snapshot = await repository.get_opening_snapshot(opening)
            done, total = await repository.candidate_counts(opening)
            if done == 8 and total == 8:
                break
            await asyncio.sleep(0.05)
        done, total = await repository.candidate_counts(opening)
        assert done == 8
        assert max_active <= 4
    finally:
        worker_module.parse_cv = real_parse
        await pool.stop()


async def test_resumable_candidates_are_reenqueued_on_start(
    repository, opening, tmp_path
):
    candidate_id = await add_candidate(
        repository, opening, tmp_path, text="Python PostgreSQL production"
    )
    await repository.set_candidate_status(
        candidate_id, CandidateStatus.EXTRACTING
    )
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


async def test_retry_is_idempotent(repository, opening, tmp_path):
    candidate_id = await add_candidate(
        repository, opening, tmp_path, text="Python PostgreSQL production"
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
        snapshot = await repository.get_opening_snapshot(opening)
        assert len(snapshot.candidates) == 1
        result = await repository.get_candidate_result(candidate_id)
        assert result.status == CandidateStatus.COMPLETE
    finally:
        await pool.stop()


async def test_manual_override_recalculates_total(
    repository, opening, tmp_path
):
    candidate_id = await add_candidate(
        repository, opening, tmp_path, text="customer support only"
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
            }:
                break
            await asyncio.sleep(0.05)
    finally:
        await pool.stop()

    result = await repository.get_candidate_result(candidate_id)
    before = result.total_score
    updated = await repository.update_manual_evaluation(
        candidate_id,
        "python",
        manual_fraction=1.0,
        review_note="Verified",
        reviewed_by="tester",
    )
    assert updated.evaluations[0].manual_fraction == 1.0
    assert updated.evaluations[0].status == MatchStatus.REVIEWED
    assert updated.evaluations[0].reviewed_by == "tester"
    assert updated.evaluations[0].reviewed_at is not None
    assert updated.total_score is not None
    assert updated.total_score != before


async def test_terminal_marker_is_atomic(repository, opening, tmp_path):
    candidate_id = await add_candidate(
        repository, opening, tmp_path, text="Python PostgreSQL production"
    )
    assert await repository.mark_opening_complete_if_terminal(opening) is False
    await repository.set_candidate_status(
        candidate_id, CandidateStatus.COMPLETE
    )
    assert await repository.mark_opening_complete_if_terminal(opening) is True
    assert await repository.mark_opening_complete_if_terminal(opening) is False


async def test_flagged_cells_escalate_to_reviewer(
    repository, opening, tmp_path
):
    candidate_id = await add_candidate(
        repository,
        opening,
        tmp_path,
        text="Python PostgreSQL production",
    )

    class ResolvingReviewer:
        async def review(self, *, opening, criteria, flagged, spans):
            return {
                evaluation.criterion_id: CriterionEvaluation(
                    criterion_id=evaluation.criterion_id,
                    status=MatchStatus.STRONG,
                    confidence=0.95,
                    model_fraction=1.0,
                    rationale="Confirmed by second pass.",
                )
                for evaluation in flagged
            }

    pool = make_pool(
        repository,
        tmp_path,
        evaluator=FlaggingEvaluator(),
        reviewer=ResolvingReviewer(),
    )
    await pool.process_candidate(candidate_id)
    result = await repository.get_candidate_result(candidate_id)
    assert result.status == CandidateStatus.COMPLETE
    assert all(
        e.status == MatchStatus.STRONG for e in result.evaluations
    )
    assert result.evaluations[0].rationale == "Confirmed by second pass."


async def test_reviewer_failure_keeps_review_status(
    repository, opening, tmp_path
):
    candidate_id = await add_candidate(
        repository,
        opening,
        tmp_path,
        text="Python PostgreSQL production",
    )

    class FailingReviewer:
        async def review(self, **kwargs):
            raise RuntimeError("openrouter down")

    pool = make_pool(
        repository,
        tmp_path,
        evaluator=FlaggingEvaluator(),
        reviewer=FailingReviewer(),
    )
    await pool.process_candidate(candidate_id)
    result = await repository.get_candidate_result(candidate_id)
    assert result.status == CandidateStatus.NEEDS_REVIEW
    assert all(
        e.status == MatchStatus.NEEDS_REVIEW for e in result.evaluations
    )


async def test_discard_pending_skips_queued_candidate(
    repository, opening, tmp_path
):
    candidate_id = await add_candidate(
        repository, opening, tmp_path, text="Python PostgreSQL"
    )
    pool = make_pool(repository, tmp_path)
    processed = []
    original = pool.process_candidate

    async def spy(candidate_id):
        processed.append(candidate_id)
        return await original(candidate_id)

    pool.process_candidate = spy
    pool.enqueue(candidate_id)
    await repository.delete_candidate(candidate_id)
    pool.discard_pending(candidate_id)
    await pool.start()
    try:
        deadline = time.time() + 5
        while time.time() < deadline and not pool._queue.empty():
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.1)
        assert processed == []
        assert candidate_id not in pool._pending
    finally:
        await pool.stop()


async def test_discard_pending_unknown_id_is_noop(repository, tmp_path):
    pool = make_pool(repository, tmp_path)
    pool.discard_pending("never-queued")
    await pool.start()
    try:
        assert "never-queued" not in pool._pending
    finally:
        await pool.stop()


async def test_process_deleted_candidate_is_noop(
    repository, opening, tmp_path
):
    candidate_id = await add_candidate(
        repository, opening, tmp_path, text="Python PostgreSQL"
    )
    await repository.delete_candidate(candidate_id)
    pool = make_pool(repository, tmp_path)
    await pool.process_candidate(candidate_id)
    assert await repository.get_candidate_result(candidate_id) is None


def test_candidate_outcome_flags_uncertain_evaluations():
    criteria = make_criteria()
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
    status, total = candidate_outcome(evaluations, criteria)
    assert status == CandidateStatus.NEEDS_REVIEW
    assert total == round(100 * (5 * 1.0 + 4 * 1.0 + 3 * 0.0) / 12, 2)
