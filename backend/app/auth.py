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
from collections import deque

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

SESSION_COOKIE = "smartcv_session"
SESSION_TTL_SECONDS = 12 * 60 * 60

# In-memory per-IP login throttling: more than this many failed attempts
# inside the sliding window -> 429 until the window drains or a login
# succeeds.
LOGIN_RATE_LIMIT_ATTEMPTS = 10
LOGIN_RATE_LIMIT_WINDOW_SECONDS = 60.0


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


def _login_attempts(request: Request) -> dict[str, deque[float]]:
    """Per-app store: {client_ip: deque of failed-attempt timestamps}."""
    store = getattr(request.app.state, "login_attempts", None)
    if store is None:
        store = {}
        request.app.state.login_attempts = store
    return store


def _client_ip(request: Request) -> str:
    if request.client is not None and request.client.host:
        return request.client.host
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip() or "unknown"
    return "unknown"


def _record_failed_login(request: Request, ip: str) -> int:
    """Append a failure for ip after pruning expired ones; return count."""
    now = time.monotonic()
    window = _login_attempts(request).setdefault(ip, deque())
    cutoff = now - LOGIN_RATE_LIMIT_WINDOW_SECONDS
    while window and window[0] <= cutoff:
        window.popleft()
    window.append(now)
    return len(window)


def _clear_failed_logins(request: Request, ip: str) -> None:
    _login_attempts(request).pop(ip, None)


def _secure_cookie(request: Request) -> bool:
    """Honor X-Forwarded-Proto when TLS terminates at a proxy."""
    return (
        request.url.scheme == "https"
        or request.headers.get("x-forwarded-proto") == "https"
    )


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
    ip = _client_ip(request)
    expected = accounts.get(body.username)
    if expected is not None and hmac.compare_digest(
        expected, body.password
    ):
        _clear_failed_logins(request, ip)
        token = request.app.state.sessions.create(body.username)
        response.set_cookie(
            SESSION_COOKIE,
            token,
            httponly=True,
            samesite="lax",
            secure=_secure_cookie(request),
            max_age=SESSION_TTL_SECONDS,
            path="/",
        )
        return
    if _record_failed_login(request, ip) > LOGIN_RATE_LIMIT_ATTEMPTS:
        raise HTTPException(
            status_code=429, detail="Too many attempts, try again later"
        )
    raise HTTPException(
        status_code=401, detail="Invalid username or password"
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
