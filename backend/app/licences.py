"""An organization's licence: its plan, kind (paid or demo), dates and caps, and where it stands today.

    demo / active -> (end date passes) grace for 14 days -> expired      suspended: set by staff at any time

What each state does, for everyone in the organization (and its public form and dashboard links):
    demo, active, grace   full use (grace: a renewal banner for admins)
    expired               read-only: sign in, view, export; nothing added or changed; public forms stop taking answers
    suspended             nothing but signing in to see why; public links stop working
Every change is recorded in licence_events."""
from datetime import date, timedelta

from psycopg.types.json import Jsonb

from .errors import Problem

GRACE_DAYS = 14
DEMO_DAYS = 30
DEMO_PLAN = "advanced"                     # a demo gives full use of the biggest standard plan
STATUSES = ("free", "demo", "active", "grace", "expired", "suspended")
STATUS_NAMES = {"free": "Free (Individual)", "demo": "Demo", "active": "Active", "grace": "Grace period",
                "expired": "Expired", "suspended": "Suspended"}

# The same rule in SQL, for filtering lists: `o` is the organizations row.
STATUS_SQL = (
    "CASE WHEN o.suspended_at IS NOT NULL THEN 'suspended' "
    "     WHEN o.plan = 'individual' THEN 'free' "
    "     WHEN o.subscription_ends IS NULL OR o.subscription_ends >= current_date "
    "       THEN CASE WHEN o.licence_kind = 'demo' THEN 'demo' ELSE 'active' END "
    f"     WHEN o.subscription_ends + {GRACE_DAYS} >= current_date THEN 'grace' "
    "     ELSE 'expired' END")


def status(org: dict, today: date | None = None) -> str:
    today = today or date.today()
    if org.get("suspended_at"):
        return "suspended"
    if org["plan"] == "individual":
        return "free"
    ends = org.get("subscription_ends")
    if ends is None or ends >= today:
        return "demo" if org.get("licence_kind") == "demo" else "active"
    return "grace" if ends + timedelta(days=GRACE_DAYS) >= today else "expired"


def grace_ends(org: dict) -> date | None:
    ends = org.get("subscription_ends")
    return ends + timedelta(days=GRACE_DAYS) if ends else None


def demo_dates(today: date | None = None) -> tuple[date, date]:
    today = today or date.today()
    return today, today + timedelta(days=DEMO_DAYS - 1)


async def record(conn, org_id, action: str, actor_id=None, invoice_ref: str | None = None, note: str | None = None) -> None:
    """Add the organization's licence as it now stands to its history."""
    cur = await conn.execute("SELECT plan, licence_kind, subscription_starts, subscription_ends, limits FROM organizations "
                             "WHERE id = %s", (org_id,))
    o = await cur.fetchone()
    await conn.execute(
        "INSERT INTO licence_events (org_id, action, plan, kind, starts, ends, limits, invoice_ref, note, actor_id) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
        (org_id, action, o["plan"], o["licence_kind"], o["subscription_starts"], o["subscription_ends"],
         Jsonb(o["limits"] or {}), (invoice_ref or "").strip() or None, (note or "").strip() or None, actor_id))


# ---------- what a licence allows ----------
READ_METHODS = {"GET", "HEAD", "OPTIONS"}
# Writes that only read: exports are how people take their work with them, so they work while read-only.
READ_ONLY_EXCEPTIONS = ("/exports",)
# What a suspended or expired organization's people can still reach: their organization's page and leaving it.
ALWAYS_OPEN = ("/org", "/org/leave", "/org/support-visits")


def _problem(state: str, org_name: str | None = None) -> Problem:
    who = f"{org_name}'s" if org_name else "Your organization's"
    if state == "suspended":
        return Problem(403, f"{who} Geohub access is suspended. Contact GeoEstate NIG Limited to restore it.",
                       code="licence_suspended")
    return Problem(403, f"{who} Geohub subscription has ended, so it is read-only: you can view and export your work but "
                        "not add or change anything. Renew with GeoEstate NIG Limited to carry on.", code="licence_expired")


def allows(state: str, method: str, path: str) -> Problem | None:
    """The problem to refuse a request with, or None when the licence allows it."""
    if state not in ("expired", "suspended"):
        return None
    if path in ALWAYS_OPEN:
        return None
    if state == "suspended":
        return _problem(state)
    if method in READ_METHODS or path.endswith(READ_ONLY_EXCEPTIONS):
        return None
    return _problem(state)


def of_row(row: dict, prefix: str = "org_") -> str:
    """The status from a row that carries the organization's licence columns under `prefix`."""
    return status({"plan": row.get(f"{prefix}plan") or "individual", "subscription_ends": row.get(f"{prefix}ends"),
                   "suspended_at": row.get(f"{prefix}suspended_at"), "licence_kind": row.get(f"{prefix}kind")})


async def check_project(conn, project_id, write: bool) -> None:
    """For links used without signing in (public forms and dashboards): the project's organization must allow it."""
    cur = await conn.execute("SELECT o.name, o.plan, o.subscription_ends, o.suspended_at, o.licence_kind FROM projects p "
                             "JOIN organizations o ON o.id = p.org_id WHERE p.id = %s", (project_id,))
    o = await cur.fetchone()
    if not o:
        return
    st = status(o)
    if st == "suspended" or (st == "expired" and write):
        if st == "expired":
            raise Problem(403, "This form is closed: its organization's Geohub subscription has ended.", code="licence_expired")
        raise Problem(404, "This link is not available.", code="not_found")


LICENCE_COLS = ("o.plan AS org_plan, o.subscription_ends AS org_ends, o.suspended_at AS org_suspended_at, "
                "o.licence_kind AS org_kind")
