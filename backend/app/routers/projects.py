import json
from urllib.parse import quote
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request, Response

from .. import orgs, storage
from ..audit import audit
from ..db import get_conn
from ..deps import RANK, current_user, require_role
from ..errors import Problem
from ..logging_setup import client_ip
from ..mailer import send_email
from ..config import settings
from ..pagination import Page, decode_cursor, page_from_offset, encode_cursor
from ..schemas import AuditOut, MemberIn, MemberOut, MemberPatch, ProjectIn, ProjectOut, ProjectPatch
from ..services.geo import check_geometry

router = APIRouter(tags=["projects"])

# The caller's role: the highest of their project membership, their teams' role, and owner/admin when they own or
# run the organization.
PROJECT_SQL = (
    "SELECT p.id, p.name, p.description, p.created_at, "
    "(ARRAY['viewer','collector','admin','owner'])[GREATEST("
    "   array_position(ARRAY['viewer','collector','admin','owner'], m.role), "
    "   array_position(ARRAY['viewer','collector','admin','owner'], t.role), "
    "   CASE om.role WHEN 'owner' THEN 4 WHEN 'admin' THEN 3 END)] AS role, "
    "p.last_activity_at AS last_update, "
    "(SELECT count(*) FROM features f WHERE f.project_id = p.id AND f.deleted_at IS NULL) AS feature_count, "
    "(SELECT count(*) FROM features f WHERE f.project_id = p.id AND f.deleted_at IS NULL AND f.status = 'submitted') AS waiting_count, "
    "(SELECT count(*) FROM members mm WHERE mm.project_id = p.id AND mm.role = 'collector') AS collector_count "
    "FROM projects p LEFT JOIN members m ON m.project_id = p.id AND m.user_id = %(u)s "
    "LEFT JOIN org_members om ON om.user_id = %(u)s AND om.org_id = p.org_id AND om.role IN ('owner','admin') "
    "LEFT JOIN team_project_roles t ON t.project_id = p.id AND t.user_id = %(u)s "
    "WHERE (m.user_id IS NOT NULL OR om.user_id IS NOT NULL OR t.user_id IS NOT NULL) ")


@router.post("/projects", response_model=ProjectOut, status_code=201)
async def create_project(body: ProjectIn, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    org = await orgs.require_builder(conn, user)
    await orgs.check_limit(conn, org["org_id"], "projects")
    cur = await conn.execute("INSERT INTO projects (name, description, created_by, org_id) VALUES (%s, %s, %s, %s) RETURNING id",
                             (body.name, body.description, user["id"], org["org_id"]))
    pid = (await cur.fetchone())["id"]
    await conn.execute("INSERT INTO members (project_id, user_id, role) VALUES (%s, %s, 'owner')", (pid, user["id"]))
    await audit(conn, "project.create", actor_id=user["id"], project_id=pid, target_type="project", target_id=pid,
                ip=client_ip(request))
    cur = await conn.execute(PROJECT_SQL + "AND p.id = %(p)s", {"u": user["id"], "p": pid})
    return await cur.fetchone()


@router.get("/projects", response_model=Page[ProjectOut])
async def list_projects(limit: int = Query(50, ge=1, le=200), cursor: str | None = None,
                        user=Depends(current_user), conn=Depends(get_conn)):
    off = decode_cursor(cursor).get("o", 0)
    cur = await conn.execute(PROJECT_SQL + "ORDER BY p.last_activity_at DESC, p.id LIMIT %(l)s OFFSET %(o)s",
                             {"u": user["id"], "l": limit + 1, "o": off})
    items, nxt = page_from_offset(await cur.fetchall(), limit, off)
    return {"items": items, "next_cursor": nxt}


@router.get("/projects/{project_id}", response_model=ProjectOut)
async def get_project(project_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    await require_role(conn, project_id, user["id"])
    cur = await conn.execute(PROJECT_SQL + "AND p.id = %(p)s", {"u": user["id"], "p": project_id})
    return await cur.fetchone()


@router.patch("/projects/{project_id}", response_model=ProjectOut)
async def update_project(project_id: UUID, body: ProjectPatch, user=Depends(current_user), conn=Depends(get_conn)):
    await require_role(conn, project_id, user["id"], "admin")
    await conn.execute("UPDATE projects SET name = COALESCE(%s, name), description = COALESCE(%s, description) "
                       "WHERE id = %s", (body.name, body.description, project_id))
    cur = await conn.execute(PROJECT_SQL + "AND p.id = %(p)s", {"u": user["id"], "p": project_id})
    return await cur.fetchone()


@router.delete("/projects/{project_id}", status_code=204)
async def delete_project(project_id: UUID, request: Request, tasks: BackgroundTasks,
                         user=Depends(current_user), conn=Depends(get_conn)):
    await require_role(conn, project_id, user["id"], "owner")
    cur = await conn.execute("SELECT id FROM datasets WHERE project_id = %s", (project_id,))
    dataset_ids = [str(r["id"]) for r in await cur.fetchall()]
    await audit(conn, "project.delete", actor_id=user["id"], project_id=project_id, target_type="project",
                target_id=project_id, ip=client_ip(request))
    await conn.execute("DELETE FROM projects WHERE id = %s", (project_id,))
    prefixes = [f"media/{project_id}/", f"imagery/{project_id}/"] + [
        p for d in dataset_ids for p in (f"snapshots/{d}/", f"exports/{d}/")]
    for p in prefixes:
        tasks.add_task(storage.delete_prefix, p)
    return Response(status_code=204)


# ---------- members ----------
async def _area(conn, area):
    if area is None:
        return None
    err = check_geometry("area", area)
    if err:
        raise Problem(422, "assigned_area is not a valid polygon.", code="validation", fields={"assigned_area": [err]})
    return json.dumps(area)


@router.get("/projects/{project_id}/members", response_model=Page[MemberOut])
async def list_members(project_id: UUID, limit: int = Query(100, ge=1, le=200), cursor: str | None = None,
                       user=Depends(current_user), conn=Depends(get_conn)):
    await require_role(conn, project_id, user["id"])
    off = decode_cursor(cursor).get("o", 0)
    cur = await conn.execute(
        "SELECT * FROM ("
        " SELECT u.id, u.id AS user_id, u.email, u.name, m.role, 'active' AS status, "
        "  ST_AsGeoJSON(m.assigned_area)::jsonb AS assigned_area FROM members m JOIN users u ON u.id = m.user_id "
        "  WHERE m.project_id = %s "
        " UNION ALL "
        " SELECT i.id, NULL, i.email, NULL, i.role, 'invited', NULL FROM invitations i WHERE i.project_id = %s"
        ") x ORDER BY (status = 'active') DESC, array_position(ARRAY['owner','admin','collector','viewer'], role), "
        "email LIMIT %s OFFSET %s", (project_id, project_id, limit + 1, off))
    items, nxt = page_from_offset(await cur.fetchall(), limit, off)
    return {"items": items, "next_cursor": nxt}


@router.post("/projects/{project_id}/members", response_model=MemberOut, status_code=201)
async def add_member(project_id: UUID, body: MemberIn, request: Request, user=Depends(current_user),
                     conn=Depends(get_conn)):
    """Invite by email. Existing users join immediately; others get an invitation that is accepted when they register."""
    actor = await require_role(conn, project_id, user["id"], "admin")
    if body.role == "admin" and actor != "owner":
        raise Problem(403, "Only an owner can add admins.", code="forbidden")
    area = await _area(conn, body.assigned_area)
    ip = client_ip(request)
    cur = await conn.execute("SELECT id, name FROM users WHERE lower(email) = lower(%s)", (body.email,))
    target = await cur.fetchone()
    cur = await conn.execute("SELECT name FROM projects WHERE id = %s", (project_id,))
    pname = (await cur.fetchone())["name"]
    cur = await conn.execute("SELECT org_id FROM projects WHERE id = %s", (project_id,))
    project_org = (await cur.fetchone())["org_id"]
    if target:
        cur = await conn.execute("SELECT 1 FROM members WHERE project_id = %s AND user_id = %s", (project_id, target["id"]))
        if await cur.fetchone():
            raise Problem(409, "That person is already a member.", code="already_member")
        # projects are shared within an organization; a fresh sign-up is brought into it, in the matching kind
        join_as = {"collector": "collector", "viewer": "viewer"}.get(body.role, "member")
        if project_org and await orgs.bring_into(conn, target["id"], project_org, join_as):
            await audit(conn, "org.member_join", actor_id=user["id"], project_id=project_id, target_type="user",
                        target_id=target["id"], ip=ip, via="project")
        await orgs.check_project_role(conn, target["id"], body.role)
        await conn.execute("INSERT INTO members (project_id, user_id, role, assigned_area) "
                           "VALUES (%s, %s, %s, geom_from_json(%s))", (project_id, target["id"], body.role, area))
        await audit(conn, "member.add", actor_id=user["id"], project_id=project_id, target_type="user",
                    target_id=target["id"], ip=ip, role=body.role)
        await send_email(body.email, f"You were added to {pname}",
                         f"{user['name']} added you to the project \"{pname}\" on Geohub as {body.role}.",
                         action=("Open the project", f"{settings.app_url}/collect/{project_id}"),
                         key=f"project-add/{project_id}/{target['id']}")
        return {"id": target["id"], "user_id": target["id"], "email": body.email.lower(), "name": target["name"],
                "role": body.role, "status": "active", "assigned_area": body.assigned_area}
    cur = await conn.execute(
        "INSERT INTO invitations (project_id, email, role, invited_by) VALUES (%s, %s, %s, %s) "
        "ON CONFLICT (project_id, lower(email)) DO UPDATE SET role = EXCLUDED.role RETURNING id",
        (project_id, body.email.lower(), body.role, user["id"]))
    inv = await cur.fetchone()
    await audit(conn, "member.invite", actor_id=user["id"], project_id=project_id, target_type="invitation",
                target_id=inv["id"], ip=ip, email=body.email.lower(), role=body.role)
    await send_email(body.email, f"{user['name']} invited you to {pname}",
                     f"{user['name']} invited you to the project \"{pname}\" on Geohub as {body.role}.\n\n"
                     f"Create your account with this email address ({body.email.lower()}) to join.",
                     action=("Create your account", f"{settings.app_url}/login?signup=1&email={quote(body.email.lower())}"),
                     key=f"project-invite/{inv['id']}/{body.role}")
    return {"id": inv["id"], "user_id": None, "email": body.email.lower(), "name": None, "role": body.role,
            "status": "invited", "assigned_area": None}


async def _target(conn, project_id, ident):
    cur = await conn.execute("SELECT user_id, role FROM members WHERE project_id = %s AND user_id = %s",
                             (project_id, ident))
    m = await cur.fetchone()
    if m:
        return "member", m
    cur = await conn.execute("SELECT id, email, role FROM invitations WHERE project_id = %s AND id = %s",
                             (project_id, ident))
    inv = await cur.fetchone()
    if inv:
        return "invitation", inv
    raise Problem(404, "Member not found.", code="not_found")


async def _owner_count(conn, project_id) -> int:
    cur = await conn.execute("SELECT count(*) AS n FROM members WHERE project_id = %s AND role = 'owner'", (project_id,))
    return (await cur.fetchone())["n"]


@router.patch("/projects/{project_id}/members/{user_id}", response_model=MemberOut)
async def update_member(project_id: UUID, user_id: UUID, body: MemberPatch, request: Request,
                        user=Depends(current_user), conn=Depends(get_conn)):
    """`user_id` is a user id, or an invitation id for pending invites."""
    actor = await require_role(conn, project_id, user["id"], "admin")
    kind, t = await _target(conn, project_id, user_id)
    if actor != "owner" and (RANK[t["role"]] >= RANK["admin"] or (body.role and RANK[body.role] >= RANK["admin"])):
        raise Problem(403, "Only an owner can change admins or owners.", code="forbidden")
    if body.role == "owner" and t["role"] != "owner" and kind == "invitation":
        raise Problem(422, "Invitations cannot be owners.", code="validation")
    if kind == "invitation":
        if body.role:
            await conn.execute("UPDATE invitations SET role = %s WHERE id = %s", (body.role, user_id))
        cur = await conn.execute("SELECT id, email, role FROM invitations WHERE id = %s", (user_id,))
        i = await cur.fetchone()
        return {"id": i["id"], "user_id": None, "email": i["email"], "name": None, "role": i["role"],
                "status": "invited", "assigned_area": None}
    if t["role"] == "owner" and body.role and body.role != "owner" and await _owner_count(conn, project_id) <= 1:
        raise Problem(409, "A project needs at least one owner.", code="last_owner")
    area = await _area(conn, body.assigned_area)
    if body.role:
        await orgs.check_project_role(conn, user_id, body.role)
        await conn.execute("UPDATE members SET role = %s WHERE project_id = %s AND user_id = %s",
                           (body.role, project_id, user_id))
        await audit(conn, "member.role_change", actor_id=user["id"], project_id=project_id, target_type="user",
                    target_id=user_id, ip=client_ip(request), old=t["role"], new=body.role)
    if body.clear_assigned_area:
        await conn.execute("UPDATE members SET assigned_area = NULL WHERE project_id = %s AND user_id = %s",
                           (project_id, user_id))
    elif area:
        await conn.execute("UPDATE members SET assigned_area = geom_from_json(%s) WHERE project_id = %s AND user_id = %s",
                           (area, project_id, user_id))
    cur = await conn.execute(
        "SELECT u.id, u.id AS user_id, u.email, u.name, m.role, 'active' AS status, "
        "ST_AsGeoJSON(m.assigned_area)::jsonb AS assigned_area FROM members m JOIN users u ON u.id = m.user_id "
        "WHERE m.project_id = %s AND m.user_id = %s", (project_id, user_id))
    return await cur.fetchone()


@router.delete("/projects/{project_id}/members/{user_id}", status_code=204)
async def remove_member(project_id: UUID, user_id: UUID, request: Request, user=Depends(current_user),
                        conn=Depends(get_conn)):
    me = await require_role(conn, project_id, user["id"])
    kind, t = await _target(conn, project_id, user_id)
    leaving = kind == "member" and user_id == user["id"]
    if not leaving:
        if RANK[me] < RANK["admin"]:
            raise Problem(403, "This action needs the admin role or higher.", code="forbidden")
        if me != "owner" and RANK[t["role"]] >= RANK["admin"]:
            raise Problem(403, "Only an owner can remove admins or owners.", code="forbidden")
    if kind == "invitation":
        await conn.execute("DELETE FROM invitations WHERE id = %s", (user_id,))
    else:
        if t["role"] == "owner" and await _owner_count(conn, project_id) <= 1:
            raise Problem(409, "A project needs at least one owner.", code="last_owner")
        await conn.execute("DELETE FROM members WHERE project_id = %s AND user_id = %s", (project_id, user_id))
    await audit(conn, "member.remove", actor_id=user["id"], project_id=project_id, target_type="user",
                target_id=user_id, ip=client_ip(request), role=t["role"])
    return Response(status_code=204)


# Groups of actions the activity page filters by. Each is a list of LIKE patterns on audit_log.action.
AUDIT_KINDS = {
    "records": ["feature.%", "features.%"],
    "forms": ["form.%"],
    "people": ["member.%"],
    "publishing": ["dataset.%", "export.%"],
    "dashboards": ["dashboard.%"],
    "project": ["project.%", "imagery.%"],
}


@router.get("/projects/{project_id}/audit", response_model=Page[AuditOut], tags=["audit"])
async def audit_log(project_id: UUID, limit: int = Query(50, ge=1, le=200), cursor: str | None = None,
                    kind: Literal["records", "forms", "people", "publishing", "dashboards", "project"] | None = None,
                    actor: UUID | None = None,
                    user=Depends(current_user), conn=Depends(get_conn)):
    """The project's activity, newest first, with who did it and what it was done to, by name where it still exists."""
    await require_role(conn, project_id, user["id"], "admin")
    before = decode_cursor(cursor).get("b")
    patterns = AUDIT_KINDS[kind] if kind else None
    cur = await conn.execute(
        "SELECT a.id, a.at, a.actor_id, u.name AS actor_name, a.action, a.target_type, a.target_id, a.details, "
        "  CASE a.target_type "
        "    WHEN 'form' THEN (SELECT name FROM forms WHERE id::text = a.target_id) "
        "    WHEN 'user' THEN (SELECT name FROM users WHERE id::text = a.target_id) "
        "    WHEN 'dashboard' THEN (SELECT name FROM dashboards WHERE id::text = a.target_id) "
        "    WHEN 'dataset' THEN (SELECT title FROM datasets WHERE id::text = a.target_id OR slug = a.target_id LIMIT 1) "
        "    WHEN 'project' THEN (SELECT name FROM projects WHERE id::text = a.target_id) "
        "    WHEN 'feature' THEN (SELECT fo.name FROM features f JOIN forms fo ON fo.id = f.form_id WHERE f.id::text = a.target_id) "
        "  END AS target_name "
        "FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id "
        "WHERE a.project_id = %s AND (%s::bigint IS NULL OR a.id < %s) "
        "  AND (%s::text[] IS NULL OR a.action LIKE ANY(%s::text[])) "
        "  AND (%s::uuid IS NULL OR a.actor_id = %s) "
        "ORDER BY a.id DESC LIMIT %s",
        (project_id, before, before, patterns, patterns, actor, actor, limit + 1))
    rows = await cur.fetchall()
    more = len(rows) > limit
    rows = rows[:limit]
    return {"items": rows, "next_cursor": encode_cursor(b=rows[-1]["id"]) if more else None}
