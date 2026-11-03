from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import apikeys, ratelimit
from .config import settings
from .db import get_conn
from .errors import Problem
from .security import decode_token

bearer = HTTPBearer(auto_error=False, description="Short-lived access token from /auth/login")
RANK = {"viewer": 1, "collector": 2, "admin": 3, "owner": 4}


USER_SQL = (
    "SELECT u.id, u.email, u.name, u.created_at, u.must_change_password, (u.totp_enabled_at IS NOT NULL) AS mfa_enabled, "
    "  (COALESCE(o.require_mfa, false) AND u.totp_enabled_at IS NULL) AS mfa_setup_required "
    "FROM users u LEFT JOIN org_members om ON om.user_id = u.id LEFT JOIN organizations o ON o.id = om.org_id ")
READ_METHODS = {"GET", "HEAD", "OPTIONS"}


async def _user_from_token(conn, token: str, request: Request) -> dict:
    if token.startswith(apikeys.PREFIX):
        user = await apikeys.user_for(conn, token)
        if request.method not in READ_METHODS and user["api_key_access"] != "write":
            raise Problem(403, "This API key can only read. Make a key with write access to change things.", code="read_only_key")
        request.state.api_key_id = str(user["api_key_id"])
    else:
        sub = decode_token(token, "access")["sub"]
        cur = await conn.execute(USER_SQL + "WHERE u.id = %s", (sub,))
        user = await cur.fetchone()
        if not user:
            raise Problem(401, "Unknown user.", code="invalid_token")
    request.state.user_id = str(user["id"])
    await ratelimit.hit(f"user:{user['id']}", settings.rate_user_per_min, 60)
    return user


def gate(user: dict) -> dict:
    if user["mfa_setup_required"]:
        raise Problem(403, "Your organization requires two-step sign-in. Set it up to continue.", code="mfa_setup_required")
    return user


async def signed_in_user(request: Request, creds: HTTPAuthorizationCredentials | None = Depends(bearer),
                         conn=Depends(get_conn)) -> dict:
    """The person, even while they still have to set up two-step sign-in: only for /me and setting it up."""
    if not creds:
        raise Problem(401, "Sign in to continue.", code="unauthenticated", headers={"WWW-Authenticate": "Bearer"})
    return await _user_from_token(conn, creds.credentials, request)


async def current_user(user=Depends(signed_in_user)) -> dict:
    return gate(user)


async def session_user(request: Request, user=Depends(signed_in_user)) -> dict:
    """A person signed in themselves, not an API key: for passwords, two-step sign-in and making keys."""
    if getattr(request.state, "api_key_id", None):
        raise Problem(403, "API keys cannot do this. Sign in to Geohub instead.", code="api_key_not_allowed")
    return user


async def optional_user(request: Request, creds: HTTPAuthorizationCredentials | None = Depends(bearer),
                        conn=Depends(get_conn)) -> dict | None:
    return gate(await _user_from_token(conn, creds.credentials, request)) if creds else None


# An organization's owner is an owner of every project in it, and its admins are admins of every one, so work
# never gets stranded when the person who made a project leaves. Teams given a project add their role too.
ORG_PROJECT_ROLE = {"owner": "owner", "admin": "admin"}


async def role_in(conn, project_id, user_id) -> str | None:
    cur = await conn.execute(
        "SELECT m.role, om.role AS org_role, t.role AS team_role FROM projects p "
        "LEFT JOIN members m ON m.project_id = p.id AND m.user_id = %s "
        "LEFT JOIN org_members om ON om.user_id = %s AND om.org_id = p.org_id "
        "LEFT JOIN team_project_roles t ON t.project_id = p.id AND t.user_id = %s "
        "WHERE p.id = %s", (user_id, user_id, user_id, project_id))
    row = await cur.fetchone()
    if not row:
        return None
    # direct membership, the organization role, and the role through their teams: the highest counts
    roles = [r for r in (row["role"], ORG_PROJECT_ROLE.get(row["org_role"] or ""), row["team_role"]) if r]
    return max(roles, key=RANK.__getitem__) if roles else None


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


def platform_admin_emails() -> set[str]:
    return {e.strip().lower() for e in settings.platform_admins.split(",") if e.strip()}


# Staff roles and what they may do: app/staff.py.
