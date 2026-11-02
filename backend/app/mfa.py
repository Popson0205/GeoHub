"""Two-step sign-in with an authenticator app (time-based one-time codes, RFC 6238), plus recovery codes.

After the password (or Google / Microsoft), someone with two-step sign-in on is asked for the 6-digit code their app
shows. Each code works once. Ten recovery codes, each usable once, get them in when the phone is lost; an
administrator can also turn it off for them. The app's secret is stored encrypted with a key made from JWT_SECRET,
so changing JWT_SECRET means everyone sets up two-step sign-in again."""
import base64
import hashlib
import hmac
import os
import secrets
import struct
import time
from urllib.parse import quote

import jwt
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .config import settings
from .errors import Problem
from .security import hash_token

STEP = 30
DIGITS = 6
CHALLENGE_MINUTES = 5
RECOVERY_COUNT = 10
clock = time                     # tests replace this to step through codes
_RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"


# ---------- codes ----------
def new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _code_at(secret: str, step: int) -> str:
    key = base64.b32decode(secret + "=" * (-len(secret) % 8))
    h = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    o = h[-1] & 0x0F
    return str((struct.unpack(">I", h[o:o + 4])[0] & 0x7FFFFFFF) % 10 ** DIGITS).zfill(DIGITS)


def code_now(secret: str, at: float | None = None) -> str:
    return _code_at(secret, int((clock.time() if at is None else at) // STEP))


def matching_step(secret: str, code: str, at: float | None = None) -> int | None:
    """The time step the code belongs to (now, or one step either side for a slow phone clock), or None."""
    code = "".join(c for c in code if c.isdigit())
    if len(code) != DIGITS:
        return None
    now = int((clock.time() if at is None else at) // STEP)
    for step in (now, now - 1, now + 1):
        if hmac.compare_digest(_code_at(secret, step), code):
            return step
    return None


def otpauth_url(secret: str, email: str) -> str:
    issuer = "Geohub"
    return (f"otpauth://totp/{quote(issuer)}:{quote(email)}?secret={secret}&issuer={quote(issuer)}"
            f"&algorithm=SHA1&digits={DIGITS}&period={STEP}")


# ---------- the secret, encrypted at rest ----------
def _key() -> bytes:
    return hashlib.sha256(b"geohub-totp-v1|" + settings.jwt_secret.encode()).digest()


def seal(secret: str) -> str:
    nonce = os.urandom(12)
    return "v1:" + base64.urlsafe_b64encode(nonce + AESGCM(_key()).encrypt(nonce, secret.encode(), b"totp")).decode()


def unseal(stored: str) -> str:
    try:
        raw = base64.urlsafe_b64decode(stored.split(":", 1)[1])
        return AESGCM(_key()).decrypt(raw[:12], raw[12:], b"totp").decode()
    except Exception:  # noqa: BLE001
        raise Problem(409, "Two-step sign-in needs setting up again (the server's key changed). Ask an administrator "
                           "to turn it off for you.", code="mfa_unreadable")


# ---------- recovery codes ----------
def new_recovery_codes() -> list[str]:
    return ["-".join("".join(secrets.choice(_RECOVERY_ALPHABET) for _ in range(5)) for _ in range(2))
            for _ in range(RECOVERY_COUNT)]


def _norm_recovery(code: str) -> str:
    return "".join(c for c in code.lower() if c.isalnum())


async def store_recovery_codes(conn, user_id, codes: list[str]) -> None:
    await conn.execute("DELETE FROM mfa_recovery_codes WHERE user_id = %s", (user_id,))
    for c in codes:
        await conn.execute("INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (%s, %s)", (user_id, hash_token(_norm_recovery(c))))


# ---------- checking a code ----------
async def check(conn, user_id, code: str) -> str:
    """Accept a code from the app (each only once) or an unused recovery code. Returns which it was."""
    cur = await conn.execute("SELECT totp_secret, totp_last_step FROM users WHERE id = %s FOR UPDATE", (user_id,))
    u = await cur.fetchone()
    if not u or not u["totp_secret"]:
        raise Problem(409, "Two-step sign-in is not set up.", code="mfa_not_set_up")
    step = matching_step(unseal(u["totp_secret"]), code)
    if step is not None:
        if u["totp_last_step"] is not None and step <= u["totp_last_step"]:
            raise Problem(401, "That code was already used. Wait for the next one.", code="bad_code")
        await conn.execute("UPDATE users SET totp_last_step = %s WHERE id = %s", (step, user_id))
        return "app"
    norm = _norm_recovery(code)
    if len(norm) == 10:
        cur = await conn.execute("UPDATE mfa_recovery_codes SET used_at = now() WHERE id = (SELECT id FROM mfa_recovery_codes "
                                 "WHERE user_id = %s AND code_hash = %s AND used_at IS NULL LIMIT 1) RETURNING id",
                                 (user_id, hash_token(norm)))
        if await cur.fetchone():
            return "recovery"
    raise Problem(401, "That code is not right. Enter the 6 digits your app shows now, or a recovery code.", code="bad_code")


# ---------- the step between password and code ----------
def challenge_token(user_id) -> str:
    now = int(time.time())
    return jwt.encode({"sub": str(user_id), "typ": "mfa", "iat": now, "exp": now + CHALLENGE_MINUTES * 60,
                       "jti": secrets.token_urlsafe(8)}, settings.jwt_secret, algorithm="HS256")


def read_challenge(token: str) -> str:
    try:
        p = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise Problem(401, "The sign-in took too long. Sign in again.", code="mfa_expired")
    if p.get("typ") != "mfa":
        raise Problem(401, "Sign in again.", code="mfa_expired")
    return p["sub"]
