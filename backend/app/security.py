from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal

from cryptography.fernet import Fernet, InvalidToken
from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .db import get_session
from .models import DEFAULT_WORKSPACE_ID, ApiClient, AuthSession, Membership, User
from .tenancy import activate_workspace


DemoRole = Literal["admin", "manager", "user", "cs_agent", "warehouse"]


@dataclass(slots=True)
class AuthContext:
    role: DemoRole
    workspace_id: str
    user_id: str | None
    auth_type: str
    scopes: frozenset[str] | None = None


def _required_scope(request: Request) -> str | None:
    """Map API-client requests to the least privilege required by the route.

    Human sessions and development demo roles continue to use role checks. API
    clients must satisfy both the stored role and the route scope.
    """
    path = request.url.path
    method = request.method.upper()
    if "/auth/" in path:
        return None
    if "/commerce" in path:
        return "commerce:read" if method == "GET" else "commerce:write"
    if "/knowledge-bases" in path:
        return "knowledge:read" if method == "GET" else "knowledge:write"
    if "/models" in path or "/model-options" in path:
        return "models:read" if method == "GET" else "models:write"
    if "/tools" in path:
        return "tools:read" if method == "GET" else "tools:write"
    if "/logs" in path:
        return "logs:read"
    if "/fde/" in path:
        if path.endswith("/run") or path.endswith("/preview"):
            return "apps:run"
        if path.endswith("/evaluate") or "evaluation-suite" in path:
            return "apps:evaluate"
        return "apps:read" if method == "GET" else "apps:write"
    if "/apps" in path or "/conversations" in path:
        return "apps:read" if method == "GET" else "apps:run" if "/chat" in path else "apps:write"
    return None


def _enforce_scope(context: AuthContext, request: Request) -> None:
    if context.auth_type != "api_client":
        return
    required = _required_scope(request)
    if required is None:
        return
    scopes = context.scopes or frozenset()
    namespace = required.split(":", 1)[0]
    if required not in scopes and f"{namespace}:*" not in scopes and "*" not in scopes:
        raise HTTPException(status_code=403, detail=f"API Token 缺少权限：{required}")


def _fernet() -> Fernet:
    raw_key = get_settings().encryption_key.encode("utf-8")
    derived = base64.urlsafe_b64encode(hashlib.sha256(raw_key).digest())
    return Fernet(derived)


def encrypt_secret(value: str | None) -> bytes | None:
    if not value:
        return None
    return _fernet().encrypt(value.encode("utf-8"))


def decrypt_secret(value: bytes | None) -> str | None:
    if value is None:
        return None
    try:
        return _fernet().decrypt(value).decode("utf-8")
    except InvalidToken as exc:
        raise RuntimeError("Stored credential cannot be decrypted with the current APP_ENCRYPTION_KEY") from exc


def mask_secret(value: str | None) -> str | None:
    if not value:
        return None
    if len(value) <= 8:
        return "••••••••"
    return f"{value[:4]}••••••••{value[-4:]}"


def hash_password(password: str, *, salt: bytes | None = None) -> str:
    actual_salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), actual_salt, 240_000)
    return f"pbkdf2_sha256$240000${base64.urlsafe_b64encode(actual_salt).decode()}${base64.urlsafe_b64encode(digest).decode()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, iterations, salt, expected = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.urlsafe_b64decode(salt), int(iterations))
        return hmac.compare_digest(base64.urlsafe_b64encode(digest).decode(), expected)
    except (ValueError, TypeError):
        return False


def issue_token() -> str:
    return f"fde_{secrets.token_urlsafe(32)}"


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def _bearer_context(
    token: str,
    workspace_id: str | None,
    session: AsyncSession,
) -> AuthContext:
    token_hash = hash_token(token)
    auth_session = await session.scalar(select(AuthSession).where(AuthSession.token_hash == token_hash))
    if auth_session:
        expires_at = auth_session.expires_at
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=UTC)
        if expires_at <= datetime.now(UTC):
            raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
        user = await session.get(User, auth_session.user_id)
        if not user or not user.is_active:
            raise HTTPException(status_code=401, detail="用户不可用")
        memberships = list(await session.scalars(select(Membership).where(Membership.user_id == user.id)))
        if not memberships:
            raise HTTPException(status_code=403, detail="用户尚未加入任何业务空间")
        selected = workspace_id or memberships[0].workspace_id
        membership = next((item for item in memberships if item.workspace_id == selected), None)
        if not membership:
            raise HTTPException(status_code=403, detail="无权访问该业务空间")
        return AuthContext(membership.role, selected, user.id, "session")  # type: ignore[arg-type]
    api_client = await session.scalar(select(ApiClient).where(ApiClient.token_hash == token_hash))
    if api_client and api_client.revoked_at is None:
        if workspace_id and workspace_id != api_client.workspace_id:
            raise HTTPException(status_code=403, detail="API Token 不属于该业务空间")
        api_client.last_used_at = datetime.now(UTC)
        await session.commit()
        return AuthContext(
            api_client.role,
            api_client.workspace_id,
            None,
            "api_client",
            frozenset(api_client.scopes),
        )  # type: ignore[arg-type]
    raise HTTPException(status_code=401, detail="无效或已过期的访问凭证")


async def get_auth_context(
    request: Request,
    authorization: Annotated[str | None, Header()] = None,
    x_demo_role: Annotated[str | None, Header()] = None,
    x_workspace_id: Annotated[str | None, Header()] = None,
    session: AsyncSession = Depends(get_session),
) -> AuthContext:
    if authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise HTTPException(status_code=401, detail="Authorization 必须使用 Bearer Token")
        context = await _bearer_context(token.strip(), x_workspace_id, session)
        _enforce_scope(context, request)
        activate_workspace(context.workspace_id)
        return context
    settings = get_settings()
    if settings.env == "production":
        raise HTTPException(status_code=401, detail="生产环境必须登录或使用 API Token")
    role = (x_demo_role or "user").lower()
    if role not in {"admin", "manager", "user"}:
        raise HTTPException(status_code=400, detail="X-Demo-Role must be admin, manager or user")
    context = AuthContext(role, x_workspace_id or DEFAULT_WORKSPACE_ID, None, "demo")  # type: ignore[arg-type]
    activate_workspace(context.workspace_id)
    return context


async def get_demo_role(context: AuthContext = Depends(get_auth_context)) -> DemoRole:
    return context.role


async def get_workspace_id(context: AuthContext = Depends(get_auth_context)) -> str:
    return context.workspace_id


def require_roles(*allowed: DemoRole) -> Callable[..., AuthContext]:
    async def dependency(context: AuthContext = Depends(get_auth_context)) -> AuthContext:
        if context.role not in allowed:
            raise HTTPException(status_code=403, detail="当前身份无权执行此操作")
        return context

    return dependency


def session_expiry(days: int = 7) -> datetime:
    return datetime.now(UTC) + timedelta(days=days)

