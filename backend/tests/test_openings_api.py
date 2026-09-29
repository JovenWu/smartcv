import pytest
from fastapi.testclient import TestClient

from backend.app.config import Settings
from backend.app.main import create_app
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


def make_opening(client, **overrides):
    body = {
        "title": "Backend Engineer",
        "department": "Engineering",
        "criteria": [c.model_dump(mode="json", by_alias=True)
                     for c in make_criteria()],
    }
    body.update(overrides)
    response = client.post("/api/openings", json=body)
    assert response.status_code == 201
    return response.json()


def test_create_list_get_update_opening(client):
    opening = make_opening(
        client,
        employmentType="full_time",
        workArrangement="hybrid",
        skills=["Python"],
        closesAt="2026-10-15",
        source={"type": "link", "url": "https://boards.example/job/1"},
    )
    assert opening["employmentType"] == "full_time"
    assert opening["workArrangement"] == "hybrid"
    assert opening["skills"] == ["Python"]
    assert opening["closesAt"] == "2026-10-15"
    assert opening["source"]["type"] == "link"
    assert opening["status"] == "open"
    assert opening["candidates"] == 0
    assert opening["pendingReview"] == 0
    oid = opening["id"]

    listed = client.get("/api/openings").json()
    assert [o["id"] for o in listed] == [oid]

    got = client.get(f"/api/openings/{oid}").json()
    assert got["criteria"][0]["required"] is False
    assert got["criteria"][0]["name"] == "Python"

    patched = client.patch(
        f"/api/openings/{oid}",
        json={"title": "Senior BE", "status": "closed"},
    )
    assert patched.status_code == 200
    assert patched.json()["title"] == "Senior BE"
    assert patched.json()["status"] == "closed"
    assert patched.json()["updatedAt"] is not None


def test_create_opening_requires_title(client):
    assert client.post("/api/openings", json={}).status_code == 422


def test_criteria_suggestions_endpoint(client):
    response = client.post(
        "/api/criteria-suggestions",
        json={
            "title": "Backend Engineer",
            "skills": ["Kubernetes"],
            "existingCriteria": [{"id": "python", "name": "Python"}],
        },
    )
    assert response.status_code == 200
    suggestions = response.json()["suggestions"]
    assert len(suggestions) == 1
    assert suggestions[0]["skill"] == "Kubernetes"
    assert suggestions[0]["criterion"]["suggestedWeight"] >= 1


def test_unknown_opening_404s(client):
    assert client.get("/api/openings/nope").status_code == 404
    assert client.patch("/api/openings/nope", json={"title": "x"}).status_code == 404
    assert client.get("/api/openings/nope/candidates").status_code == 404
