from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...db import get_session
from ...models import ApiClient, AuditEvent, AuthSession, Membership, User, Workspace
from ...security import (
    AuthContext,
    get_auth_context,
    hash_password,
    hash_token,
    issue_token,
    require_roles,
    session_expiry,
    verify_password,
)

router = APIRouter()


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=256)
    workspace_id: str | None = None


class UserCreate(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    display_name: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=8, max_length=256)
    role: Literal["admin", "manager", "user", "cs_agent", "warehouse"] = "user"


class WorkspaceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    slug: str = Field(min_length=2, max_length=80, pattern=r"^[a-z0-9][a-z0-9-]*$")


class ApiClientCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    role: Literal["admin", "manager"] = "manager"
    scopes: list[str] = Field(
        default_factory=lambda: [
            "apps:read",
            "apps:write",
            "apps:run",
            "apps:evaluate",
            "knowledge:read",
            "knowledge:write",
            "models:read",
            "tools:read",
            "tools:write",
            "logs:read",
        ]
    )


class MembershipUpdate(BaseModel):
    role: Literal["admin", "manager", "user", "cs_agent", "warehouse"]


def user_payload(user: User, memberships: list[Membership]) -> dict:
    return {
        "id": user.id,
        "email": user.email,
        "display_name": user.display_name,
        "memberships": [{"workspace_id": item.workspace_id, "role": item.role} for item in memberships],
    }


@router.post("/login")
async def login(payload: LoginRequest, session: AsyncSession = Depends(get_session)) -> dict:
    email = payload.email.strip().lower()
    user = await session.scalar(select(User).where(User.email == email))
    if not user or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="邮箱或密码不正确")
    memberships = list(await session.scalars(select(Membership).where(Membership.user_id == user.id)))
    if not memberships:
        raise HTTPException(status_code=403, detail="用户尚未加入任何业务空间")
    if payload.workspace_id and payload.workspace_id not in {item.workspace_id for item in memberships}:
        raise HTTPException(status_code=403, detail="无权访问该业务空间")
    token = issue_token()
    session.add(AuthSession(user_id=user.id, token_hash=hash_token(token), expires_at=session_expiry()))
    await session.commit()
    return {"token": token, "token_type": "bearer", "user": user_payload(user, memberships)}


@router.post("/logout", status_code=204)
async def logout(
    context: AuthContext = Depends(get_auth_context),
    session: AsyncSession = Depends(get_session),
) -> Response:
    if context.user_id:
        await session.execute(delete(AuthSession).where(AuthSession.user_id == context.user_id))
        await session.commit()
    return Response(status_code=204)


@router.get("/me")
async def me(context: AuthContext = Depends(get_auth_context), session: AsyncSession = Depends(get_session)) -> dict:
    if context.auth_type == "demo":
        return {"auth_type": "demo", "role": context.role, "workspace_id": context.workspace_id}
    if context.auth_type == "api_client":
        return {"auth_type": "api_client", "role": context.role, "workspace_id": context.workspace_id}
    user = await session.get(User, context.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    memberships = list(await session.scalars(select(Membership).where(Membership.user_id == user.id)))
    return {"auth_type": "session", "role": context.role, "workspace_id": context.workspace_id, "user": user_payload(user, memberships)}


@router.get("/workspaces")
async def list_workspaces(context: AuthContext = Depends(get_auth_context), session: AsyncSession = Depends(get_session)) -> list[dict]:
    if context.auth_type == "demo":
        workspaces = list(await session.scalars(select(Workspace).where(Workspace.is_active.is_(True))))
    elif context.user_id:
        workspaces = list(await session.scalars(select(Workspace).join(Membership, Membership.workspace_id == Workspace.id).where(Membership.user_id == context.user_id)))
    else:
        workspaces = list(await session.scalars(select(Workspace).where(Workspace.id == context.workspace_id)))
    return [{"id": item.id, "name": item.name, "slug": item.slug} for item in workspaces]


@router.post("/workspaces", status_code=201)
async def create_workspace(
    payload: WorkspaceCreate,
    context: AuthContext = Depends(require_roles("admin")),
    session: AsyncSession = Depends(get_session),
) -> dict:
    if await session.scalar(select(Workspace).where(Workspace.slug == payload.slug)):
        raise HTTPException(status_code=409, detail="空间标识已存在")
    workspace = Workspace(name=payload.name, slug=payload.slug)
    session.add(workspace)
    await session.flush()
    if context.user_id:
        session.add(Membership(workspace_id=workspace.id, user_id=context.user_id, role="admin"))
    await session.commit()
    return {"id": workspace.id, "name": workspace.name, "slug": workspace.slug}


@router.post("/users", status_code=201)
async def create_user(
    payload: UserCreate,
    context: AuthContext = Depends(require_roles("admin")),
    session: AsyncSession = Depends(get_session),
) -> dict:
    email = payload.email.strip().lower()
    user = await session.scalar(select(User).where(User.email == email))
    if not user:
        user = User(email=email, display_name=payload.display_name, password_hash=hash_password(payload.password))
        session.add(user)
        await session.flush()
    membership = await session.scalar(select(Membership).where(Membership.workspace_id == context.workspace_id, Membership.user_id == user.id))
    if membership:
        raise HTTPException(status_code=409, detail="用户已在当前业务空间")
    session.add(Membership(workspace_id=context.workspace_id, user_id=user.id, role=payload.role))
    session.add(AuditEvent(workspace_id=context.workspace_id, actor_id=context.user_id, action="member.invited", resource_type="user", resource_id=user.id, detail={"email": user.email, "role": payload.role}))
    await session.commit()
    return {"id": user.id, "email": user.email, "display_name": user.display_name, "role": payload.role}


@router.get("/users")
async def list_users(
    context: AuthContext = Depends(require_roles("admin")),
    session: AsyncSession = Depends(get_session),
) -> list[dict]:
    rows = await session.execute(
        select(User, Membership)
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.workspace_id == context.workspace_id)
        .order_by(User.display_name, User.email)
    )
    return [
        {
            "id": user.id,
            "email": user.email,
            "display_name": user.display_name,
            "is_active": user.is_active,
            "role": membership.role,
            "joined_at": membership.created_at,
        }
        for user, membership in rows.all()
    ]


@router.patch("/users/{user_id}")
async def update_user_membership(
    user_id: str,
    payload: MembershipUpdate,
    context: AuthContext = Depends(require_roles("admin")),
    session: AsyncSession = Depends(get_session),
) -> dict:
    membership = await session.scalar(select(Membership).where(Membership.workspace_id == context.workspace_id, Membership.user_id == user_id))
    user = await session.get(User, user_id)
    if not membership or not user:
        raise HTTPException(status_code=404, detail="成员不存在")
    if context.user_id == user_id and payload.role != "admin":
        raise HTTPException(status_code=409, detail="不能降低当前登录管理员自己的权限")
    previous = membership.role
    membership.role = payload.role
    session.add(AuditEvent(workspace_id=context.workspace_id, actor_id=context.user_id, action="member.role_updated", resource_type="user", resource_id=user.id, detail={"from": previous, "to": payload.role}))
    await session.commit()
    return {"id": user.id, "email": user.email, "display_name": user.display_name, "role": membership.role}


@router.delete("/users/{user_id}", status_code=204)
async def remove_user_membership(
    user_id: str,
    context: AuthContext = Depends(require_roles("admin")),
    session: AsyncSession = Depends(get_session),
) -> Response:
    if context.user_id == user_id:
        raise HTTPException(status_code=409, detail="不能将当前登录管理员移出业务空间")
    membership = await session.scalar(select(Membership).where(Membership.workspace_id == context.workspace_id, Membership.user_id == user_id))
    if not membership:
        raise HTTPException(status_code=404, detail="成员不存在")
    session.add(AuditEvent(workspace_id=context.workspace_id, actor_id=context.user_id, action="member.removed", resource_type="user", resource_id=user_id, detail={}))
    await session.delete(membership)
    await session.commit()
    return Response(status_code=204)


@router.get("/api-clients")
async def list_api_clients(
    context: AuthContext = Depends(require_roles("admin")),
    session: AsyncSession = Depends(get_session),
) -> list[dict]:
    clients = list(await session.scalars(select(ApiClient).where(ApiClient.workspace_id == context.workspace_id, ApiClient.revoked_at.is_(None))))
    return [{"id": item.id, "name": item.name, "role": item.role, "scopes": item.scopes, "last_used_at": item.last_used_at} for item in clients]


@router.post("/api-clients", status_code=201)
async def create_api_client(
    payload: ApiClientCreate,
    context: AuthContext = Depends(require_roles("admin")),
    session: AsyncSession = Depends(get_session),
) -> dict:
    token = issue_token()
    client = ApiClient(workspace_id=context.workspace_id, name=payload.name, role=payload.role, scopes=payload.scopes, token_hash=hash_token(token))
    session.add(client)
    await session.flush()
    session.add(AuditEvent(workspace_id=context.workspace_id, actor_id=context.user_id, action="api_client.created", resource_type="api_client", resource_id=client.id, detail={"name": client.name, "scopes": client.scopes}))
    await session.commit()
    return {"id": client.id, "name": client.name, "token": token, "workspace_id": client.workspace_id, "scopes": client.scopes}


@router.delete("/api-clients/{client_id}", status_code=204)
async def revoke_api_client(
    client_id: str,
    context: AuthContext = Depends(require_roles("admin")),
    session: AsyncSession = Depends(get_session),
) -> Response:
    client = await session.get(ApiClient, client_id)
    if not client or client.workspace_id != context.workspace_id:
        raise HTTPException(status_code=404, detail="API 客户端不存在")
    client.revoked_at = datetime.now(UTC)
    session.add(AuditEvent(workspace_id=context.workspace_id, actor_id=context.user_id, action="api_client.revoked", resource_type="api_client", resource_id=client.id, detail={"name": client.name}))
    await session.commit()
    return Response(status_code=204)
