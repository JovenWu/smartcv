import asyncio

from backend.app.documents import (
    NeedsManualReview,
    RendererUnavailable,
    UnreadableDocument,
    UnsupportedFile,
    extract_identity,
    parse_cv,
)
from backend.app.schemas import CandidateStatus, MatchStatus
from backend.app.typesafe_adapter import RetryableEvaluationError

_STOP_TIMEOUT_SECONDS = 10


def candidate_outcome(
    evaluations, criteria
) -> tuple[CandidateStatus, float | None]:
    """(status, weighted total) for a finished evaluation pass."""
    from backend.app.scoring import (
        calculate_total_score,
        effective_fractions,
    )

    weights = {criterion.id: criterion.weight for criterion in criteria}
    by_id = {evaluation.criterion_id: evaluation for evaluation in evaluations}
    total = calculate_total_score(weights, effective_fractions(by_id))
    flagged = any(
        evaluation.status == MatchStatus.NEEDS_REVIEW
        for evaluation in evaluations
    )
    status = (
        CandidateStatus.NEEDS_REVIEW if flagged else CandidateStatus.COMPLETE
    )
    return status, total


class CandidateWorkerPool:
    def __init__(
        self,
        repository,
        evaluator,
        event_publisher,
        worker_count: int = 4,
    ) -> None:
        self.repository = repository
        self.evaluator = evaluator
        self.event_publisher = event_publisher
        self.worker_count = worker_count
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._pending: set[str] = set()
        self._tasks: list[asyncio.Task] = []

    async def start(self) -> None:
        for candidate in await self.repository.list_resumable_candidates():
            self.enqueue(candidate.id)
        self._tasks = [
            asyncio.create_task(self._run(), name=f"cv-worker-{index}")
            for index in range(self.worker_count)
        ]

    def enqueue(self, candidate_id: str) -> None:
        if candidate_id in self._pending:
            return
        self._pending.add(candidate_id)
        self._queue.put_nowait(candidate_id)

    async def stop(self) -> None:
        try:
            await asyncio.wait_for(
                self._queue.join(), timeout=_STOP_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            pass
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = []

    async def _run(self) -> None:
        while True:
            candidate_id = await self._queue.get()
            try:
                await self.process_candidate(candidate_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                work_item = await self.repository.get_candidate(candidate_id)
                await self.repository.mark_candidate_failed(
                    candidate_id,
                    "Unexpected processing error",
                    retryable=True,
                )
                if work_item is not None:
                    await self.event_publisher.publish_candidate_update(
                        work_item.opening_id, candidate_id
                    )
            finally:
                self._pending.discard(candidate_id)
                self._queue.task_done()

    async def process_candidate(self, candidate_id: str) -> None:
        candidate = await self.repository.get_candidate(candidate_id)
        if candidate is None:
            return
        await self.repository.set_candidate_status(
            candidate_id, CandidateStatus.EXTRACTING
        )
        await self.event_publisher.publish_candidate_update(
            candidate.opening_id, candidate_id
        )
        try:
            parsed = await asyncio.to_thread(
                parse_cv, candidate.stored_path, candidate.filename
            )
        except NeedsManualReview as error:
            await self.repository.mark_candidate_needs_review(
                candidate_id, str(error)
            )
            await self.event_publisher.publish_candidate_update(
                candidate.opening_id, candidate_id
            )
            return
        except RendererUnavailable as error:
            await self.repository.mark_candidate_failed(
                candidate_id, str(error), retryable=True
            )
            await self.event_publisher.publish_candidate_update(
                candidate.opening_id, candidate_id
            )
            return
        except (UnsupportedFile, UnreadableDocument) as error:
            await self.repository.mark_candidate_failed(
                candidate_id, str(error), retryable=False
            )
            await self.event_publisher.publish_candidate_update(
                candidate.opening_id, candidate_id
            )
            return
        name, email = extract_identity(parsed.spans)
        await self.repository.save_source_spans(
            candidate_id,
            parsed.preview_path,
            parsed.spans,
            name=name,
            email=email,
            page_count=parsed.page_count,
        )
        await self.repository.set_candidate_status(
            candidate_id, CandidateStatus.EVALUATING
        )
        await self.event_publisher.publish_candidate_update(
            candidate.opening_id, candidate_id
        )
        try:
            evaluations = await self.evaluator.evaluate_candidate(
                candidate.criteria, parsed.spans
            )
        except RetryableEvaluationError as error:
            await self.repository.mark_candidate_failed(
                candidate_id, str(error), retryable=True
            )
            await self.event_publisher.publish_candidate_update(
                candidate.opening_id, candidate_id
            )
            return
        status, total = candidate_outcome(evaluations, candidate.criteria)
        await self.repository.save_candidate_result(
            candidate_id, list(evaluations), status, total
        )
        await self.event_publisher.publish_candidate_update(
            candidate.opening_id, candidate_id
        )
