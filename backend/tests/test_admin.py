"""Admin user-management routes (mirrors accordance's admin API)."""

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
def admin_client(gated_settings):
    with TestClient(create_app(gated_settings)) as client:
        response = client.post(
            "/api/auth/login",
            json={"username": "recruiter", "password": "s3cret"},
        )
        assert response.status_code == 204
        yield client


def _login(client, username, password):
    return client.post(
        "/api/auth/login",
        json={"username": username, "password": password},
    )


def test_users_require_auth(gated_settings):
    with TestClient(create_app(gated_settings)) as client:
        assert client.get("/api/admin/users").status_code == 401


def test_users_require_admin(gated_settings):
    with TestClient(create_app(gated_settings)) as client:
        assert _login(client, "guest", "demo123").status_code == 204
        assert client.get("/api/admin/users").status_code == 403


def test_admin_lists_and_creates_users(admin_client):
    users = admin_client.get("/api/admin/users").json()
    assert {u["username"] for u in users} == {"recruiter", "guest"}
    by_name = {u["username"]: u for u in users}
    assert by_name["recruiter"]["isAdmin"] is True
    assert by_name["guest"]["isAdmin"] is False

    response = admin_client.post(
        "/api/admin/users",
        json={"username": "hiring", "password": "longenough1"},
    )
    assert response.status_code == 201
    created = response.json()
    assert created["username"] == "hiring"
    assert created["isAdmin"] is False
    assert created["isActive"] is True


def test_create_user_rejects_duplicate_and_short_password(admin_client):
    assert (
        admin_client.post(
            "/api/admin/users",
            json={"username": "guest", "password": "longenough1"},
        ).status_code
        == 409
    )
    assert (
        admin_client.post(
            "/api/admin/users",
            json={"username": "newbie", "password": "short"},
        ).status_code
        == 422
    )


def test_update_user_toggle_and_self_protection(admin_client):
    users = admin_client.get("/api/admin/users").json()
    guest = next(u for u in users if u["username"] == "guest")
    admin = next(u for u in users if u["username"] == "recruiter")

    updated = admin_client.patch(
        f"/api/admin/users/{guest['id']}", json={"isAdmin": True}
    ).json()
    assert updated["isAdmin"] is True
    updated = admin_client.patch(
        f"/api/admin/users/{guest['id']}", json={"isAdmin": False}
    ).json()
    assert updated["isAdmin"] is False

    assert (
        admin_client.patch(
            f"/api/admin/users/{admin['id']}", json={"isActive": False}
        ).status_code
        == 400
    )
    assert (
        admin_client.patch(
            f"/api/admin/users/{admin['id']}", json={"isAdmin": False}
        ).status_code
        == 400
    )
    assert (
        admin_client.patch(
            f"/api/admin/users/{guest['id']}", json={}
        ).status_code
        == 400
    )


def test_disabled_user_cannot_login_and_sessions_die(admin_client):
    users = admin_client.get("/api/admin/users").json()
    guest = next(u for u in users if u["username"] == "guest")

    assert (
        admin_client.patch(
            f"/api/admin/users/{guest['id']}", json={"isActive": False}
        ).status_code
        == 200
    )
    assert _login(admin_client, "guest", "demo123").status_code == 401


def test_reset_password_rotates_credentials(admin_client):
    users = admin_client.get("/api/admin/users").json()
    guest = next(u for u in users if u["username"] == "guest")
    assert (
        admin_client.post(
            f"/api/admin/users/{guest['id']}/reset-password",
            json={"password": "newpass123"},
        ).status_code
        == 204
    )
    assert _login(admin_client, "guest", "demo123").status_code == 401
    assert _login(admin_client, "guest", "newpass123").status_code == 204
    assert (
        _login(admin_client, "recruiter", "s3cret").status_code == 204
    )
    assert (
        admin_client.post(
            "/api/admin/users/nope/reset-password",
            json={"password": "newpass123"},
        ).status_code
        == 404
    )


def test_change_password_self_service(admin_client):
    assert (
        admin_client.post(
            "/api/auth/password",
            json={
                "current_password": "s3cret",
                "new_password": "rotated123",
            },
        ).status_code
        == 204
    )
    assert admin_client.get("/api/auth/session").status_code == 200
    assert _login(admin_client, "recruiter", "s3cret").status_code == 401
    assert (
        _login(admin_client, "recruiter", "rotated123").status_code == 204
    )
    assert (
        admin_client.post(
            "/api/auth/password",
            json={
                "current_password": "s3cret",
                "new_password": "whatever123",
            },
        ).status_code
        == 400
    )


def test_open_mode_has_no_admin_routes(tmp_path):
    settings = Settings(
        _env_file=None,
        data_dir=tmp_path / "data",
        smartcv_fake_evaluator=True,
        worker_count=2,
    )
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/admin/users").status_code == 403
