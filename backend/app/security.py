import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from uuid import UUID

import anyio
import bcrypt
import jwt

from .config import settings
from .errors import Problem


def _prehash(pw: str) -> bytes:
    # bcrypt ignores everything after 72 bytes; hashing first keeps long passphrases intact.
    return base64.b64encode(hashlib.sha256(pw.encode()).digest())


async def hash_password(pw: str) -> str:
    return await anyio.to_thread.run_sync(lambda: bcrypt.hashpw(_prehash(pw), bcrypt.gensalt()).decode())


async def verify_password(pw: str, hashed: str) -> bool:
    return await anyio.to_thread.run_sync(lambda: bcrypt.checkpw(_prehash(pw), hashed.encode()))


_DUMMY = bcrypt.hashpw(b"x", bcrypt.gensalt()).decode()


async def burn_password_check(pw: str):
    """Spend the same time as a real check so unknown emails cannot be told apart by timing."""
    await verify_password(pw, _DUMMY)


def _encode(payload: dict, minutes: int) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode({**payload, "iat": now, "exp": now + timedelta(minutes=minutes)},
                      settings.jwt_secret, algorithm="HS256")


def make_access_token(user_id: UUID) -> str:
    return _encode({"sub": str(user_id), "typ": "access"}, settings.access_token_minutes)


def make_tile_token(project_id: UUID, user_id: UUID) -> str:
    return _encode({"sub": str(user_id), "typ": "tile", "pid": str(project_id)}, settings.tile_token_minutes)


def decode_token(token: str, typ: str) -> dict:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise Problem(401, "Your session has expired. Refresh the token and retry.", code="token_expired")
    except jwt.PyJWTError:
        raise Problem(401, "Invalid token.", code="invalid_token")
    if payload.get("typ") != typ:
        raise Problem(401, "Wrong token type.", code="invalid_token")
    return payload


def new_refresh_token() -> tuple[str, str]:
    raw = secrets.token_urlsafe(48)
    return raw, hash_token(raw)


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()
