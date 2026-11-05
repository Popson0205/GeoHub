"""The GeoEstate staff console: customers and their licences, support actions, staff and what staff did. Plus the
public "Request an organization" form. Who may do what: app/staff.py."""
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response
from psycopg.types.json import Jsonb

from .. import domains, licence_keys, licences, orgs, passwords, products, ratelimit, staff
from ..audit import audit
from ..config import settings
from ..db import get_conn
from ..deps import platform_admin_emails
from ..errors import Problem
from ..logging_setup import client_ip
from ..mailer import send_email
from ..schemas import (AdminOrgDetail, AdminOrgIn, AdminOrgOut, AdminOrgPatch, OrgDomainIn, OrgDomainOut, OrgRequestIn,
                       OrgRequestOut, OrgRequestPatch, OwnerIn, LicenceKeyIn, ProductIn, ProductOut, ProductRemoveIn, StaffActivityOut, StaffIn, StaffMeOut, StaffNoteIn,
                       StaffNoteOut, StaffOut, StaffPatch, SupportVisitIn, SupportVisitOut, SuspendIn)

router = APIRouter(tags=["staff console"])

ORG_SQL = (
    "SELECT o.id, o.name, o.slug, o.plan, o.limits, o.subscription_starts, o.subscription_ends, o.created_at, "
    "  o.licence_kind, o.suspended_at, o.suspended_reason, "
    f"  {licences.STATUS_SQL} AS status, "
    "  (o.subscription_ends - current_date) AS days_left, ou.name AS owner_name, ou.email AS owner_email, "
    "  (SELECT max(u.last_sign_in_at) FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = o.id) AS last_active, "
    "  ARRAY(SELECT domain || CASE WHEN verified_at IS NULL THEN ' (unverified)' ELSE '' END FROM org_domains "
    "        WHERE org_id = o.id ORDER BY created_at) AS domains "
    "FROM organizations o "
    "LEFT JOIN LATERAL (SELECT u.name, u.email FROM org_members m JOIN users u ON u.id = m.user_id "
    "  WHERE m.org_id = o.id AND m.role = 'owner' ORDER BY m.created_at LIMIT 1) ou ON true ")


async def _org(conn, row) -> dict:
    return {**row, "plan_name": orgs.PLAN_NAMES.get(row["plan"], row["plan"]), "caps": orgs.caps(row["plan"], row["limits"]),
            "limits": {k: int(v) for k, v in (row["limits"] or {}).items() if v is not None},
            "usage": await orgs.usage(conn, row["id"]), "grace_ends": licences.grace_ends(row)}


async def _one(conn, org_id) -> dict:
    cur = await conn.execute(ORG_SQL + "WHERE o.id = %s", (org_id,))
    row = await cur.fetchone()
    if not row:
        raise Problem(404, "Organization not found.", code="not_found")
    return row


async def _staff_audit(conn, action: str, user: dict, request: Request, org_id=None, target_type=None, target_id=None, **details):
    """Every staff action goes in the staff activity log, under platform.*, with the organization it was about."""
    await audit(conn, f"platform.{action}", actor_id=user["id"], target_type=target_type or ("organization" if org_id else None),
                target_id=target_id or org_id, ip=client_ip(request), **({"org_id": str(org_id)} if org_id else {}), **details)


@router.get("/admin/me", response_model=StaffMeOut, summary="Your staff role and what it lets you do")
async def me(user=Depends(staff.staff()), conn=Depends(get_conn)):
    r = user["staff_role"]
    return {"role": r, "role_name": staff.ROLE_NAMES[r], "perms": staff.perms_of(r), "mfa_ok": True}


# ---------- customers ----------
@router.get("/admin/orgs", response_model=list[AdminOrgOut], summary="Customers (client organizations)")
async def list_orgs(q: str | None = None, plan: str | None = None,
                    status: str | None = Query(None, pattern="^(free|demo|active|grace|expired|suspended|due)$",
                                               description="due = ends within 60 days"),
                    paid_only: bool = Query(True, description="Hide Individual accounts"),
                    user=Depends(staff.staff()), conn=Depends(get_conn)):
    where, params = ["true"], []
    if paid_only and status != "free":
        where.append("o.plan <> 'individual'")
    if plan:
        where.append("o.plan = %s"); params.append(plan)
    if status == "due":
        where.append("o.subscription_ends BETWEEN current_date AND current_date + 60 AND o.suspended_at IS NULL")
    elif status:
        where.append(f"({licences.STATUS_SQL}) = %s"); params.append(status)
    if q:
        where.append("(o.name ILIKE %s OR o.slug ILIKE %s OR ou.email ILIKE %s OR EXISTS (SELECT 1 FROM org_domains d "
                     "WHERE d.org_id = o.id AND d.domain ILIKE %s))"); params += [f"%{q}%"] * 4
    cur = await conn.execute(ORG_SQL + "WHERE " + " AND ".join(where) +
                             " ORDER BY o.subscription_ends NULLS LAST, o.name LIMIT 500", params)
    return [await _org(conn, r) for r in await cur.fetchall()]


@router.get("/admin/orgs/{org_id}", response_model=AdminOrgDetail, summary="One customer: people, licence history, notes, activity")
async def get_org(org_id: UUID, user=Depends(staff.staff()), conn=Depends(get_conn)):
    out = await _org(conn, await _one(conn, org_id))
    cur = await conn.execute(
        "SELECT u.id AS user_id, u.name, u.email, m.role, (u.totp_enabled_at IS NOT NULL) AS mfa_enabled, "
        "  u.last_sign_in_at AS last_active, m.created_at AS joined_at FROM org_members m JOIN users u ON u.id = m.user_id "
        "WHERE m.org_id = %s ORDER BY array_position(ARRAY['owner','admin','member','collector','viewer'], m.role), lower(u.name)",
        (org_id,))
    out["people"] = await cur.fetchall()
    cur = await conn.execute(
        "SELECT (SELECT count(*) FROM org_invitations WHERE org_id = %(o)s) AS invited, "
        "  (SELECT count(*) FROM api_keys WHERE org_id = %(o)s AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS api_keys, "
        "  (SELECT count(*) FROM org_teams WHERE org_id = %(o)s) AS teams", {"o": org_id})
    out.update(await cur.fetchone())
    cur = await conn.execute("SELECT e.*, u.name AS actor_name FROM licence_events e LEFT JOIN users u ON u.id = e.actor_id "
                             "WHERE e.org_id = %s ORDER BY e.id DESC LIMIT 100", (org_id,))
    out["licences"] = await cur.fetchall()
    cur = await conn.execute("SELECT n.id, n.body, n.author_id, u.name AS author_name, n.created_at FROM org_staff_notes n "
                             "LEFT JOIN users u ON u.id = n.author_id WHERE n.org_id = %s ORDER BY n.created_at DESC", (org_id,))
    out["notes"] = await cur.fetchall()
    cur = await conn.execute(
        "SELECT a.id, a.at, a.action, a.actor_id, u.name AS actor_name, a.target_type, a.target_id, a.details "
        "FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id "
        "WHERE a.details->>'org_id' = %(o)s OR (a.target_type = 'organization' AND a.target_id = %(o)s) "
        "ORDER BY a.id DESC LIMIT 50", {"o": str(org_id)})
    out["activity"] = await cur.fetchall()
    cur = await conn.execute("SELECT p.id, p.name, p.last_activity_at AS last_update, "
                             "  (SELECT count(*) FROM features f WHERE f.project_id = p.id AND f.deleted_at IS NULL) AS records "
                             "FROM projects p WHERE p.org_id = %s ORDER BY p.last_activity_at DESC LIMIT 200", (org_id,))
    out["projects"] = await cur.fetchall()
    out["support_visits"] = await visits(conn, org_id)
    out["products"] = await products.of_org(conn, org_id)
    cur = await conn.execute("SELECT k.payload, k.issued_at FROM licence_keys k WHERE k.org_id = %s ORDER BY k.issued_at DESC LIMIT 50",
                             (org_id,))
    out["licence_keys"] = [licence_keys.summary(r["payload"]) | {"issued_by": r["payload"].get("issued_by")} for r in await cur.fetchall()]
    return out


VISIT_SQL = ("SELECT s.id, s.staff_id, u.name AS staff_name, s.reason, s.started_at, s.ends_at, s.ended_at, "
             "  (s.ended_at IS NULL AND s.ends_at > now()) AS active FROM support_sessions s LEFT JOIN users u ON u.id = s.staff_id ")


async def visits(conn, org_id, limit: int = 20) -> list[dict]:
    cur = await conn.execute(VISIT_SQL + "WHERE s.org_id = %s ORDER BY s.started_at DESC LIMIT %s", (org_id, limit))
    return await cur.fetchall()


@router.post("/admin/orgs/{org_id}/support", response_model=SupportVisitOut, status_code=201,
             summary="Open a customer's projects to help them (read-only, for a few hours, shown to the customer)")
async def start_visit(org_id: UUID, body: SupportVisitIn, request: Request, user=Depends(staff.staff("customers.support")),
                      conn=Depends(get_conn)):
    """While the visit is open, the staff member sees the customer's projects as a viewer: records, maps, forms and
    dashboards, changing nothing. The customer's owners and admins see the visit and its reason on their
    Organization page."""
    o = await _one(conn, org_id)
    await conn.execute("UPDATE support_sessions SET ended_at = now() WHERE staff_id = %s AND org_id = %s AND ended_at IS NULL",
                       (user["id"], org_id))
    cur = await conn.execute("INSERT INTO support_sessions (org_id, staff_id, reason, ends_at) "
                             "VALUES (%s, %s, %s, now() + make_interval(hours => %s)) RETURNING id",
                             (org_id, user["id"], body.reason.strip(), body.hours))
    vid = (await cur.fetchone())["id"]
    await _staff_audit(conn, "support_start", user, request, org_id, target_type="support_visit", target_id=vid,
                       reason=body.reason.strip(), hours=body.hours)
    cur = await conn.execute("SELECT u.email, u.name FROM org_members m JOIN users u ON u.id = m.user_id "
                             "WHERE m.org_id = %s AND m.role IN ('owner','admin')", (org_id,))
    for p in await cur.fetchall():
        await send_email(p["email"], "GeoEstate support is looking at your Geohub projects",
                         f"Hello {p['name'].split()[0]},\n\n{user['name']} from GeoEstate support opened the projects of "
                         f"\"{o['name']}\" to help, for up to {body.hours} hour{'s' if body.hours > 1 else ''}. They can see "
                         f"your records, forms and dashboards but cannot change anything.\n\nReason: {body.reason.strip()}\n\n"
                         "You can see every support visit on your Organization page. If you did not ask for help, reply to this email.",
                         action=("See support visits", f"{settings.app_url}/settings/organization"),
                         key=f"support-visit/{vid}/{p['email']}")
    cur = await conn.execute(VISIT_SQL + "WHERE s.id = %s", (vid,))
    return await cur.fetchone()


@router.post("/admin/support/{visit_id}/end", response_model=SupportVisitOut, summary="End a support visit")
async def end_visit(visit_id: UUID, request: Request, user=Depends(staff.staff("customers.support")), conn=Depends(get_conn)):
    cur = await conn.execute("UPDATE support_sessions SET ended_at = COALESCE(ended_at, now()) WHERE id = %s "
                             "AND (staff_id = %s OR %s) RETURNING org_id", (visit_id, user["id"], user["staff_role"] == "super_admin"))
    row = await cur.fetchone()
    if not row:
        raise Problem(404, "Support visit not found.", code="not_found")
    await _staff_audit(conn, "support_end", user, request, row["org_id"], target_type="support_visit", target_id=visit_id)
    cur = await conn.execute(VISIT_SQL + "WHERE s.id = %s", (visit_id,))
    return await cur.fetchone()


@router.post("/admin/orgs", response_model=AdminOrgOut, status_code=201, summary="Set up a customer and its owner")
async def create_org(body: AdminOrgIn, request: Request, user=Depends(staff.staff("licences.edit")), conn=Depends(get_conn)):
    """Creates the organization on its licence, and its owner's account. A new owner gets an email to set their
    password; someone who signed up on their own with nothing made yet is moved in; anyone else is refused. A demo
    licence is a month of Organization Advanced from today."""
    org_id = await setup_org(conn, body, user["id"])
    await _staff_audit(conn, "org_create", user, request, org_id, plan=body.plan if body.licence_kind == "paid" else licences.DEMO_PLAN,
                       kind=body.licence_kind, owner=body.owner_email.lower())
    return await _org(conn, await _one(conn, org_id))


async def setup_org(conn, body: AdminOrgIn, actor_id=None, note_suffix: str = "") -> UUID:
    """Set up a customer (see create_org). Also used by the GeoEstate CRM."""
    plan, starts, ends = body.plan, body.subscription_starts, body.subscription_ends
    if body.licence_kind == "demo":
        plan = licences.DEMO_PLAN
        d0, d1 = licences.demo_dates()
        starts, ends = starts or d0, ends or d1
    if plan == "individual":
        raise Problem(422, "Customers are on an Organization plan. Individual accounts sign up themselves.", code="validation",
                      fields={"plan": ["not for customers"]})
    if starts and ends and ends < starts:
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
    org = await orgs.create_org(conn, body.name, uid, plan=plan)
    await conn.execute("UPDATE organizations SET subscription_starts = %s, subscription_ends = %s, limits = %s, licence_kind = %s "
                       "WHERE id = %s", (starts, ends, Jsonb(body.limits), body.licence_kind, org["id"]))
    if body.request_id:
        await conn.execute("UPDATE org_requests SET status = 'set_up', org_id = %s, updated_at = now() WHERE id = %s",
                           (org["id"], body.request_id))
    note = " ".join(x for x in ((body.note or "").strip(), note_suffix) if x) or None
    await licences.record(conn, org["id"], "demo" if body.licence_kind == "demo" else "create", actor_id, body.invoice_ref, note)
    link = (f"{settings.app_url}/set-password?token={await passwords.issue(conn, uid, 'set')}" if not existing
            else settings.app_url)
    what = (f"a one-month demo of the {orgs.PLAN_NAMES[plan]} plan, until {ends:%-d %B %Y}" if body.licence_kind == "demo"
            else f"the {orgs.PLAN_NAMES[plan]} plan")
    await send_email(email, f"Your Geohub organization {body.name} is ready",
                     f"Hello {body.owner_name.split()[0] if not existing else existing['name'].split()[0]},\n\n"
                     f"Your organization \"{body.name}\" is set up on Geohub, on {what}, and you are its owner. "
                     + ("Choose your password with the button below (the link works once, within 72 hours), then "
                        if not existing else "Sign in with your usual password, then ")
                     + "open Organization in the account menu to add your team.",
                     action=("Set your password" if not existing else "Open Geohub", link))
    return org["id"]


@router.patch("/admin/orgs/{org_id}", response_model=AdminOrgOut, summary="Renew or change a customer's licence, or rename it")
async def update_org(org_id: UUID, body: AdminOrgPatch, request: Request, user=Depends(staff.staff("licences.edit")),
                     conn=Depends(get_conn)):
    now = await _one(conn, org_id)
    sets, params = [], []
    if body.name is not None:
        sets.append("name = %s"); params.append(body.name.strip())
    if body.plan is not None:
        sets.append("plan = %s"); params.append(body.plan)
    if body.licence_kind is not None:
        sets.append("licence_kind = %s"); params.append(body.licence_kind)
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
        licence_change = body.model_dump(exclude_none=True, exclude={"name", "invoice_ref", "note"}, exclude_defaults=True)
        if licence_change:
            renewed = bool(body.subscription_ends and now["subscription_ends"] and body.subscription_ends > now["subscription_ends"])
            await licences.record(conn, org_id, "renew" if renewed else "change", user["id"], body.invoice_ref, body.note)
        await _staff_audit(conn, "org_update", user, request, org_id, **body.model_dump(exclude_none=True, mode="json"))
    return await _org(conn, await _one(conn, org_id))


@router.put("/admin/orgs/{org_id}/products/{product}", response_model=list[ProductOut],
            summary="Give a customer another GeoEstate product (Land Registry, LandCheck, FarmScan), or change it")
async def put_product(org_id: UUID, product: str, body: ProductIn, request: Request, user=Depends(staff.staff("licences.edit")),
                      conn=Depends(get_conn)):
    o = await _one(conn, org_id)
    if o["plan"] == "individual":
        raise Problem(409, "Individual accounts cannot have other products. Set the customer up as an organization first.",
                      code="individual")
    action = await products.put(conn, org_id, product, plan=body.plan, kind=body.licence_kind, starts=body.subscription_starts,
                                ends=body.subscription_ends, limits_=body.limits, features_=body.features)
    await products.record(conn, org_id, product, action, user["id"], body.invoice_ref, body.note)
    await _staff_audit(conn, "product_set", user, request, org_id, product=product, **body.model_dump(exclude_none=True, mode="json"))
    return await products.of_org(conn, org_id)


@router.post("/admin/orgs/{org_id}/products/{product}/remove", response_model=list[ProductOut],
             summary="Take a product away from a customer (its data is kept)")
async def remove_product(org_id: UUID, product: str, body: ProductRemoveIn, request: Request,
                         user=Depends(staff.staff("licences.edit")), conn=Depends(get_conn)):
    await _one(conn, org_id)
    if not await products.remove(conn, org_id, product):
        raise Problem(404, "This customer does not have that product.", code="not_found")
    await products.record(conn, org_id, product, "remove", user["id"], note=body.note)
    await _staff_audit(conn, "product_remove", user, request, org_id, product=product, note=body.note.strip())
    return await products.of_org(conn, org_id)


@router.get("/admin/licence-keys", summary="Whether this deployment issues licence keys, and the public key installations need")
async def licence_key_settings(user=Depends(staff.staff()), conn=Depends(get_conn)):
    return {"can_issue": licence_keys.public_key() is not None, "public_key": licence_keys.public_key()}


@router.post("/admin/orgs/{org_id}/licence-keys", status_code=201,
             summary="Issue a licence key for the customer's own installation, carrying its licences")
async def issue_licence_key(org_id: UUID, body: LicenceKeyIn, request: Request, user=Depends(staff.staff("licences.edit")),
                            conn=Depends(get_conn)):
    out = await licence_keys.make(conn, org_id, body.installation, body.ends, body.note, user)
    await _staff_audit(conn, "licence_key", user, request, org_id, installation=out["installation"], key_id=out["id"])
    return out


@router.get("/admin/licence-keys/{key_id}", summary="An issued licence key, to send again")
async def get_licence_key(key_id: UUID, user=Depends(staff.staff()), conn=Depends(get_conn)):
    cur = await conn.execute("SELECT key, payload FROM licence_keys WHERE id = %s", (key_id,))
    row = await cur.fetchone()
    if not row:
        raise Problem(404, "Licence key not found.", code="not_found")
    return {"key": row["key"], **licence_keys.summary(row["payload"])}


@router.post("/admin/orgs/{org_id}/suspend", response_model=AdminOrgOut, summary="Suspend a customer (for example for non-payment)")
async def suspend(org_id: UUID, body: SuspendIn, request: Request, user=Depends(staff.staff("licences.edit")), conn=Depends(get_conn)):
    await _one(conn, org_id)
    await conn.execute("UPDATE organizations SET suspended_at = now(), suspended_reason = %s WHERE id = %s", (body.reason.strip(), org_id))
    await licences.record(conn, org_id, "suspend", user["id"], note=body.reason)
    await _staff_audit(conn, "org_suspend", user, request, org_id, reason=body.reason.strip())
    return await _org(conn, await _one(conn, org_id))


@router.post("/admin/orgs/{org_id}/reactivate", response_model=AdminOrgOut, summary="Lift a suspension")
async def reactivate(org_id: UUID, request: Request, user=Depends(staff.staff("licences.edit")), conn=Depends(get_conn)):
    o = await _one(conn, org_id)
    if not o["suspended_at"]:
        raise Problem(409, "This customer is not suspended.", code="not_suspended")
    await conn.execute("UPDATE organizations SET suspended_at = NULL, suspended_reason = NULL WHERE id = %s", (org_id,))
    await licences.record(conn, org_id, "reactivate", user["id"])
    await _staff_audit(conn, "org_reactivate", user, request, org_id)
    return await _org(conn, await _one(conn, org_id))


@router.post("/admin/orgs/{org_id}/domains", response_model=OrgDomainOut, status_code=201,
             summary="Add a company email domain, already verified (staff checked it)")
async def admin_add_domain(org_id: UUID, body: OrgDomainIn, request: Request, user=Depends(staff.staff("licences.edit")),
                           conn=Depends(get_conn)):
    d = domains.normalize(body.domain)
    cur = await conn.execute("SELECT org_id FROM org_domains WHERE domain = %s", (d,))
    taken = await cur.fetchone()
    if taken and taken["org_id"] != org_id:
        raise Problem(409, f"{d} belongs to another organization. Remove it there first.", code="domain_taken", fields={"domain": ["taken"]})
    cur = await conn.execute(
        "INSERT INTO org_domains (domain, org_id, verify_token, verified_at) VALUES (%s, %s, %s, now()) "
        "ON CONFLICT (domain) DO UPDATE SET verified_at = COALESCE(org_domains.verified_at, now()) RETURNING *",
        (d, org_id, domains.new_token()))
    await _staff_audit(conn, "domain_add", user, request, org_id, domain=d)
    return domains.out(await cur.fetchone())


# ---------- support ----------
async def _person(conn, org_id, user_id) -> dict:
    cur = await conn.execute("SELECT u.id, u.name, u.email, m.role FROM org_members m JOIN users u ON u.id = m.user_id "
                             "WHERE m.org_id = %s AND m.user_id = %s", (org_id, user_id))
    p = await cur.fetchone()
    if not p:
        raise Problem(404, "That person is not in this organization.", code="not_found")
    return p


@router.post("/admin/orgs/{org_id}/people/{user_id}/send-link", status_code=202, summary="Email someone a set-password link")
async def send_link(org_id: UUID, user_id: UUID, request: Request, user=Depends(staff.staff("customers.support")), conn=Depends(get_conn)):
    from .org import _welcome
    p = await _person(conn, org_id, user_id)
    m = await orgs.membership(conn, user_id)
    sent = await _welcome(conn, m, {"name": "GeoEstate support"}, p["name"], p["email"], p["role"] if p["role"] != "owner" else "admin",
                          await passwords.issue(conn, user_id, "set"))
    await _staff_audit(conn, "send_link", user, request, org_id, target_type="user", target_id=user_id)
    return {"sent": sent}


@router.delete("/admin/orgs/{org_id}/people/{user_id}/mfa", status_code=204, summary="Turn off someone's two-step sign-in (lost phone)")
async def reset_mfa(org_id: UUID, user_id: UUID, request: Request, user=Depends(staff.staff("customers.support")), conn=Depends(get_conn)):
    from .security import _turn_off
    p = await _person(conn, org_id, user_id)
    cur = await conn.execute("SELECT 1 FROM users WHERE id = %s AND totp_secret IS NOT NULL", (user_id,))
    if not await cur.fetchone():
        raise Problem(409, "They do not have two-step sign-in on.", code="mfa_not_set_up")
    await _turn_off(conn, user_id)
    await send_email(p["email"], "Your two-step sign-in was turned off",
                     f"Hello {p['name'].split()[0]},\n\nGeoEstate support turned off two-step sign-in for your Geohub account, "
                     "as you asked. Next time you sign in, use your password alone, then set it up again under Account security.\n\n"
                     "If you did not ask for this, reply to this email at once.")
    await _staff_audit(conn, "mfa_reset", user, request, org_id, target_type="user", target_id=user_id)
    return Response(status_code=204)


@router.post("/admin/orgs/{org_id}/owner", response_model=AdminOrgDetail, summary="Make someone in the organization its owner")
async def transfer_owner(org_id: UUID, body: OwnerIn, request: Request, user=Depends(staff.staff("licences.edit")), conn=Depends(get_conn)):
    """For when the owner left the company. The new owner takes a team seat; the previous owners become administrators."""
    p = await _person(conn, org_id, body.user_id)
    if p["role"] == "owner":
        raise Problem(409, "They are already an owner.", code="already_owner")
    if orgs.KIND_OF_ROLE[p["role"]] != "seats":
        await orgs.check_limit(conn, org_id, "seats")
    await conn.execute("UPDATE org_members SET role = 'admin' WHERE org_id = %s AND role = 'owner'", (org_id,))
    await conn.execute("UPDATE org_members SET role = 'owner' WHERE user_id = %s", (body.user_id,))
    await _staff_audit(conn, "owner_transfer", user, request, org_id, target_type="user", target_id=body.user_id)
    return await get_org(org_id, user, conn)


@router.post("/admin/orgs/{org_id}/notes", response_model=StaffNoteOut, status_code=201, summary="Add a staff note to a customer")
async def add_note(org_id: UUID, body: StaffNoteIn, request: Request, user=Depends(staff.staff("customers.support")), conn=Depends(get_conn)):
    await _one(conn, org_id)
    cur = await conn.execute("INSERT INTO org_staff_notes (org_id, author_id, body) VALUES (%s, %s, %s) "
                             "RETURNING id, body, author_id, created_at", (org_id, user["id"], body.body.strip()))
    n = await cur.fetchone()
    await _staff_audit(conn, "note_add", user, request, org_id, target_type="note", target_id=n["id"])
    return {**n, "author_name": user["name"]}


@router.delete("/admin/notes/{note_id}", status_code=204, summary="Delete a staff note (your own, or any for super admins)")
async def delete_note(note_id: UUID, request: Request, user=Depends(staff.staff("customers.support")), conn=Depends(get_conn)):
    cur = await conn.execute("SELECT org_id, author_id FROM org_staff_notes WHERE id = %s", (note_id,))
    n = await cur.fetchone()
    if not n:
        raise Problem(404, "Note not found.", code="not_found")
    if n["author_id"] != user["id"] and user["staff_role"] != "super_admin":
        raise Problem(403, "Only its author or a super admin can delete a note.", code="forbidden")
    await conn.execute("DELETE FROM org_staff_notes WHERE id = %s", (note_id,))
    await _staff_audit(conn, "note_delete", user, request, n["org_id"], target_type="note", target_id=note_id)
    return Response(status_code=204)


# ---------- staff ----------
async def _staff_list(conn) -> list[dict]:
    env = platform_admin_emails()
    cur = await conn.execute(
        "SELECT u.id AS user_id, u.name, lower(u.email) AS email, s.role, (u.totp_enabled_at IS NOT NULL) AS mfa_enabled, "
        "  u.last_sign_in_at AS last_active, s.created_at FROM users u LEFT JOIN platform_staff s ON s.user_id = u.id "
        "WHERE s.user_id IS NOT NULL OR lower(u.email) = ANY(%s)", (list(env),))
    rows = {r["email"]: {**r, "from_settings": r["email"] in env, "role": "super_admin" if r["email"] in env else r["role"]}
            for r in await cur.fetchall()}
    for e in env - rows.keys():                  # listed in PLATFORM_ADMINS but has not signed up yet
        rows[e] = {"user_id": None, "name": None, "email": e, "role": "super_admin", "mfa_enabled": False, "from_settings": True}
    order = {r: i for i, r in enumerate(staff.ROLES)}
    return sorted(rows.values(), key=lambda r: (order[r["role"]], (r["name"] or r["email"]).lower()))


@router.get("/admin/staff", response_model=list[StaffOut], summary="GeoEstate staff and their roles")
async def list_staff(user=Depends(staff.staff()), conn=Depends(get_conn)):
    return await _staff_list(conn)


@router.post("/admin/staff", response_model=list[StaffOut], status_code=201, summary="Add a staff member (super admins)")
async def add_staff(body: StaffIn, request: Request, user=Depends(staff.staff("staff.manage")), conn=Depends(get_conn)):
    """Someone without a Geohub account gets one, with an email to set their password; they must turn on two-step
    sign-in before they can open the console."""
    email = body.email.lower()
    if email in platform_admin_emails():
        raise Problem(409, "That person is in PLATFORM_ADMINS, so already a super admin.", code="already_staff")
    cur = await conn.execute("SELECT id, name FROM users WHERE lower(email) = %s", (email,))
    u = await cur.fetchone()
    new = u is None
    if new:
        name = (body.name or "").strip() or email.split("@")[0]
        cur = await conn.execute("INSERT INTO users (email, name, password_hash) VALUES (%s, %s, %s) RETURNING id, name",
                                 (email, name, await passwords.unusable_hash()))
        u = await cur.fetchone()
        await orgs.create_org(conn, "GeoEstate staff", u["id"])
    cur = await conn.execute("INSERT INTO platform_staff (user_id, role, added_by) VALUES (%s, %s, %s) ON CONFLICT (user_id) DO NOTHING "
                             "RETURNING user_id", (u["id"], body.role, user["id"]))
    if not await cur.fetchone():
        raise Problem(409, "That person is already on the staff. Change their role instead.", code="already_staff")
    link = f"{settings.app_url}/set-password?token={await passwords.issue(conn, u['id'], 'set')}" if new else f"{settings.app_url}/admin"
    await send_email(email, "You were added to the GeoEstate staff console",
                     f"Hello {u['name'].split()[0]},\n\n{user['name']} added you to the GeoEstate staff console on Geohub, as "
                     f"{staff.ROLE_NAMES[body.role]}.\n\n" + ("First choose your password with the button below (the link works "
                     "once, within 72 hours). " if new else "") + "Turn on two-step sign-in under Account security, then open "
                     "Staff console in the account menu.", action=("Set your password" if new else "Open the staff console", link))
    await _staff_audit(conn, "staff_add", user, request, target_type="user", target_id=u["id"], email=email, role=body.role)
    return await _staff_list(conn)


async def _super_admins_left(conn, without) -> int:
    cur = await conn.execute("SELECT count(*) AS n FROM platform_staff WHERE role = 'super_admin' AND user_id <> %s", (without,))
    return (await cur.fetchone())["n"] + len(platform_admin_emails())


@router.patch("/admin/staff/{user_id}", response_model=list[StaffOut], summary="Change a staff member's role (super admins)")
async def set_staff_role(user_id: UUID, body: StaffPatch, request: Request, user=Depends(staff.staff("staff.manage")),
                         conn=Depends(get_conn)):
    if user_id == user["id"]:
        raise Problem(409, "Ask another super admin to change your own role.", code="own_role")
    cur = await conn.execute("UPDATE platform_staff SET role = %s WHERE user_id = %s RETURNING user_id", (body.role, user_id))
    if not await cur.fetchone():
        raise Problem(404, "That person is not on the staff, or is in PLATFORM_ADMINS (changed only there).", code="not_found")
    await _staff_audit(conn, "staff_update", user, request, target_type="user", target_id=user_id, role=body.role)
    return await _staff_list(conn)


@router.delete("/admin/staff/{user_id}", response_model=list[StaffOut], summary="Remove someone from the staff (super admins)")
async def remove_staff(user_id: UUID, request: Request, user=Depends(staff.staff("staff.manage")), conn=Depends(get_conn)):
    """They keep their Geohub account; only the staff console closes to them."""
    if user_id == user["id"]:
        raise Problem(409, "Ask another super admin to remove you.", code="own_role")
    if not await _super_admins_left(conn, user_id):
        raise Problem(409, "The staff console needs at least one super admin.", code="last_super_admin")
    cur = await conn.execute("DELETE FROM platform_staff WHERE user_id = %s RETURNING role", (user_id,))
    row = await cur.fetchone()
    await conn.execute("UPDATE support_sessions SET ended_at = now() WHERE staff_id = %s AND ended_at IS NULL", (user_id,))
    if not row:
        raise Problem(404, "That person is not on the staff, or is in PLATFORM_ADMINS (removed only there).", code="not_found")
    await _staff_audit(conn, "staff_remove", user, request, target_type="user", target_id=user_id, role=row["role"])
    return await _staff_list(conn)


@router.get("/admin/activity", response_model=list[StaffActivityOut], summary="What staff did, newest first")
async def staff_activity(org_id: UUID | None = None, actor_id: UUID | None = None, before: int | None = None,
                         limit: int = Query(100, ge=1, le=200), user=Depends(staff.staff("audit.view")), conn=Depends(get_conn)):
    where, params = ["a.action LIKE 'platform.%%'"], []
    if org_id:
        where.append("a.details->>'org_id' = %s"); params.append(str(org_id))
    if actor_id:
        where.append("a.actor_id = %s"); params.append(actor_id)
    if before:
        where.append("a.id < %s"); params.append(before)
    cur = await conn.execute(
        "SELECT a.id, a.at, a.action, a.actor_id, u.name AS actor_name, a.target_type, a.target_id, a.details, "
        "  o.id AS org_id, o.name AS org_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id "
        "LEFT JOIN organizations o ON o.id::text = a.details->>'org_id' "
        f"WHERE {' AND '.join(where)} ORDER BY a.id DESC LIMIT %s", (*params, limit))
    return await cur.fetchall()


# ---------- requests from the website ----------
@router.post("/org-requests", status_code=202, summary="Ask GeoEstate for an organization or a demo licence (public)",
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
    plan = {"standard": "Organization Standard", "advanced": "Organization Advanced", "custom": "Custom", "unsure": "not sure yet",
            "demo": "a one-month demo licence"}[body.plan]
    for to in await staff.emails(conn):
        await send_email(to, f"{'Demo' if body.plan == 'demo' else 'Organization'} request: {body.organization}",
                         f"{body.contact_name} ({body.email}{', ' + body.phone if body.phone else ''}) asked for "
                         f"{plan if body.plan == 'demo' else 'an organization'} for \"{body.organization}\".\n\n"
                         f"Plan: {plan}\nTeam size: {body.team_size or 'not given'}\n\n"
                         f"{body.message or ''}", action=("Open the requests", f"{settings.app_url}/admin?tab=requests"),
                         key=f"org-request/{rid}")
    await send_email(body.email, "We received your Geohub request",
                     f"Hello {body.contact_name.split()[0]},\n\nThank you for asking about Geohub for \"{body.organization}\". "
                     + ("GeoEstate NIG Limited will contact you within two working days to set up your one-month demo."
                        if body.plan == "demo" else
                        "GeoEstate NIG Limited will contact you within two working days with an invoice and next steps."),
                     key=f"org-request-ack/{rid}")
    return {"received": True}


@router.get("/admin/requests", response_model=list[OrgRequestOut], summary="Organization and demo requests, newest first")
async def list_requests(status: str | None = None, user=Depends(staff.staff()), conn=Depends(get_conn)):
    cur = await conn.execute("SELECT * FROM org_requests WHERE (%s::text IS NULL OR status = %s) ORDER BY created_at DESC LIMIT 500",
                             (status, status))
    return await cur.fetchall()


@router.patch("/admin/requests/{request_id}", response_model=OrgRequestOut, summary="Mark a request's progress")
async def update_request(request_id: UUID, body: OrgRequestPatch, request: Request, user=Depends(staff.staff("requests.edit")),
                         conn=Depends(get_conn)):
    cur = await conn.execute(
        "UPDATE org_requests SET status = COALESCE(%s, status), note = COALESCE(%s, note), updated_at = now() "
        "WHERE id = %s RETURNING *", (body.status, body.note, request_id))
    row = await cur.fetchone()
    if not row:
        raise Problem(404, "Request not found.", code="not_found")
    await _staff_audit(conn, "request_update", user, request, row["org_id"], target_type="request", target_id=request_id,
                       **body.model_dump(exclude_none=True))
    return row
