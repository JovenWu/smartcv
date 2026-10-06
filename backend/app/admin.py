"""Admin-only account management, modeled on accordance's api/admin.py.

Create accounts, toggle admin/active flags, and reset passwords. Every
route is gated by ``require_admin``; self-disable and self-demote are
blocked so at least one active admin always remains.
"""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from backend.app.auth import require_admin
from backend.app.schemas import ApiModel, UserInfo
from backend.app.users import (
    MIN_PASSWORD_LEN,
    hash_password,
)

router = APIRouter(
    prefix="/api/admin",
    tags=["admin"],
)


def _repository(request: Request):
    return getattr(request.app.state, "repository", None)


class CreateUserRequest(ApiModel):
    username: str = Field(min_length=1)
    password: str = Field(min_length=MIN_PASSWORD_LEN)
    is_admin: bool = False


class UpdateUserRequest(ApiModel):
    is_active: bool | None = None
    is_admin: bool | None = None


class ResetPasswordRequest(BaseModel):
    password: str = Field(min_length=MIN_PASSWORD_LEN)


@router.get("/users", response_model=list[UserInfo])
async def list_users(
    request: Request,
    _: Annotated[UserInfo, Depends(require_admin)],
) -> list[UserInfo]:
    return await _repository(request).list_users()


@router.post("/users", response_model=UserInfo, status_code=201)
async def create_user(
    body: CreateUserRequest,
    request: Request,
    _: Annotated[UserInfo, Depends(require_admin)],
) -> UserInfo:
    repository = _repository(request)
    digest = await asyncio.to_thread(hash_password, body.password)
    user = await repository.create_user(
        body.username, digest, is_admin=body.is_admin
    )
    if user is None:
        raise HTTPException(409, "Username already exists")
    return user


@router.patch("/users/{user_id}", response_model=UserInfo)
async def update_user(
    user_id: str,
    body: UpdateUserRequest,
    request: Request,
    admin: Annotated[UserInfo, Depends(require_admin)],
) -> UserInfo:
    if body.is_active is None and body.is_admin is None:
        raise HTTPException(400, "No fields to update")
    if user_id == admin.id:
        if body.is_active is False:
            raise HTTPException(
                400, "You cannot disable your own account"
            )
        if body.is_admin is False:
            raise HTTPException(
                400, "You cannot remove your own admin access"
            )
    repository = _repository(request)
    user = await repository.update_user(
        user_id, is_active=body.is_active, is_admin=body.is_admin
    )
    if user is None:
        raise HTTPException(404, "No such user")
    if body.is_active is False:
        await repository.delete_user_sessions(user_id)
    return user


@router.post("/users/{user_id}/reset-password", status_code=204)
async def reset_password(
    user_id: str,
    body: ResetPasswordRequest,
    request: Request,
    _: Annotated[UserInfo, Depends(require_admin)],
):
    repository = _repository(request)
    digest = await asyncio.to_thread(hash_password, body.password)
    if not await repository.set_user_password(user_id, digest):
        raise HTTPException(404, "No such user")
    await repository.delete_user_sessions(user_id)
