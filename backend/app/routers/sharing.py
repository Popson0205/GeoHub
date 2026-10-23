"""Share a form by link. Admins choose who may use the link; the link itself never changes unless they regenerate it."""
from uuid import UUID

from fastapi import APIRouter, Depends, Request

from ..audit import audit
from ..config import settings
from ..db import get_conn
from ..deps import RANK, current_user, optional_user, require_role, role_in
from ..errors import Problem
from ..logging_setup import client_ip
from ..ratelimit import limit
from ..schemas import PublicFormOut, PublicSubmit, SharingOut, SharingPatch
from ..services import features as svc

router = APIRouter(tags=["sharing"])


async def _form(conn, form_id) -> dict:
    cur = await conn.execute("SELECT id, project_id, version, share_mode, share_token FROM forms WHERE id = %s", (form_id,))
    f = await cur.fetchone()
    if not f:
        raise Problem(404, "Form not found.", code="not_found")
    return f


def _out(f: dict) -> dict:
    return {"share_mode": f["share_mode"], "share_token": f["share_token"], "published": f["version"] > 0}


@router.get("/forms/{form_id}/sharing", response_model=SharingOut)
async def get_sharing(form_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    f = await _form(conn, form_id)
    await require_role(conn, f["project_id"], user["id"], "admin")
    return _out(f)


@router.patch("/forms/{form_id}/sharing", response_model=SharingOut)
async def set_sharing(form_id: UUID, body: SharingPatch, request: Request, user=Depends(current_user),
                      conn=Depends(get_conn)):
    f = await _form(conn, form_id)
    await require_role(conn, f["project_id"], user["id"], "admin")
    if body.share_mode == "public" and f["version"] == 0:
        raise Problem(409, "Publish the form before making its link public.", code="form_not_published")
    cur = await conn.execute(
        "UPDATE forms SET share_mode = COALESCE(%s, share_mode), "
        "share_token = CASE WHEN %s THEN replace(gen_random_uuid()::text, '-', '') ELSE share_token END "
        "WHERE id = %s RETURNING id, project_id, version, share_mode, share_token",
        (body.share_mode, body.regenerate_link, form_id))
    out = await cur.fetchone()
    await audit(conn, "form.sharing", actor_id=user["id"], project_id=f["project_id"], target_type="form",
                target_id=form_id, ip=client_ip(request), share_mode=out["share_mode"], regenerated=body.regenerate_link)
    return _out(out)


async def _by_token(conn, token: str) -> dict:
    cur = await conn.execute(
        "SELECT f.id, f.project_id, f.share_mode, f.version, p.name AS project_name, v.name, v.geometry_type, v.fields "
        "FROM forms f JOIN projects p ON p.id = f.project_id "
        "JOIN form_versions v ON v.form_id = f.id AND v.version = f.version WHERE f.share_token = %s AND f.version > 0",
        (token,))
    row = await cur.fetchone()
    if not row:
        raise Problem(404, "This form link is not valid, or the form is not published.", code="not_found")
    return row


@router.get("/public/forms/{token}", response_model=PublicFormOut,
            dependencies=[Depends(limit("public_form", lambda: settings.rate_anon_read_per_min))])
async def public_form(token: str, user=Depends(optional_user), conn=Depends(get_conn)):
    """The form behind a link. Public links need no sign-in. Collaborator-only links need a signed-in collaborator."""
    f = await _by_token(conn, token)
    access = "public"
    if f["share_mode"] != "public":
        if not user:
            raise Problem(401, "Sign in to use this form.", code="unauthenticated")
        role = await role_in(conn, f["project_id"], user["id"])
        if not role or RANK[role] < RANK["collector"]:
            raise Problem(403, "You have not been added to this form. Ask its owner to add you as a collaborator.",
                          code="not_collaborator")
        access = "member"
    return {"token": token, "form_id": f["id"], "project_id": f["project_id"], "project_name": f["project_name"],
            "name": f["name"], "geometry_type": f["geometry_type"], "version": f["version"], "fields": f["fields"],
            "access": access}


@router.post("/public/forms/{token}/submissions", status_code=201,
             dependencies=[Depends(limit("public_submit", lambda: settings.rate_public_submit_per_hour, 3600))])
async def public_submit(token: str, body: PublicSubmit, request: Request, conn=Depends(get_conn)):
    """Anonymous submission. Only works while the link is public; the result waits in the project for review."""
    f = await _by_token(conn, token)
    if f["share_mode"] != "public":
        raise Problem(403, "This form is not public.", code="not_public")
    res = await svc.apply_change(
        conn, project_id=f["project_id"], user_id=None, role="collector", ip=client_ip(request),
        ch={"id": body.id, "op": "create", "base_version": 0, "form_id": f["id"], "form_version": f["version"],
            "geometry": body.geometry.model_dump(), "properties": body.properties, "status": "submitted"})
    if res["status"] == "rejected" and res.get("code") == "ALREADY_EXISTS":
        return {"id": str(body.id), "received": True}          # a retry of a submission that already arrived
    if res["status"] != "applied":
        raise Problem(422, res.get("detail") or "The answers do not match the form.", code="validation",
                      fields=res.get("fields"))
    return {"id": str(body.id), "received": True}
