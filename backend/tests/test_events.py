import asyncio
import uuid

import pytest

from backend.app.database import SQLiteRepository
from backend.app.events import EventHub, EventPublisher, OpeningEvent
from backend.app.schemas import CandidateStatus, OpeningCreate
from backend.tests.factories import make_criteria


@pytest.fixture
async def repository(tmp_path):
    repo = SQLiteRepository(tmp_path / "events.sqlite3")
    await repo.open()
    yield repo
    await repo.close()


async def collect(subscriber, count, timeout=2.0):
    events = []

    async def drain():
        async for event in subscriber:
            events.append(event)
            if len(events) >= count:
                return

    await asyncio.wait_for(drain(), timeout=timeout)
    return events


async def test_broadcast_reaches_multiple_subscribers():
    hub = EventHub()
    async with (
        hub.subscribe("opening-1") as first,
        hub.subscribe("opening-1") as second,
    ):
        hub.publish(
            "opening-1",
            OpeningEvent("opening.progress", {"completedCount": 1}),
        )
        first_event = await asyncio.wait_for(
            first.__aiter__().__anext__(), timeout=1
        )
        second_event = await asyncio.wait_for(
            second.__aiter__().__anext__(), timeout=1
        )
        assert first_event.name == "opening.progress"
        assert first_event.payload["completedCount"] == 1
        assert second_event.payload == first_event.payload


async def test_events_are_isolated_per_opening():
    hub = EventHub()
    async with (
        hub.subscribe("opening-a") as sub_a,
        hub.subscribe("opening-b") as sub_b,
    ):
        hub.publish(
            "opening-a",
            OpeningEvent("opening.progress", {"completedCount": 3}),
        )
        received = await asyncio.wait_for(sub_a.__aiter__().__anext__(), 1)
        assert received.payload["completedCount"] == 3
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(sub_b.__aiter__().__anext__(), 0.2)


async def test_unsubscribed_opening_publish_is_noop():
    hub = EventHub()
    hub.publish("nobody", OpeningEvent("opening.progress", {}))


async def test_publish_candidate_update_emits_candidate_and_progress(
    repository, tmp_path
):
    opening_id = uuid.uuid4().hex
    await repository.create_opening(
        opening_id, OpeningCreate(title="Role", criteria=make_criteria())
    )
    await repository.add_candidates(
        opening_id,
        [
            {
                "id": "c1",
                "filename": "cv.pdf",
                "stored_path": str(tmp_path / "c1"),
                "upload_order": 0,
            }
        ],
    )
    hub = EventHub()
    publisher = EventPublisher(hub, repository)
    async with hub.subscribe(opening_id) as subscriber:
        await publisher.publish_candidate_update(opening_id, "c1")
        first = await asyncio.wait_for(subscriber.__aiter__().__anext__(), 1)
        second = await asyncio.wait_for(subscriber.__aiter__().__anext__(), 1)
        assert first.name == "candidate.updated"
        assert first.payload["candidate"]["id"] == "c1"
        assert first.payload["completedCount"] == 0
        assert first.payload["totalCount"] == 1
        assert second.name == "opening.progress"
        assert second.payload == {
            "completedCount": 0,
            "totalCount": 1,
        }


async def test_terminal_transition_emits_opening_complete_once(
    repository, tmp_path
):
    opening_id = uuid.uuid4().hex
    await repository.create_opening(
        opening_id, OpeningCreate(title="Role", criteria=make_criteria())
    )
    await repository.add_candidates(
        opening_id,
        [
            {
                "id": "c1",
                "filename": "cv.pdf",
                "stored_path": str(tmp_path / "c1"),
                "upload_order": 0,
            }
        ],
    )
    await repository.set_candidate_status("c1", CandidateStatus.COMPLETE)
    hub = EventHub()
    publisher = EventPublisher(hub, repository)
    async with hub.subscribe(opening_id) as subscriber:
        await publisher.publish_candidate_update(opening_id, "c1")
        names = []
        for _ in range(3):
            event = await asyncio.wait_for(
                subscriber.__aiter__().__anext__(), 1
            )
            names.append(event.name)
        assert names == [
            "candidate.updated",
            "opening.progress",
            "opening.complete",
        ]
        await publisher.publish_candidate_update(opening_id, "c1")
        follow_up = []
        for _ in range(2):
            event = await asyncio.wait_for(
                subscriber.__aiter__().__anext__(), 1
            )
            follow_up.append(event.name)
        assert "opening.complete" not in follow_up
