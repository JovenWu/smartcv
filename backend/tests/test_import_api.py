import pymupdf
import pytest
from fastapi.testclient import TestClient

from backend.app.config import Settings
from backend.app.importer import (
    FakeImporter,
    ImportProviderError,
    ListingNotReadable,
)
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


def test_import_file_rejects_signature_mismatch(client):
    for name, payload, mime in (
        ("ad.pdf", b"plain text", "application/pdf"),
        ("ad.png", b"%PDF-1.7 fake", "image/png"),
        ("ad.webp", b"RIFF\x00\x00\x00\x00WAVE", "image/webp"),
        ("ad.docx", b"not a zip", "application/octet-stream"),
    ):
        response = client.post(
            "/api/openings/import/file",
            files=[("file", (name, payload, mime))],
        )
        assert response.status_code == 415, name


def test_import_file_accepts_image_signature(client):
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    response = client.post(
        "/api/openings/import/file",
        files=[("file", ("listing.png", png, "image/png"))],
    )
    assert response.status_code == 200
    assert response.json()["source"]["filename"] == "listing.png"


def test_import_provider_error_is_sanitized(settings):
    class FailingImporter:
        async def import_listing(self, source):
            raise ImportProviderError(
                "upstream 401 for key sk-secret-value"
            )

    with TestClient(
        create_app(settings, importer=FailingImporter())
    ) as client:
        response = client.post(
            "/api/openings/import/link",
            json={"url": "https://jobstreet.example/job/1"},
        )
        assert response.status_code == 502
        assert response.json()["detail"] == "Listing import failed"
        assert "sk-secret-value" not in response.text


def test_import_unreadable_error_is_sanitized(settings):
    class UnreadableImporter:
        async def import_listing(self, source):
            raise ListingNotReadable("resolved to db.internal:5432")

    with TestClient(
        create_app(settings, importer=UnreadableImporter())
    ) as client:
        response = client.post(
            "/api/openings/import/link",
            json={"url": "https://jobstreet.example/job/1"},
        )
        assert response.status_code == 422
        assert response.json()["detail"] == "Listing import failed"
        assert "db.internal" not in response.text
