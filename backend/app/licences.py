"""An organization's licence: its plan, kind (paid or demo), dates and caps, and where it stands today.

    demo / active -> (end date passes) grace for 14 days -> expired      suspended: set by staff at any time

What each state does to the people using Geohub (renewal banner, read-only) comes with the next part of the staff
console; here the state is worked out and every change is recorded in licence_events."""
from datetime import date, timedelta

from psycopg.types.json import Jsonb

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
