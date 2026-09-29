"""Demo-gate session auth.

Enabled only when SMARTCV_ACCOUNTS is configured (a JSON map of
username -> password, e.g. {"recruiter": "s3cret"}). With no accounts
configured every route is open, which keeps local dev and the test
suite credential-free. Sessions are in-memory tokens: a restart logs
everyone out, which is acceptable for a demo deployment.
"""

import hmac
import secrets
import time

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

SESSION_COOKIE = "smartcv_session"
SESSION_TTL_SECONDS = 12 * 60 * 60


class SessionStore:
    """In-memory token -> username map with a fixed TTL per session."""

    def __init__(self, ttl_seconds: int = SESSION_TTL_SECONDS) -> None:
        self._ttl = ttl_seconds
        self._sessions: dict[str, tuple[str, float]] = {}

    def create(self, username: str) -> str:
        token = secrets.token_hex(32)
        self._sessions[token] = (username, time.time() + self._ttl)
        return token

    def get(self, token: str) -> str | None:
        entry = self._sessions.get(token)
        if entry is None:
            return None
        username, expires_at = entry
        if expires_at < time.time():
            self._sessions.pop(token, None)
            return None
        return username

    def revoke(self, token: str) -> None:
        self._sessions.pop(token, None)


def _accounts(request: Request) -> dict[str, str]:
    return request.app.state.settings.demo_accounts


def _session_user(request: Request) -> str | None:
    token = request.cookies.get(SESSION_COOKIE)
    if token is None:
        return None
    store: SessionStore = request.app.state.sessions
    return store.get(token)


def require_session(request: Request) -> None:
    """Dependency: 401 unless auth is disabled or a valid session exists."""
    if not _accounts(request):
        return
    if _session_user(request) is None:
        raise HTTPException(status_code=401, detail="Authentication required")


def current_username(request: Request) -> str:
    """Session username for audit fields; 'local' when auth is disabled."""
    return _session_user(request) or "local"


class LoginRequest(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)


class SessionInfo(BaseModel):
    auth_required: bool
    authenticated: bool
    username: str | None = None


auth_router = APIRouter(prefix="/api/auth")


@auth_router.post("/login", status_code=204)
async def login(body: LoginRequest, request: Request, response: Response):
    accounts = _accounts(request)
    expected = accounts.get(body.username)
    if expected is None or not hmac.compare_digest(expected, body.password):
        raise HTTPException(
            status_code=401, detail="Invalid username or password"
        )
    token = request.app.state.sessions.create(body.username)
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
        max_age=SESSION_TTL_SECONDS,
        path="/",
    )


@auth_router.post("/logout", status_code=204)
async def logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        request.app.state.sessions.revoke(token)
    response.delete_cookie(SESSION_COOKIE, path="/")


@auth_router.get("/session", response_model=SessionInfo)
async def session(request: Request) -> SessionInfo:
    required = bool(_accounts(request))
    username = _session_user(request)
    return SessionInfo(
        auth_required=required,
        authenticated=not required or username is not None,
        username=username,
    )
