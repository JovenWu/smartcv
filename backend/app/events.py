import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class JobEvent:
    name: str
    payload: dict[str, Any]


class _Subscriber:
    def __init__(self, queue: asyncio.Queue[JobEvent]) -> None:
        self._queue = queue

    def __aiter__(self) -> "_Subscriber":
        return self

    async def __anext__(self) -> JobEvent:
        return await self._queue.get()


class EventHub:
    """Process-local fan-out of job events to SSE subscribers."""

    def __init__(self) -> None:
        self._subscribers: dict[str, set[asyncio.Queue[JobEvent]]] = {}

    @asynccontextmanager
    async def subscribe(self, job_id: str) -> AsyncIterator[AsyncIterator[JobEvent]]:
        queue: asyncio.Queue[JobEvent] = asyncio.Queue()
        subscribers = self._subscribers.setdefault(job_id, set())
        subscribers.add(queue)
        try:
            yield _Subscriber(queue)
        finally:
            subscribers.discard(queue)
            if not subscribers:
                self._subscribers.pop(job_id, None)

    def publish(self, job_id: str, event: JobEvent) -> None:
        for queue in list(self._subscribers.get(job_id, ())):
            queue.put_nowait(event)


class EventPublisher:
    """Translates repository state into stream events after each transition."""

    def __init__(self, hub: EventHub, repository) -> None:
        self.hub = hub
        self.repository = repository

    async def publish_candidate_update(
        self, job_id: str, candidate_id: str
    ) -> None:
        candidate = await self.repository.get_candidate_result(candidate_id)
        completed_count, total_count = await self.repository.candidate_counts(
            job_id
        )
        self.hub.publish(
            job_id,
            JobEvent(
                "candidate.updated",
                {
                    "candidate": candidate.model_dump(mode="json"),
                    "completed_count": completed_count,
                    "total_count": total_count,
                },
            ),
        )
        await self.publish_job_progress(job_id)

    async def publish_job_progress(self, job_id: str) -> None:
        completed_count, total_count = await self.repository.candidate_counts(
            job_id
        )
        self.hub.publish(
            job_id,
            JobEvent(
                "job.progress",
                {
                    "completed_count": completed_count,
                    "total_count": total_count,
                },
            ),
        )
        if await self.repository.mark_job_complete_if_terminal(job_id):
            snapshot = await self.repository.get_job_snapshot(job_id)
            self.hub.publish(
                job_id, JobEvent("job.complete", snapshot.model_dump(mode="json"))
            )
