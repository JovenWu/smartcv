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


def make_job(client):
    response = client.post(
        "/api/jobs",
        json={
            "title": "Backend Engineer",
            "criteria": [
                c.model_dump(mode="json") for c in make_criteria()
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


def wait_for_terminal(client, job_id, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        snapshot = client.get(f"/api/jobs/{job_id}").json()
        if snapshot["is_final"]:
            return snapshot
        time.sleep(0.05)
    raise AssertionError("job did not reach a terminal state")


def test_create_job_returns_snapshot(client):
    job_id = make_job(client)
    snapshot = client.get(f"/api/jobs/{job_id}").json()
    assert snapshot["title"] == "Backend Engineer"
    assert len(snapshot["criteria"]) == 3
    assert snapshot["total_count"] == 0
    assert snapshot["is_final"] is False


def test_create_job_rejects_invalid_weight(client):
    response = client.post(
        "/api/jobs",
        json={
            "title": "Role",
            "criteria": [
                {"id": "x", "name": "X", "description": "d", "weight": 0}
            ],
        },
    )
    assert response.status_code == 422
    response = client.post(
        "/api/jobs",
        json={
            "title": "Role",
            "criteria": [
                {"id": "x", "name": "X", "description": "d", "weight": 6}
            ],
        },
    )
    assert response.status_code == 422


def test_unknown_job_returns_404(client):
    assert client.get("/api/jobs/nope").status_code == 404
    files = [("files", ("a.pdf", pdf_bytes("x"), "application/pdf"))]
    assert client.post("/api/jobs/nope/cvs", files=files).status_code == 404


def test_mixed_batch_queues_valid_and_fails_invalid(client):
    job_id = make_job(client)
    files = [
        ("files", ("good.pdf", pdf_bytes("Built Python and PostgreSQL production systems"), "application/pdf")),
        ("files", ("corrupt.pdf", b"not a pdf", "application/pdf")),
        ("files", ("notes.txt", b"plain text", "text/plain")),
    ]
    response = client.post(f"/api/jobs/{job_id}/cvs", files=files)
    assert response.status_code == 201
    body = response.json()
    assert body["total_count"] == 3
    by_name = {c["filename"]: c for c in body["candidates"]}
    assert by_name["good.pdf"]["status"] == "queued"
    assert by_name["corrupt.pdf"]["status"] == "failed"
    assert by_name["corrupt.pdf"]["retryable"] is False
    assert by_name["notes.txt"]["status"] == "failed"
    assert by_name["notes.txt"]["retryable"] is False


def test_batch_over_limit_is_413_without_writes(client, settings):
    job_id = make_job(client)
    settings.max_batch_files = 3
    files = [
        ("files", (f"cv{i}.pdf", pdf_bytes("x"), "application/pdf"))
        for i in range(4)
    ]
    response = client.post(f"/api/jobs/{job_id}/cvs", files=files)
    assert response.status_code == 413
    snapshot = client.get(f"/api/jobs/{job_id}").json()
    assert snapshot["total_count"] == 0


def test_batch_at_limit_is_accepted(client, settings):
    job_id = make_job(client)
    settings.max_batch_files = 4
    files = [
        ("files", (f"cv{i}.pdf", pdf_bytes(f"Python {i}"), "application/pdf"))
        for i in range(4)
    ]
    response = client.post(f"/api/jobs/{job_id}/cvs", files=files)
    assert response.status_code == 201
    assert response.json()["total_count"] == 4


def test_full_batch_completes_with_scores(client):
    job_id = make_job(client)
    files = [
        ("files", ("strong.pdf", pdf_bytes("Built Python and PostgreSQL production services for three years"), "application/pdf")),
        ("files", ("weak.pdf", pdf_bytes("Worked in customer support."), "application/pdf")),
    ]
    client.post(f"/api/jobs/{job_id}/cvs", files=files)
    snapshot = wait_for_terminal(client, job_id)
    assert snapshot["is_final"] is True
    assert snapshot["completed_count"] == 2
    by_name = {c["filename"]: c for c in snapshot["candidates"]}
    strong = by_name["strong.pdf"]
    weak = by_name["weak.pdf"]
    assert strong["total_score"] is not None
    assert strong["total_score"] > 0
    assert len(strong["evaluations"]) == 3
    assert weak["status"] in {"complete", "needs_review"}
    assert weak["total_score"] is not None


def test_manual_review_updates_total(client):
    job_id = make_job(client)
    files = [
        ("files", ("cv.pdf", pdf_bytes("Worked in customer support."), "application/pdf")),
    ]
    upload = client.post(f"/api/jobs/{job_id}/cvs", files=files).json()
    candidate_id = upload["candidates"][0]["id"]
    wait_for_terminal(client, job_id)
    candidate = client.get(f"/api/jobs/{job_id}").json()["candidates"][0]
    before = candidate["total_score"]
    response = client.patch(
        f"/api/jobs/{job_id}/candidates/{candidate_id}/criteria/python",
        json={"match_level": "strong", "review_note": "Verified in interview"},
    )
    assert response.status_code == 200
    updated = response.json()
    evaluation = next(
        e for e in updated["evaluations"] if e["criterion_id"] == "python"
    )
    assert evaluation["status"] == "reviewed"
    assert evaluation["manual_fraction"] == 1.0
    assert evaluation["review_note"] == "Verified in interview"
    assert updated["total_score"] != before


def test_patch_unknown_candidate_or_criterion_is_404(client):
    job_id = make_job(client)
    response = client.patch(
        f"/api/jobs/{job_id}/candidates/nope/criteria/python",
        json={"match_level": "strong"},
    )
    assert response.status_code == 404


def test_non_retryable_failure_rejects_retry(client):
    job_id = make_job(client)
    files = [("files", ("corrupt.pdf", b"junk", "application/pdf"))]
    upload = client.post(f"/api/jobs/{job_id}/cvs", files=files).json()
    candidate_id = upload["candidates"][0]["id"]
    wait_for_terminal(client, job_id)
    response = client.post(
        f"/api/jobs/{job_id}/candidates/{candidate_id}/retry"
    )
    assert response.status_code == 409


def test_retryable_failure_can_be_retried(settings, tmp_path):
    attempts = {"count": 0}
    fake = FakeEvaluator()

    class FlakyEvaluator:
        async def evaluate_candidate(self, criteria, spans):
            attempts["count"] += 1
            if attempts["count"] == 1:
                raise RetryableEvaluationError("temporary outage")
            return await fake.evaluate_candidate(criteria, spans)

        async def suggest_weights(self, criteria):
            return await fake.suggest_weights(criteria)

    app = create_app(settings, evaluator=FlakyEvaluator())
    with TestClient(app) as client:
        job_id = make_job(client)
        files = [
            ("files", ("cv.pdf", pdf_bytes("Built Python services"), "application/pdf"))
        ]
        upload = client.post(f"/api/jobs/{job_id}/cvs", files=files).json()
        candidate_id = upload["candidates"][0]["id"]
        snapshot = wait_for_terminal(client, job_id)
        candidate = snapshot["candidates"][0]
        assert candidate["status"] == "failed"
        assert candidate["retryable"] is True
        response = client.post(
            f"/api/jobs/{job_id}/candidates/{candidate_id}/retry"
        )
        assert response.status_code == 200
        snapshot = wait_for_terminal(client, job_id)
        candidate = snapshot["candidates"][0]
        assert candidate["status"] == "complete"
        assert candidate["total_score"] is not None


def test_sse_sends_final_snapshot_and_closes(client):
    job_id = make_job(client)
    client.post(
        f"/api/jobs/{job_id}/cvs",
        files=[
            ("files", ("a.pdf", pdf_bytes("Python PostgreSQL production"), "application/pdf")),
        ],
    )
    wait_for_terminal(client, job_id)
    response = client.get(f"/api/jobs/{job_id}/events")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-cache"
    assert "event: snapshot" in response.text
    assert '"is_final":true' in response.text


def test_sse_unknown_job_is_404(client):
    response = client.get("/api/jobs/nope/events")
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
    assert all(1 <= s["proposed_weight"] <= 5 for s in suggestions)


def test_preview_and_spans_endpoints(client):
    job_id = make_job(client)
    files = [
        ("files", ("cv.pdf", pdf_bytes("Built Python services"), "application/pdf"))
    ]
    upload = client.post(f"/api/jobs/{job_id}/cvs", files=files).json()
    candidate_id = upload["candidates"][0]["id"]
    wait_for_terminal(client, job_id)
    spans = client.get(
        f"/api/jobs/{job_id}/candidates/{candidate_id}/spans"
    )
    assert spans.status_code == 200
    assert spans.json()[0]["page_number"] == 1
    assert "Python services" in spans.json()[0]["text"]
    preview = client.get(
        f"/api/jobs/{job_id}/candidates/{candidate_id}/preview"
    )
    assert preview.status_code == 200
    assert preview.content.startswith(b"%PDF-")
    assert (
        client.get(f"/api/jobs/{job_id}/candidates/nope/preview").status_code
        == 404
    )
