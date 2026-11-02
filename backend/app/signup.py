"""What happens when a new account is made, however it was made (a password or Google / Microsoft sign-in)."""
import logging

from . import domains, orgs, passwords
from .audit import audit
from .config import settings
from .mailer import send_email

log = logging.getLogger("signup")


async def finish(conn, user: dict, *, org_name: str | None = None, email_verified: bool = False, ip: str | None = None) -> dict:
    """Put the new account in its organization and turn its project invitations into memberships. When the email is
    on a company's domain but not proven yet, email a link that confirms it and joins that organization."""
    m = await orgs.join_on_signup(conn, user, org_name, email_verified=email_verified)
    cur = await conn.execute(
        "WITH inv AS (DELETE FROM invitations i USING projects p WHERE p.id = i.project_id AND p.org_id = %s "
        "  AND lower(i.email) = lower(%s) RETURNING i.project_id, i.role) "
        "INSERT INTO members (project_id, user_id, role) SELECT project_id, %s, role FROM inv "
        "RETURNING project_id", (m["org_id"], user["email"], user["id"]))
    for r in await cur.fetchall():
        await audit(conn, "member.join", actor_id=user["id"], project_id=r["project_id"], target_type="user",
                    target_id=user["id"], ip=ip, via="invitation")
    if not email_verified and m["plan"] == "individual" and m["role"] == "owner":
        d = await domains.find_join(conn, user["email"])
        if d:
            raw = await passwords.issue(conn, user["id"], "join", org_id=d["org_id"])
            await send_email(user["email"], f"Join {d['name']} on Geohub",
                             f"Hello {user['name'].split()[0]},\n\nYour email is on {domains.domain_of(user['email'])}, so you "
                             f"can join {d['name']} on Geohub. Confirm it is your email with the button below (the link "
                             "works once, within 72 hours).\n\nIf you did not sign up for Geohub, ignore this email.",
                             action=(f"Join {d['name']}", f"{settings.app_url}/join-organization?token={raw}"))
    return m
