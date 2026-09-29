import pymupdf
import pytest
from fastapi.testclient import TestClient

from backend.app.config import Settings
from backend.app.importer import FakeImporter
from backend.app.main import create_app


def pdf_bytes(text: str) -> bytes:
    document = pymupdf.open()
    page = document.new_page()
    if text:
        page.insert_text((72, 72), text)
    data = document.tobytes()
    document.close()
    return data


@pytest.fixture
def settings(tmp_path):
    return Settings(
        _env_file=None,
        data_dir=tmp_path / "data",
        smartcv_fake_evaluator=True,
        worker_count=1,
    )


@pytest.fixture
def client(settings):
    with TestClient(create_app(settings, importer=FakeImporter())) as client:
        yield client


def test_import_link_endpoint(client):
    response = client.post(
        "/api/openings/import/link",
        json={"url": "https://jobstreet.example/job/1"},
    )
    assert response.status_code == 200
    draft = response.json()
    assert draft["source"]["type"] == "link"
    assert draft["source"]["url"] == "https://jobstreet.example/job/1"
    assert draft["criteria"][0]["suggestedWeight"] == 3
    assert draft["title"]


def test_import_file_endpoint(client):
    response = client.post(
        "/api/openings/import/file",
        files=[
            (
                "file",
                (
                    "ad.pdf",
                    pdf_bytes("Backend Engineer listing"),
                    "application/pdf",
                ),
            )
        ],
    )
    assert response.status_code == 200
    draft = response.json()
    assert draft["source"]["type"] == "file"
    assert draft["source"]["filename"] == "ad.pdf"


def test_import_file_rejects_unsupported_type(client):
    response = client.post(
        "/api/openings/import/file",
        files=[("file", ("notes.txt", b"plain", "text/plain"))],
    )
    assert response.status_code == 415


def test_import_unconfigured_returns_503(settings):
    with TestClient(create_app(settings)) as client:
        response = client.post(
            "/api/openings/import/link",
            json={"url": "https://jobstreet.example/job/1"},
        )
        assert response.status_code == 503
