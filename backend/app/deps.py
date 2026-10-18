from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import ratelimit
from .config import settings
from .db import get_conn
from .errors import Problem
from .security import decode_token

bearer = HTTPBearer(auto_error=False, description="Short-lived access token from /auth/login")
RANK = {"viewer": 1, "collector": 2, "admin": 3, "owner": 4}


async def _user_from_token(conn, token: str, request: Request) -> dict:
    sub = decode_token(token, "access")["sub"]
    cur = await conn.execute("SELECT id, email, name, created_at FROM users WHERE id = %s", (sub,))
    user = await cur.fetchone()
    if not user:
        raise Problem(401, "Unknown user.", code="invalid_token")
    request.state.user_id = str(user["id"])
    await ratelimit.hit(f"user:{user['id']}", settings.rate_user_per_min, 60)
    return user


async def current_user(request: Request, creds: HTTPAuthorizationCredentials | None = Depends(bearer),
                       conn=Depends(get_conn)) -> dict:
    if not creds:
        raise Problem(401, "Sign in to continue.", code="unauthenticated", headers={"WWW-Authenticate": "Bearer"})
    return await _user_from_token(conn, creds.credentials, request)


async def optional_user(request: Request, creds: HTTPAuthorizationCredentials | None = Depends(bearer),
                        conn=Depends(get_conn)) -> dict | None:
    return await _user_from_token(conn, creds.credentials, request) if creds else None


async def role_in(conn, project_id, user_id) -> str | None:
    cur = await conn.execute("SELECT role FROM members WHERE project_id = %s AND user_id = %s", (project_id, user_id))
    row = await cur.fetchone()
    return row["role"] if row else None


async def require_role(conn, project_id, user_id, minimum: str = "viewer") -> str:
    """Non-members get 404 (the project's existence is not revealed); members below `minimum` get 403."""
    role = await role_in(conn, project_id, user_id)
    if not role:
        raise Problem(404, "Project not found.", code="not_found")
    if RANK[role] < RANK[minimum]:
        raise Problem(403, f"This action needs the {minimum} role or higher.", code="forbidden")
    return role


MAP_RANK = {"contributor": 1, "reviewer": 2, "owner": 3}


async def require_map(conn, map_id, user_id, minimum: str = "contributor") -> dict:
    """The map plus the caller's `role` on it (owner, reviewer or contributor). People with no role get 404 (the map's
    existence is not revealed); members below `minimum` get 403."""
    cur = await conn.execute(
        "SELECT m.*, CASE WHEN m.owner_id = %s THEN 'owner' ELSE mm.role END AS role FROM workspace_maps m "
        "LEFT JOIN map_members mm ON mm.map_id = m.id AND mm.user_id = %s WHERE m.id = %s", (user_id, user_id, map_id))
    row = await cur.fetchone()
    if not row or not row["role"]:
        raise Problem(404, "Map not found.", code="not_found")
    if MAP_RANK[row["role"]] < MAP_RANK[minimum]:
        raise Problem(403, f"This action needs the {minimum} role on the map.", code="forbidden")
    return row
