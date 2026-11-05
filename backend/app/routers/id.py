"""GeoEstate ID endpoints: Geohub signs people in to the other GeoEstate apps (see app/geoestate_id.py).

  GET  /id/configuration           where everything is (issuer, endpoints, the public key)
  GET  /id/jwks                    the public key apps check access tokens with
  GET  /id/clients/{id}            the app's name, for the sign-in page; checks its return address
  POST /id/authorize               signed in to Geohub: a one-time code for the app (the page at /id/authorize calls it)
  POST /id/token                   the app swaps a code, or a refresh token, for tokens
  GET  /id/userinfo                who the access token's person is, as of now
  POST /id/revoke                  sign out of the app: its refresh token stops working"""
import secrets
from urllib.parse import urlencode, urlsplit

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from .. import geoestate_id as gid
from .. import ratelimit
from ..audit import audit
from ..config import settings
from ..db import get_conn
from ..deps import gate, session_user
from ..errors import Problem
from ..logging_setup import client_ip
from ..security import hash_token

router = APIRouter(prefix="/id", tags=["GeoEstate ID"])


class AuthorizeIn(BaseModel):
    client_id: str = Field(max_length=64)
    redirect_uri: str = Field(max_length=2000)
    state: str | None = Field(None, max_length=500, description="Sent back to the app unchanged")
    code_challenge: str | None = Field(None, min_length=43, max_length=128, description="PKCE: base64url(SHA-256(verifier))")
    code_challenge_method: str = Field("S256", pattern="^S256$")


@router.get("/configuration", summary="Where GeoEstate ID's endpoints and key are")
async def configuration():
    api = f"{settings.public_base_url}{settings.api_prefix}/id"
    return {"issuer": gid.issuer(), "authorization_endpoint": f"{settings.app_url}/id/authorize",
            "token_endpoint": f"{api}/token", "userinfo_endpoint": f"{api}/userinfo", "revocation_endpoint": f"{api}/revoke",
            "jwks_uri": f"{api}/jwks", "response_types_supported": ["code"], "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"], "id_token_signing_alg_values_supported": ["EdDSA"]}


@router.get("/jwks", summary="The public key that signs GeoEstate ID tokens")
async def jwks():
    return gid.jwks()


@router.get("/clients/{client_id}", summary="An app Geohub signs people in to")
async def get_client(client_id: str, redirect_uri: str | None = None):
    c = gid.client(client_id, redirect_uri)
    return {"id": c["id"], "name": c["name"], "product": c["product"]}


@router.post("/authorize", summary="Signed in to Geohub: a one-time code for the app",
             dependencies=[Depends(ratelimit.limit("id-authorize", 60, 60))])
async def authorize(body: AuthorizeIn, request: Request, user=Depends(session_user), conn=Depends(get_conn)):
    gate(user)                                                    # two-step sign-in first, if the organization requires it
    c = gid.client(body.client_id, body.redirect_uri)
    if not c["secret_hash"] and not body.code_challenge:
        raise Problem(400, f"{c['name']} has no secret, so it must use PKCE (code_challenge).", code="pkce_required")
    await gid.claims_for(conn, user["id"], c)                     # refuses here when they may not use the app
    raw = secrets.token_urlsafe(32)
    await conn.execute("INSERT INTO id_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, expires_at) "
                       "VALUES (%s, %s, %s, %s, %s, now() + interval '2 minutes')",
                       (hash_token(raw), c["id"], user["id"], body.redirect_uri, body.code_challenge))
    await audit(conn, "id.authorize", actor_id=user["id"], ip=client_ip(request), client=c["id"])
    sep = "&" if urlsplit(body.redirect_uri).query else "?"
    q = {"code": raw, **({"state": body.state} if body.state is not None else {})}
    return {"redirect_to": f"{body.redirect_uri}{sep}{urlencode(q)}", "app": c["name"]}


async def _form(request: Request) -> dict:
    """OAuth sends forms; JSON is accepted too. A client may also authenticate with HTTP Basic."""
    if request.headers.get("content-type", "").startswith("application/json"):
        data = await request.json()
    else:
        data = dict(await request.form())
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("basic "):
        import base64
        try:
            cid, _, secret = base64.b64decode(auth[6:]).decode().partition(":")
            data.setdefault("client_id", cid)
            data.setdefault("client_secret", secret)
        except ValueError:
            pass
    return {k: (str(v) if v is not None else None) for k, v in data.items()}


def _grant_error(detail: str, code: str = "invalid_grant") -> Problem:
    return Problem(400, detail, code=code, error=code)


async def _refuse(conn, detail: str) -> Problem:
    """Keep what was written (a burned code, ended sessions) even though the request is refused."""
    await conn.commit()
    return _grant_error(detail)


@router.post("/token", summary="Swap a code or a refresh token for tokens",
             dependencies=[Depends(ratelimit.limit("id-token", 120, 60))])
async def token(request: Request, conn=Depends(get_conn)):
    f = await _form(request)
    c = gid.client(f.get("client_id"))
    gid.check_secret(c, f.get("client_secret"))
    grant = f.get("grant_type")
    if grant == "authorization_code":
        cur = await conn.execute("SELECT * FROM id_codes WHERE code_hash = %s FOR UPDATE", (hash_token(f.get("code") or ""),))
        code = await cur.fetchone()
        if not code or code["client_id"] != c["id"]:
            raise _grant_error("That code is not valid.")
        if code["used_at"]:
            # a code used twice may have been stolen: end every session it started
            await conn.execute("UPDATE id_refresh_tokens SET revoked_at = now() WHERE user_id = %s AND client_id = %s AND revoked_at IS NULL "
                               "AND created_at >= %s", (code["user_id"], c["id"], code["created_at"]))
            raise await _refuse(conn, "That code was already used.")
        await conn.execute("UPDATE id_codes SET used_at = now() WHERE code_hash = %s", (code["code_hash"],))
        cur = await conn.execute("SELECT now() > %s AS expired", (code["expires_at"],))
        if (await cur.fetchone())["expired"]:
            raise await _refuse(conn, "That code has expired. Sign in again.")
        if f.get("redirect_uri") != code["redirect_uri"]:
            raise await _refuse(conn, "redirect_uri must be the one the code was asked for.")
        if not gid.pkce_ok(code["code_challenge"], f.get("code_verifier")):
            raise await _refuse(conn, "The PKCE code_verifier does not match.")
        return await gid.issue(conn, code["user_id"], c)
    if grant == "refresh_token":
        cur = await conn.execute("SELECT * FROM id_refresh_tokens WHERE token_hash = %s FOR UPDATE", (hash_token(f.get("refresh_token") or ""),))
        rt = await cur.fetchone()
        if not rt or rt["client_id"] != c["id"]:
            raise _grant_error("That refresh token is not valid. Sign in again.")
        if rt["revoked_at"]:
            # an old refresh token used again: someone may have copied it, so end the session it belongs to
            await conn.execute("UPDATE id_refresh_tokens SET revoked_at = now() WHERE user_id = %s AND client_id = %s AND revoked_at IS NULL",
                               (rt["user_id"], c["id"]))
            raise await _refuse(conn, "That refresh token was already used. Sign in again.")
        cur = await conn.execute("SELECT now() > %s AS expired", (rt["expires_at"],))
        if (await cur.fetchone())["expired"]:
            raise _grant_error("The sign-in has expired. Sign in again.")
        await conn.execute("UPDATE id_refresh_tokens SET revoked_at = now() WHERE id = %s", (rt["id"],))
        return await gid.issue(conn, rt["user_id"], c)
    raise _grant_error("grant_type must be authorization_code or refresh_token.", "unsupported_grant_type")


@router.get("/userinfo", summary="Who the access token's person is, as of now")
async def userinfo(request: Request, conn=Depends(get_conn)):
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise Problem(401, "Send the access token as a Bearer token.", code="unauthenticated", headers={"WWW-Authenticate": "Bearer"})
    claims = gid.verify(auth[7:].strip())
    return await gid.claims_for(conn, claims["sub"], gid.client(claims["aud"]))


@router.post("/revoke", status_code=200, summary="Sign out of an app: its refresh token stops working")
async def revoke(request: Request, conn=Depends(get_conn)):
    f = await _form(request)
    c = gid.client(f.get("client_id"))
    gid.check_secret(c, f.get("client_secret"))
    await conn.execute("UPDATE id_refresh_tokens SET revoked_at = now() WHERE token_hash = %s AND client_id = %s AND revoked_at IS NULL",
                       (hash_token(f.get("token") or ""), c["id"]))
    return {"revoked": True}                                       # the same answer whether or not it existed (RFC 7009)
