"""Joining an organization by company email domain.

An organization on a paid plan adds its domain (e.g. lagossurvey.com) and proves it owns it with a DNS TXT record
(or GeoEstate checks it by hand). After that, people whose email is on that domain join it when they sign up, as
long as their email is proven: straight away with Google or Microsoft sign-in, or after clicking a link emailed to
them when they sign up with a password."""
import re
import secrets

import httpx

from .errors import Problem

# Addresses anyone can get: never a company's domain.
FREE_MAIL = {
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "ymail.com", "rocketmail.com", "outlook.com",
    "hotmail.com", "hotmail.co.uk", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com",
    "proton.me", "protonmail.com", "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com", "yandex.ru",
    "qq.com", "163.com", "126.com", "hey.com", "fastmail.com", "tutanota.com", "pm.me",
}
_DOMAIN = re.compile(r"^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
DOH = "https://dns.google/resolve"
# Tests replace this with a mock transport.
transport: httpx.AsyncBaseTransport | None = None


def domain_of(email: str) -> str:
    return email.rsplit("@", 1)[-1].strip().lower()


def normalize(raw: str) -> str:
    """'@LagosSurvey.com ' -> 'lagossurvey.com'; refuses what is not a company domain."""
    d = raw.strip().lower().lstrip("@").rstrip(".")
    if d.startswith("http://") or d.startswith("https://"):
        d = d.split("//", 1)[1].split("/", 1)[0]
    if d.startswith("www."):
        d = d[4:]
    if not _DOMAIN.match(d):
        raise Problem(422, "Enter a domain like yourcompany.com.", code="validation", fields={"domain": ["not a domain"]})
    if d in FREE_MAIL:
        raise Problem(422, f"{d} is a public email service, not your company's domain.", code="validation",
                      fields={"domain": ["public email service"]})
    return d


def new_token() -> str:
    return secrets.token_hex(12)


def txt_value(token: str) -> str:
    return f"geohub-verification={token}"


async def has_txt(domain: str, token: str) -> bool:
    """Whether the domain publishes the verification record (looked up over DNS-over-HTTPS)."""
    want = txt_value(token)
    async with httpx.AsyncClient(timeout=10, transport=transport) as c:
        r = await c.get(DOH, params={"name": domain, "type": "TXT"}, headers={"accept": "application/dns-json"})
    r.raise_for_status()
    for a in r.json().get("Answer") or []:
        # TXT data comes quoted, and long records in several quoted parts
        if want in "".join(re.findall(r'"([^"]*)"', a.get("data", ""))) or want in a.get("data", ""):
            return True
    return False


async def find_join(conn, email: str) -> dict | None:
    """The organization people with this email join by its domain: verified, joining on, and on a paid plan."""
    cur = await conn.execute(
        "SELECT d.org_id, d.role, o.name FROM org_domains d JOIN organizations o ON o.id = d.org_id "
        "WHERE d.domain = %s AND d.verified_at IS NOT NULL AND d.auto_join AND o.plan <> 'individual'", (domain_of(email),))
    return await cur.fetchone()


def out(row: dict) -> dict:
    return {"domain": row["domain"], "verified": row["verified_at"] is not None, "verified_at": row["verified_at"],
            "auto_join": row["auto_join"], "role": row["role"], "created_at": row["created_at"],
            "record": {"type": "TXT", "name": row["domain"], "value": txt_value(row["verify_token"])}}
