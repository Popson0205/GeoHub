from uuid import uuid4

from fastapi import APIRouter, Depends, Request, Response

from .. import ratelimit
from .. import orgs
from ..audit import audit
from ..config import settings
from ..db import get_conn
from ..deps import USER_SQL, session_user, signed_in_user
from ..errors import Problem
from ..logging_setup import client_ip
from .. import mfa, passwords, signup, staff
from ..mailer import send_email
from ..schemas import (AuthOut, ChangePasswordIn, ForgotPasswordIn, LoginIn, MfaChallengeOut, MfaVerifyIn, PasswordTokenOut,
                       RefreshIn, JoinOrgIn, RegisterIn, SetPasswordIn, UserOut)
from ..security import (burn_password_check, hash_password, hash_token, make_access_token, new_refresh_token,
                        verify_password)

router = APIRouter(prefix="/auth", tags=["auth"])


async def _issue(conn, user: dict, family_id=None) -> dict:
    org = orgs.org_out(await orgs.require_membership(conn, user))
    cur = await conn.execute(USER_SQL + "WHERE u.id = %s", (user["id"],))
    u = await cur.fetchone()
    role = await staff.role_of(conn, user)
    await conn.execute("UPDATE users SET last_sign_in_at = now() WHERE id = %s", (user["id"],))
    raw, digest = new_refresh_token()
    await conn.execute(
        "INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) "
        "VALUES (%s, %s, %s, now() + make_interval(days => %s))",
        (user["id"], family_id or uuid4(), digest, settings.refresh_token_days))
    return {"access_token": make_access_token(user["id"]), "refresh_token": raw,
            "expires_in": settings.access_token_minutes * 60,
            "user": {"id": user["id"], "email": user["email"], "name": user["name"], "org": org,
                     "must_change_password": u["must_change_password"], "platform_admin": bool(role), "staff_role": role,
                     "mfa_enabled": u["mfa_enabled"], "mfa_setup_required": u["mfa_setup_required"]}}


async def sign_in(conn, user: dict) -> dict:
    """Tokens, or, when the person has two-step sign-in on, a challenge to answer with a code first."""
    cur = await conn.execute("SELECT totp_enabled_at IS NOT NULL AS on FROM users WHERE id = %s", (user["id"],))
    if (await cur.fetchone())["on"]:
        return {"mfa_required": True, "mfa_token": mfa.challenge_token(user["id"])}
    return await _issue(conn, user)


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
    await signup.finish(conn, user, org_name=body.organization, ip=client_ip(request))
    return await _issue(conn, user)


@router.post("/login", response_model=AuthOut | MfaChallengeOut,
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
    return await sign_in(conn, user)


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


@router.get("/password-link/{token}", response_model=PasswordTokenOut, summary="Who a set/reset password link is for")
async def password_link(token: str, conn=Depends(get_conn)):
    t = await passwords.lookup(conn, token)
    return {"email": t["email"], "name": t["name"], "purpose": t["purpose"], "org_name": t["org_name"]}


@router.post("/set-password", response_model=AuthOut | MfaChallengeOut, summary="Set a password from a one-time link, and sign in",
             dependencies=[Depends(ratelimit.limit("set-password", 20, 3600))])
async def set_password(body: SetPasswordIn, request: Request, conn=Depends(get_conn)):
    t = await passwords.lookup(conn, body.token, lock=True, purposes=("set", "reset"))
    await conn.execute("UPDATE users SET password_hash = %s, must_change_password = false WHERE id = %s",
                       (await hash_password(body.password), t["user_id"]))
    await conn.execute("UPDATE password_tokens SET used_at = now() WHERE id = %s", (t["id"],))
    # a reset ends every other session, in case someone else had the old password
    await conn.execute("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = %s AND revoked_at IS NULL", (t["user_id"],))
    await audit(conn, "user.password_set", actor_id=t["user_id"], target_type="user", target_id=t["user_id"],
                ip=client_ip(request), via=t["purpose"])
    return await sign_in(conn, {"id": t["user_id"], "email": t["email"], "name": t["name"]})


@router.post("/join-organization", response_model=AuthOut | MfaChallengeOut, summary="Confirm your email and join the organization of its domain",
             dependencies=[Depends(ratelimit.limit("join-organization", 20, 3600))])
async def join_organization(body: JoinOrgIn, request: Request, conn=Depends(get_conn)):
    t = await passwords.lookup(conn, body.token, lock=True, purposes=("join",))
    cur = await conn.execute("SELECT role FROM org_domains WHERE org_id = %s AND domain = %s AND verified_at IS NOT NULL",
                             (t["org_id"], t["email"].rsplit("@", 1)[-1].lower()))
    d = await cur.fetchone()
    if not d:
        raise Problem(410, "This organization no longer takes people by email domain. Ask its administrator to add you.",
                      code="link_expired")
    await orgs.bring_into(conn, t["user_id"], t["org_id"], d["role"])
    await conn.execute("UPDATE password_tokens SET used_at = now() WHERE id = %s", (t["id"],))
    await audit(conn, "org.join_domain", actor_id=t["user_id"], target_type="organization", target_id=t["org_id"],
                ip=client_ip(request), role=d["role"])
    return await sign_in(conn, {"id": t["user_id"], "email": t["email"], "name": t["name"]})


@router.post("/mfa/verify", response_model=AuthOut, summary="Finish signing in with a code from the authenticator app",
             dependencies=[Depends(ratelimit.limit("mfa-verify", 30, 300))])
async def mfa_verify(body: MfaVerifyIn, request: Request, conn=Depends(get_conn)):
    """`mfa_token` comes from /auth/login (or another sign-in) when two-step sign-in is on. A recovery code works
    once in place of the app's code."""
    uid = mfa.read_challenge(body.mfa_token)
    await ratelimit.hit(f"mfa-user:{uid}", 10, 900)          # guessing codes for one person is stopped quickly
    cur = await conn.execute("SELECT id, email, name FROM users WHERE id = %s AND totp_enabled_at IS NOT NULL", (uid,))
    user = await cur.fetchone()
    if not user:
        raise Problem(401, "Sign in again.", code="mfa_expired")
    try:
        how = await mfa.check(conn, uid, body.code)
    except Problem as p:
        await audit(conn, "user.mfa_failed", actor_id=uid, target_type="user", target_id=uid, ip=client_ip(request))
        await conn.commit()          # keep the record of the failed try even though the request fails
        raise p
    if how == "recovery":
        await audit(conn, "user.mfa_recovery_used", actor_id=uid, target_type="user", target_id=uid, ip=client_ip(request))
    return await _issue(conn, user)


@router.post("/forgot-password", status_code=202, summary="Email a link to choose a new password",
             dependencies=[Depends(ratelimit.limit("forgot-password", 5, 3600))])
async def forgot_password(body: ForgotPasswordIn, conn=Depends(get_conn)):
    """Always answers the same, so it never reveals whether an email has an account."""
    await ratelimit.hit(f"forgot-email:{body.email.lower()}", 3, 3600)
    cur = await conn.execute("SELECT id, name, email FROM users WHERE lower(email) = lower(%s)", (body.email,))
    u = await cur.fetchone()
    if u:
        raw = await passwords.issue(conn, u["id"], "reset")
        await send_email(u["email"], "Choose a new Geohub password",
                         f"Hello {u['name']},\n\nSomeone asked to reset the password for this Geohub account. If it was "
                         "you, choose a new password below. The link works once, within 2 hours.\n\n"
                         "If it was not you, ignore this email: your password stays as it is.",
                         action=("Choose a new password", f"{settings.app_url}/set-password?token={raw}"))
    return {"sent": True}


@router.post("/change-password", status_code=204, summary="Change your password (also after a temporary one)")
async def change_password(body: ChangePasswordIn, request: Request, user=Depends(session_user), conn=Depends(get_conn)):
    cur = await conn.execute("SELECT password_hash FROM users WHERE id = %s", (user["id"],))
    if not await verify_password(body.current_password, (await cur.fetchone())["password_hash"]):
        raise Problem(422, "The current password is not right.", code="bad_credentials", fields={"current_password": ["not right"]})
    if body.new_password == body.current_password:
        raise Problem(422, "Choose a password different from the current one.", code="validation", fields={"new_password": ["same as before"]})
    await conn.execute("UPDATE users SET password_hash = %s, must_change_password = false WHERE id = %s",
                       (await hash_password(body.new_password), user["id"]))
    await audit(conn, "user.password_change", actor_id=user["id"], target_type="user", target_id=user["id"], ip=client_ip(request))
    return Response(status_code=204)


@router.post("/logout", status_code=204)
async def logout(body: RefreshIn, conn=Depends(get_conn)):
    await conn.execute(
        "UPDATE refresh_tokens SET revoked_at = now() WHERE revoked_at IS NULL AND family_id IN "
        "(SELECT family_id FROM refresh_tokens WHERE token_hash = %s)", (hash_token(body.refresh_token),))
    return Response(status_code=204)


me_router = APIRouter(tags=["auth"])


@me_router.get("/me", response_model=UserOut)
async def me(user=Depends(signed_in_user), conn=Depends(get_conn)):
    """Answers even while two-step sign-in still has to be set up (mfa_setup_required), so the app can ask for it."""
    role = await staff.role_of(conn, user)
    return {**user, "org": orgs.org_out(await orgs.require_membership(conn, user)),   # must_change_password: from the user row
            "platform_admin": bool(role), "staff_role": role}
