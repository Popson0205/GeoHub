import secrets
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from psycopg.types.json import Jsonb

from ..audit import audit
from ..config import settings
from ..db import get_conn
from ..deps import current_user, require_role
from ..errors import Problem
from ..logging_setup import client_ip
from ..pagination import Page
from ..ratelimit import limit
from ..schemas import (DashboardConfig, DashboardIn, DashboardOut, DashboardPatch, DashboardSharingOut,
                       DashboardSharingPatch, PublicDashboardOut)
from ..services.dashboard_share import MAX_PUBLIC_RECORDS, map_forms, shape_public_dashboard, used_fields

router = APIRouter(tags=["dashboards"])

COLUMNS = "id, project_id, name, config, updated_at, (share_token IS NOT NULL) AS shared"
MAX_PER_PROJECT = 50
# Dashboards show collected data, which collectors (who only collect) do not get to read back.
VIEW_ROLES = {"viewer", "admin", "owner"}


async def _can_view(conn, project_id, user_id) -> str:
    role = await require_role(conn, project_id, user_id)          # non-members get 404
    if role not in VIEW_ROLES:
        raise Problem(403, "Dashboards are for administrators and viewers.", code="forbidden")
    return role


async def _load(conn, dashboard_id) -> dict:
    cur = await conn.execute(f"SELECT {COLUMNS} FROM dashboards WHERE id = %s", (dashboard_id,))
    row = await cur.fetchone()
    if not row:
        raise Problem(404, "Dashboard not found.", code="not_found")
    return row


async def _check_forms(conn, project_id, config: DashboardConfig) -> None:
    """Every form a page or chart draws on must belong to this project."""
    wanted = config.form_ids()
    if not wanted:
        return
    cur = await conn.execute("SELECT id FROM forms WHERE project_id = %s AND id = ANY(%s)", (project_id, list(wanted)))
    missing = wanted - {r["id"] for r in await cur.fetchall()}
    if missing:
        raise Problem(422, "That form is not in this project.", code="validation",
                      fields={"config.pages": ["Pick forms from this project."]})


@router.get("/projects/{project_id}/dashboards", response_model=Page[DashboardOut])
async def list_dashboards(project_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    await _can_view(conn, project_id, user["id"])
    cur = await conn.execute(f"SELECT {COLUMNS} FROM dashboards WHERE project_id = %s ORDER BY created_at, id LIMIT %s",
                             (project_id, MAX_PER_PROJECT))
    return {"items": await cur.fetchall(), "next_cursor": None}


@router.post("/projects/{project_id}/dashboards", response_model=DashboardOut, status_code=201)
async def create_dashboard(project_id: UUID, body: DashboardIn, request: Request,
                           user=Depends(current_user), conn=Depends(get_conn)):
    await require_role(conn, project_id, user["id"], "admin")
    await _check_forms(conn, project_id, body.config)
    cur = await conn.execute("SELECT count(*) AS n FROM dashboards WHERE project_id = %s", (project_id,))
    if (await cur.fetchone())["n"] >= MAX_PER_PROJECT:
        raise Problem(409, f"A project can have up to {MAX_PER_PROJECT} dashboards.", code="conflict")
    cur = await conn.execute(
        "INSERT INTO dashboards (project_id, name, config, created_by) VALUES (%s, %s, %s, %s) RETURNING id",
        (project_id, body.name, Jsonb(body.config.model_dump(mode="json")), user["id"]))
    new_id = (await cur.fetchone())["id"]
    await audit(conn, "dashboard.create", actor_id=user["id"], project_id=project_id, target_type="dashboard",
                target_id=new_id, ip=client_ip(request))
    return await _load(conn, new_id)


@router.get("/dashboards/{dashboard_id}", response_model=DashboardOut)
async def get_dashboard(dashboard_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    d = await _load(conn, dashboard_id)
    await _can_view(conn, d["project_id"], user["id"])
    return d


@router.patch("/dashboards/{dashboard_id}", response_model=DashboardOut)
async def update_dashboard(dashboard_id: UUID, body: DashboardPatch, user=Depends(current_user),
                           conn=Depends(get_conn)):
    d = await _load(conn, dashboard_id)
    await require_role(conn, d["project_id"], user["id"], "admin")
    if body.config is not None:
        await _check_forms(conn, d["project_id"], body.config)
    await conn.execute(
        "UPDATE dashboards SET name = COALESCE(%s, name), config = COALESCE(%s, config), updated_at = now() WHERE id = %s",
        (body.name, Jsonb(body.config.model_dump(mode="json")) if body.config is not None else None, dashboard_id))
    return await _load(conn, dashboard_id)


@router.delete("/dashboards/{dashboard_id}", status_code=204)
async def delete_dashboard(dashboard_id: UUID, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    d = await _load(conn, dashboard_id)
    await require_role(conn, d["project_id"], user["id"], "admin")
    await conn.execute("DELETE FROM dashboards WHERE id = %s", (dashboard_id,))
    await audit(conn, "dashboard.delete", actor_id=user["id"], project_id=d["project_id"], target_type="dashboard",
                target_id=dashboard_id, ip=client_ip(request))
    return Response(status_code=204)


# ---------- share by link ----------
def _new_token() -> str:
    return secrets.token_urlsafe(32)                                # 256 bits: cannot be guessed or enumerated


@router.get("/dashboards/{dashboard_id}/sharing", response_model=DashboardSharingOut)
async def get_sharing(dashboard_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    d = await _load(conn, dashboard_id)
    await require_role(conn, d["project_id"], user["id"], "admin")
    cur = await conn.execute("SELECT share_token FROM dashboards WHERE id = %s", (dashboard_id,))
    token = (await cur.fetchone())["share_token"]
    return {"public": token is not None, "share_token": token}


@router.patch("/dashboards/{dashboard_id}/sharing", response_model=DashboardSharingOut)
async def set_sharing(dashboard_id: UUID, body: DashboardSharingPatch, request: Request, user=Depends(current_user),
                      conn=Depends(get_conn)):
    """Turn the public link on or off, or replace it. Off deletes the token, so an old link never comes back to life."""
    d = await _load(conn, dashboard_id)
    await require_role(conn, d["project_id"], user["id"], "admin")
    cur = await conn.execute("SELECT share_token FROM dashboards WHERE id = %s FOR UPDATE", (dashboard_id,))
    token = (await cur.fetchone())["share_token"]
    if body.public is False:
        token = None
    elif body.public is True or (token is not None and body.regenerate_link):
        if token is None or body.regenerate_link:
            token = _new_token()
    elif body.regenerate_link:
        raise Problem(409, "Turn the public link on first.", code="conflict")
    await conn.execute("UPDATE dashboards SET share_token = %s WHERE id = %s", (token, dashboard_id))
    await audit(conn, "dashboard.sharing", actor_id=user["id"], project_id=d["project_id"], target_type="dashboard",
                target_id=dashboard_id, ip=client_ip(request), public=token is not None, regenerated=body.regenerate_link)
    return {"public": token is not None, "share_token": token}


@router.get("/public/dashboards/{token}", response_model=PublicDashboardOut,
            dependencies=[Depends(limit("public_dashboard", lambda: settings.rate_anon_read_per_min))])
async def public_dashboard(token: str, response: Response, conn=Depends(get_conn)):
    """A dashboard by its public link, no sign-in. Only what services/dashboard_share.py allows leaves the project."""
    response.headers["Cache-Control"] = "no-store"                  # turning the link off must take effect at once
    response.headers["X-Robots-Tag"] = "noindex, nofollow"
    cur = await conn.execute(
        "SELECT d.id, d.project_id, d.name, d.config, d.updated_at, p.name AS project_name "
        "FROM dashboards d JOIN projects p ON p.id = d.project_id WHERE d.share_token = %s", (token,))
    d = await cur.fetchone()
    if not d:
        raise Problem(404, "This dashboard link is not valid, or it is no longer shared.", code="not_found")
    config = DashboardConfig.model_validate(d["config"])
    wanted = list(used_fields(config))
    cur = await conn.execute(
        "SELECT f.id, v.name, v.geometry_type, f.version, v.fields FROM forms f "
        "JOIN form_versions v ON v.form_id = f.id AND v.version = f.version "
        "WHERE f.project_id = %s AND f.id = ANY(%s) AND f.version > 0", (d["project_id"], wanted))
    forms = await cur.fetchall()
    cur = await conn.execute(
        "SELECT f.id, f.form_id, f.properties, f.updated_at, "
        "CASE WHEN f.form_id = ANY(%s) THEN ST_AsGeoJSON(f.geom, 7)::jsonb END AS geometry "
        "FROM features f WHERE f.project_id = %s AND f.form_id = ANY(%s) AND f.deleted_at IS NULL AND f.status = 'approved' "
        "ORDER BY f.updated_at DESC, f.id LIMIT %s",
        (list(map_forms(config)), d["project_id"], wanted, MAX_PUBLIC_RECORDS + 1))
    rows = await cur.fetchall()
    return shape_public_dashboard(token=token, name=d["name"], project_name=d["project_name"], config=config,
                                  updated_at=d["updated_at"], forms=forms, features=rows[:MAX_PUBLIC_RECORDS],
                                  truncated=len(rows) > MAX_PUBLIC_RECORDS)
