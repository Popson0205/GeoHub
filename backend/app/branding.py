"""An organization's own look: its logo, its colour (buttons, links, highlights) and the name its emails come from.

Branding comes with Organization plans. The colour is darkened when needed so white text on it stays readable
(WCAG AA, 4.5:1). Logos are re-drawn as PNG of at most 512 px, so what is stored and served is always a plain image."""
import io
import re

from .config import settings
from .errors import Problem

MAX_LOGO_BYTES = 1_000_000
LOGO_PX = 512


def _lin(c: float) -> float:
    c /= 255
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def luminance(hex_: str) -> float:
    r, g, b = (int(hex_[i:i + 2], 16) for i in (1, 3, 5))
    return 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)


def contrast_with_white(hex_: str) -> float:
    return 1.05 / (luminance(hex_) + 0.05)


def readable(hex_: str) -> str:
    """The colour, darkened step by step until white text on it has at least 4.5:1 contrast."""
    r, g, b = (int(hex_[i:i + 2], 16) for i in (1, 3, 5))
    out = hex_
    while contrast_with_white(out) < 4.5:
        r, g, b = (int(x * 0.92) for x in (r, g, b))
        out = f"#{r:02x}{g:02x}{b:02x}"
    return out


def normalize_color(raw: str) -> str:
    c = raw.strip().lower()
    if re.fullmatch(r"#?[0-9a-f]{3}", c):
        c = "#" + "".join(ch * 2 for ch in c.lstrip("#"))
    if not c.startswith("#"):
        c = "#" + c
    if not re.fullmatch(r"#[0-9a-f]{6}", c):
        raise Problem(422, "Use a colour like #0b5cad.", code="validation", fields={"color": ["not a colour"]})
    return readable(c)


def clean_logo(data: bytes) -> bytes:
    """Any PNG, JPEG, WebP or GIF, as a PNG of at most 512 px; refuses anything else."""
    from PIL import Image, UnidentifiedImageError
    if len(data) > MAX_LOGO_BYTES:
        raise Problem(413, "The logo is larger than 1 MB. Use a smaller image.", code="too_large")
    try:
        im = Image.open(io.BytesIO(data))
        if im.format not in ("PNG", "JPEG", "WEBP", "GIF"):
            raise UnidentifiedImageError()
        im.load()
    except Exception:  # noqa: BLE001
        raise Problem(422, "Use a PNG, JPEG or WebP image for the logo.", code="validation", fields={"logo": ["not an image"]})
    im = im.convert("RGBA")
    im.thumbnail((LOGO_PX, LOGO_PX))
    out = io.BytesIO()
    im.save(out, format="PNG", optimize=True)
    return out.getvalue()


def logo_url(org_id, updated_at) -> str | None:
    if not updated_at:
        return None
    return f"{settings.app_url.rstrip('/')}{settings.api_prefix.rstrip('/')}/orgs/{org_id}/logo?v={int(updated_at.timestamp())}"


def brief(row: dict) -> dict | None:
    """The brand the app shows to the organization's people, from a row with org_id/id, plan and the brand columns."""
    if row.get("plan") == "individual" or not (row.get("brand_color") or row.get("logo_updated_at")):
        return None
    return {"color": row.get("brand_color"), "logo_url": logo_url(row.get("org_id") or row.get("id"), row.get("logo_updated_at"))}


async def for_email(conn, org_id) -> dict | None:
    """What an organization's emails carry: its name, colour, logo, sender name and reply-to. None on Individual."""
    cur = await conn.execute("SELECT id, name, plan, brand_color, logo_updated_at, email_sender_name, email_reply_to "
                             "FROM organizations WHERE id = %s", (org_id,))
    o = await cur.fetchone()
    if not o or o["plan"] == "individual":
        return None
    return {"name": o["name"], "color": o["brand_color"], "logo_url": logo_url(o["id"], o["logo_updated_at"]),
            "sender_name": o["email_sender_name"], "reply_to": o["email_reply_to"]}
