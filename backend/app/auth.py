"""DB-backed session auth, modeled on accordance's auth module.

Enabled when SMARTCV_ACCOUNTS is configured (seeded into the users
table on startup) or the users table already has rows. With neither,
every route is open, which keeps local dev and the test suite
credential-free. Sessions live in the ``sessions`` table keyed by the
SHA-256 of the raw token, so a restart no longer logs everyone out and
disabling a user invalidates their sessions immediately.
"""

import asyncio
import time
from collections import deque
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from backend.app.schemas import UserInfo
from backend.app.users import (
    MIN_PASSWORD_LEN,
    hash_password,
    verify_password,
)

SESSION_COOKIE = "smartcv_session"
SESSION_TTL_SECONDS = 12 * 60 * 60

LOGIN_RATE_LIMIT_ATTEMPTS = 10
LOGIN_RATE_LIMIT_WINDOW_SECONDS = 60.0


def _repository(request: Request):
    return getattr(request.app.state, "repository", None)


def _auth_enabled(request: Request) -> bool:
    """Auth is on when the lifespan seeded accounts or users exist."""
    enabled = getattr(request.app.state, "auth_enabled", None)
    if enabled is not None:
        return enabled
    return request.app.state.settings.auth_enabled


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


async def _session_user(request: Request) -> UserInfo | None:
    token = request.cookies.get(SESSION_COOKIE)
    repository = _repository(request)
    if token is None or repository is None:
        return None
    return await repository.user_for_token(token)


async def require_session(request: Request) -> None:
    """Dependency: 401 unless auth is disabled or a valid session exists."""
    if not _auth_enabled(request):
        return
    if await _session_user(request) is None:
        raise HTTPException(status_code=401, detail="Authentication required")


async def require_user(request: Request) -> UserInfo:
    """Dependency: the signed-in user; 403 when auth is disabled."""
    if not _auth_enabled(request):
        raise HTTPException(
            status_code=403,
            detail="User management requires authentication",
        )
    user = await _session_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="Authentication required")
    return user


async def require_admin(
    user: Annotated[UserInfo, Depends(require_user)],
) -> UserInfo:
    """Dependency: admin-only routes (user management)."""
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    return user


async def current_username(request: Request) -> str:
    """Session username for audit fields; 'local' when auth is disabled."""
    user = await _session_user(request)
    return user.username if user is not None else "local"


class LoginRequest(BaseModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=1)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1)
    new_password: str = Field(min_length=MIN_PASSWORD_LEN)


class SessionInfo(BaseModel):
    auth_required: bool
    authenticated: bool
    username: str | None = None
    is_admin: bool = False


auth_router = APIRouter(prefix="/api/auth")


@auth_router.post("/login", status_code=204)
async def login(body: LoginRequest, request: Request, response: Response):
    repository = _repository(request)
    ip = _client_ip(request)
    ok = False
    if repository is not None:
        entry = await repository.get_user_auth(body.username)
        if entry is not None:
            user, digest = entry
            if user.is_active:
                ok = await asyncio.to_thread(
                    verify_password, body.password, digest
                )
    if ok:
        _clear_failed_logins(request, ip)
        token = await repository.create_session(
            user.id, SESSION_TTL_SECONDS
        )
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
    repository = _repository(request)
    if token and repository is not None:
        await repository.delete_session(token)
    response.delete_cookie(SESSION_COOKIE, path="/")


@auth_router.post("/password", status_code=204)
async def change_password(
    body: ChangePasswordRequest,
    request: Request,
    response: Response,
    user: Annotated[UserInfo, Depends(require_user)],
):
    """Self-service password change; keeps the current session alive."""
    repository = _repository(request)
    entry = await repository.get_user_auth(user.username)
    if entry is None or not await asyncio.to_thread(
        verify_password, body.current_password, entry[1]
    ):
        raise HTTPException(
            status_code=400, detail="Current password is incorrect"
        )
    digest = await asyncio.to_thread(hash_password, body.new_password)
    await repository.set_user_password(user.id, digest)
    await repository.delete_user_sessions(user.id)
    token = await repository.create_session(user.id, SESSION_TTL_SECONDS)
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        secure=_secure_cookie(request),
        max_age=SESSION_TTL_SECONDS,
        path="/",
    )


@auth_router.get("/session", response_model=SessionInfo)
async def session(request: Request) -> SessionInfo:
    required = _auth_enabled(request)
    user = await _session_user(request)
    return SessionInfo(
        auth_required=required,
        authenticated=not required or user is not None,
        username=user.username if user else None,
        is_admin=user.is_admin if user else False,
    )
