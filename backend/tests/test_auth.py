import pytest
from fastapi.testclient import TestClient

from backend.app.config import Settings
from backend.app.main import create_app


@pytest.fixture
def gated_settings(tmp_path):
    return Settings(
        _env_file=None,
        data_dir=tmp_path / "data",
        smartcv_fake_evaluator=True,
        worker_count=2,
        smartcv_accounts='{"recruiter": "s3cret", "guest": "demo123"}',
    )


@pytest.fixture
def gated_client(gated_settings):
    with TestClient(create_app(gated_settings)) as client:
        yield client


@pytest.fixture
def open_settings(tmp_path):
    return Settings(
        _env_file=None,
        data_dir=tmp_path / "data",
        smartcv_fake_evaluator=True,
        worker_count=2,
    )


@pytest.fixture
def open_client(open_settings):
    with TestClient(create_app(open_settings)) as client:
        yield client


def test_health_is_public(gated_client):
    assert gated_client.get("/api/health").status_code == 200


def test_protected_routes_require_a_session(gated_client):
    assert gated_client.get("/api/openings/missing").status_code == 401
    response = gated_client.post(
        "/api/weight-suggestions",
        json={"criteria": [{"id": "c1", "name": "Python", "description": ""}]},
    )
    assert response.status_code == 401
    assert gated_client.get("/api/openings/x/events").status_code == 401


def test_session_endpoint_reports_auth_state(gated_client):
    response = gated_client.get("/api/auth/session")
    assert response.status_code == 200
    assert response.json() == {
        "auth_required": True,
        "authenticated": False,
        "username": None,
        "is_admin": False,
    }


def test_login_rejects_bad_credentials(gated_client):
    assert (
        gated_client.post(
            "/api/auth/login",
            json={"username": "recruiter", "password": "wrong"},
        ).status_code
        == 401
    )
    assert (
        gated_client.post(
            "/api/auth/login",
            json={"username": "nobody", "password": "s3cret"},
        ).status_code
        == 401
    )


def test_login_sets_httponly_cookie_and_unlocks_api(gated_client):
    response = gated_client.post(
        "/api/auth/login",
        json={"username": "recruiter", "password": "s3cret"},
    )
    assert response.status_code == 204
    cookie = response.cookies.get("smartcv_session")
    assert cookie

    session = gated_client.get("/api/auth/session").json()
    assert session["authenticated"] is True
    assert session["username"] == "recruiter"

    assert gated_client.get("/api/openings/missing").status_code == 404


def test_cookie_is_httponly(gated_client):
    response = gated_client.post(
        "/api/auth/login",
        json={"username": "guest", "password": "demo123"},
    )
    assert "httponly" in response.headers["set-cookie"].lower()


def test_logout_revokes_the_session(gated_client):
    gated_client.post(
        "/api/auth/login",
        json={"username": "recruiter", "password": "s3cret"},
    )
    assert gated_client.get("/api/openings/missing").status_code == 404

    assert gated_client.post("/api/auth/logout").status_code == 204
    assert gated_client.get("/api/openings/missing").status_code == 401
    session = gated_client.get("/api/auth/session").json()
    assert session["authenticated"] is False


def test_unknown_or_forged_cookie_is_rejected(gated_client):
    gated_client.cookies.set("smartcv_session", "forged-token")
    assert gated_client.get("/api/openings/missing").status_code == 401


def test_no_accounts_configured_means_open_access(open_client):
    assert open_client.get("/api/openings/missing").status_code == 404
    session = open_client.get("/api/auth/session").json()
    assert session == {
        "auth_required": False,
        "authenticated": True,
        "username": None,
        "is_admin": False,
    }


def test_login_is_rate_limited_after_ten_failures(gated_client):
    bad = {"username": "recruiter", "password": "wrong"}
    for _ in range(10):
        assert (
            gated_client.post("/api/auth/login", json=bad).status_code
            == 401
        )
    blocked = gated_client.post("/api/auth/login", json=bad)
    assert blocked.status_code == 429
    assert blocked.json()["detail"] == "Too many attempts, try again later"
    # Still locked out on the next bad attempt inside the window.
    assert gated_client.post("/api/auth/login", json=bad).status_code == 429


def test_successful_login_resets_the_rate_limit(gated_client):
    bad = {"username": "recruiter", "password": "wrong"}
    for _ in range(12):
        gated_client.post("/api/auth/login", json=bad)
    ok = gated_client.post(
        "/api/auth/login",
        json={"username": "recruiter", "password": "s3cret"},
    )
    assert ok.status_code == 204
    # The counter was cleared: a fresh bad attempt is a plain 401.
    assert gated_client.post("/api/auth/login", json=bad).status_code == 401


def test_cookie_secure_flag_honors_forwarded_proto(gated_client):
    plain = gated_client.post(
        "/api/auth/login",
        json={"username": "recruiter", "password": "s3cret"},
    )
    assert plain.status_code == 204
    assert "secure" not in plain.headers["set-cookie"].lower()

    forwarded = gated_client.post(
        "/api/auth/login",
        json={"username": "recruiter", "password": "s3cret"},
        headers={"X-Forwarded-Proto": "https"},
    )
    assert forwarded.status_code == 204
    assert "secure" in forwarded.headers["set-cookie"].lower()
