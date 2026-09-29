import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class OpeningEvent:
    name: str
    payload: dict[str, Any]


class _Subscriber:
    def __init__(self, queue: asyncio.Queue[OpeningEvent]) -> None:
        self._queue = queue

    def __aiter__(self) -> "_Subscriber":
        return self

    async def __anext__(self) -> OpeningEvent:
        return await self._queue.get()


class EventHub:
    """Process-local fan-out of opening events to SSE subscribers."""

    def __init__(self) -> None:
        self._subscribers: dict[str, set[asyncio.Queue[OpeningEvent]]] = {}

    @asynccontextmanager
    async def subscribe(
        self, opening_id: str
    ) -> AsyncIterator[AsyncIterator[OpeningEvent]]:
        queue: asyncio.Queue[OpeningEvent] = asyncio.Queue()
        subscribers = self._subscribers.setdefault(opening_id, set())
        subscribers.add(queue)
        try:
            yield _Subscriber(queue)
        finally:
            subscribers.discard(queue)
            if not subscribers:
                self._subscribers.pop(opening_id, None)

    def publish(self, opening_id: str, event: OpeningEvent) -> None:
        for queue in list(self._subscribers.get(opening_id, ())):
            queue.put_nowait(event)


class EventPublisher:
    """Translates repository state into stream events after each transition."""

    def __init__(self, hub: EventHub, repository) -> None:
        self.hub = hub
        self.repository = repository

    async def publish_candidate_update(
        self, opening_id: str, candidate_id: str
    ) -> None:
        candidate = await self.repository.get_candidate_result(candidate_id)
        completed_count, total_count = await self.repository.candidate_counts(
            opening_id
        )
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
        await self.publish_opening_progress(opening_id)

    async def publish_opening_progress(self, opening_id: str) -> None:
        completed_count, total_count = await self.repository.candidate_counts(
            opening_id
        )
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
