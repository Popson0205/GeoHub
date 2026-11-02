"""For GeoEstate staff (PLATFORM_ADMINS): set up client organizations, their plans and subscription dates, and answer
requests made from the website. Plus the public "Request an organization" form."""
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from psycopg.types.json import Jsonb

from .. import domains, orgs, passwords, ratelimit
from ..audit import audit
from ..config import settings
from ..db import get_conn
from ..deps import platform_admin, platform_admin_emails
from ..errors import Problem
from ..logging_setup import client_ip
from ..mailer import send_email
from ..schemas import OrgDomainIn, OrgDomainOut, AdminOrgIn, AdminOrgOut, AdminOrgPatch, OrgRequestIn, OrgRequestOut, OrgRequestPatch

router = APIRouter(tags=["platform admin"])

ORG_SQL = (
    "SELECT o.id, o.name, o.slug, o.plan, o.limits, o.subscription_starts, o.subscription_ends, o.created_at, "
    "  (o.subscription_ends - current_date) AS days_left, ou.name AS owner_name, ou.email AS owner_email, "
    "  ARRAY(SELECT domain || CASE WHEN verified_at IS NULL THEN ' (unverified)' ELSE '' END FROM org_domains "
    "        WHERE org_id = o.id ORDER BY created_at) AS domains "
    "FROM organizations o "
    "LEFT JOIN LATERAL (SELECT u.name, u.email FROM org_members m JOIN users u ON u.id = m.user_id "
    "  WHERE m.org_id = o.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) ou ON true ")


async def _org(conn, row) -> dict:
    return {**row, "plan_name": orgs.PLAN_NAMES.get(row["plan"], row["plan"]), "caps": orgs.caps(row["plan"], row["limits"]),
            "limits": {k: int(v) for k, v in (row["limits"] or {}).items() if v is not None},
            "usage": await orgs.usage(conn, row["id"])}


@router.get("/admin/orgs", response_model=list[AdminOrgOut], summary="Client organizations")
async def list_orgs(q: str | None = None, plan: str | None = None, paid_only: bool = Query(True, description="Hide Individual accounts"),
                    admin=Depends(platform_admin), conn=Depends(get_conn)):
    where, params = ["true"], []
    if paid_only:
        where.append("o.plan <> 'individual'")
    if plan:
        where.append("o.plan = %s"); params.append(plan)
    if q:
        where.append("(o.name ILIKE %s OR o.slug ILIKE %s OR ou.email ILIKE %s)"); params += [f"%{q}%"] * 3
    cur = await conn.execute(ORG_SQL + "WHERE " + " AND ".join(where) +
                             " ORDER BY o.subscription_ends NULLS LAST, o.name LIMIT 500", params)
    return [await _org(conn, r) for r in await cur.fetchall()]


@router.post("/admin/orgs", response_model=AdminOrgOut, status_code=201, summary="Set up a client organization and its owner")
async def create_org(body: AdminOrgIn, request: Request, admin=Depends(platform_admin), conn=Depends(get_conn)):
    """Creates the organization on its plan and dates, and its owner's account. A new owner gets an email to set
    their password; someone who signed up on their own with nothing made yet is moved in; anyone else is refused."""
    if body.subscription_starts and body.subscription_ends and body.subscription_ends < body.subscription_starts:
        raise Problem(422, "The subscription cannot end before it starts.", code="validation", fields={"subscription_ends": ["before start"]})
    email = body.owner_email.lower()
    cur = await conn.execute("SELECT u.id, u.name, om.org_id FROM users u LEFT JOIN org_members om ON om.user_id = u.id "
                             "WHERE lower(u.email) = %s", (email,))
    existing = await cur.fetchone()
    if existing and existing["org_id"] and not await orgs.is_empty_solo(conn, existing["org_id"]):
        raise Problem(409, "That email already belongs to an organization with work in it. Use another email for the owner.",
                      code="other_organization", fields={"owner_email": ["already in use"]})
    if existing:
        uid = existing["id"]
        if existing["org_id"]:
            await conn.execute("DELETE FROM organizations WHERE id = %s", (existing["org_id"],))
    else:
        cur = await conn.execute("INSERT INTO users (email, name, password_hash) VALUES (%s, %s, %s) RETURNING id",
                                 (email, body.owner_name.strip(), await passwords.unusable_hash()))
        uid = (await cur.fetchone())["id"]
    org = await orgs.create_org(conn, body.name, uid, plan=body.plan)
    await conn.execute("UPDATE organizations SET subscription_starts = %s, subscription_ends = %s, limits = %s WHERE id = %s",
                       (body.subscription_starts, body.subscription_ends, Jsonb(body.limits), org["id"]))
    if body.request_id:
        await conn.execute("UPDATE org_requests SET status = 'set_up', org_id = %s, updated_at = now() WHERE id = %s",
                           (org["id"], body.request_id))
    link = (f"{settings.app_url}/set-password?token={await passwords.issue(conn, uid, 'set')}" if not existing
            else settings.app_url)
    await send_email(email, f"Your Geohub organization {body.name} is ready",
                     f"Hello {body.owner_name.split()[0] if not existing else existing['name'].split()[0]},\n\n"
                     f"Your organization \"{body.name}\" is set up on Geohub, on the {orgs.PLAN_NAMES[body.plan]} plan, "
                     "and you are its owner. "
                     + ("Choose your password with the button below (the link works once, within 72 hours), then "
                        if not existing else "Sign in with your usual password, then ")
                     + "open Organization in the account menu to add your team.",
                     action=("Set your password" if not existing else "Open Geohub", link))
    await audit(conn, "platform.org_create", actor_id=admin["id"], target_type="organization", target_id=org["id"],
                ip=client_ip(request), plan=body.plan, owner=email)
    cur = await conn.execute(ORG_SQL + "WHERE o.id = %s", (org["id"],))
    return await _org(conn, await cur.fetchone())


@router.patch("/admin/orgs/{org_id}", response_model=AdminOrgOut, summary="Change an organization's plan, dates or caps")
async def update_org(org_id: UUID, body: AdminOrgPatch, request: Request, admin=Depends(platform_admin), conn=Depends(get_conn)):
    cur = await conn.execute("SELECT subscription_starts, subscription_ends FROM organizations WHERE id = %s", (org_id,))
    now = await cur.fetchone()
    if not now:
        raise Problem(404, "Organization not found.", code="not_found")
    sets, params = [], []
    if body.name is not None:
        sets.append("name = %s"); params.append(body.name.strip())
    if body.plan is not None:
        sets.append("plan = %s"); params.append(body.plan)
    if body.clear_dates:
        sets.append("subscription_starts = NULL, subscription_ends = NULL")
    else:
        starts = body.subscription_starts or now["subscription_starts"]
        ends = body.subscription_ends or now["subscription_ends"]
        if starts and ends and ends < starts:
            raise Problem(422, "The subscription cannot end before it starts.", code="validation", fields={"subscription_ends": ["before start"]})
        if body.subscription_starts is not None:
            sets.append("subscription_starts = %s"); params.append(body.subscription_starts)
        if body.subscription_ends is not None:
            sets.append("subscription_ends = %s"); params.append(body.subscription_ends)
    if body.limits is not None:
        sets.append("limits = %s"); params.append(Jsonb(body.limits))
    if sets:
        await conn.execute(f"UPDATE organizations SET {', '.join(sets)} WHERE id = %s", (*params, org_id))
        await audit(conn, "platform.org_update", actor_id=admin["id"], target_type="organization", target_id=org_id,
                    ip=client_ip(request), **body.model_dump(exclude_none=True, mode="json"))
    cur = await conn.execute(ORG_SQL + "WHERE o.id = %s", (org_id,))
    return await _org(conn, await cur.fetchone())


@router.post("/admin/orgs/{org_id}/domains", response_model=OrgDomainOut, status_code=201,
             summary="Add a company email domain, already verified (staff checked it)")
async def admin_add_domain(org_id: UUID, body: OrgDomainIn, request: Request, admin=Depends(platform_admin), conn=Depends(get_conn)):
    d = domains.normalize(body.domain)
    cur = await conn.execute("SELECT org_id FROM org_domains WHERE domain = %s", (d,))
    taken = await cur.fetchone()
    if taken and taken["org_id"] != org_id:
        raise Problem(409, f"{d} belongs to another organization. Remove it there first.", code="domain_taken", fields={"domain": ["taken"]})
    cur = await conn.execute(
        "INSERT INTO org_domains (domain, org_id, verify_token, verified_at) VALUES (%s, %s, %s, now()) "
        "ON CONFLICT (domain) DO UPDATE SET verified_at = COALESCE(org_domains.verified_at, now()) RETURNING *",
        (d, org_id, domains.new_token()))
    await audit(conn, "org.domain_verify", actor_id=admin["id"], target_type="organization", target_id=org_id,
                ip=client_ip(request), domain=d, via="platform_admin")
    return domains.out(await cur.fetchone())


# ---------- requests from the website ----------
@router.post("/org-requests", status_code=202, summary="Ask GeoEstate for an organization (public)",
             dependencies=[Depends(ratelimit.limit("org-request", 5, 3600))])
async def request_org(body: OrgRequestIn, request: Request, conn=Depends(get_conn)):
    if body.website:                               # only robots fill in the hidden field: accept quietly, keep nothing
        return {"received": True}
    cur = await conn.execute(
        "INSERT INTO org_requests (organization, contact_name, email, phone, plan, team_size, message) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
        (body.organization.strip(), body.contact_name.strip(), body.email.lower(), body.phone, body.plan,
         body.team_size, body.message))
    rid = (await cur.fetchone())["id"]
    plan = {"standard": "Organization Standard", "advanced": "Organization Advanced", "custom": "Custom", "unsure": "not sure yet"}[body.plan]
    for to in platform_admin_emails():
        await send_email(to, f"Organization request: {body.organization}",
                         f"{body.contact_name} ({body.email}{', ' + body.phone if body.phone else ''}) asked for an "
                         f"organization for \"{body.organization}\".\n\nPlan: {plan}\nTeam size: {body.team_size or 'not given'}\n\n"
                         f"{body.message or ''}", action=("Open the requests", f"{settings.app_url}/admin?tab=requests"),
                         key=f"org-request/{rid}")
    await send_email(body.email, "We received your Geohub request",
                     f"Hello {body.contact_name.split()[0]},\n\nThank you for asking about Geohub for \"{body.organization}\". "
                     "GeoEstate NIG Limited will contact you within two working days with an invoice and next steps.",
                     key=f"org-request-ack/{rid}")
    return {"received": True}


@router.get("/admin/requests", response_model=list[OrgRequestOut], summary="Organization requests, newest first")
async def list_requests(status: str | None = None, admin=Depends(platform_admin), conn=Depends(get_conn)):
    cur = await conn.execute("SELECT * FROM org_requests WHERE (%s::text IS NULL OR status = %s) ORDER BY created_at DESC LIMIT 500",
                             (status, status))
    return await cur.fetchall()


@router.patch("/admin/requests/{request_id}", response_model=OrgRequestOut, summary="Mark a request's progress")
async def update_request(request_id: UUID, body: OrgRequestPatch, admin=Depends(platform_admin), conn=Depends(get_conn)):
    cur = await conn.execute(
        "UPDATE org_requests SET status = COALESCE(%s, status), note = COALESCE(%s, note), updated_at = now() "
        "WHERE id = %s RETURNING *", (body.status, body.note, request_id))
    row = await cur.fetchone()
    if not row:
        raise Problem(404, "Request not found.", code="not_found")
    return row
