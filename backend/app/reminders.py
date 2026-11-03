"""Renewal reminders: email an organization's owners and admins 60, 30 and 7 days before its subscription ends, on the
day itself, and when its 14 days of grace run out and it becomes read-only, copying GeoEstate's super admins and
account managers. Each reminder goes once (recorded in subscription_reminders), so running this more often than daily,
or on several servers, sends nothing twice."""
import asyncio
import logging
from datetime import date, timedelta

from . import licences, products, staff
from .config import settings
from .mailer import send_email

log = logging.getLogger("reminders")
READ_ONLY = -licences.GRACE_DAYS          # the day after the grace period: read-only from now
DAYS = (60, 30, 7, 0, READ_ONLY)


def _day(d: date) -> str:
    return f"{d:%d %B %Y}".lstrip("0")


def _when(days: int, ends: date) -> str:
    if days == READ_ONLY:
        return f"ended on {_day(ends)}"
    return f"ends today, {_day(ends)}" if days == 0 else f"ends in {days} days, on {_day(ends)}"


def _what_happens(days: int, ends: date, demo: bool, name: str = "Geohub") -> str:
    grace = ends + timedelta(days=licences.GRACE_DAYS)
    if days == READ_ONLY:
        return ("Its 14 days of grace are over, so it is now read-only: everyone can still sign in, view and export their "
                "work, but nothing can be added or changed, and public forms no longer take answers. "
                + (f"To keep using {name}, ask us for an invoice." if demo else "Renew to carry on where you left off."))
    return (f"If it is not renewed by then, everyone keeps full use for 14 more days, until {_day(grace)}. After that the "
            "organization becomes read-only: people can still view and export their work, but not add or change anything.")


async def run(conn, today: date | None = None) -> int:
    """Send the reminders that are due today. Returns how many organizations were reminded."""
    today = today or date.today()
    cur = await conn.execute(
        "SELECT 'hub' AS product, o.id, o.name, o.plan, o.licence_kind, o.subscription_ends, (o.subscription_ends - %(d)s::date) AS days "
        "FROM organizations o WHERE o.subscription_ends IS NOT NULL AND o.plan <> 'individual' AND o.suspended_at IS NULL "
        "AND (o.subscription_ends - %(d)s::date) = ANY(%(days)s) "
        "UNION ALL "
        "SELECT p.product, o.id, o.name, p.plan, p.licence_kind, p.subscription_ends, (p.subscription_ends - %(d)s::date) "
        "FROM org_products p JOIN organizations o ON o.id = p.org_id WHERE p.subscription_ends IS NOT NULL AND o.suspended_at IS NULL "
        "AND (p.subscription_ends - %(d)s::date) = ANY(%(days)s)", {"d": today, "days": list(DAYS)})
    due = await cur.fetchall()
    sent = 0
    for o in due:
        cur = await conn.execute(
            "INSERT INTO subscription_reminders (org_id, product, ends_on, days_before) VALUES (%s, %s, %s, %s) "
            "ON CONFLICT DO NOTHING RETURNING org_id", (o["id"], o["product"], o["subscription_ends"], o["days"]))
        if not await cur.fetchone():
            continue                               # already sent
        cur = await conn.execute("SELECT u.email, u.name FROM org_members m JOIN users u ON u.id = m.user_id "
                                 "WHERE m.org_id = %s AND m.role IN ('owner','admin')", (o["id"],))
        people = await cur.fetchall()
        demo = o["licence_kind"] == "demo"
        name = products.PRODUCTS[o["product"]]
        plan = products.plan_name(o["product"], o["plan"])
        what = f"{name} demo" if demo else f"{plan} subscription"
        when = _when(o["days"], o["subscription_ends"])
        subject = (f"{o['name']} is now read-only on {name}" if o["days"] == READ_ONLY
                   else f"Your {name} {'demo' if demo else 'subscription'} {when.split(',')[0]}")
        tag = "" if o["product"] == "hub" else f"{o['product']}/"
        where = products.urls().get(o["product"]) or settings.app_url
        for p in people:
            await send_email(
                p["email"], subject,
                f"Hello {p['name'].split()[0]},\n\nThe {what} for \"{o['name']}\" {when}. "
                + ("To become a customer" if demo else "To renew for another year")
                + ", reply to this email or contact GeoEstate NIG Limited, and we will send the invoice.\n\n"
                + _what_happens(o["days"], o["subscription_ends"], demo, name),
                action=(f"Open {name}", f"{settings.app_url}/settings/organization" if o["product"] == "hub" else where),
                key=f"renewal/{tag}{o['id']}/{o['subscription_ends']}/{o['days']}/{p['email']}")
        for to in await staff.emails(conn):
            await send_email(to, f"{'Read-only' if o['days'] == READ_ONLY else 'Demo ends' if demo else 'Renewal'}: {o['name']} {when.split(',')[0]}",
                             f"\"{o['name']}\" ({plan}{', demo' if demo else ''}) {when}"
                             + (" and is now read-only" if o["days"] == READ_ONLY else "") + ". Reminded: "
                             + (", ".join(p["email"] for p in people) or "nobody (no owner or admin)") + ".",
                             action=("Open the customer", f"{settings.app_url}/admin/customers/{o['id']}"),
                             key=f"renewal-copy/{tag}{o['id']}/{o['subscription_ends']}/{o['days']}/{to}")
        sent += 1
    if sent:
        log.info("renewal reminders sent", extra={"ctx": {"organizations": sent, "date": str(today)}})
    return sent


async def loop(pool) -> None:
    """Check once an hour while the server runs. Safe with several servers: each reminder is recorded once."""
    while True:
        try:
            async with pool.connection() as conn:
                await run(conn)
        except Exception:  # noqa: BLE001
            log.exception("renewal reminders failed; will try again in an hour")
        await asyncio.sleep(3600)
