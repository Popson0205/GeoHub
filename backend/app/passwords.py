"""One-time links to set or reset a password, and temporary passwords an admin can hand over.

Only a hash of each link's token is stored. A link works once and expires: 72 hours for a new account (people may
not read their email at once), 2 hours for a forgotten password. A new link cancels the person's older ones."""
import secrets

from .errors import Problem
from .security import hash_password, hash_token

HOURS = {"set": 72, "reset": 2}
# No 0/O, 1/l/I: a temporary password is often read out loud or copied from paper.
_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def temporary_password() -> str:
    return "-".join("".join(secrets.choice(_ALPHABET) for _ in range(4)) for _ in range(3))   # e.g. Kp7d-Qm3x-Ta9e


async def unusable_hash() -> str:
    """For an account whose owner has not set a password yet: nothing anyone could type matches it."""
    return await hash_password(secrets.token_urlsafe(32))


async def issue(conn, user_id, purpose: str) -> str:
    raw = secrets.token_urlsafe(32)
    await conn.execute("UPDATE password_tokens SET used_at = now() WHERE user_id = %s AND used_at IS NULL", (user_id,))
    await conn.execute("INSERT INTO password_tokens (user_id, token_hash, purpose, expires_at) "
                       "VALUES (%s, %s, %s, now() + make_interval(hours => %s))",
                       (user_id, hash_token(raw), purpose, HOURS[purpose]))
    return raw


async def lookup(conn, raw: str, lock: bool = False) -> dict:
    """The person a link is for. Refuses a link that is unknown, used or expired, saying which."""
    cur = await conn.execute(
        "SELECT t.id, t.user_id, t.purpose, t.used_at, t.expires_at < now() AS expired, u.email, u.name, o.name AS org_name "
        "FROM password_tokens t JOIN users u ON u.id = t.user_id "
        "LEFT JOIN org_members om ON om.user_id = u.id LEFT JOIN organizations o ON o.id = om.org_id "
        "WHERE t.token_hash = %s" + (" FOR UPDATE OF t" if lock else ""), (hash_token(raw),))
    t = await cur.fetchone()
    if not t:
        raise Problem(404, "This link is not valid. Ask for a new one.", code="invalid_link")
    if t["used_at"]:
        raise Problem(410, "This link was already used, or a newer one was sent. Sign in, or ask for a new link.",
                      code="link_used")
    if t["expired"]:
        raise Problem(410, "This link has expired. Ask for a new one.", code="link_expired")
    return t
