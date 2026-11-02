"""The caller's organization: its details, plan and usage, and its people."""
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response

from .. import orgs, ratelimit
from ..audit import audit
from ..config import settings
from ..db import get_conn
from ..deps import current_user
from ..errors import Problem
from ..logging_setup import client_ip
from ..mailer import send_email
from ..schemas import OrgMemberIn, OrgMemberOut, OrgMemberPatch, OrgOut, OrgPatch

router = APIRouter(prefix="/org", tags=["organization"])


async def _out(conn, m: dict) -> dict:
    return {"id": m["org_id"], "name": m["name"], "slug": m["slug"], "role": m["role"], "plan": m["plan"],
            "limits": {k: int(v) for k, v in (m["limits"] or {}).items() if k in orgs.LIMIT_LABEL},
            "usage": await orgs.usage(conn, m["org_id"]), "single_org": settings.single_org}


@router.get("", response_model=OrgOut, summary="Your organization, its plan and what it uses")
async def get_org(user=Depends(current_user), conn=Depends(get_conn)):
    return await _out(conn, await orgs.require_membership(conn, user))


@router.patch("", response_model=OrgOut, summary="Rename the organization (admins)")
async def update_org(body: OrgPatch, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    m = await orgs.require_org_role(conn, user, "admin")
    await conn.execute("UPDATE organizations SET name = %s WHERE id = %s", (body.name.strip(), m["org_id"]))
    await audit(conn, "org.rename", actor_id=user["id"], target_type="organization", target_id=m["org_id"],
                ip=client_ip(request), org_id=str(m["org_id"]), name=body.name.strip())
    return await _out(conn, await orgs.membership(conn, user["id"]))


@router.get("/members", response_model=list[OrgMemberOut], summary="People in the organization, and invitations")
async def list_members(user=Depends(current_user), conn=Depends(get_conn)):
    m = await orgs.require_membership(conn, user)
    cur = await conn.execute(
        "SELECT * FROM ("
        " SELECT u.id, u.id AS user_id, u.email, u.name, om.role, 'active' AS status, om.created_at AS joined_at "
        "  FROM org_members om JOIN users u ON u.id = om.user_id WHERE om.org_id = %(o)s "
        " UNION ALL "
        " SELECT i.id, NULL, i.email, NULL, i.role, 'invited', i.created_at FROM org_invitations i WHERE i.org_id = %(o)s"
        ") x ORDER BY (status = 'active') DESC, array_position(ARRAY['owner','admin','member'], role), lower(email)",
        {"o": m["org_id"]})
    return await cur.fetchall()


@router.post("/members", response_model=OrgMemberOut, status_code=201, summary="Invite someone by email (admins)")
async def add_member(body: OrgMemberIn, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    """Someone with an account joins at once (if they are not part of another organization's work); anyone else
    gets an invitation and joins when they sign up with this email. Each counts against the plan's seats."""
    m = await orgs.require_org_role(conn, user, "admin")
    if body.role == "admin" and m["role"] != "owner":
        raise Problem(403, "Only an owner can add administrators.", code="forbidden")
    email, ip = body.email.lower(), client_ip(request)
    cur = await conn.execute("SELECT id, name, created_at FROM users WHERE lower(email) = %s", (email,))
    target = await cur.fetchone()
    if target:
        if not await orgs.bring_into(conn, target["id"], m["org_id"], body.role):
            raise Problem(409, "That person is already in your organization.", code="already_member")
        await audit(conn, "org.member_add", actor_id=user["id"], target_type="user", target_id=target["id"], ip=ip,
                    org_id=str(m["org_id"]), role=body.role)
        await send_email(email, f"You joined {m['name']} on Geohub",
                         f"{user['name']} added you to the organization \"{m['name']}\" on Geohub. "
                         "You can now be added to its projects and maps.",
                         action=("Open Geohub", settings.app_url), key=f"org-join/{m['org_id']}/{target['id']}")
        cur = await conn.execute("SELECT created_at FROM org_members WHERE user_id = %s", (target["id"],))
        return {"id": target["id"], "user_id": target["id"], "email": email, "name": target["name"], "role": body.role,
                "status": "active", "joined_at": (await cur.fetchone())["created_at"]}
    cur = await conn.execute("SELECT id FROM org_invitations WHERE org_id = %s AND lower(email) = %s", (m["org_id"], email))
    if not await cur.fetchone():
        await orgs.check_limit(conn, m["org_id"], "seats")
    cur = await conn.execute(
        "INSERT INTO org_invitations (org_id, email, role, invited_by) VALUES (%s, %s, %s, %s) "
        "ON CONFLICT (org_id, lower(email)) DO UPDATE SET role = EXCLUDED.role RETURNING id, created_at",
        (m["org_id"], email, body.role, user["id"]))
    inv = await cur.fetchone()
    await audit(conn, "org.member_invite", actor_id=user["id"], target_type="invitation", target_id=inv["id"], ip=ip,
                org_id=str(m["org_id"]), role=body.role, email=email)
    await send_email(email, f"Join {m['name']} on Geohub",
                     f"{user['name']} invited you to join \"{m['name']}\" on Geohub, where the team maps places, "
                     f"collects field data and shares it.\n\nCreate your account with this email address ({email}) "
                     "and you will join the organization straight away.",
                     action=("Create your account", f"{settings.app_url}/login?signup=1&email={quote(email)}"),
                     key=f"org-invite/{inv['id']}/{body.role}")
    return {"id": inv["id"], "user_id": None, "email": email, "name": None, "role": body.role, "status": "invited",
            "joined_at": inv["created_at"]}


async def _target(conn, org_id, user_id) -> dict:
    cur = await conn.execute("SELECT om.role, u.name FROM org_members om JOIN users u ON u.id = om.user_id "
                             "WHERE om.user_id = %s AND om.org_id = %s", (user_id, org_id))
    t = await cur.fetchone()
    if not t:
        raise Problem(404, "That person is not in your organization.", code="not_found")
    return t


async def _owners(conn, org_id) -> int:
    cur = await conn.execute("SELECT count(*) AS n FROM org_members WHERE org_id = %s AND role = 'owner'", (org_id,))
    return (await cur.fetchone())["n"]


@router.patch("/members/{user_id}", response_model=OrgMemberOut, summary="Change someone's role (owners)")
async def set_role(user_id: UUID, body: OrgMemberPatch, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    m = await orgs.require_org_role(conn, user, "owner")
    t = await _target(conn, m["org_id"], user_id)
    if t["role"] == "owner" and body.role != "owner" and await _owners(conn, m["org_id"]) == 1:
        raise Problem(409, "An organization needs at least one owner. Make someone else an owner first.", code="last_owner")
    await conn.execute("UPDATE org_members SET role = %s WHERE user_id = %s", (body.role, user_id))
    await audit(conn, "org.role_change", actor_id=user["id"], target_type="user", target_id=user_id,
                ip=client_ip(request), org_id=str(m["org_id"]), role=body.role)
    cur = await conn.execute("SELECT u.id, u.id AS user_id, u.email, u.name, om.role, 'active' AS status, "
                             "om.created_at AS joined_at FROM org_members om JOIN users u ON u.id = om.user_id "
                             "WHERE om.user_id = %s", (user_id,))
    return await cur.fetchone()


async def _detach(conn, org_id, user_id, new_owner) -> None:
    """Take someone out of an organization: off its projects, and their maps handed to `new_owner`."""
    await conn.execute("DELETE FROM members WHERE user_id = %s AND project_id IN (SELECT id FROM projects WHERE org_id = %s)",
                       (user_id, org_id))
    await conn.execute("DELETE FROM map_members WHERE user_id = %s AND map_id IN (SELECT id FROM workspace_maps WHERE org_id = %s)",
                       (user_id, org_id))
    await conn.execute("UPDATE workspace_maps SET owner_id = %s WHERE owner_id = %s AND org_id = %s", (new_owner, user_id, org_id))
    await conn.execute("DELETE FROM org_members WHERE user_id = %s", (user_id,))


@router.delete("/members/{user_id}", status_code=204, summary="Remove someone from the organization (admins)")
async def remove_member(user_id: UUID, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    """They lose access to the organization's projects and maps. Maps they owned pass to whoever removed them."""
    m = await orgs.require_org_role(conn, user, "admin")
    if user_id == user["id"]:
        raise Problem(409, "To leave the organization yourself, use Leave.", code="use_leave")
    t = await _target(conn, m["org_id"], user_id)
    if t["role"] in ("owner", "admin") and m["role"] != "owner":
        raise Problem(403, "Only an owner can remove an owner or administrator.", code="forbidden")
    if t["role"] == "owner" and await _owners(conn, m["org_id"]) == 1:
        raise Problem(409, "An organization needs at least one owner.", code="last_owner")
    await _detach(conn, m["org_id"], user_id, user["id"])
    await audit(conn, "org.member_remove", actor_id=user["id"], target_type="user", target_id=user_id,
                ip=client_ip(request), org_id=str(m["org_id"]), role=t["role"])
    return Response(status_code=204)


@router.post("/leave", status_code=204, summary="Leave your organization")
async def leave(request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    """On a shared deployment you get a fresh organization of your own; on a private copy you lose access."""
    m = await orgs.require_membership(conn, user)
    if m["role"] == "owner" and await _owners(conn, m["org_id"]) == 1:
        cur = await conn.execute("SELECT count(*) AS n FROM org_members WHERE org_id = %s", (m["org_id"],))
        if (await cur.fetchone())["n"] > 1:
            raise Problem(409, "You are the only owner. Make someone else an owner before you leave.", code="last_owner")
        raise Problem(409, "You are the only person in this organization, so there is nothing to leave.", code="sole_member")
    cur = await conn.execute("SELECT user_id FROM org_members WHERE org_id = %s AND role = 'owner' AND user_id <> %s "
                             "ORDER BY created_at LIMIT 1", (m["org_id"], user["id"]))
    await _detach(conn, m["org_id"], user["id"], (await cur.fetchone())["user_id"])
    await audit(conn, "org.leave", actor_id=user["id"], target_type="user", target_id=user["id"],
                ip=client_ip(request), org_id=str(m["org_id"]))
    return Response(status_code=204)


@router.post("/email-check", summary="Send yourself a test email and report each step (admins)",
             dependencies=[Depends(ratelimit.limit("email-check", 6, 3600))])
async def email_check(user=Depends(current_user), conn=Depends(get_conn)):
    """Checks the email settings, Brevo key and sender, sends a test email to your own address and reports what
    happened to it. It only ever emails the person asking."""
    from ..ops.check_email import diagnose
    await orgs.require_org_role(conn, user, "admin")
    return await diagnose(user["email"])


@router.delete("/invitations/{invitation_id}", status_code=204, summary="Cancel an invitation (admins)")
async def cancel_invitation(invitation_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    m = await orgs.require_org_role(conn, user, "admin")
    cur = await conn.execute("DELETE FROM org_invitations WHERE id = %s AND org_id = %s RETURNING id", (invitation_id, m["org_id"]))
    if not await cur.fetchone():
        raise Problem(404, "Invitation not found.", code="not_found")
    return Response(status_code=204)
