from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from psycopg.types.json import Jsonb

from ..audit import audit
from ..db import get_conn
from ..deps import current_user, require_role
from ..errors import Problem
from ..logging_setup import client_ip
from ..pagination import Page
from ..schemas import DashboardConfig, DashboardIn, DashboardOut, DashboardPatch

router = APIRouter(tags=["dashboards"])

COLUMNS = "id, project_id, name, config, updated_at"
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


async def _check_form(conn, project_id, config: DashboardConfig) -> None:
    if config.form_id is None:
        return
    cur = await conn.execute("SELECT 1 FROM forms WHERE id = %s AND project_id = %s", (config.form_id, project_id))
    if not await cur.fetchone():
        raise Problem(422, "That form is not in this project.", code="validation",
                      fields={"config.form_id": ["Pick a form from this project."]})


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
    await _check_form(conn, project_id, body.config)
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
        await _check_form(conn, d["project_id"], body.config)
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
