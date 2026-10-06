import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

_SUBSCRIBER_QUEUE_MAX = 256

_CLOSE = object()


@dataclass(frozen=True)
class OpeningEvent:
    name: str
    payload: dict[str, Any]


class _Subscriber:
    def __init__(self, queue: asyncio.Queue) -> None:
        self._queue = queue

    def __aiter__(self) -> "_Subscriber":
        return self

    async def __anext__(self) -> OpeningEvent:
        item = await self._queue.get()
        if item is _CLOSE:
            raise StopAsyncIteration
        return item


class EventHub:
    """Process-local fan-out of opening events to SSE subscribers."""

    def __init__(self) -> None:
        self._subscribers: dict[str, set[asyncio.Queue]] = {}

    @asynccontextmanager
    async def subscribe(
        self, opening_id: str
    ) -> AsyncIterator[AsyncIterator[OpeningEvent]]:
        queue: asyncio.Queue = asyncio.Queue(
            maxsize=_SUBSCRIBER_QUEUE_MAX
        )
        subscribers = self._subscribers.setdefault(opening_id, set())
        subscribers.add(queue)
        try:
            yield _Subscriber(queue)
        finally:
            subscribers.discard(queue)
            if not subscribers:
                self._subscribers.pop(opening_id, None)

    @staticmethod
    def _offer(queue: asyncio.Queue, item: Any) -> None:
        """put_nowait that evicts the oldest queued item when full."""
        try:
            queue.put_nowait(item)
        except asyncio.QueueFull:
            queue.get_nowait()
            queue.put_nowait(item)

    def publish(self, opening_id: str, event: OpeningEvent) -> None:
        queues = self._subscribers.get(opening_id)
        if not queues:
            return
        for queue in list(queues):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                queues.discard(queue)
                self._offer(queue, _CLOSE)
        if not queues:
            self._subscribers.pop(opening_id, None)

    def close_opening(self, opening_id: str) -> None:
        """Push ``opening.deleted`` then terminate all of its streams."""
        queues = self._subscribers.pop(opening_id, set())
        for queue in queues:
            self._offer(
                queue,
                OpeningEvent(
                    "opening.deleted", {"openingId": opening_id}
                ),
            )
            self._offer(queue, _CLOSE)


class EventPublisher:
    """Translates repository state into stream events after each transition."""

    def __init__(self, hub: EventHub, repository) -> None:
        self.hub = hub
        self.repository = repository

    async def publish_candidate_update(
        self, opening_id: str, candidate_id: str
    ) -> None:
        candidate = await self.repository.get_candidate_result(candidate_id)
        if candidate is None:
            return
        counts = await self.repository.candidate_counts(opening_id)
        completed_count, total_count = counts
        self.hub.publish(
            opening_id,
            OpeningEvent(
                "candidate.updated",
                {
                    "candidate": candidate.model_dump(
                        mode="json", by_alias=True
                    ),
                    "completedCount": completed_count,
                    "totalCount": total_count,
                },
            ),
        )
        await self.publish_opening_progress(opening_id, counts)

    def publish_candidate_deleted(
        self, opening_id: str, candidate_id: str
    ) -> None:
        self.hub.publish(
            opening_id,
            OpeningEvent(
                "candidate.deleted", {"candidateId": candidate_id}
            ),
        )

    async def publish_candidates_updated(
        self, opening_id: str, candidate_ids: list[str]
    ) -> None:
        """One bulk-change event followed by fresh progress counts."""
        self.hub.publish(
            opening_id,
            OpeningEvent(
                "candidates.updated",
                {"candidateIds": list(candidate_ids)},
            ),
        )
        await self.publish_opening_progress(opening_id)

    async def publish_opening_progress(
        self,
        opening_id: str,
        counts: tuple[int, int] | None = None,
    ) -> None:
        if counts is None:
            counts = await self.repository.candidate_counts(opening_id)
        completed_count, total_count = counts
        self.hub.publish(
            opening_id,
            OpeningEvent(
                "opening.progress",
                {
                    "completedCount": completed_count,
                    "totalCount": total_count,
                },
            ),
        )
        if await self.repository.mark_opening_complete_if_terminal(opening_id):
            snapshot = await self.repository.get_opening_snapshot(opening_id)
            self.hub.publish(
                opening_id,
                OpeningEvent(
                    "opening.complete",
                    snapshot.model_dump(mode="json", by_alias=True),
                ),
            )
