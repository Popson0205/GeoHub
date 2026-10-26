from uuid import uuid4

from fastapi import APIRouter, Depends, Request, Response

from .. import ratelimit
from ..audit import audit
from ..config import settings
from ..db import get_conn
from ..deps import current_user
from ..errors import Problem
from ..logging_setup import client_ip
from ..schemas import AuthOut, LoginIn, RefreshIn, RegisterIn, UserOut
from ..security import (burn_password_check, hash_password, hash_token, make_access_token, new_refresh_token,
                        verify_password)

router = APIRouter(prefix="/auth", tags=["auth"])


async def _issue(conn, user: dict, family_id=None) -> dict:
    raw, digest = new_refresh_token()
    await conn.execute(
        "INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) "
        "VALUES (%s, %s, %s, now() + make_interval(days => %s))",
        (user["id"], family_id or uuid4(), digest, settings.refresh_token_days))
    return {"access_token": make_access_token(user["id"]), "refresh_token": raw,
            "expires_in": settings.access_token_minutes * 60,
            "user": {"id": user["id"], "email": user["email"], "name": user["name"]}}


@router.post("/register", response_model=AuthOut, status_code=201,
             dependencies=[Depends(ratelimit.limit("register", lambda: settings.rate_register_per_hour, 3600))])
async def register(body: RegisterIn, request: Request, conn=Depends(get_conn)):
    cur = await conn.execute("SELECT 1 FROM users WHERE lower(email) = lower(%s)", (body.email,))
    if await cur.fetchone():
        raise Problem(409, "That email is already registered.", code="email_taken", fields={"email": ["already registered"]})
    cur = await conn.execute(
        "INSERT INTO users (email, name, password_hash) VALUES (%s, %s, %s) RETURNING id, email, name",
        (body.email.lower(), body.name, await hash_password(body.password)))
    user = await cur.fetchone()
    # Turn any pending project invitations for this email into memberships.
    cur = await conn.execute(
        "WITH inv AS (DELETE FROM invitations WHERE lower(email) = lower(%s) RETURNING project_id, role) "
        "INSERT INTO members (project_id, user_id, role) SELECT project_id, %s, role FROM inv "
        "RETURNING project_id", (body.email, user["id"]))
    for r in await cur.fetchall():
        await audit(conn, "member.join", actor_id=user["id"], project_id=r["project_id"], target_type="user",
                    target_id=user["id"], ip=client_ip(request), via="invitation")
    return await _issue(conn, user)


@router.post("/login", response_model=AuthOut,
             dependencies=[Depends(ratelimit.limit("login", lambda: settings.rate_login_per_min, 60))])
async def login(body: LoginIn, conn=Depends(get_conn)):
    await ratelimit.hit(f"login-email:{body.email.lower()}", settings.rate_login_per_min * 2, 900)
    cur = await conn.execute("SELECT id, email, name, password_hash FROM users WHERE lower(email) = lower(%s)",
                             (body.email,))
    user = await cur.fetchone()
    if not user:
        await burn_password_check(body.password)
    if not user or not await verify_password(body.password, user["password_hash"]):
        raise Problem(401, "Wrong email or password.", code="bad_credentials")
    return await _issue(conn, user)


@router.post("/refresh", response_model=AuthOut,
             dependencies=[Depends(ratelimit.limit("refresh", 60, 60))])
async def refresh(body: RefreshIn, conn=Depends(get_conn)):
    """Rotating refresh tokens. Presenting an already-used token revokes the whole session family."""
    cur = await conn.execute(
        "SELECT rt.id, rt.user_id, rt.family_id, rt.expires_at, rt.revoked_at, (rt.expires_at < now()) AS expired, "
        "u.email, u.name FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id "
        "WHERE rt.token_hash = %s FOR UPDATE OF rt", (hash_token(body.refresh_token),))
    rt = await cur.fetchone()
    if not rt:
        raise Problem(401, "Invalid refresh token.", code="invalid_token")
    if rt["revoked_at"]:
        await conn.execute("UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = %s AND revoked_at IS NULL",
                           (rt["family_id"],))
        await conn.commit()          # keep the revocation even though we now fail the request
        raise Problem(401, "This refresh token was already used. Sign in again.", code="token_reused")
    if rt["expired"]:
        raise Problem(401, "Refresh token expired. Sign in again.", code="token_expired")
    await conn.execute("UPDATE refresh_tokens SET revoked_at = now() WHERE id = %s", (rt["id"],))
    return await _issue(conn, {"id": rt["user_id"], "email": rt["email"], "name": rt["name"]}, rt["family_id"])


@router.post("/logout", status_code=204)
async def logout(body: RefreshIn, conn=Depends(get_conn)):
    await conn.execute(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE revoked_at IS NULL AND family_id IN "
        "(SELECT family_id FROM refresh_tokens WHERE token_hash = %s)", (hash_token(body.refresh_token),))
    return Response(status_code=204)


me_router = APIRouter(tags=["auth"])


@me_router.get("/me", response_model=UserOut)
async def me(user=Depends(current_user)):
    return user
