"""Renewal reminders: email an organization's owners and admins 60, 30 and 7 days before its subscription ends, and on
the day itself, copying GeoEstate's platform admins. Each reminder goes once (recorded in subscription_reminders), so
running this more often than daily, or on several servers, sends nothing twice. Nothing is blocked when a
subscription ends; renewal is followed up by GeoEstate."""
import asyncio
import logging
from datetime import date

from . import orgs
from .config import settings
from . import staff
from .mailer import send_email

log = logging.getLogger("reminders")
DAYS = (60, 30, 7, 0)


def _when(days: int, ends: date) -> str:
    on = f"{ends:%d %B %Y}".lstrip("0")
    return f"ends today, {on}" if days == 0 else f"ends in {days} days, on {on}"


async def run(conn, today: date | None = None) -> int:
    """Send the reminders that are due today. Returns how many organizations were reminded."""
    today = today or date.today()
    cur = await conn.execute(
        "SELECT o.id, o.name, o.plan, o.subscription_ends, (o.subscription_ends - %s::date) AS days FROM organizations o "
        "WHERE o.subscription_ends IS NOT NULL AND o.plan <> 'individual' "
        "AND (o.subscription_ends - %s::date) = ANY(%s)", (today, today, list(DAYS)))
    due = await cur.fetchall()
    sent = 0
    for o in due:
        cur = await conn.execute(
            "INSERT INTO subscription_reminders (org_id, ends_on, days_before) VALUES (%s, %s, %s) "
            "ON CONFLICT DO NOTHING RETURNING org_id", (o["id"], o["subscription_ends"], o["days"]))
        if not await cur.fetchone():
            continue                               # already sent
        cur = await conn.execute("SELECT u.email, u.name FROM org_members m JOIN users u ON u.id = m.user_id "
                                 "WHERE m.org_id = %s AND m.role IN ('owner','admin')", (o["id"],))
        people = await cur.fetchall()
        plan = orgs.PLAN_NAMES.get(o["plan"], o["plan"])
        when = _when(o["days"], o["subscription_ends"])
        for p in people:
            await send_email(
                p["email"], f"Your Geohub subscription {when.split(',')[0]}",
                f"Hello {p['name'].split()[0]},\n\nThe {plan} subscription for \"{o['name']}\" {when}. To renew for another "
                "year, reply to this email or contact GeoEstate NIG Limited, and we will send the invoice.\n\n"
                "Your work and your team's access stay as they are.",
                action=("Open Geohub", f"{settings.app_url}/settings/organization"),
                key=f"renewal/{o['id']}/{o['subscription_ends']}/{o['days']}/{p['email']}")
        for to in await staff.emails(conn):
            await send_email(to, f"Renewal: {o['name']} {when.split(',')[0]}",
                             f"\"{o['name']}\" ({plan}) {when}. Reminded: "
                             + (", ".join(p["email"] for p in people) or "nobody (no owner or admin)") + ".",
                             action=("Open the platform admin page", f"{settings.app_url}/admin"),
                             key=f"renewal-copy/{o['id']}/{o['subscription_ends']}/{o['days']}/{to}")
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
