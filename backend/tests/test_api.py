import time

import pytest
from fastapi.testclient import TestClient

from backend.app.config import Settings
from backend.app.main import create_app
from backend.app.typesafe_adapter import (
    FakeEvaluator,
    RetryableEvaluationError,
)
from backend.tests.factories import make_criteria


@pytest.fixture
def settings(tmp_path):
    return Settings(
        _env_file=None,
        data_dir=tmp_path / "data",
        smartcv_fake_evaluator=True,
        worker_count=2,
    )


@pytest.fixture
def app(settings):
    return create_app(settings)


@pytest.fixture
def client(app):
    with TestClient(app) as client:
        yield client


def make_opening(client):
    response = client.post(
        "/api/openings",
        json={
            "title": "Backend Engineer",
            "criteria": [
                c.model_dump(mode="json", by_alias=True)
                for c in make_criteria()
            ],
        },
    )
    assert response.status_code == 201
    return response.json()["id"]


def pdf_bytes(text: str) -> bytes:
    import pymupdf

    document = pymupdf.open()
    page = document.new_page()
    if text:
        page.insert_text((72, 72), text)
    data = document.tobytes()
    document.close()
    return data


def wait_for_terminal(client, opening_id, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        opening = client.get(f"/api/openings/{opening_id}").json()
        if opening["isFinal"]:
            return opening
        time.sleep(0.05)
    raise AssertionError("opening did not reach a terminal state")


def test_create_opening_returns_opening(client):
    opening_id = make_opening(client)
    opening = client.get(f"/api/openings/{opening_id}").json()
    assert opening["title"] == "Backend Engineer"
    assert len(opening["criteria"]) == 3
    assert opening["candidates"] == 0
    assert opening["isFinal"] is False


def test_create_opening_rejects_invalid_weight(client):
    response = client.post(
        "/api/openings",
        json={
            "title": "Role",
            "criteria": [
                {"id": "x", "name": "X", "description": "d", "weight": 0}
            ],
        },
    )
    assert response.status_code == 422
    response = client.post(
        "/api/openings",
        json={
            "title": "Role",
            "criteria": [
                {"id": "x", "name": "X", "description": "d", "weight": 6}
            ],
        },
    )
    assert response.status_code == 422


def test_unknown_opening_returns_404(client):
    assert client.get("/api/openings/nope").status_code == 404
    files = [("files", ("a.pdf", pdf_bytes("x"), "application/pdf"))]
    assert (
        client.post("/api/openings/nope/candidates", files=files).status_code
        == 404
    )


def test_mixed_batch_queues_valid_and_fails_invalid(client):
    opening_id = make_opening(client)
    files = [
        ("files", ("good.pdf", pdf_bytes("Built Python and PostgreSQL production systems"), "application/pdf")),
        ("files", ("corrupt.pdf", b"not a pdf", "application/pdf")),
        ("files", ("notes.txt", b"plain text", "text/plain")),
    ]
    response = client.post(f"/api/openings/{opening_id}/candidates", files=files)
    assert response.status_code == 201
    body = response.json()
    assert body["totalCount"] == 3
    by_name = {c["file"]["filename"]: c for c in body["candidates"]}
    assert by_name["good.pdf"]["status"] == "queued"
    assert by_name["corrupt.pdf"]["status"] == "failed"
    assert by_name["corrupt.pdf"]["retryable"] is False
    assert by_name["notes.txt"]["status"] == "failed"
    assert by_name["notes.txt"]["retryable"] is False


def test_batch_over_limit_is_413_without_writes(client, settings):
    opening_id = make_opening(client)
    settings.max_batch_files = 3
    files = [
        ("files", (f"cv{i}.pdf", pdf_bytes("x"), "application/pdf"))
        for i in range(4)
    ]
    response = client.post(f"/api/openings/{opening_id}/candidates", files=files)
    assert response.status_code == 413
    opening = client.get(f"/api/openings/{opening_id}").json()
    assert opening["candidates"] == 0


def test_duplicate_upload_is_skipped(client):
    opening_id = make_opening(client)
    payload = pdf_bytes("Built Python services")
    first = client.post(
        f"/api/openings/{opening_id}/candidates",
        files=[("files", ("jane.pdf", payload, "application/pdf"))],
    )
    assert first.status_code == 201
    assert len(first.json()["candidates"]) == 1

    # Same bytes under a different filename is still a duplicate.
    second = client.post(
        f"/api/openings/{opening_id}/candidates",
        files=[("files", ("jane-copy.pdf", payload, "application/pdf"))],
    )
    assert second.status_code == 201
    body = second.json()
    assert body["candidates"] == []
    assert len(body["duplicates"]) == 1
    assert body["duplicates"][0]["file"]["filename"] == "jane.pdf"

    candidates = client.get(f"/api/openings/{opening_id}/candidates").json()
    assert len(candidates) == 1


def test_duplicate_within_one_batch_is_skipped(client):
    opening_id = make_opening(client)
    payload = pdf_bytes("Python PostgreSQL")
    files = [
        ("files", ("a.pdf", payload, "application/pdf")),
        ("files", ("a-copy.pdf", payload, "application/pdf")),
        ("files", ("b.pdf", pdf_bytes("Different CV"), "application/pdf")),
    ]
    response = client.post(
        f"/api/openings/{opening_id}/candidates", files=files
    )
    assert response.status_code == 201
    body = response.json()
    assert len(body["candidates"]) == 2
    assert len(body["duplicates"]) == 1
    assert body["duplicates"][0]["file"]["filename"] == "a.pdf"


def test_same_file_to_another_opening_is_allowed(client):
    opening_a = make_opening(client)
    opening_b = make_opening(client)
    payload = pdf_bytes("Python")
    for opening_id in (opening_a, opening_b):
        response = client.post(
            f"/api/openings/{opening_id}/candidates",
            files=[("files", ("cv.pdf", payload, "application/pdf"))],
        )
        assert response.status_code == 201
        assert len(response.json()["candidates"]) == 1
        assert response.json()["duplicates"] == []


def test_batch_at_limit_is_accepted(client, settings):
    opening_id = make_opening(client)
    settings.max_batch_files = 4
    files = [
        ("files", (f"cv{i}.pdf", pdf_bytes(f"Python {i}"), "application/pdf"))
        for i in range(4)
    ]
    response = client.post(f"/api/openings/{opening_id}/candidates", files=files)
    assert response.status_code == 201
    assert response.json()["totalCount"] == 4


def test_full_batch_completes_with_scores(client):
    opening_id = make_opening(client)
    files = [
        ("files", ("strong.pdf", pdf_bytes("Built Python and PostgreSQL production services for three years"), "application/pdf")),
        ("files", ("weak.pdf", pdf_bytes("Worked in customer support."), "application/pdf")),
    ]
    client.post(f"/api/openings/{opening_id}/candidates", files=files)
    wait_for_terminal(client, opening_id)
    candidates = client.get(f"/api/openings/{opening_id}/candidates").json()
    by_name = {c["file"]["filename"]: c for c in candidates}
    strong = by_name["strong.pdf"]
    weak = by_name["weak.pdf"]
    assert strong["totalScore"] is not None
    assert strong["totalScore"] > 0
    assert len(strong["evaluations"]) == 3
    assert strong["isFinal"] is True
    assert weak["status"] in {"complete", "needs_review"}
    assert weak["totalScore"] is not None


def test_manual_review_updates_total(client):
    opening_id = make_opening(client)
    files = [
        ("files", ("cv.pdf", pdf_bytes("Worked in customer support."), "application/pdf")),
    ]
    upload = client.post(
        f"/api/openings/{opening_id}/candidates", files=files
    ).json()
    candidate_id = upload["candidates"][0]["id"]
    wait_for_terminal(client, opening_id)
    candidate = client.get(
        f"/api/openings/{opening_id}/candidates"
    ).json()[0]
    before = candidate["totalScore"]
    response = client.patch(
        f"/api/openings/{opening_id}/candidates/{candidate_id}"
        "/criteria/python",
        json={"matchLevel": "strong", "reviewNote": "Verified in interview"},
    )
    assert response.status_code == 200
    updated = response.json()
    evaluation = next(
        e for e in updated["evaluations"] if e["criterionId"] == "python"
    )
    assert evaluation["status"] == "reviewed"
    assert evaluation["manualFraction"] == 1.0
    assert evaluation["reviewNote"] == "Verified in interview"
    assert evaluation["reviewedBy"] == "local"
    assert evaluation["reviewedAt"] is not None
    assert updated["totalScore"] != before


def test_decision_endpoint_updates_candidate(client):
    opening_id = make_opening(client)
    files = [
        ("files", ("cv.pdf", pdf_bytes("Python"), "application/pdf")),
    ]
    upload = client.post(
        f"/api/openings/{opening_id}/candidates", files=files
    ).json()
    candidate_id = upload["candidates"][0]["id"]
    response = client.patch(
        f"/api/openings/{opening_id}/candidates/{candidate_id}/decision",
        json={"decision": "shortlisted"},
    )
    assert response.status_code == 200
    assert response.json()["decision"] == "shortlisted"
    response = client.patch(
        f"/api/openings/{opening_id}/candidates/{candidate_id}/decision",
        json={"decision": "bogus"},
    )
    assert response.status_code == 422


def test_patch_unknown_candidate_or_criterion_is_404(client):
    opening_id = make_opening(client)
    response = client.patch(
        f"/api/openings/{opening_id}/candidates/nope/criteria/python",
        json={"matchLevel": "strong"},
    )
    assert response.status_code == 404


def test_non_retryable_failure_rejects_retry(client):
    opening_id = make_opening(client)
    files = [("files", ("corrupt.pdf", b"junk", "application/pdf"))]
    upload = client.post(
        f"/api/openings/{opening_id}/candidates", files=files
    ).json()
    candidate_id = upload["candidates"][0]["id"]
    wait_for_terminal(client, opening_id)
    response = client.post(
        f"/api/openings/{opening_id}/candidates/{candidate_id}/retry"
    )
    assert response.status_code == 409


def test_retryable_failure_can_be_retried(settings, tmp_path):
    attempts = {"count": 0}
    fake = FakeEvaluator()

    class FlakyEvaluator:
        async def evaluate_candidate(self, criteria, spans, opening=None):
            attempts["count"] += 1
            if attempts["count"] == 1:
                raise RetryableEvaluationError("temporary outage")
            return await fake.evaluate_candidate(criteria, spans)

        async def suggest_weights(self, criteria):
            return await fake.suggest_weights(criteria)

        async def suggest_criteria(self, request):
            return await fake.suggest_criteria(request)

    app = create_app(settings, evaluator=FlakyEvaluator())
    with TestClient(app) as client:
        opening_id = make_opening(client)
        files = [
            ("files", ("cv.pdf", pdf_bytes("Built Python services"), "application/pdf"))
        ]
        upload = client.post(
            f"/api/openings/{opening_id}/candidates", files=files
        ).json()
        candidate_id = upload["candidates"][0]["id"]
        wait_for_terminal(client, opening_id)
        candidate = client.get(
            f"/api/openings/{opening_id}/candidates"
        ).json()[0]
        assert candidate["status"] == "failed"
        assert candidate["retryable"] is True
        response = client.post(
            f"/api/openings/{opening_id}/candidates/{candidate_id}/retry"
        )
        assert response.status_code == 200
        wait_for_terminal(client, opening_id)
        candidate = client.get(
            f"/api/openings/{opening_id}/candidates"
        ).json()[0]
        assert candidate["status"] == "complete"
        assert candidate["totalScore"] is not None


def test_sse_sends_final_snapshot_and_closes(client):
    opening_id = make_opening(client)
    client.post(
        f"/api/openings/{opening_id}/candidates",
        files=[
            ("files", ("a.pdf", pdf_bytes("Python PostgreSQL production"), "application/pdf")),
        ],
    )
    wait_for_terminal(client, opening_id)
    response = client.get(f"/api/openings/{opening_id}/events")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-cache"
    assert "event: snapshot" in response.text
    assert '"isFinal":true' in response.text


def test_sse_unknown_opening_is_404(client):
    response = client.get("/api/openings/nope/events")
    assert response.status_code == 404


def test_weight_suggestions_endpoint(client):
    response = client.post(
        "/api/weight-suggestions",
        json={
            "criteria": [
                {"id": "python", "name": "Python", "description": "Backend"},
                {"id": "db", "name": "Databases", "description": "PostgreSQL"},
            ]
        },
    )
    assert response.status_code == 200
    suggestions = response.json()["suggestions"]
    assert len(suggestions) == 2
    assert all(1 <= s["proposedWeight"] <= 5 for s in suggestions)


def test_preview_and_spans_endpoints(client):
    opening_id = make_opening(client)
    files = [
        ("files", ("cv.pdf", pdf_bytes("Built Python services"), "application/pdf"))
    ]
    upload = client.post(
        f"/api/openings/{opening_id}/candidates", files=files
    ).json()
    candidate_id = upload["candidates"][0]["id"]
    wait_for_terminal(client, opening_id)
    spans = client.get(
        f"/api/openings/{opening_id}/candidates/{candidate_id}/spans"
    )
    assert spans.status_code == 200
    assert spans.json()[0]["pageNumber"] == 1
    assert "Python services" in spans.json()[0]["text"]
    assert spans.json()[0]["bbox"]["width"] > 0
    preview = client.get(
        f"/api/openings/{opening_id}/candidates/{candidate_id}/preview"
    )
    assert preview.status_code == 200
    assert preview.content.startswith(b"%PDF-")
    candidate = client.get(
        f"/api/openings/{opening_id}/candidates"
    ).json()[0]
    assert candidate["file"]["url"].endswith("/preview")
    assert candidate["file"]["pageCount"] == 1
    assert (
        client.get(
            f"/api/openings/{opening_id}/candidates/nope/preview"
        ).status_code
        == 404
    )
