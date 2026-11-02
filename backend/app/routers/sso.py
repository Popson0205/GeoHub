"""Sign in with Google or Microsoft (OpenID Connect, authorization code flow).

    browser -> /auth/sso/{provider}/start -> provider -> /auth/sso/{provider}/callback -> {APP_URL}/sso?code=…
    web app -> POST /auth/sso/exchange {code} -> tokens, like /auth/login

The ID token comes straight from the provider's token endpoint over TLS, in exchange for our client secret, so its
issuer is proven by TLS (OpenID Connect Core 3.1.3.7); we still check its audience, expiry, issuer and nonce. A
person is matched by the provider's stable id, else by a proven email, else a new account is made (joining the
organization that invited them, or that owns their email's domain). Tokens never appear in a URL: the browser gets
a one-time code that works once, for two minutes (kept in the database, hashed)."""
import hmac
import logging
import secrets
import time
from urllib.parse import urlencode

import httpx
import jwt
from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse

from .. import ratelimit, signup
from ..audit import audit
from ..config import settings
from ..db import get_conn
from ..errors import Problem
from ..logging_setup import client_ip
from ..passwords import unusable_hash
from ..security import hash_token
from ..schemas import AuthOut, SsoExchangeIn
from .auth import _issue

router = APIRouter(prefix="/auth", tags=["auth"])
log = logging.getLogger("sso")
# Tests replace this with a mock transport.
transport: httpx.AsyncBaseTransport | None = None
COOKIE = "geohub_sso"
MS_CONSUMERS = "9188040d-6c67-4c5b-b112-36a304b66dad"      # the tenant of personal Microsoft accounts
NAMES = {"google": "Google", "microsoft": "Microsoft"}


def _conf(provider: str) -> dict:
    if provider == "google" and settings.google_client_id and settings.google_client_secret:
        return {"id": settings.google_client_id, "secret": settings.google_client_secret,
                "auth": "https://accounts.google.com/o/oauth2/v2/auth", "token": "https://oauth2.googleapis.com/token"}
    if provider == "microsoft" and settings.microsoft_client_id and settings.microsoft_client_secret:
        base = f"https://login.microsoftonline.com/{settings.microsoft_tenant}/oauth2/v2.0"
        return {"id": settings.microsoft_client_id, "secret": settings.microsoft_client_secret,
                "auth": f"{base}/authorize", "token": f"{base}/token"}
    raise Problem(404, f"Sign-in with {NAMES.get(provider, provider)} is not set up on this server.", code="not_found")


def enabled() -> list[str]:
    out = []
    for p in NAMES:
        try:
            _conf(p)
            out.append(p)
        except Problem:
            pass
    return out


def _callback_url(provider: str) -> str:
    return f"{settings.app_url.rstrip('/')}{settings.api_prefix.rstrip('/')}/auth/sso/{provider}/callback"


def _safe_next(n: str | None) -> str:
    return n if n and n.startswith("/") and not n.startswith("//") and "\\" not in n else "/"


def _to_login(message: str) -> RedirectResponse:
    r = RedirectResponse(f"{settings.app_url}/login?{urlencode({'sso_error': message})}", status_code=303)
    r.delete_cookie(COOKIE, path=f"{settings.api_prefix.rstrip('/')}/auth/sso")
    return r


@router.get("/providers", summary="Which Google / Microsoft sign-in buttons to show")
async def providers():
    return {"providers": enabled()}


@router.get("/sso/{provider}/start", summary="Go to Google or Microsoft to sign in", include_in_schema=True,
            dependencies=[Depends(ratelimit.limit("sso-start", 30, 60))])
async def start(provider: str, next: str | None = None):
    c = _conf(provider)
    nonce = secrets.token_urlsafe(24)
    state = jwt.encode({"typ": "sso", "p": provider, "n": nonce, "next": _safe_next(next), "exp": int(time.time()) + 600},
                       settings.jwt_secret, algorithm="HS256")
    q = {"client_id": c["id"], "response_type": "code", "scope": "openid email profile", "redirect_uri": _callback_url(provider),
         "state": state, "nonce": nonce, "prompt": "select_account"}
    r = RedirectResponse(f"{c['auth']}?{urlencode(q)}", status_code=302)
    # ties the answer to this browser, so nobody can sign someone else in to their own account (login CSRF)
    r.set_cookie(COOKIE, nonce, max_age=600, httponly=True, samesite="lax", secure=settings.app_url.startswith("https://"),
                 path=f"{settings.api_prefix.rstrip('/')}/auth/sso")
    return r


def _check_claims(provider: str, claims: dict, client_id: str, nonce: str) -> tuple[str, str | None, bool, str]:
    """(subject, email, email proven, name) from verified ID token claims."""
    aud = claims.get("aud")
    if client_id not in ([aud] if isinstance(aud, str) else (aud or [])):
        raise Problem(400, "The sign-in answer was not meant for this app.", code="sso_failed")
    if int(claims.get("exp", 0)) < time.time() - 60:
        raise Problem(400, "The sign-in took too long. Try again.", code="sso_failed")
    if not hmac.compare_digest(str(claims.get("nonce", "")), nonce):
        raise Problem(400, "The sign-in answer could not be matched to this request. Try again.", code="sso_failed")
    email = (claims.get("email") or "").strip().lower() or None
    if provider == "google":
        if claims.get("iss") not in ("https://accounts.google.com", "accounts.google.com"):
            raise Problem(400, "Unexpected sign-in issuer.", code="sso_failed")
        verified = claims.get("email_verified") in (True, "true")
    else:
        tid = claims.get("tid", "")
        if claims.get("iss") != f"https://login.microsoftonline.com/{tid}/v2.0":
            raise Problem(400, "Unexpected sign-in issuer.", code="sso_failed")
        if settings.microsoft_tenant not in ("common", "organizations", "consumers") and tid != settings.microsoft_tenant:
            raise Problem(403, "Use your organization's Microsoft account.", code="sso_failed")
        # Work accounts' email is whatever their administrator typed, unless Microsoft says the domain is verified
        # (the xms_edov claim); personal accounts' email is proven.
        verified = bool(email) and (tid == MS_CONSUMERS or claims.get("xms_edov") in (True, "true", "1", 1))
    name = (claims.get("name") or "").strip() or (email.split("@")[0] if email else NAMES[provider] + " user")
    return str(claims["sub"]), email, verified, name[:120]


async def _resolve(conn, provider: str, subject: str, email: str | None, verified: bool, name: str, ip: str) -> dict:
    cur = await conn.execute("SELECT u.id, u.email, u.name FROM user_identities i JOIN users u ON u.id = i.user_id "
                             "WHERE i.provider = %s AND i.subject = %s", (provider, subject))
    user = await cur.fetchone()
    if user:
        await conn.execute("UPDATE user_identities SET last_used_at = now(), email = %s WHERE provider = %s AND subject = %s",
                           (email, provider, subject))
        return user
    if not email or not verified:
        raise Problem(403, f"{NAMES[provider]} did not confirm your email address, so it cannot be used to sign in here. "
                           "Sign in with your email and password instead.", code="email_unverified")
    cur = await conn.execute("SELECT id, email, name FROM users WHERE lower(email) = %s", (email,))
    user = await cur.fetchone()
    new = user is None
    if new:
        cur = await conn.execute("INSERT INTO users (email, name, password_hash) VALUES (%s, %s, %s) RETURNING id, email, name",
                                 (email, name, await unusable_hash()))
        user = await cur.fetchone()
        await signup.finish(conn, user, email_verified=True, ip=ip)
    await conn.execute("INSERT INTO user_identities (provider, subject, user_id, email, last_used_at) VALUES (%s, %s, %s, %s, now())",
                       (provider, subject, user["id"], email))
    await audit(conn, "user.sso_link", actor_id=user["id"], target_type="user", target_id=user["id"], ip=ip,
                provider=provider, new_account=new)
    return user


@router.get("/sso/{provider}/callback", include_in_schema=False)
async def callback(provider: str, request: Request, code: str | None = None, state: str | None = None,
                   error: str | None = None, conn=Depends(get_conn)):
    if error:
        return _to_login("Sign-in was cancelled." if error == "access_denied" else f"{NAMES.get(provider, provider)} sign-in failed ({error}).")
    try:
        c = _conf(provider)
        try:
            st = jwt.decode(state or "", settings.jwt_secret, algorithms=["HS256"])
        except jwt.PyJWTError:
            raise Problem(400, "The sign-in link expired. Try again.", code="sso_failed")
        cookie = request.cookies.get(COOKIE, "")
        if st.get("typ") != "sso" or st.get("p") != provider or not cookie or not hmac.compare_digest(cookie, st.get("n", "")):
            raise Problem(400, "Start the sign-in again from this browser.", code="sso_failed")
        if not code:
            raise Problem(400, "The sign-in answer had no code.", code="sso_failed")
        try:
            async with httpx.AsyncClient(timeout=15, transport=transport) as h:
                r = await h.post(c["token"], data={"code": code, "client_id": c["id"], "client_secret": c["secret"],
                                                   "redirect_uri": _callback_url(provider), "grant_type": "authorization_code"},
                                 headers={"accept": "application/json"})
        except httpx.HTTPError:
            raise Problem(502, f"Could not reach {NAMES[provider]}. Try again.", code="sso_failed")
        if r.status_code >= 400 or "id_token" not in r.json():
            raise Problem(400, f"{NAMES[provider]} did not accept the sign-in. Try again.", code="sso_failed")
        claims = jwt.decode(r.json()["id_token"], options={"verify_signature": False})
        subject, email, verified, name = _check_claims(provider, claims, c["id"], st["n"])
        async with conn.transaction():              # all or nothing: no half-made account if joining fails
            user = await _resolve(conn, provider, subject, email, verified, name, client_ip(request))
    except Problem as p:
        return _to_login(p.detail)
    except Exception:  # noqa: BLE001 - never leave someone on a raw error page in the middle of signing in
        log.exception("sso callback failed (%s)", provider)
        return _to_login(f"{NAMES.get(provider, provider)} sign-in did not finish because of a problem on our side. "
                         "Try again, or sign in with your email and password.")
    one_time = secrets.token_urlsafe(32)
    await conn.execute("DELETE FROM sso_codes WHERE expires_at < now()")
    await conn.execute("INSERT INTO sso_codes (code_hash, user_id, expires_at) VALUES (%s, %s, now() + interval '2 minutes')",
                       (hash_token(one_time), user["id"]))
    await conn.commit()                 # the browser trades the code straight away: it must be there already
    r = RedirectResponse(f"{settings.app_url}/sso?{urlencode({'code': one_time, 'next': st['next']})}", status_code=303)
    r.delete_cookie(COOKIE, path=f"{settings.api_prefix.rstrip('/')}/auth/sso")
    return r


@router.post("/sso/exchange", response_model=AuthOut, summary="Trade the one-time code from a Google / Microsoft sign-in for tokens",
             dependencies=[Depends(ratelimit.limit("sso-exchange", 30, 60))])
async def exchange(body: SsoExchangeIn, conn=Depends(get_conn)):
    cur = await conn.execute("DELETE FROM sso_codes WHERE code_hash = %s RETURNING user_id, expires_at > now() AS fresh",
                             (hash_token(body.code),))
    row = await cur.fetchone()
    if not row or not row["fresh"]:
        raise Problem(401, "This sign-in has expired. Sign in again.", code="invalid_token")
    cur = await conn.execute("SELECT id, email, name FROM users WHERE id = %s", (row["user_id"],))
    user = await cur.fetchone()
    if not user:
        raise Problem(401, "This account no longer exists.", code="invalid_token")
    return await _issue(conn, user)
