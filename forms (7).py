from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from psycopg.types.json import Jsonb

from ..audit import audit
from ..db import get_conn
from ..deps import current_user, require_role
from ..errors import Problem
from ..logging_setup import client_ip
from ..pagination import Page, decode_cursor, page_from_offset
from ..schemas import FormIn, FormOut, FormPatch, FormVersionOut
from ..services.forms import check_field_defs

router = APIRouter(tags=["forms"])

FORM_SQL = (
    "SELECT f.id, f.project_id, f.name, f.geometry_type, f.version, f.fields, f.updated_at, "
    "CASE WHEN f.version = 0 THEN 'draft' ELSE 'published' END AS status, "
    "(f.version = 0 OR v.fields IS DISTINCT FROM f.fields OR v.name <> f.name) AS has_unpublished_changes "
    "FROM forms f LEFT JOIN form_versions v ON v.form_id = f.id AND v.version = f.version ")


async def _load(conn, form_id) -> dict:
    cur = await conn.execute(FORM_SQL + "WHERE f.id = %s", (form_id,))
    f = await cur.fetchone()
    if not f:
        raise Problem(404, "Form not found.", code="not_found")
    return f


def _check(fields):
    errs = check_field_defs([f if isinstance(f, dict) else f.model_dump() for f in fields])
    if errs:
        raise Problem(422, "The form has invalid fields.", code="validation", fields=errs)


@router.post("/projects/{project_id}/forms", response_model=FormOut, status_code=201)
async def create_form(project_id: UUID, body: FormIn, user=Depends(current_user), conn=Depends(get_conn)):
    await require_role(conn, project_id, user["id"], "admin")
    _check(body.fields)
    cur = await conn.execute(
        "INSERT INTO forms (project_id, name, geometry_type, fields, created_by) VALUES (%s, %s, %s, %s, %s) "
        "RETURNING id", (project_id, body.name, body.geometry_type,
                         Jsonb([f.model_dump(exclude_none=True) for f in body.fields]), user["id"]))
    return await _load(conn, (await cur.fetchone())["id"])


@router.get("/projects/{project_id}/forms", response_model=Page[FormOut])
async def list_forms(project_id: UUID, limit: int = Query(50, ge=1, le=200), cursor: str | None = None,
                     user=Depends(current_user), conn=Depends(get_conn)):
    await require_role(conn, project_id, user["id"])
    off = decode_cursor(cursor).get("o", 0)
    cur = await conn.execute(FORM_SQL + "WHERE f.project_id = %s ORDER BY f.created_at, f.id LIMIT %s OFFSET %s",
                             (project_id, limit + 1, off))
    items, nxt = page_from_offset(await cur.fetchall(), limit, off)
    return {"items": items, "next_cursor": nxt}


@router.get("/forms/{form_id}", response_model=FormOut)
async def get_form(form_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    f = await _load(conn, form_id)
    await require_role(conn, f["project_id"], user["id"])
    return f


@router.patch("/forms/{form_id}", response_model=FormOut)
async def update_form(form_id: UUID, body: FormPatch, user=Depends(current_user), conn=Depends(get_conn)):
    """Edits the working draft. Collectors keep using the last published version until you publish again."""
    f = await _load(conn, form_id)
    await require_role(conn, f["project_id"], user["id"], "admin")
    if body.geometry_type and body.geometry_type != f["geometry_type"] and f["version"] > 0:
        raise Problem(409, "Geometry type cannot change after a form has been published.", code="geometry_locked")
    if body.fields is not None:
        _check(body.fields)
    await conn.execute(
        "UPDATE forms SET name = COALESCE(%s, name), geometry_type = COALESCE(%s, geometry_type), "
        "fields = COALESCE(%s, fields), updated_at = now() WHERE id = %s",
        (body.name, body.geometry_type,
         Jsonb([x.model_dump(exclude_none=True) for x in body.fields]) if body.fields is not None else None, form_id))
    return await _load(conn, form_id)


@router.post("/forms/{form_id}/publish", response_model=FormOut)
async def publish_form(form_id: UUID, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    """Freeze the draft as the next version. Older versions stay readable and keep validating older features."""
    f = await _load(conn, form_id)
    await require_role(conn, f["project_id"], user["id"], "admin")
    if f["version"] > 0 and not f["has_unpublished_changes"]:
        raise Problem(409, "There are no changes to publish.", code="nothing_to_publish")
    nxt = f["version"] + 1
    await conn.execute(
        "INSERT INTO form_versions (form_id, version, name, geometry_type, fields, published_by) "
        "SELECT id, %s, name, geometry_type, fields, %s FROM forms WHERE id = %s", (nxt, user["id"], form_id))
    await conn.execute("UPDATE forms SET version = %s, updated_at = now() WHERE id = %s", (nxt, form_id))
    await audit(conn, "form.publish", actor_id=user["id"], project_id=f["project_id"], target_type="form",
                target_id=form_id, ip=client_ip(request), version=nxt)
    return await _load(conn, form_id)


@router.get("/forms/{form_id}/versions", response_model=list[FormVersionOut])
async def list_versions(form_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    f = await _load(conn, form_id)
    await require_role(conn, f["project_id"], user["id"])
    cur = await conn.execute("SELECT form_id, version, name, geometry_type, fields, published_at FROM form_versions "
                             "WHERE form_id = %s ORDER BY version DESC", (form_id,))
    return await cur.fetchall()


@router.get("/forms/{form_id}/versions/{version}", response_model=FormVersionOut)
async def get_version(form_id: UUID, version: int, user=Depends(current_user), conn=Depends(get_conn)):
    f = await _load(conn, form_id)
    await require_role(conn, f["project_id"], user["id"])
    cur = await conn.execute("SELECT form_id, version, name, geometry_type, fields, published_at FROM form_versions "
                             "WHERE form_id = %s AND version = %s", (form_id, version))
    v = await cur.fetchone()
    if not v:
        raise Problem(404, "Form version not found.", code="not_found")
    return v
