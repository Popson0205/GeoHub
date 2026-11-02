"""Your two-step sign-in, the organization's rule that everyone uses it, and API keys."""
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response

from .. import apikeys, mfa, orgs, ratelimit
from ..audit import audit
from ..db import get_conn
from ..deps import gate, session_user
from ..errors import Problem
from ..logging_setup import client_ip
from ..schemas import (ApiKeyCreated, ApiKeyIn, ApiKeyOut, MfaCodeIn, MfaSetupOut, MfaStatusOut, OrgOut, OrgSecurityPatch,
                       RecoveryCodesOut)
from .org import _mail, _out, _target

router = APIRouter(tags=["security"])


# ---------- your two-step sign-in ----------
async def _status(conn, user_id) -> dict:
    cur = await conn.execute(
        "SELECT u.totp_enabled_at, COALESCE(o.require_mfa, false) AS required, "
        "  (SELECT count(*) FROM mfa_recovery_codes r WHERE r.user_id = u.id AND r.used_at IS NULL) AS left "
        "FROM users u LEFT JOIN org_members om ON om.user_id = u.id LEFT JOIN organizations o ON o.id = om.org_id "
        "WHERE u.id = %s", (user_id,))
    r = await cur.fetchone()
    return {"enabled": r["totp_enabled_at"] is not None, "enabled_at": r["totp_enabled_at"],
            "recovery_codes_left": r["left"] if r["totp_enabled_at"] else 0, "required_by_org": r["required"]}


@router.get("/auth/mfa", response_model=MfaStatusOut, summary="Whether your two-step sign-in is on")
async def mfa_status(user=Depends(session_user), conn=Depends(get_conn)):
    return await _status(conn, user["id"])


@router.post("/auth/mfa/setup", response_model=MfaSetupOut, summary="Start setting up two-step sign-in")
async def mfa_setup(user=Depends(session_user), conn=Depends(get_conn)):
    """A new secret for the authenticator app (as a QR code's contents and as text). Nothing changes until a code
    from the app is confirmed with /auth/mfa/enable."""
    if user["mfa_enabled"]:
        raise Problem(409, "Two-step sign-in is already on. Turn it off first to move it to another phone.", code="mfa_already_on")
    secret = mfa.new_secret()
    await conn.execute("UPDATE users SET totp_secret = %s, totp_last_step = NULL WHERE id = %s", (mfa.seal(secret), user["id"]))
    return {"secret": secret, "otpauth_url": mfa.otpauth_url(secret, user["email"])}


@router.post("/auth/mfa/enable", response_model=RecoveryCodesOut, summary="Confirm a code from the app and turn two-step sign-in on",
             dependencies=[Depends(ratelimit.limit("mfa-enable", 20, 900))])
async def mfa_enable(body: MfaCodeIn, request: Request, user=Depends(session_user), conn=Depends(get_conn)):
    if user["mfa_enabled"]:
        raise Problem(409, "Two-step sign-in is already on.", code="mfa_already_on")
    cur = await conn.execute("SELECT totp_secret FROM users WHERE id = %s", (user["id"],))
    stored = (await cur.fetchone())["totp_secret"]
    if not stored:
        raise Problem(409, "Start the setup first.", code="mfa_not_set_up")
    step = mfa.matching_step(mfa.unseal(stored), body.code)
    if step is None:
        raise Problem(422, "That code is not right. Check the phone's time is set automatically, and enter the code "
                           "the app shows now.", code="bad_code", fields={"code": ["not right"]})
    await conn.execute("UPDATE users SET totp_enabled_at = now(), totp_last_step = %s WHERE id = %s", (step, user["id"]))
    codes = mfa.new_recovery_codes()
    await mfa.store_recovery_codes(conn, user["id"], codes)
    await audit(conn, "user.mfa_enable", actor_id=user["id"], target_type="user", target_id=user["id"], ip=client_ip(request))
    return {"recovery_codes": codes}


@router.post("/auth/mfa/recovery-codes", response_model=RecoveryCodesOut, summary="Make new recovery codes (the old ones stop working)",
             dependencies=[Depends(ratelimit.limit("mfa-codes", 10, 900))])
async def new_recovery_codes(body: MfaCodeIn, request: Request, user=Depends(session_user), conn=Depends(get_conn)):
    if not user["mfa_enabled"]:
        raise Problem(409, "Two-step sign-in is not on.", code="mfa_not_set_up")
    await mfa.check(conn, user["id"], body.code)
    codes = mfa.new_recovery_codes()
    await mfa.store_recovery_codes(conn, user["id"], codes)
    await audit(conn, "user.mfa_recovery_codes", actor_id=user["id"], target_type="user", target_id=user["id"], ip=client_ip(request))
    return {"recovery_codes": codes}


@router.post("/auth/mfa/disable", status_code=204, summary="Turn your two-step sign-in off",
             dependencies=[Depends(ratelimit.limit("mfa-disable", 10, 900))])
async def mfa_disable(body: MfaCodeIn, request: Request, user=Depends(session_user), conn=Depends(get_conn)):
    """Needs a code from the app (or a recovery code), so someone at an unlocked computer cannot do it."""
    if not user["mfa_enabled"]:
        raise Problem(409, "Two-step sign-in is not on.", code="mfa_not_set_up")
    if (await _status(conn, user["id"]))["required_by_org"]:
        raise Problem(409, "Your organization requires two-step sign-in, so it cannot be turned off. To move it to a "
                           "new phone, ask an administrator to reset it.", code="mfa_required")
    await mfa.check(conn, user["id"], body.code)
    await _turn_off(conn, user["id"])
    await audit(conn, "user.mfa_disable", actor_id=user["id"], target_type="user", target_id=user["id"], ip=client_ip(request))
    return Response(status_code=204)


async def _turn_off(conn, user_id) -> None:
    await conn.execute("UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = %s", (user_id,))
    await conn.execute("DELETE FROM mfa_recovery_codes WHERE user_id = %s", (user_id,))


# ---------- the organization's rule ----------
@router.patch("/org/security", response_model=OrgOut, summary="Require two-step sign-in for everyone (admins)")
async def org_security(body: OrgSecurityPatch, request: Request, user=Depends(session_user), conn=Depends(get_conn)):
    """Once required, anyone without it is asked to set it up the next time they use Geohub, and can do nothing else
    until they have. API keys of people who have not set it up stop working until they do."""
    gate(user)
    m = await orgs.require_org_role(conn, user, "admin")
    if m["plan"] == "individual":
        raise Problem(403, "Requiring two-step sign-in comes with Organization plans. Turn it on for yourself under "
                           "Account security.", code="plan_feature")
    if body.require_mfa and not user["mfa_enabled"]:
        raise Problem(409, "Turn on two-step sign-in for yourself first, so you are not locked out.", code="mfa_not_set_up")
    await conn.execute("UPDATE organizations SET require_mfa = %s WHERE id = %s", (body.require_mfa, m["org_id"]))
    await audit(conn, "org.require_mfa", actor_id=user["id"], target_type="organization", target_id=m["org_id"],
                ip=client_ip(request), required=body.require_mfa)
    return await _out(conn, await orgs.membership(conn, user["id"]))


@router.delete("/org/members/{user_id}/mfa", status_code=204, summary="Turn off someone's two-step sign-in, for a lost phone (admins)")
async def reset_member_mfa(user_id: UUID, request: Request, user=Depends(session_user), conn=Depends(get_conn)):
    """They sign in with their password alone next time; if the organization requires it, they set it up again then."""
    gate(user)
    m = await orgs.require_org_role(conn, user, "admin")
    if user_id == user["id"]:
        raise Problem(409, "Turn off your own under Account security, or ask another administrator.", code="use_own")
    t = await _target(conn, m["org_id"], user_id)
    if t["role"] in ("owner", "admin") and m["role"] != "owner":
        raise Problem(403, "Only an owner can reset an owner's or administrator's two-step sign-in.", code="forbidden")
    cur = await conn.execute("SELECT email FROM users WHERE id = %s AND totp_secret IS NOT NULL", (user_id,))
    row = await cur.fetchone()
    if not row:
        raise Problem(409, "They do not have two-step sign-in on.", code="mfa_not_set_up")
    await _turn_off(conn, user_id)
    await audit(conn, "org.mfa_reset", actor_id=user["id"], target_type="user", target_id=user_id, ip=client_ip(request),
                org_id=str(m["org_id"]))
    await _mail(conn, m, row["email"], "Your two-step sign-in was turned off",
                f"Hello {t['name'].split()[0]},\n\n{user['name']} turned off two-step sign-in for your Geohub account, "
                "for example because of a lost phone. Next time you sign in, use your password alone"
                + (", then set up two-step sign-in again." if m.get("require_mfa") else ". You can turn it on again under Account security.")
                + "\n\nIf you did not ask for this, tell your administrator.")
    return Response(status_code=204)


# ---------- API keys ----------
KEY_SQL = ("SELECT k.id, k.name, k.prefix, k.access, k.created_at, k.expires_at, k.last_used_at, k.revoked_at, "
           "k.user_id, u.name AS user_name, u.email AS user_email FROM api_keys k JOIN users u ON u.id = k.user_id ")


async def _keys_org(conn, user) -> dict:
    gate(user)
    m = await orgs.require_membership(conn, user)
    if m["plan"] == "individual":
        raise Problem(403, "API keys come with Organization plans. Ask GeoEstate for one.", code="plan_feature")
    return m


@router.get("/org/api-keys", response_model=list[ApiKeyOut], summary="API keys: yours, or everyone's for administrators")
async def list_keys(all: bool = False, user=Depends(session_user), conn=Depends(get_conn)):
    m = await _keys_org(conn, user)
    admin = orgs.ORG_RANK[m["role"]] >= orgs.ORG_RANK["admin"]
    if all and not admin:
        raise Problem(403, "Only administrators see everyone's keys.", code="forbidden")
    cur = await conn.execute(KEY_SQL + "WHERE k.org_id = %s AND (%s OR k.user_id = %s) "
                             "ORDER BY (k.revoked_at IS NULL) DESC, k.created_at DESC", (m["org_id"], all, user["id"]))
    return await cur.fetchall()


@router.post("/org/api-keys", response_model=ApiKeyCreated, status_code=201, summary="Make an API key (shown once)",
             dependencies=[Depends(ratelimit.limit("api-key-create", 20, 3600))])
async def create_key(body: ApiKeyIn, request: Request, user=Depends(session_user), conn=Depends(get_conn)):
    """The key acts as you, with your permissions. Read keys can only look; write keys can also change things."""
    m = await _keys_org(conn, user)
    if body.access == "write" and m["role"] == "viewer":
        raise Problem(403, "Viewers can only make read keys.", code="forbidden")
    cur = await conn.execute("SELECT count(*) AS n FROM api_keys WHERE user_id = %s AND revoked_at IS NULL "
                             "AND (expires_at IS NULL OR expires_at > now())", (user["id"],))
    if (await cur.fetchone())["n"] >= apikeys.MAX_PER_PERSON:
        raise Problem(409, f"You have {apikeys.MAX_PER_PERSON} keys. Revoke one you no longer use first.", code="too_many_keys")
    raw, prefix, digest = apikeys.new_key()
    expires = datetime.now(timezone.utc) + timedelta(days=body.expires_in_days) if body.expires_in_days else None
    cur = await conn.execute("INSERT INTO api_keys (org_id, user_id, name, prefix, key_hash, access, expires_at) "
                             "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
                             (m["org_id"], user["id"], body.name.strip(), prefix, digest, body.access, expires))
    kid = (await cur.fetchone())["id"]
    await audit(conn, "org.api_key_create", actor_id=user["id"], target_type="api_key", target_id=kid, ip=client_ip(request),
                org_id=str(m["org_id"]), access=body.access, name=body.name.strip())
    cur = await conn.execute(KEY_SQL + "WHERE k.id = %s", (kid,))
    return {**await cur.fetchone(), "key": raw}


@router.delete("/org/api-keys/{key_id}", status_code=204, summary="Revoke an API key (yours, or any for administrators)")
async def revoke_key(key_id: UUID, request: Request, user=Depends(session_user), conn=Depends(get_conn)):
    m = await _keys_org(conn, user)
    cur = await conn.execute("SELECT user_id, revoked_at FROM api_keys WHERE id = %s AND org_id = %s", (key_id, m["org_id"]))
    k = await cur.fetchone()
    if not k:
        raise Problem(404, "Key not found.", code="not_found")
    if k["user_id"] != user["id"] and orgs.ORG_RANK[m["role"]] < orgs.ORG_RANK["admin"]:
        raise Problem(403, "Only administrators can revoke other people's keys.", code="forbidden")
    if not k["revoked_at"]:
        await conn.execute("UPDATE api_keys SET revoked_at = now() WHERE id = %s", (key_id,))
        await audit(conn, "org.api_key_revoke", actor_id=user["id"], target_type="api_key", target_id=key_id,
                    ip=client_ip(request), org_id=str(m["org_id"]))
    return Response(status_code=204)
