"""The link to the GeoEstate CRM (a separate app): it reads customers and website requests, sets up customers, and
switches on the licence a paid invoice buys. It signs each call with CRM_LINK_KEY; without that setting, none of this
exists. Every change is in the licence history and the staff activity log, with the CRM staff member's name."""
import hmac
from datetime import date, datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from .. import licences, orgs
from ..audit import audit
from ..config import settings
from ..db import get_conn
from ..errors import Problem
from ..logging_setup import client_ip
from ..schemas import AdminOrgIn, OrgRequestOut, PlanId
from .admin import ORG_SQL, setup_org


def crm_only(request: Request) -> None:
    key = settings.crm_link_key
    given = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not key:
        raise Problem(404, "Not found.", code="not_found")
    if not given or not hmac.compare_digest(given.encode(), key.encode()):
        raise Problem(401, "The CRM link key is not right. GEOHUB_LINK_KEY in the CRM must equal CRM_LINK_KEY in Geohub.",
                      code="bad_link_key")


router = APIRouter(prefix="/crm-link", tags=["GeoEstate CRM link"], dependencies=[Depends(crm_only)])


class CrmOrgOut(BaseModel):
    id: UUID
    name: str
    plan: str
    plan_name: str
    licence_kind: Literal["paid", "demo"]
    status: str
    status_name: str
    subscription_starts: date | None
    subscription_ends: date | None
    grace_ends: date | None
    suspended_reason: str | None
    owner_name: str | None
    owner_email: str | None
    created_at: datetime
    last_active: datetime | None
    console_url: str = Field(description="The customer's page in the Geohub staff console")
    already_applied: bool = False


class CrmSetupIn(AdminOrgIn):
    staff_name: str = Field(min_length=1, max_length=120, description="Who in the CRM did it")


class CrmLicenceIn(BaseModel):
    plan: PlanId
    subscription_starts: date
    subscription_ends: date
    invoice_ref: str = Field(min_length=1, max_length=80)
    staff_name: str = Field(min_length=1, max_length=120)
    lift_suspension: bool = Field(False, description="Also lift a suspension (for example one for non-payment)")


def _out(row: dict, **extra) -> dict:
    return {**row, "plan_name": orgs.PLAN_NAMES.get(row["plan"], row["plan"]), "grace_ends": licences.grace_ends(row),
            "status_name": licences.STATUS_NAMES.get(row["status"], row["status"]),
            "console_url": f"{settings.app_url}/admin/customers/{row['id']}", **extra}


async def _one(conn, org_id) -> dict:
    cur = await conn.execute(ORG_SQL + "WHERE o.id = %s", (org_id,))
    row = await cur.fetchone()
    if not row:
        raise Problem(404, "That organization is not on Geohub (any more).", code="not_found")
    return row


async def _log(conn, request: Request, action: str, org_id, staff_name: str, **details) -> None:
    await audit(conn, f"platform.{action}", target_type="organization", target_id=org_id, ip=client_ip(request),
                org_id=str(org_id), via="GeoEstate CRM", staff=staff_name.strip(), **details)


@router.get("/orgs", response_model=list[CrmOrgOut], summary="Customers (Organization plans), or the ones with these ids")
async def list_orgs(q: str | None = None, ids: str | None = None, conn=Depends(get_conn)):
    where, params = ["o.plan <> 'individual'"], []
    if ids:
        try:
            wanted = [str(UUID(x.strip())) for x in ids.split(",") if x.strip()][:500]
        except ValueError:
            raise Problem(422, "ids must be organization ids, separated by commas.", code="validation")
        where = ["o.id = ANY(%s::uuid[])"]; params.append(wanted)
    if q:
        where.append("(o.name ILIKE %s OR ou.email ILIKE %s)"); params += [f"%{q}%"] * 2
    cur = await conn.execute(ORG_SQL + "WHERE " + " AND ".join(where) + " ORDER BY lower(o.name) LIMIT 500", params)
    return [_out(r) for r in await cur.fetchall()]


@router.get("/orgs/{org_id}", response_model=CrmOrgOut, summary="One customer and its licence today")
async def get_org(org_id: UUID, conn=Depends(get_conn)):
    return _out(await _one(conn, org_id))


@router.get("/requests", response_model=list[OrgRequestOut], summary="Requests from the website, newest first")
async def list_requests(status: str | None = None, conn=Depends(get_conn)):
    cur = await conn.execute("SELECT * FROM org_requests WHERE (%s::text IS NULL OR status = %s) ORDER BY created_at DESC LIMIT 500",
                             (status, status))
    return await cur.fetchall()


@router.post("/orgs", response_model=CrmOrgOut, status_code=201, summary="Set up a customer and its owner (a paid licence or a demo)")
async def create_org(body: CrmSetupIn, request: Request, conn=Depends(get_conn)):
    org_id = await setup_org(conn, body, None, note_suffix=f"(by {body.staff_name.strip()} in the GeoEstate CRM)")
    await _log(conn, request, "org_create", org_id, body.staff_name, kind=body.licence_kind, owner=body.owner_email.lower(),
               plan=licences.DEMO_PLAN if body.licence_kind == "demo" else body.plan)
    return _out(await _one(conn, org_id))


@router.post("/orgs/{org_id}/licence", response_model=CrmOrgOut, summary="Switch on the licence a paid invoice buys")
async def apply_licence(org_id: UUID, body: CrmLicenceIn, request: Request, conn=Depends(get_conn)):
    """Sets the plan and dates as a paid licence. Safe to repeat: an invoice already applied changes nothing."""
    now = await _one(conn, org_id)
    if body.subscription_ends < body.subscription_starts:
        raise Problem(422, "The licence cannot end before it starts.", code="validation", fields={"subscription_ends": ["before start"]})
    if body.plan == "individual":
        raise Problem(422, "Customers are on an Organization plan.", code="validation", fields={"plan": ["not for customers"]})
    ref = body.invoice_ref.strip()
    cur = await conn.execute("SELECT 1 FROM licence_events WHERE org_id = %s AND invoice_ref = %s AND action IN ('create','renew','change')",
                             (org_id, ref))
    if await cur.fetchone():
        return _out(now, already_applied=True)
    await conn.execute("UPDATE organizations SET plan = %s, licence_kind = 'paid', subscription_starts = %s, subscription_ends = %s "
                       "WHERE id = %s", (body.plan, body.subscription_starts, body.subscription_ends, org_id))
    renewed = bool(now["subscription_ends"] and body.subscription_ends > now["subscription_ends"]) or now["licence_kind"] == "demo"
    by = f"Paid invoice, applied by {body.staff_name.strip()} in the GeoEstate CRM."
    await licences.record(conn, org_id, "renew" if renewed or not now["subscription_ends"] else "change", None, ref, by)
    if body.lift_suspension and now["suspended_at"]:
        await conn.execute("UPDATE organizations SET suspended_at = NULL, suspended_reason = NULL WHERE id = %s", (org_id,))
        await licences.record(conn, org_id, "reactivate", None, ref, by)
    await _log(conn, request, "org_update", org_id, body.staff_name, plan=body.plan, licence_kind="paid", invoice_ref=ref,
               subscription_starts=body.subscription_starts.isoformat(), subscription_ends=body.subscription_ends.isoformat(),
               **({"lift_suspension": True} if body.lift_suspension and now["suspended_at"] else {}))
    return _out(await _one(conn, org_id))
