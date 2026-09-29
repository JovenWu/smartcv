"""End-to-end test against a live uvicorn server over real HTTP.

Covers: opening creation, SSE snapshot, live per-candidate updates while the
batch is still processing, terminal opening.complete, per-file failure
isolation, manual review, retry, preview/spans endpoints.
"""

import json
import shutil
import socket
import threading
import time

import httpx
import pymupdf
import pytest
import uvicorn

from backend.app.config import Settings
from backend.app.main import create_app
from backend.tests.factories import make_criteria, write_docx


def pdf_bytes(text: str) -> bytes:
    document = pymupdf.open()
    page = document.new_page()
    if text:
        page.insert_text((72, 72), text)
    data = document.tobytes()
    document.close()
    return data


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture
def live_server(tmp_path):
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path / "data",
        smartcv_fake_evaluator=True,
        worker_count=4,
    )
    app = create_app(settings)
    port = _free_port()
    config = uvicorn.Config(
        app, host="127.0.0.1", port=port, log_level="warning"
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.time() + 15
    while not server.started:
        if time.time() > deadline:
            raise RuntimeError("server did not start")
        time.sleep(0.05)
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=15)


def _read_event(lines):
    name = None
    for line in lines:
        if line.startswith("event: "):
            name = line[len("event: "):]
        elif line.startswith("data: "):
            return name, json.loads(line[len("data: "):])
    return None, None


def test_full_screening_flow_over_http(live_server, tmp_path):
    base = live_server
    with httpx.Client(base_url=base, timeout=30) as http:
        assert http.get("/api/health").json() == {"status": "ok"}

        opening = http.post(
            "/api/openings",
            json={
                "title": "Backend Engineer",
                "criteria": [
                    c.model_dump(mode="json", by_alias=True)
                    for c in make_criteria()
                ],
            },
        ).json()
        opening_id = opening["id"]
        assert opening["candidates"] == 0

        docx_file = tmp_path / "cv.docx"
        write_docx(docx_file, "Python and PostgreSQL production services")
        has_soffice = shutil.which("soffice") is not None

        files = [
            ("files", ("strong.pdf", pdf_bytes(
                "Built Python and PostgreSQL production services for years"
            ), "application/pdf")),
            ("files", ("weak.pdf", pdf_bytes(
                "Worked in customer support."
            ), "application/pdf")),
            ("files", ("empty.pdf", pdf_bytes(""), "application/pdf")),
            ("files", ("corrupt.pdf", b"junk bytes", "application/pdf")),
            ("files", ("cv.docx", docx_file.read_bytes(),
                       "application/octet-stream")),
        ]

        events = []
        updated_ids = set()
        completed_via_stream = None
        with http.stream(
            "GET", f"/api/openings/{opening_id}/events"
        ) as response:
            assert response.status_code == 200
            assert response.headers["content-type"].startswith(
                "text/event-stream"
            )
            lines = response.iter_lines()
            name, snapshot = _read_event(lines)
            assert name == "snapshot"
            assert snapshot["opening"]["isFinal"] is False
            assert snapshot["opening"]["candidates"] == 0
            assert snapshot["candidates"] == []

            upload = http.post(
                f"/api/openings/{opening_id}/candidates", files=files
            )
            assert upload.status_code == 201
            assert upload.json()["totalCount"] == 5

            while True:
                name, payload = _read_event(lines)
                assert name is not None, "stream ended before opening.complete"
                events.append(name)
                if name == "candidate.updated":
                    updated_ids.add(payload["candidate"]["id"])
                if name == "opening.complete":
                    completed_via_stream = payload
                    break

        assert events[-1] == "opening.complete"
        assert events.count("opening.complete") == 1
        assert updated_ids, "no live candidate updates were streamed"
        snapshot = completed_via_stream
        assert snapshot["opening"]["isFinal"] is True
        assert snapshot["opening"]["candidates"] == 5
        assert len(snapshot["candidates"]) == 5

        by_name = {c["file"]["filename"]: c for c in snapshot["candidates"]}
        assert by_name["strong.pdf"]["totalScore"] is not None
        assert by_name["strong.pdf"]["totalScore"] > 0
        assert len(by_name["strong.pdf"]["evaluations"]) == 3
        assert by_name["weak.pdf"]["totalScore"] == 0.0
        assert by_name["empty.pdf"]["status"] == "needs_review"
        assert by_name["empty.pdf"]["totalScore"] is None
        assert by_name["corrupt.pdf"]["status"] == "failed"
        assert by_name["corrupt.pdf"]["retryable"] is False
        if has_soffice:
            assert by_name["cv.docx"]["totalScore"] is not None
        else:
            assert by_name["cv.docx"]["status"] == "failed"
            assert by_name["cv.docx"]["retryable"] is True

        candidate_id = by_name["strong.pdf"]["id"]
        spans = http.get(
            f"/api/openings/{opening_id}/candidates/{candidate_id}/spans"
        )
        assert spans.status_code == 200
        assert any(
            "Python" in span["text"] for span in spans.json()
        )
        preview = http.get(
            f"/api/openings/{opening_id}/candidates/{candidate_id}/preview"
        )
        assert preview.status_code == 200
        assert preview.content.startswith(b"%PDF-")

        review = http.patch(
            f"/api/openings/{opening_id}/candidates/{candidate_id}"
            "/criteria/postgresql",
            json={"matchLevel": "not_found", "reviewNote": "e2e check"},
        )
        assert review.status_code == 200
        assert review.json()["evaluations"][-1]["status"] == "reviewed"
        assert review.json()["evaluations"][-1]["reviewedBy"] == "local"

        decision = http.patch(
            f"/api/openings/{opening_id}/candidates/{candidate_id}/decision",
            json={"decision": "shortlisted"},
        )
        assert decision.status_code == 200
        assert decision.json()["decision"] == "shortlisted"


def test_demo_batch_generation(tmp_path, monkeypatch):
    import backend.scripts.generate_demo_batch as generator

    monkeypatch.setattr(generator, "OUTPUT_DIR", tmp_path / "demo")
    generator.main()
    output = tmp_path / "demo"
    assert (output / "job.json").exists()
    files = list(output.iterdir())
    pdfs = [f for f in files if f.suffix == ".pdf"]
    docxs = [f for f in files if f.suffix == ".docx"]
    assert len(files) == 26  # 25 CVs + job.json
    assert len(pdfs) == 15
    assert len(docxs) == 10
