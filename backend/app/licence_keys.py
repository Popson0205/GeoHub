"""Signed licence keys, for customers who run GeoEstate software on their own servers or in their own cloud.

GeoEstate's own deployment issues them (LICENCE_SIGNING_SECRET set): a key lists the customer, the installation's web
address, and each product's plan, kind, dates, caps and feature switches, signed with GeoEstate's Ed25519 key.

    GEOESTATE-LICENCE-1.<payload, base64url JSON>.<signature, base64url>

The customer's installation (LICENCE_REQUIRED=true) checks the signature with GeoEstate's public key and that the key
was made for its own address, then sets its organization's licences from it. Change one character and it is refused.
Renewing = pasting the next key. Without a valid key, an installation that requires one gets the usual 14 days of
grace from its first start, then is read-only.

The public key the installation trusts comes from PINNED below when set (built into the software), otherwise from
LICENCE_PUBLIC_KEY, which GeoEstate sets when installing."""
import base64
import json
import uuid
from datetime import date, datetime, timezone
from urllib.parse import urlsplit

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from psycopg.types.json import Jsonb

from . import licences, products
from .config import settings
from .errors import Problem

FORMAT = "GEOESTATE-LICENCE-1"
# GeoEstate's public licence keys (base64url, raw Ed25519). Once set, LICENCE_PUBLIC_KEY is ignored, so an
# installation cannot be pointed at another key by changing a setting.
PINNED: tuple[str, ...] = ()


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _signing_key() -> Ed25519PrivateKey | None:
    secret = settings.licence_signing_secret.strip()
    if not secret:
        return None
    seed = HKDF(algorithm=hashes.SHA256(), length=32, salt=b"geoestate-licence", info=b"ed25519").derive(secret.encode())
    return Ed25519PrivateKey.from_private_bytes(seed)


def public_key() -> str | None:
    """GeoEstate's public key, for LICENCE_PUBLIC_KEY on installations (only where keys are issued)."""
    k = _signing_key()
    if not k:
        return None
    return _b64(k.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))


def trusted() -> list[str]:
    if PINNED:
        return list(PINNED)
    keys = [k.strip() for k in settings.licence_public_key.split(",") if k.strip()]
    own = public_key()
    return keys + ([own] if own and own not in keys else [])


def site(url: str) -> str:
    """An installation's address as compared: scheme and host, without a trailing slash or path."""
    p = urlsplit(url.strip())
    if p.scheme not in ("http", "https") or not p.netloc:
        raise Problem(422, "The installation's address must be a web address, e.g. https://geohub.client.gov.ng",
                      code="validation", fields={"installation": ["not a web address"]})
    return f"{p.scheme}://{p.netloc.lower()}"


def sign(payload: dict) -> str:
    k = _signing_key()
    if not k:
        raise Problem(503, "This deployment cannot issue licence keys: set LICENCE_SIGNING_SECRET.", code="cannot_issue")
    body = _b64(json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode())
    return f"{FORMAT}.{body}.{_b64(k.sign(f'{FORMAT}.{body}'.encode()))}"


def read(key: str, for_site: str | None = None) -> dict:
    """The key's contents, when it is genuine, unchanged, and made for this installation. Refuses otherwise."""
    parts = "".join(key.split()).split(".")          # pasted keys may come wrapped over several lines
    if len(parts) != 3 or parts[0] != FORMAT:
        raise Problem(422, "That is not a GeoEstate licence key. Paste the whole key, from GEOESTATE-LICENCE-1 to its end.",
                      code="not_a_key")
    keys = trusted()
    if not keys:
        raise Problem(503, "This installation does not know GeoEstate's public key (LICENCE_PUBLIC_KEY), so it cannot check "
                           "licence keys. Contact GeoEstate NIG Limited.", code="no_public_key")
    try:
        sig = _unb64(parts[2])
        signed = f"{parts[0]}.{parts[1]}".encode()
    except ValueError:
        raise Problem(422, "That licence key is damaged. Paste it again, exactly as it was sent.", code="bad_key")
    for k in keys:
        try:
            Ed25519PublicKey.from_public_bytes(_unb64(k)).verify(sig, signed)
            break
        except (InvalidSignature, ValueError):
            continue
    else:
        raise Problem(422, "That licence key is not genuine, or was changed after GeoEstate issued it.", code="bad_signature")
    payload = json.loads(_unb64(parts[1]))
    here = site(for_site or settings.app_url)
    if site(payload["installation"]) != here:
        raise Problem(422, f"That licence key is for {payload['installation']}, not this installation ({here}).",
                      code="other_installation")
    return payload


def summary(payload: dict) -> dict:
    return {"id": payload["id"], "customer": payload["customer"], "installation": payload["installation"],
            "issued_at": payload["issued_at"], "note": payload.get("note"),
            "products": [{"product": p["product"], "name": products.PRODUCTS[p["product"]],
                          "plan_name": products.plan_name(p["product"], p["plan"]), "starts": p.get("starts"), "ends": p.get("ends")}
                         for p in payload["products"]]}


async def make(conn, org_id, installation: str, ends: date | None, note: str | None, actor: dict) -> dict:
    """Issue a key carrying the customer's licences as they stand now (or all ending on `ends`)."""
    cur = await conn.execute("SELECT name, plan, licence_kind, subscription_starts, subscription_ends, limits FROM organizations "
                             "WHERE id = %s", (org_id,))
    o = await cur.fetchone()
    if not o:
        raise Problem(404, "Organization not found.", code="not_found")
    if o["plan"] == "individual":
        raise Problem(409, "An Individual account has no licence to put in a key. Set it up as an organization first.",
                      code="individual")
    items = [{"product": "hub", "plan": o["plan"], "kind": o["licence_kind"], "starts": o["subscription_starts"],
              "ends": ends or o["subscription_ends"], "limits": o["limits"] or {}, "features": {}}]
    cur = await conn.execute("SELECT * FROM org_products WHERE org_id = %s", (org_id,))
    for r in await cur.fetchall():
        items.append({"product": r["product"], "plan": r["plan"], "kind": r["licence_kind"], "starts": r["subscription_starts"],
                      "ends": ends or r["subscription_ends"], "limits": r["limits"] or {}, "features": r["features"] or {}})
    items.sort(key=lambda p: list(products.PRODUCTS).index(p["product"]))
    payload = {"format": 1, "id": str(uuid.uuid4()), "customer": o["name"], "installation": site(installation),
               "issued_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "issued_by": actor["name"],
               "note": (note or "").strip() or None,
               "products": [{**p, "starts": p["starts"].isoformat() if p["starts"] else None,
                             "ends": p["ends"].isoformat() if p["ends"] else None} for p in items]}
    key = sign(payload)
    await conn.execute("INSERT INTO licence_keys (id, org_id, installation, payload, key, note, issued_by) VALUES (%s, %s, %s, %s, %s, %s, %s)",
                       (payload["id"], org_id, payload["installation"], Jsonb(payload), key, payload["note"], actor["id"]))
    return {"key": key, **summary(payload)}


async def install(conn, org_id, key: str, actor_id=None) -> dict:
    """Check a key and set the organization's licences from it. The key is the whole truth: products it does not
    list are taken away (their data is kept)."""
    payload = read(key)
    cur = await conn.execute("SELECT key_id FROM installation_licence WHERE id = 1")
    now = await cur.fetchone()
    note = f"Licence key {payload['id'][:8]} from GeoEstate NIG Limited"
    for p in payload["products"]:
        starts = date.fromisoformat(p["starts"]) if p.get("starts") else None
        ends = date.fromisoformat(p["ends"]) if p.get("ends") else None
        if p["product"] == "hub":
            await conn.execute("UPDATE organizations SET plan = %s, licence_kind = %s, subscription_starts = %s, subscription_ends = %s, "
                               "limits = %s WHERE id = %s", (p["plan"], p.get("kind", "paid"), starts, ends, Jsonb(p.get("limits") or {}), org_id))
            await licences.record(conn, org_id, "key", actor_id, payload["id"][:8], note)
        else:
            await products.put(conn, org_id, p["product"], plan=p["plan"], kind=p.get("kind", "paid"), starts=starts, ends=ends,
                               limits_=p.get("limits") or {}, features_=p.get("features") or {})
            await products.record(conn, org_id, p["product"], "key", actor_id, payload["id"][:8], note)
    listed = {p["product"] for p in payload["products"]}
    for other in products.OTHER:
        if other not in listed and await products.remove(conn, org_id, other):
            await products.record(conn, org_id, other, "remove", actor_id, payload["id"][:8], f"Not in {note.lower()}")
    await conn.execute(
        "INSERT INTO installation_licence (id, key, key_id, payload, installed_by) VALUES (1, %s, %s, %s, %s) "
        "ON CONFLICT (id) DO UPDATE SET key = EXCLUDED.key, key_id = EXCLUDED.key_id, payload = EXCLUDED.payload, "
        "installed_by = EXCLUDED.installed_by, installed_at = now()",
        ("".join(key.split()), payload["id"], Jsonb(payload), actor_id))
    return {**summary(payload), "replaced": bool(now and str(now["key_id"]) != payload["id"])}


async def installed(conn) -> dict | None:
    cur = await conn.execute("SELECT payload, installed_at FROM installation_licence WHERE id = 1")
    row = await cur.fetchone()
    return {**summary(row["payload"]), "installed_at": row["installed_at"]} if row else None


async def on_start(conn) -> None:
    """At start-up: install LICENCE_KEY when set and new; on an installation that requires a key and has none, start
    the 14 days of grace (organizations with no end date end today)."""
    if not settings.licence_required:
        return
    cur = await conn.execute("SELECT id FROM organizations ORDER BY created_at LIMIT 2")
    orgs = await cur.fetchall()
    have = await installed(conn)
    if settings.licence_key.strip() and len(orgs) == 1:
        try:
            if not have or have["id"] != read(settings.licence_key)["id"]:
                await install(conn, orgs[0]["id"], settings.licence_key)
            return
        except Problem:
            pass                                          # a bad key in the settings: as if there were none
    if not have:
        await conn.execute("UPDATE organizations SET subscription_ends = current_date, licence_kind = 'paid' "
                           "WHERE subscription_ends IS NULL AND plan <> 'individual'")
