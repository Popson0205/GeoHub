"""The caller's organization: its details, plan and usage, and its people."""
import re
from typing import Literal
from urllib.parse import quote
from uuid import UUID

from email_validator import EmailNotValidError, validate_email
from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, Request, Response, UploadFile

from .. import branding, domains, licence_keys, orgs, peopleimport, products, ratelimit
from ..audit import audit
from ..config import settings
from ..db import get_conn
from ..deps import current_user
from ..errors import Problem
from ..logging_setup import client_ip
from ..mailer import send_email
from .. import passwords
from ..schemas import LicenceKeyPaste, ProductOut, SupportVisitOut, AccountIn, AccountOut, AddableRole, ImportOut, OrgBrandingPatch, OrgDomainIn, OrgDomainOut, OrgDomainPatch, OrgMemberIn, OrgMemberOut, OrgMemberPatch, OrgOut, OrgPatch

router = APIRouter(prefix="/org", tags=["organization"])
public_router = APIRouter(tags=["organization"])


async def _mail(conn, m: dict, to: str, subject: str, body: str, **kw) -> bool:
    """An email sent for the organization: in its name and look when it has branding."""
    return await send_email(to, subject, body, brand=await branding.for_email(conn, m["org_id"]), **kw)


async def _out(conn, m: dict) -> dict:
    return {"id": m["org_id"], "name": m["name"], "slug": m["slug"], "role": m["role"], "plan": m["plan"],
            "plan_name": orgs.PLAN_NAMES.get(m["plan"], m["plan"]), "caps": orgs.caps(m["plan"], m["limits"]),
            "limits": {k: int(v) for k, v in (m["limits"] or {}).items() if k in orgs.LIMIT_LABEL and v is not None},
            "usage": await orgs.usage(conn, m["org_id"]), "subscription_starts": m["subscription_starts"],
            "subscription_ends": m["subscription_ends"], "single_org": settings.single_org,
            "branding": {"color": m["brand_color"], "logo_url": branding.logo_url(m["org_id"], m["logo_updated_at"]),
                         "sender_name": m["email_sender_name"], "reply_to": m["email_reply_to"]},
            "require_mfa": m["require_mfa"]}


@router.get("", response_model=OrgOut, summary="Your organization, its plan and what it uses")
async def get_org(user=Depends(current_user), conn=Depends(get_conn)):
    return await _out(conn, await orgs.require_membership(conn, user))


@router.get("/products", response_model=list[ProductOut], summary="The GeoEstate products your organization has, Geohub first")
async def get_products(user=Depends(current_user), conn=Depends(get_conn)):
    m = await orgs.require_membership(conn, user)
    return await products.of_org(conn, m["org_id"])


@router.get("/licence-key", summary="This installation's licence key (on customers' own installations)")
async def get_licence_key(user=Depends(current_user), conn=Depends(get_conn)):
    return {"required": settings.licence_required, "installed": await licence_keys.installed(conn),
            "can_check": bool(licence_keys.trusted()), "installation": settings.app_url}


@router.put("/licence-key", summary="Install a new licence key from GeoEstate (owners and admins)")
async def put_licence_key(body: LicenceKeyPaste, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    m = await orgs.require_membership(conn, user)
    if m["role"] not in ("owner", "admin"):
        raise Problem(403, "Only the organization's owners and administrators can install a licence key.", code="forbidden")
    if not settings.licence_required:
        raise Problem(409, "This Geohub is run by GeoEstate: its licences are managed for you, without a key.", code="not_installation")
    out = await licence_keys.install(conn, m["org_id"], body.key, user["id"])
    await audit(conn, "org.licence_key", actor_id=user["id"], target_type="organization", target_id=m["org_id"], ip=client_ip(request),
                key_id=out["id"])
    return {"required": True, "installed": await licence_keys.installed(conn), "can_check": True, "installation": settings.app_url}


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
        " SELECT u.id, u.id AS user_id, u.email, u.name, om.role, 'active' AS status, om.created_at AS joined_at, "
        "  (u.totp_enabled_at IS NOT NULL) AS mfa_enabled "
        "  FROM org_members om JOIN users u ON u.id = om.user_id WHERE om.org_id = %(o)s "
        " UNION ALL "
        " SELECT i.id, NULL, i.email, NULL, i.role, 'invited', i.created_at, NULL FROM org_invitations i WHERE i.org_id = %(o)s"
        ") x ORDER BY (status = 'active') DESC, array_position(ARRAY['owner','admin','member','collector','viewer'], role), lower(email)",
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
        await _mail(conn, m, email, f"You joined {m['name']} on Geohub",
                         f"{user['name']} added you to the organization \"{m['name']}\" on Geohub. "
                         "You can now be added to its projects and maps.",
                         action=("Open Geohub", settings.app_url), key=f"org-join/{m['org_id']}/{target['id']}")
        cur = await conn.execute("SELECT created_at FROM org_members WHERE user_id = %s", (target["id"],))
        return {"id": target["id"], "user_id": target["id"], "email": email, "name": target["name"], "role": body.role,
                "status": "active", "joined_at": (await cur.fetchone())["created_at"]}
    cur = await conn.execute("SELECT id FROM org_invitations WHERE org_id = %s AND lower(email) = %s", (m["org_id"], email))
    if not await cur.fetchone():
        await orgs.check_limit(conn, m["org_id"], orgs.KIND_OF_ROLE[body.role])
    cur = await conn.execute(
        "INSERT INTO org_invitations (org_id, email, role, invited_by) VALUES (%s, %s, %s, %s) "
        "ON CONFLICT (org_id, lower(email)) DO UPDATE SET role = EXCLUDED.role RETURNING id, created_at",
        (m["org_id"], email, body.role, user["id"]))
    inv = await cur.fetchone()
    await audit(conn, "org.member_invite", actor_id=user["id"], target_type="invitation", target_id=inv["id"], ip=ip,
                org_id=str(m["org_id"]), role=body.role, email=email)
    await _mail(conn, m, email, f"Join {m['name']} on Geohub",
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
    if orgs.KIND_OF_ROLE[body.role] != orgs.KIND_OF_ROLE[t["role"]]:
        await orgs.check_limit(conn, m["org_id"], orgs.KIND_OF_ROLE[body.role])
    await conn.execute("UPDATE org_members SET role = %s WHERE user_id = %s", (body.role, user_id))
    # someone who becomes a field collector or viewer keeps their projects, in the role that kind allows
    if body.role in ("collector", "viewer"):
        # only team seats lead a team
        await conn.execute("UPDATE team_members SET lead = false WHERE user_id = %s AND lead", (user_id,))
        await conn.execute("UPDATE members SET role = %s WHERE user_id = %s AND role <> %s "
                           "AND project_id IN (SELECT id FROM projects WHERE org_id = %s)", (body.role, user_id, body.role, m["org_id"]))
        if body.role == "collector":
            await conn.execute("UPDATE map_members SET role = 'contributor' WHERE user_id = %s "
                               "AND map_id IN (SELECT id FROM workspace_maps WHERE org_id = %s)", (user_id, m["org_id"]))
        else:
            await conn.execute("DELETE FROM map_members WHERE user_id = %s AND map_id IN "
                               "(SELECT id FROM workspace_maps WHERE org_id = %s)", (user_id, m["org_id"]))
    await audit(conn, "org.role_change", actor_id=user["id"], target_type="user", target_id=user_id,
                ip=client_ip(request), org_id=str(m["org_id"]), role=body.role)
    cur = await conn.execute("SELECT u.id, u.id AS user_id, u.email, u.name, om.role, 'active' AS status, "
                             "om.created_at AS joined_at FROM org_members om JOIN users u ON u.id = om.user_id "
                             "WHERE om.user_id = %s", (user_id,))
    return await cur.fetchone()


async def _detach(conn, org_id, user_id, new_owner) -> None:
    """Take someone out of an organization: off its projects and teams, their maps handed to `new_owner`, and their
    API keys revoked."""
    await conn.execute("DELETE FROM members WHERE user_id = %s AND project_id IN (SELECT id FROM projects WHERE org_id = %s)",
                       (user_id, org_id))
    await conn.execute("DELETE FROM map_members WHERE user_id = %s AND map_id IN (SELECT id FROM workspace_maps WHERE org_id = %s)",
                       (user_id, org_id))
    await conn.execute("UPDATE workspace_maps SET owner_id = %s WHERE owner_id = %s AND org_id = %s", (new_owner, user_id, org_id))
    await conn.execute("DELETE FROM team_members WHERE user_id = %s AND team_id IN (SELECT id FROM org_teams WHERE org_id = %s)",
                       (user_id, org_id))
    await conn.execute("UPDATE api_keys SET revoked_at = now() WHERE user_id = %s AND org_id = %s AND revoked_at IS NULL",
                       (user_id, org_id))
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


@router.get("/support-visits", response_model=list[SupportVisitOut], summary="When GeoEstate support opened your projects (admins)")
async def support_visits(user=Depends(current_user), conn=Depends(get_conn)):
    from .admin import visits
    m = await orgs.require_org_role(conn, user, "admin")
    return await visits(conn, m["org_id"], 50)


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


# ---------- accounts made by an admin ----------
ROLE_WORDS = {"admin": "an administrator", "member": "a member", "collector": "a field collector", "viewer": "a viewer"}
DEFAULT_PROJECT_ROLE = {"admin": "admin", "member": "admin", "collector": "collector", "viewer": "viewer"}


def _welcome_mail(m: dict, admin: dict, name: str, email: str, role: str, raw: str) -> tuple:
    return (email, f"Your Geohub account for {m['name']}",
            f"Hello {name},\n\n{admin['name']} created a Geohub account for you in \"{m['name']}\", as {ROLE_WORDS[role]}.\n\n"
            f"Your sign-in email is {email}. Choose your password with the button below; the link works once, within 72 hours. "
            "If it has expired, ask your administrator to send it again.",
            ("Set your password", f"{settings.app_url}/set-password?token={raw}"))


async def _welcome(conn, m: dict, admin: dict, name: str, email: str, role: str, raw: str) -> bool:
    to, subject, text, action = _welcome_mail(m, admin, name, email, role, raw)
    return await _mail(conn, m, to, subject, text, action=action)


async def _make_account(conn, m: dict, admin: dict, email: str, name: str, role: str, delivery: str, grants: list[tuple],
                        ip: str, via: str = "single") -> dict:
    """Make (or bring in) one person's account, in the organization and the given projects. Returns who it is and the
    email to send them, which the caller sends now or after the request."""
    cur = await conn.execute("SELECT id, name FROM users WHERE lower(email) = %s", (email,))
    existing = await cur.fetchone()
    temporary = None
    if existing:
        # someone who signed up on their own with nothing in their account yet is brought in; anyone else is refused
        if not await orgs.bring_into(conn, existing["id"], m["org_id"], role):
            raise Problem(409, "That person is already in your organization.", code="already_member")
        uid, name = existing["id"], existing["name"]
        mail = (email, f"You joined {m['name']} on Geohub",
                f"{admin['name']} added your Geohub account to \"{m['name']}\", as {ROLE_WORDS[role]}. "
                "Sign in with your usual password.", ("Open Geohub", settings.app_url))
    else:
        await orgs.check_limit(conn, m["org_id"], orgs.KIND_OF_ROLE[role])
        temporary = passwords.temporary_password() if delivery == "temporary" else None
        pw_hash = await (passwords.hash_password(temporary) if temporary else passwords.unusable_hash())
        cur = await conn.execute(
            "INSERT INTO users (email, name, password_hash, must_change_password) VALUES (%s, %s, %s, %s) RETURNING id",
            (email, name, pw_hash, bool(temporary)))
        uid = (await cur.fetchone())["id"]
        await conn.execute("INSERT INTO org_members (user_id, org_id, role) VALUES (%s, %s, %s)", (uid, m["org_id"], role))
        await conn.execute("DELETE FROM org_invitations WHERE org_id = %s AND lower(email) = %s", (m["org_id"], email))
        mail = None if temporary else _welcome_mail(m, admin, name, email, role, await passwords.issue(conn, uid, "set"))
    for project_id, prole in grants:
        prole = prole or DEFAULT_PROJECT_ROLE[role]
        await orgs.check_project_role(conn, uid, prole)
        await conn.execute("INSERT INTO members (project_id, user_id, role) VALUES (%s, %s, %s) "
                           "ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role", (project_id, uid, prole))
    await audit(conn, "org.account_create", actor_id=admin["id"], target_type="user", target_id=uid, ip=ip,
                org_id=str(m["org_id"]), role=role, delivery="existing" if existing else delivery, projects=len(grants), via=via)
    return {"id": uid, "name": name, "existing": bool(existing), "temporary": temporary, "mail": mail}


@router.post("/accounts", response_model=AccountOut, status_code=201, summary="Create an account for someone (admins)")
async def create_account(body: AccountIn, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    """The person gets an account straight away, in the organization and the projects given, and either an email
    with a one-time link to set their password, or a temporary password shown here once (they choose their own at
    first sign-in). It uses one place of the role's kind: a team seat, a field collector or a viewer."""
    m = await orgs.require_org_role(conn, user, "admin")
    if body.role == "admin" and m["role"] != "owner":
        raise Problem(403, "Only an owner can add administrators.", code="forbidden")
    email = body.email.lower()
    # every project named must belong to this organization
    pids = [g.project_id for g in body.projects]
    if pids:
        cur = await conn.execute("SELECT id FROM projects WHERE org_id = %s AND id = ANY(%s)", (m["org_id"], pids))
        found = {r["id"] for r in await cur.fetchall()}
        if len(found) != len(set(pids)):
            raise Problem(422, "Some of those projects are not in your organization.", code="validation",
                          fields={"projects": ["unknown project"]})
    a = await _make_account(conn, m, user, email, body.name.strip(), body.role, body.delivery,
                            [(g.project_id, g.role) for g in body.projects], client_ip(request))
    sent = False
    if a["mail"]:
        to, subject, text, action = a["mail"]
        sent = await _mail(conn, m, to, subject, text, action=action)
    cur = await conn.execute("SELECT created_at FROM org_members WHERE user_id = %s", (a["id"],))
    return {"member": {"id": a["id"], "user_id": a["id"], "email": email, "name": a["name"], "role": body.role, "status": "active",
                       "joined_at": (await cur.fetchone())["created_at"]},
            "temporary_password": a["temporary"], "email_sent": sent}


@router.post("/accounts/import", response_model=ImportOut, summary="Add many people from a spreadsheet (admins)",
             dependencies=[Depends(ratelimit.limit("accounts-import", 30, 3600))])
async def import_accounts(request: Request, background: BackgroundTasks, file: UploadFile = File(...),
                          preview: bool = Form(True), delivery: Literal["email", "temporary"] = Form("email"),
                          default_role: AddableRole = Form("collector"), user=Depends(current_user), conn=Depends(get_conn)):
    """A CSV or Excel (.xlsx) file with columns email and name, and optionally role, team and projects (names,
    separated by ;). First send it with preview=true to see what would happen to each row; nothing is changed. Then
    send it with preview=false to make the accounts: all of them, or none if any row has a problem or the plan has
    no room. Welcome emails go out after the accounts are made."""
    m = await orgs.require_org_role(conn, user, "admin")
    rows = peopleimport.read(file.filename or "", await file.read(peopleimport.MAX_BYTES + 1))
    cur = await conn.execute("SELECT id, lower(name) AS key, name FROM org_teams WHERE org_id = %s", (m["org_id"],))
    teams = {t["key"]: t for t in await cur.fetchall()}
    cur = await conn.execute("SELECT id, lower(name) AS key FROM projects WHERE org_id = %s", (m["org_id"],))
    projects: dict[str, list] = {}
    for p in await cur.fetchall():
        projects.setdefault(p["key"], []).append(p["id"])
    emails = [r["email"] for r in rows]
    cur = await conn.execute(
        "SELECT lower(u.email) AS email, om.org_id, (om.org_id = %s) AS here FROM users u "
        "LEFT JOIN org_members om ON om.user_id = u.id WHERE lower(u.email) = ANY(%s)", (m["org_id"], emails))
    accounts = {a["email"]: a for a in await cur.fetchall()}
    cur = await conn.execute("SELECT lower(email) AS email, role FROM org_invitations WHERE org_id = %s AND lower(email) = ANY(%s)",
                             (m["org_id"], emails))
    invited = {i["email"]: i["role"] for i in await cur.fetchall()}
    seen: set[str] = set()
    needed = {k: 0 for k in orgs.PEOPLE_KINDS}
    out = []
    for r in rows:
        role = peopleimport.role_of(r["role"], default_role)
        res = {**r, "role": role or r["role"] or default_role, "status": "new", "error": None}
        problems = []
        try:
            validate_email(r["email"], check_deliverability=False)
        except EmailNotValidError:
            problems.append("Not an email address.")
        if not r["name"]:
            problems.append("Name is empty.")
        if r["email"] in seen:
            problems.append("This email is in the file twice.")
        seen.add(r["email"])
        if role is None:
            problems.append(f"Unknown role “{r['role']}”. Use member, field collector or viewer" + (", or admin." if m["role"] == "owner" else "."))
        elif role == "admin" and m["role"] != "owner":
            problems.append("Only an owner can add administrators.")
        if r["team"] and r["team"].lower() not in teams:
            problems.append(f"No team called “{r['team']}”. Make it under Teams first.")
        for pname in r["projects"]:
            found = projects.get(pname.lower(), [])
            if not found:
                problems.append(f"No project called “{pname}”.")
            elif len(found) > 1:
                problems.append(f"More than one project is called “{pname}”. Rename one, then try again.")
        a = accounts.get(r["email"])
        if a:
            if a["here"]:
                problems.append("Already in your organization.")
            elif a["org_id"] and not await orgs.is_empty_solo(conn, a["org_id"]):
                problems.append("Has an account in another organization. They need to leave it first.")
            else:
                res["status"] = "existing"
        if problems:
            res["status"], res["error"] = "error", " ".join(problems)
        elif role:
            kind = orgs.KIND_OF_ROLE[role]
            # a pending invitation for this email already holds a place of its kind
            if not (r["email"] in invited and orgs.KIND_OF_ROLE[invited[r["email"]]] == kind):
                needed[kind] += 1
        out.append(res)
    cur = await conn.execute("SELECT plan, limits FROM organizations WHERE id = %s", (m["org_id"],))
    o = await cur.fetchone()
    caps, usage = orgs.caps(o["plan"], o["limits"]), await orgs.usage(conn, m["org_id"])
    capacity = [{"kind": k, "needed": needed[k], "left": None if caps[k] is None else max(0, caps[k] - usage[k])}
                for k in orgs.PEOPLE_KINDS if needed[k]]
    ok = all(r["status"] != "error" for r in out) and all(c["left"] is None or c["needed"] <= c["left"] for c in capacity)
    if preview:
        return {"rows": out, "capacity": capacity, "ok": ok, "done": False}
    if not ok:
        raise Problem(422, "Nothing was added. Fix the rows marked in the preview (or make room on the plan), then try again.",
                      code="import_has_problems")
    brand = await branding.for_email(conn, m["org_id"])
    ip, queued = client_ip(request), 0
    for res in out:
        grants = [(projects[p.lower()][0], None) for p in res["projects"]]
        a = await _make_account(conn, m, user, res["email"], res["name"], res["role"], delivery, grants, ip, via="import")
        if res["team"]:
            await conn.execute("INSERT INTO team_members (team_id, user_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                               (teams[res["team"].lower()]["id"], a["id"]))
            res["team"] = teams[res["team"].lower()]["name"]
        res["status"] = "added" if a["existing"] else "created"
        res["temporary_password"] = a["temporary"]
        if a["mail"]:
            to, subject, text, action = a["mail"]
            background.add_task(send_email, to, subject, text, action=action, brand=brand)
            queued += 1
    await audit(conn, "org.accounts_import", actor_id=user["id"], target_type="organization", target_id=m["org_id"], ip=ip,
                org_id=str(m["org_id"]), people=len(out), delivery=delivery)
    return {"rows": out, "capacity": capacity, "ok": True, "done": True, "emails_queued": queued}


@router.post("/members/{user_id}/send-link", status_code=202, summary="Email someone a new set-password link (admins)")
async def send_link(user_id: UUID, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    """For a welcome link that expired or went astray, or a forgotten password. Older links stop working."""
    m = await orgs.require_org_role(conn, user, "admin")
    t = await _target(conn, m["org_id"], user_id)
    if t["role"] in ("owner", "admin") and m["role"] != "owner" and user_id != user["id"]:
        raise Problem(403, "Only an owner can send a link to an owner or administrator.", code="forbidden")
    cur = await conn.execute("SELECT email FROM users WHERE id = %s", (user_id,))
    email = (await cur.fetchone())["email"]
    sent = await _welcome(conn, m, user, t["name"], email, t["role"] if t["role"] != "owner" else "admin",
                          await passwords.issue(conn, user_id, "set"))
    await audit(conn, "org.send_link", actor_id=user["id"], target_type="user", target_id=user_id,
                ip=client_ip(request), org_id=str(m["org_id"]))
    return {"sent": sent}


# ---------- company email domains ----------
async def _domain_admin(conn, user) -> dict:
    m = await orgs.require_org_role(conn, user, "admin")
    if m["plan"] == "individual":
        raise Problem(403, "Joining by company email domain comes with Organization plans. Ask GeoEstate for one.",
                      code="plan_feature")
    return m


async def _own_domain(conn, org_id, domain: str) -> dict:
    cur = await conn.execute("SELECT * FROM org_domains WHERE domain = %s AND org_id = %s", (domain.lower(), org_id))
    row = await cur.fetchone()
    if not row:
        raise Problem(404, "That domain is not one of your organization's.", code="not_found")
    return row


@router.get("/domains", response_model=list[OrgDomainOut], summary="Company email domains (admins)")
async def list_domains(user=Depends(current_user), conn=Depends(get_conn)):
    m = await orgs.require_org_role(conn, user, "admin")
    cur = await conn.execute("SELECT * FROM org_domains WHERE org_id = %s ORDER BY created_at", (m["org_id"],))
    return [domains.out(r) for r in await cur.fetchall()]


@router.post("/domains", response_model=OrgDomainOut, status_code=201, summary="Add a company email domain (admins)")
async def add_domain(body: OrgDomainIn, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    """Added unverified, with the DNS TXT record that proves ownership. Nobody joins by it until it is verified."""
    m = await _domain_admin(conn, user)
    d = domains.normalize(body.domain)
    cur = await conn.execute("SELECT org_id FROM org_domains WHERE domain = %s", (d,))
    taken = await cur.fetchone()
    if taken:
        raise Problem(409, f"{d} is already added" + (" to your organization." if taken["org_id"] == m["org_id"] else
                      " to another organization. If it is yours, contact GeoEstate."), code="domain_taken", fields={"domain": ["taken"]})
    cur = await conn.execute("INSERT INTO org_domains (domain, org_id, verify_token) VALUES (%s, %s, %s) RETURNING *",
                             (d, m["org_id"], domains.new_token()))
    await audit(conn, "org.domain_add", actor_id=user["id"], target_type="organization", target_id=m["org_id"], ip=client_ip(request), domain=d)
    return domains.out(await cur.fetchone())


@router.post("/domains/{domain}/verify", response_model=OrgDomainOut, summary="Check the domain's DNS record now (admins)",
             dependencies=[Depends(ratelimit.limit("domain-verify", 20, 3600))])
async def verify_domain(domain: str, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    m = await _domain_admin(conn, user)
    row = await _own_domain(conn, m["org_id"], domain)
    if row["verified_at"] is None:
        try:
            found = await domains.has_txt(row["domain"], row["verify_token"])
        except Exception:  # noqa: BLE001
            raise Problem(502, "Could not look up the domain's DNS just now. Try again in a minute.", code="dns_unavailable")
        if not found:
            raise Problem(422, f"The TXT record was not found on {row['domain']} yet. Add it at your domain registrar "
                               "(name: @ or the domain itself; value: " + domains.txt_value(row["verify_token"]) + "). "
                               "New records can take up to an hour to appear.", code="not_verified")
        cur = await conn.execute("UPDATE org_domains SET verified_at = now() WHERE domain = %s RETURNING *", (row["domain"],))
        row = await cur.fetchone()
        await audit(conn, "org.domain_verify", actor_id=user["id"], target_type="organization", target_id=m["org_id"],
                    ip=client_ip(request), domain=row["domain"], via="dns")
    return domains.out(row)


@router.patch("/domains/{domain}", response_model=OrgDomainOut, summary="Turn joining on or off, or change the role (admins)")
async def update_domain(domain: str, body: OrgDomainPatch, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    m = await _domain_admin(conn, user)
    row = await _own_domain(conn, m["org_id"], domain)
    cur = await conn.execute("UPDATE org_domains SET auto_join = COALESCE(%s, auto_join), role = COALESCE(%s, role) "
                             "WHERE domain = %s RETURNING *", (body.auto_join, body.role, row["domain"]))
    await audit(conn, "org.domain_update", actor_id=user["id"], target_type="organization", target_id=m["org_id"],
                ip=client_ip(request), domain=row["domain"], **body.model_dump(exclude_none=True))
    return domains.out(await cur.fetchone())


@router.delete("/domains/{domain}", status_code=204, summary="Remove a company email domain (admins)")
async def remove_domain(domain: str, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    m = await orgs.require_org_role(conn, user, "admin")
    row = await _own_domain(conn, m["org_id"], domain)
    await conn.execute("DELETE FROM org_domains WHERE domain = %s", (row["domain"],))
    await audit(conn, "org.domain_remove", actor_id=user["id"], target_type="organization", target_id=m["org_id"],
                ip=client_ip(request), domain=row["domain"])
    return Response(status_code=204)


# ---------- branding ----------
async def _brand_admin(conn, user) -> dict:
    m = await orgs.require_org_role(conn, user, "admin")
    if m["plan"] == "individual":
        raise Problem(403, "Your own logo, colour and email sender come with Organization plans. Ask GeoEstate for one.",
                      code="plan_feature")
    return m


@router.patch("/branding", response_model=OrgOut, summary="Set the organization's colour and email sender (admins)")
async def update_branding(body: OrgBrandingPatch, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    m = await _brand_admin(conn, user)
    sets, params = [], []
    if body.color is not None:
        sets.append("brand_color = %s"); params.append(branding.normalize_color(body.color) if body.color.strip() else None)
    if body.sender_name is not None:
        name = " ".join(body.sender_name.replace("<", "").replace(">", "").replace('"', "").split())
        sets.append("email_sender_name = %s"); params.append(name or None)
    if body.reply_to is not None:
        reply = body.reply_to.strip().lower()
        if reply and not re.fullmatch(r"[^@\s<>\"]+@[^@\s<>\"]+\.[a-z]{2,}", reply):
            raise Problem(422, "Enter an email address for replies.", code="validation", fields={"reply_to": ["not an email"]})
        sets.append("email_reply_to = %s"); params.append(reply or None)
    if sets:
        await conn.execute(f"UPDATE organizations SET {', '.join(sets)} WHERE id = %s", (*params, m["org_id"]))
        await audit(conn, "org.branding", actor_id=user["id"], target_type="organization", target_id=m["org_id"],
                    ip=client_ip(request), **body.model_dump(exclude_none=True))
    return await _out(conn, await orgs.membership(conn, user["id"]))


@router.put("/branding/logo", response_model=OrgOut, summary="Upload the organization's logo (admins)",
            dependencies=[Depends(ratelimit.limit("logo-upload", 20, 3600))])
async def upload_logo(request: Request, file: UploadFile = File(...), user=Depends(current_user), conn=Depends(get_conn)):
    """PNG, JPEG or WebP up to 1 MB; stored as a PNG of at most 512 px. A wide logo on a clear background looks best."""
    m = await _brand_admin(conn, user)
    png = branding.clean_logo(await file.read(branding.MAX_LOGO_BYTES + 1))
    await conn.execute("UPDATE organizations SET logo = %s, logo_updated_at = now() WHERE id = %s", (png, m["org_id"]))
    await audit(conn, "org.logo", actor_id=user["id"], target_type="organization", target_id=m["org_id"], ip=client_ip(request), bytes=len(png))
    return await _out(conn, await orgs.membership(conn, user["id"]))


@router.delete("/branding/logo", response_model=OrgOut, summary="Remove the organization's logo (admins)")
async def remove_logo(request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    m = await orgs.require_org_role(conn, user, "admin")
    await conn.execute("UPDATE organizations SET logo = NULL, logo_updated_at = NULL WHERE id = %s", (m["org_id"],))
    await audit(conn, "org.logo", actor_id=user["id"], target_type="organization", target_id=m["org_id"], ip=client_ip(request), removed=True)
    return await _out(conn, await orgs.membership(conn, user["id"]))


@public_router.get("/orgs/{org_id}/logo", summary="An organization's logo (public: it appears in emails)")
async def logo(org_id: UUID, conn=Depends(get_conn)):
    cur = await conn.execute("SELECT logo FROM organizations WHERE id = %s AND logo IS NOT NULL", (org_id,))
    row = await cur.fetchone()
    if not row:
        raise Problem(404, "No logo.", code="not_found")
    # the URL carries ?v=<time of upload>, so a new logo is a new URL and this one can be kept a long time
    return Response(bytes(row["logo"]), media_type="image/png",
                    headers={"Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff",
                             "Content-Security-Policy": "default-src 'none'; sandbox"})
