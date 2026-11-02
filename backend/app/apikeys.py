"""API keys: for scripts and other systems to use the Geohub API without a person signing in.

A key acts as the person who made it, with their permissions in their organization, read-only or read-and-write.
It is sent like a sign-in token (Authorization: Bearer ghk_…). Only a hash is stored, so a lost key cannot be shown
again: make a new one. A key stops working when it is revoked or expires, and when its person leaves or is removed
from the organization."""
import secrets

from .errors import Problem
from .security import hash_token

PREFIX = "ghk_"
MAX_PER_PERSON = 20


def new_key() -> tuple[str, str, str]:
    """(key, what is shown to tell it apart, hash)."""
    raw = PREFIX + secrets.token_urlsafe(32)
    return raw, raw[:12], hash_token(raw)


async def user_for(conn, raw: str) -> dict:
    cur = await conn.execute(
        "SELECT k.id AS api_key_id, k.access AS api_key_access, k.revoked_at, (k.expires_at < now()) AS expired, "
        "  (k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute') AS stale, "
        "  u.id, u.email, u.name, u.created_at, u.must_change_password, (u.totp_enabled_at IS NOT NULL) AS mfa_enabled, "
        "  (o.require_mfa AND u.totp_enabled_at IS NULL) AS mfa_setup_required, (om.user_id IS NOT NULL) AS in_org "
        "FROM api_keys k JOIN users u ON u.id = k.user_id JOIN organizations o ON o.id = k.org_id "
        "LEFT JOIN org_members om ON om.user_id = k.user_id AND om.org_id = k.org_id "
        "WHERE k.key_hash = %s", (hash_token(raw),))
    row = await cur.fetchone()
    if not row or row["revoked_at"] or not row["in_org"]:
        raise Problem(401, "This API key is not valid. It may have been revoked.", code="invalid_api_key")
    if row["expired"]:
        raise Problem(401, "This API key has expired. Make a new one.", code="invalid_api_key")
    if row["stale"]:                     # noted at most once a minute, so busy scripts do not write on every call
        await conn.execute("UPDATE api_keys SET last_used_at = now() WHERE id = %s", (row["api_key_id"],))
    return row
