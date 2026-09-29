import json

import httpx
import pymupdf
import pytest

from backend.app.config import Settings
from backend.app.importer import (
    FakeImporter,
    ImporterUnavailable,
    ImportSource,
    LangGraphImporter,
    ListingNotReadable,
    create_importer,
)
from backend.app.typesafe_adapter import FakeEvaluator

LISTING_HTML = (
    b"<html><body><h1>Senior Backend Engineer</h1>"
    b"<p>Python, FastAPI, PostgreSQL. " + b"x" * 900 + b"</p></body></html>"
)

DRAFT = {
    "title": "Senior Backend Engineer",
    "department": "Engineering",
    "location": "Jakarta",
    "description": "Build APIs",
    "employmentType": "full_time",
    "workArrangement": "hybrid",
    "experienceLevel": "5+ years",
    "educationLevel": None,
    "closesAt": "2026-10-15",
    "skills": ["Python", "FastAPI"],
    "criteria": [
        {"name": "Python", "description": "d", "required": True}
    ],
}


def openrouter_response(payload):
    return httpx.Response(
        200,
        json={
            "choices": [{"message": {"content": json.dumps(payload)}}]
        },
    )


def make_settings(**overrides):
    base = {
        "_env_file": None,
        "openrouter_api_key": "k",
        "tavily_api_key": "k",
    }
    base.update(overrides)
    return Settings(**base)


async def test_link_import_happy_path():
    calls = []

    def handler(request):
        calls.append(str(request.url))
        if "openrouter" in str(request.url):
            return openrouter_response(DRAFT)
        return httpx.Response(200, content=LISTING_HTML)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    importer = LangGraphImporter(
        make_settings(), FakeEvaluator(), client
    )
    draft = await importer.import_listing(
        ImportSource.link("https://jobstreet.example/job/1")
    )
    assert draft.title == "Senior Backend Engineer"
    assert draft.employment_type == "full_time"
    assert draft.work_arrangement == "hybrid"
    assert draft.closes_at == "2026-10-15"
    assert draft.criteria[0].suggested_weight == 3  # FakeEvaluator
    assert draft.criteria[0].weight == 3
    assert draft.criteria[0].required is True
    assert draft.source.type == "link"
    assert draft.source.url == "https://jobstreet.example/job/1"
    assert not any("tavily" in c for c in calls)  # thick page → no search
    await client.aclose()


async def test_thin_page_falls_back_to_tavily():
    def handler(request):
        url = str(request.url)
        if "tavily" in url:
            return httpx.Response(
                200,
                json={
                    "results": [
                        {
                            "content": "Backend Engineer at X. "
                            "Python. Hybrid Jakarta. " * 40
                        }
                    ]
                },
            )
        if "openrouter" in url:
            return openrouter_response(
                {
                    "title": "Backend Engineer",
                    "skills": ["Python"],
                    "criteria": [],
                }
            )
        return httpx.Response(403, content=b"blocked")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    importer = LangGraphImporter(
        make_settings(), FakeEvaluator(), client
    )
    draft = await importer.import_listing(
        ImportSource.link("https://jobstreet.example/job/1")
    )
    assert draft.title == "Backend Engineer"
    assert any("search" in w.lower() for w in draft.warnings)
    await client.aclose()


async def test_nothing_readable_raises():
    def handler(request):
        if "tavily" in str(request.url):
            return httpx.Response(200, json={"results": []})
        return httpx.Response(403, content=b"blocked")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    importer = LangGraphImporter(
        make_settings(), FakeEvaluator(), client
    )
    with pytest.raises(ListingNotReadable):
        await importer.import_listing(
            ImportSource.link("https://jobstreet.example/job/1")
        )
    await client.aclose()


async def test_file_import_sends_binary_part(tmp_path):
    source = tmp_path / "ad.pdf"
    document = pymupdf.open()
    document.new_page()
    source.write_bytes(document.tobytes())
    document.close()
    requests = []

    def handler(request):
        requests.append(request)
        return openrouter_response(
            {"title": "From File", "skills": [], "criteria": []}
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    importer = LangGraphImporter(
        make_settings(), FakeEvaluator(), client
    )
    draft = await importer.import_listing(
        ImportSource.file(source, "ad.pdf", "application/pdf")
    )
    assert draft.title == "From File"
    assert draft.source.type == "file"
    assert draft.source.filename == "ad.pdf"
    payload = json.loads(requests[0].content)
    content = payload["messages"][1]["content"]
    assert isinstance(content, list)
    assert any(part["type"] != "text" for part in content)
    await client.aclose()


async def test_image_import_sends_image_part(tmp_path):
    source = tmp_path / "ad.png"
    # 1x1 PNG
    source.write_bytes(
        bytes.fromhex(
            "89504e470d0a1a0a0000000d494844520000000100000001080600"
            "00001f15c4890000000d49444154789c626001000000ffff030000"
            "06000557bfabd40000000049454e44ae426082"
        )
    )
    requests = []

    def handler(request):
        requests.append(request)
        return openrouter_response(
            {"title": "Image Ad", "skills": [], "criteria": []}
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    importer = LangGraphImporter(
        make_settings(), FakeEvaluator(), client
    )
    draft = await importer.import_listing(
        ImportSource.file(source, "ad.png", "image/png")
    )
    assert draft.title == "Image Ad"
    payload = json.loads(requests[0].content)
    content = payload["messages"][1]["content"]
    assert any(
        part["type"] == "image_url" and "data:image/png" in part["image_url"]["url"]
        for part in content
    )
    await client.aclose()


async def test_private_link_is_rejected():
    def handler(request):
        return httpx.Response(200, content=LISTING_HTML)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    importer = LangGraphImporter(
        make_settings(), FakeEvaluator(), client
    )
    with pytest.raises(ListingNotReadable):
        await importer.import_listing(
            ImportSource.link("http://127.0.0.1:8000/job/1")
        )
    with pytest.raises(ListingNotReadable):
        await importer.import_listing(
            ImportSource.link("file:///etc/passwd")
        )
    await client.aclose()


async def test_redirect_to_private_host_is_rejected():
    def handler(request):
        url = str(request.url)
        if "public.example" in url:
            return httpx.Response(
                302, headers={"location": "http://169.254.169.254/latest"}
            )
        return httpx.Response(200, content=LISTING_HTML)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    importer = LangGraphImporter(
        make_settings(), FakeEvaluator(), client
    )
    with pytest.raises(ListingNotReadable):
        await importer.import_listing(
            ImportSource.link("https://public.example/job/1")
        )
    await client.aclose()


async def test_import_source_kind_and_labels():
    link = ImportSource.link("https://x.example/job")
    assert link.kind == "link"
    assert link.url == "https://x.example/job"
    file_source = ImportSource.file("p.pdf", "ad.pdf", "application/pdf")
    assert file_source.kind == "file"


async def test_fake_importer_returns_draft():
    importer = FakeImporter()
    draft = await importer.import_listing(
        ImportSource.link("https://jobstreet.example/job/1")
    )
    assert draft.source.url == "https://jobstreet.example/job/1"
    assert draft.criteria[0].suggested_weight == 3
    assert any("fake" in w.lower() for w in draft.warnings)


def test_create_importer_requires_key_or_fake():
    settings = Settings(_env_file=None)
    importer, client = create_importer(settings, FakeEvaluator())
    assert importer is None
    assert client is None
    settings = Settings(_env_file=None, smartcv_fake_importer=True)
    importer, client = create_importer(settings, FakeEvaluator())
    assert isinstance(importer, FakeImporter)


async def test_unconfigured_importer_raises_unavailable():
    settings = Settings(_env_file=None)
    importer, _client = create_importer(settings, FakeEvaluator())
    assert importer is None
    with pytest.raises(ImporterUnavailable):
        raise ImporterUnavailable("Listing import is not configured")
