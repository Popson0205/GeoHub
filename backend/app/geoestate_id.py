"""GeoEstate ID: Geohub is the sign-in for every GeoEstate app.

An app (Land Registry, LandCheck, FarmScan) sends the person to Geohub's /id/authorize page. Someone already signed in
to Geohub goes straight through; anyone else signs in first. Geohub checks that their organization has that product
(GeoEstate staff may always enter), and sends them back to the app with a one-time code. The app swaps the code for:

- an access token: a JWT signed with Geohub's Ed25519 key (EdDSA), valid 15 minutes, saying who the person is, their
  organization and role, and that product's licence (plan, status, features, limits). Apps check it against the public
  key at /id/jwks, without calling Geohub;
- a refresh token, valid 30 days and replaced each time it is used. Each refresh checks again that the person is still
  in the organization and that it still has the product.

Codes follow OAuth 2.0 with PKCE (S256): an app with a server keeps a secret; an app without one uses PKCE alone."""
import base64
import hashlib
import hmac
import json
import secrets
from datetime import datetime, timedelta, timezone
from functools import lru_cache

import jwt
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from . import orgs, products, staff
from .config import settings
from .errors import Problem
from .security import hash_token

TYP = "geoestate-id"


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


# ---------- the signing key ----------
@lru_cache(maxsize=1)
def _key() -> tuple[Ed25519PrivateKey, str]:
    if settings.id_signing_key.strip():
        key = serialization.load_pem_private_key(settings.id_signing_key.strip().encode(), password=None)
        if not isinstance(key, Ed25519PrivateKey):
            raise ValueError("ID_SIGNING_KEY must be an Ed25519 private key")
    else:       # the same key on every server and after every restart, without one more setting
        seed = HKDF(algorithm=hashes.SHA256(), length=32, salt=b"geoestate-id", info=b"ed25519-signing-key").derive(
            settings.jwt_secret.encode())
        key = Ed25519PrivateKey.from_private_bytes(seed)
    raw = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return key, hashlib.sha256(raw).hexdigest()[:16]


def jwks() -> dict:
    key, kid = _key()
    raw = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return {"keys": [{"kty": "OKP", "crv": "Ed25519", "x": b64url(raw), "kid": kid, "alg": "EdDSA", "use": "sig"}]}


def sign(claims: dict, minutes: int) -> str:
    key, kid = _key()
    now = datetime.now(timezone.utc)
    return jwt.encode({**claims, "iss": issuer(), "iat": now, "exp": now + timedelta(minutes=minutes), "typ": TYP},
                      key, algorithm="EdDSA", headers={"kid": kid})


def verify(token: str) -> dict:
    key, _ = _key()
    try:
        claims = jwt.decode(token, key.public_key(), algorithms=["EdDSA"], issuer=issuer(), options={"verify_aud": False})
    except jwt.ExpiredSignatureError:
        raise Problem(401, "The sign-in has expired.", code="token_expired")
    except jwt.InvalidTokenError:
        raise Problem(401, "That token is not valid.", code="invalid_token")
    if claims.get("typ") != TYP:
        raise Problem(401, "That token is not valid.", code="invalid_token")
    return claims


def issuer() -> str:
    return settings.app_url


# ---------- the apps Geohub signs people in to ----------
@lru_cache(maxsize=4)
def _clients(raw: str) -> dict[str, dict]:
    out = {}
    for c in json.loads(raw or "[]"):
        cid = str(c["id"]).strip()
        product = str(c.get("product") or cid)
        if product not in products.OTHER:
            raise ValueError(f"ID_CLIENTS: {cid}'s product must be one of {', '.join(products.OTHER)}")
        secret = (c.get("secret") or "").strip()
        if secret and len(secret) < 32:
            raise ValueError(f"ID_CLIENTS: {cid}'s secret must be 32+ characters")
        out[cid] = {"id": cid, "product": product, "name": products.PRODUCTS[product],
                    "redirect_uris": [u.strip() for u in c.get("redirect_uris", []) if u.strip()],
                    "secret_hash": hash_token(secret) if secret else None}
    return out


def clients() -> dict[str, dict]:
    """The apps in ID_CLIENTS. A mistake in that setting is named, instead of failing as a server error."""
    try:
        return _clients(settings.id_clients)
    except json.JSONDecodeError as e:
        raise Problem(503, f"Geohub's ID_CLIENTS setting is not valid JSON (line {e.lineno}, column {e.colno}: {e.msg}). "
                           "Check its quotes are straight (\") and entries are separated by commas.", code="id_clients_invalid") from None
    except (ValueError, KeyError, TypeError, AttributeError) as e:
        why = f"an entry has no {e}" if isinstance(e, KeyError) else str(e)
        raise Problem(503, f"Geohub's ID_CLIENTS setting has a mistake: {why}.", code="id_clients_invalid") from None


def client(client_id: str, redirect_uri: str | None = None) -> dict:
    c = clients().get(client_id or "")
    if not c:
        raise Problem(400, "This app is not registered with Geohub (ID_CLIENTS).", code="unknown_client")
    if redirect_uri is not None and redirect_uri not in c["redirect_uris"]:
        raise Problem(400, f"{c['name']} asked to return to an address Geohub does not know. Add it to its redirect_uris in "
                           "ID_CLIENTS.", code="bad_redirect_uri")
    return c


def check_secret(c: dict, secret: str | None) -> None:
    if c["secret_hash"] and not (secret and hmac.compare_digest(hash_token(secret), c["secret_hash"])):
        raise Problem(401, "The app's secret is not right.", code="invalid_client")


def pkce_ok(challenge: str | None, verifier: str | None) -> bool:
    if not challenge:
        return True
    if not verifier:
        return False
    return hmac.compare_digest(b64url(hashlib.sha256(verifier.encode()).digest()), challenge)


# ---------- who the person is, for one app ----------
async def claims_for(conn, user_id, c: dict) -> dict:
    """What an app is told about the person. Refuses when they may not use it."""
    cur = await conn.execute("SELECT id, email, name, (totp_enabled_at IS NOT NULL) AS mfa_enabled FROM users WHERE id = %s", (user_id,))
    u = await cur.fetchone()
    if not u:
        raise Problem(401, "Unknown user.", code="invalid_token")
    m = await orgs.membership(conn, user_id)
    product = None
    if m:
        product = next((p for p in await products.of_org(conn, m["org_id"]) if p["product"] == c["product"]), None)
    role = await staff.role_of(conn, u)
    if not product and not role:
        who = f"{m['name']} does" if m else "Your account does"
        raise Problem(403, f"{who} not have {c['name']}. Ask GeoEstate NIG Limited for it, or for a month's demo.",
                      code="no_product", product=c["product"])
    if not product and settings.staff_require_mfa and not u["mfa_enabled"]:
        raise Problem(403, "GeoEstate staff must use two-step sign-in to open customers' apps. Turn it on under Account "
                           "security in Geohub.", code="staff_mfa_required")
    lic = None
    if product:
        lic = {k: (v.isoformat() if hasattr(v, "isoformat") else v) for k, v in product.items() if k != "url"}
        lic["id"] = lic.pop("product")
    return {"sub": str(u["id"]), "aud": c["id"], "email": u["email"], "name": u["name"], "mfa": u["mfa_enabled"],
            "org": {"id": str(m["org_id"]), "name": m["name"], "slug": m["slug"], "role": m["role"]} if m else None,
            "product": lic, "staff_role": role}


async def issue(conn, user_id, c: dict) -> dict:
    """An access token and a new refresh token for the app."""
    claims = await claims_for(conn, user_id, c)
    raw = secrets.token_urlsafe(40)
    await conn.execute("INSERT INTO id_refresh_tokens (token_hash, client_id, user_id, expires_at) "
                       "VALUES (%s, %s, %s, now() + make_interval(days => %s))",
                       (hash_token(raw), c["id"], user_id, settings.id_refresh_days))
    return {"access_token": sign(claims, settings.id_token_minutes), "token_type": "Bearer",
            "expires_in": settings.id_token_minutes * 60, "refresh_token": raw, "user": claims}
