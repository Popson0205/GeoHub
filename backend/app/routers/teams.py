"""Teams (departments) inside an organization, and the projects they are given.

Administrators make teams and choose their leads. A lead adds and removes the team's people, and runs the team's
projects (an admin of each). Giving a team a project gives everyone in it a role there, kept within what their kind
of place allows: field collectors can at most collect, viewers only view. Standard plans have 2 teams, Advanced 10."""
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response

from .. import orgs
from ..audit import audit
from ..db import get_conn
from ..deps import current_user, require_role
from ..errors import Problem
from ..logging_setup import client_ip
from ..schemas import ProjectTeamIn, ProjectTeamOut, TeamIn, TeamMemberIn, TeamOut, TeamPatch

router = APIRouter(tags=["teams"])

TEAM_SQL = (
    "SELECT t.id, t.name, t.description, t.created_at, "
    "  COALESCE((SELECT json_agg(json_build_object('user_id', u.id, 'name', u.name, 'email', u.email, 'role', om.role, "
    "      'lead', tm.lead) ORDER BY tm.lead DESC, lower(u.name)) "
    "    FROM team_members tm JOIN users u ON u.id = tm.user_id JOIN org_members om ON om.user_id = u.id AND om.org_id = t.org_id "
    "    WHERE tm.team_id = t.id), '[]') AS members, "
    "  COALESCE((SELECT json_agg(json_build_object('project_id', p.id, 'name', p.name, 'role', pt.role) ORDER BY lower(p.name)) "
    "    FROM project_teams pt JOIN projects p ON p.id = pt.project_id WHERE pt.team_id = t.id), '[]') AS projects "
    "FROM org_teams t WHERE t.org_id = %(o)s ")


def _with_rights(t: dict, m: dict, user_id) -> dict:
    lead = any(x["lead"] and str(x["user_id"]) == str(user_id) for x in t["members"])
    admin = orgs.ORG_RANK[m["role"]] >= orgs.ORG_RANK["admin"]
    return {**t, "you_lead": lead, "can_manage_people": admin or lead, "can_edit": admin}


async def _team(conn, m: dict, team_id, user_id) -> dict:
    cur = await conn.execute(TEAM_SQL + "AND t.id = %(t)s", {"o": m["org_id"], "t": team_id})
    t = await cur.fetchone()
    if not t:
        raise Problem(404, "Team not found.", code="not_found")
    return _with_rights(t, m, user_id)


@router.get("/org/teams", response_model=list[TeamOut], summary="The organization's teams, their people and projects")
async def list_teams(user=Depends(current_user), conn=Depends(get_conn)):
    m = await orgs.require_membership(conn, user)
    cur = await conn.execute(TEAM_SQL + "ORDER BY lower(t.name)", {"o": m["org_id"]})
    return [_with_rights(t, m, user["id"]) for t in await cur.fetchall()]


@router.post("/org/teams", response_model=TeamOut, status_code=201, summary="Make a team (admins)")
async def create_team(body: TeamIn, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    m = await orgs.require_org_role(conn, user, "admin")
    await orgs.check_limit(conn, m["org_id"], "teams")
    cur = await conn.execute("SELECT 1 FROM org_teams WHERE org_id = %s AND lower(name) = lower(%s)", (m["org_id"], body.name.strip()))
    if await cur.fetchone():
        raise Problem(409, "There is already a team with that name.", code="team_exists", fields={"name": ["taken"]})
    cur = await conn.execute("INSERT INTO org_teams (org_id, name, description) VALUES (%s, %s, %s) RETURNING id",
                             (m["org_id"], body.name.strip(), body.description.strip()))
    tid = (await cur.fetchone())["id"]
    await audit(conn, "team.create", actor_id=user["id"], target_type="team", target_id=tid, ip=client_ip(request),
                org_id=str(m["org_id"]), name=body.name.strip())
    return await _team(conn, m, tid, user["id"])


@router.patch("/org/teams/{team_id}", response_model=TeamOut, summary="Rename a team or change its description (admins)")
async def update_team(team_id: UUID, body: TeamPatch, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    m = await orgs.require_org_role(conn, user, "admin")
    await _team(conn, m, team_id, user["id"])
    if body.name is not None:
        cur = await conn.execute("SELECT 1 FROM org_teams WHERE org_id = %s AND lower(name) = lower(%s) AND id <> %s",
                                 (m["org_id"], body.name.strip(), team_id))
        if await cur.fetchone():
            raise Problem(409, "There is already a team with that name.", code="team_exists", fields={"name": ["taken"]})
    await conn.execute("UPDATE org_teams SET name = COALESCE(%s, name), description = COALESCE(%s, description) WHERE id = %s",
                       (body.name.strip() if body.name else None, body.description.strip() if body.description is not None else None, team_id))
    await audit(conn, "team.update", actor_id=user["id"], target_type="team", target_id=team_id, ip=client_ip(request),
                **body.model_dump(exclude_none=True))
    return await _team(conn, m, team_id, user["id"])


@router.delete("/org/teams/{team_id}", status_code=204, summary="Delete a team (admins)")
async def delete_team(team_id: UUID, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    """Its people stay in the organization, and keep any project roles given to them directly."""
    m = await orgs.require_org_role(conn, user, "admin")
    t = await _team(conn, m, team_id, user["id"])
    await conn.execute("DELETE FROM org_teams WHERE id = %s", (team_id,))
    await audit(conn, "team.delete", actor_id=user["id"], target_type="team", target_id=team_id, ip=client_ip(request),
                name=t["name"])
    return Response(status_code=204)


@router.put("/org/teams/{team_id}/members/{user_id}", response_model=TeamOut,
            summary="Add someone to a team, or make them lead (admins and the team's leads)")
async def put_team_member(team_id: UUID, user_id: UUID, body: TeamMemberIn, request: Request, user=Depends(current_user),
                          conn=Depends(get_conn)):
    m = await orgs.require_membership(conn, user)
    t = await _team(conn, m, team_id, user["id"])
    if not t["can_manage_people"]:
        raise Problem(403, "Only administrators and the team's leads can change who is in it.", code="forbidden")
    cur = await conn.execute("SELECT role FROM org_members WHERE user_id = %s AND org_id = %s", (user_id, m["org_id"]))
    target = await cur.fetchone()
    if not target:
        raise Problem(404, "That person is not in your organization.", code="not_found")
    current = next((x for x in t["members"] if str(x["user_id"]) == str(user_id)), None)
    lead = body.lead if body.lead is not None else bool(current and current["lead"])
    if lead != bool(current and current["lead"]) and not t["can_edit"]:
        raise Problem(403, "Only administrators choose a team's leads.", code="forbidden")
    if lead and orgs.KIND_OF_ROLE[target["role"]] != "seats":
        raise Problem(422, "A team lead needs a team seat (a member, administrator or owner). Field collectors and "
                           "viewers can be in a team but not lead it.", code="role_not_allowed", fields={"lead": ["needs a team seat"]})
    await conn.execute("INSERT INTO team_members (team_id, user_id, lead) VALUES (%s, %s, %s) "
                       "ON CONFLICT (team_id, user_id) DO UPDATE SET lead = EXCLUDED.lead", (team_id, user_id, lead))
    await audit(conn, "team.member_put", actor_id=user["id"], target_type="team", target_id=team_id, ip=client_ip(request),
                user_id=str(user_id), lead=lead)
    return await _team(conn, m, team_id, user["id"])


@router.delete("/org/teams/{team_id}/members/{user_id}", response_model=TeamOut,
               summary="Take someone out of a team (admins and the team's leads)")
async def remove_team_member(team_id: UUID, user_id: UUID, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    m = await orgs.require_membership(conn, user)
    t = await _team(conn, m, team_id, user["id"])
    current = next((x for x in t["members"] if str(x["user_id"]) == str(user_id)), None)
    if not current:
        raise Problem(404, "That person is not in this team.", code="not_found")
    if not t["can_manage_people"] or (current["lead"] and not t["can_edit"] and str(user_id) != str(user["id"])):
        raise Problem(403, "Only administrators can take a lead out of a team.", code="forbidden")
    await conn.execute("DELETE FROM team_members WHERE team_id = %s AND user_id = %s", (team_id, user_id))
    await audit(conn, "team.member_remove", actor_id=user["id"], target_type="team", target_id=team_id, ip=client_ip(request),
                user_id=str(user_id))
    return await _team(conn, m, team_id, user["id"])


# ---------- a project's teams ----------
async def _project_teams(conn, project_id) -> list[dict]:
    cur = await conn.execute(
        "SELECT t.id AS team_id, t.name, pt.role, (SELECT count(*) FROM team_members tm WHERE tm.team_id = t.id) AS member_count "
        "FROM project_teams pt JOIN org_teams t ON t.id = pt.team_id WHERE pt.project_id = %s ORDER BY lower(t.name)", (project_id,))
    return await cur.fetchall()


@router.get("/projects/{project_id}/teams", response_model=list[ProjectTeamOut], summary="Teams given this project")
async def list_project_teams(project_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    await require_role(conn, project_id, user["id"])
    return await _project_teams(conn, project_id)


@router.put("/projects/{project_id}/teams/{team_id}", response_model=list[ProjectTeamOut],
            summary="Give a team this project, or change its role (project admins)")
async def put_project_team(project_id: UUID, team_id: UUID, body: ProjectTeamIn, request: Request, user=Depends(current_user),
                           conn=Depends(get_conn)):
    actor = await require_role(conn, project_id, user["id"], "admin")
    if body.role == "admin" and actor != "owner":
        raise Problem(403, "Only an owner can make a team admins of the project.", code="forbidden")
    cur = await conn.execute("SELECT t.id FROM org_teams t JOIN projects p ON p.org_id = t.org_id WHERE t.id = %s AND p.id = %s",
                             (team_id, project_id))
    if not await cur.fetchone():
        raise Problem(404, "That team is not in this project's organization.", code="not_found")
    await conn.execute("INSERT INTO project_teams (project_id, team_id, role) VALUES (%s, %s, %s) "
                       "ON CONFLICT (project_id, team_id) DO UPDATE SET role = EXCLUDED.role", (project_id, team_id, body.role))
    await audit(conn, "project.team_put", actor_id=user["id"], project_id=project_id, target_type="team", target_id=team_id,
                ip=client_ip(request), role=body.role)
    return await _project_teams(conn, project_id)


@router.delete("/projects/{project_id}/teams/{team_id}", response_model=list[ProjectTeamOut],
               summary="Take a team off this project (project admins)")
async def remove_project_team(project_id: UUID, team_id: UUID, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    await require_role(conn, project_id, user["id"], "admin")
    cur = await conn.execute("DELETE FROM project_teams WHERE project_id = %s AND team_id = %s RETURNING team_id", (project_id, team_id))
    if not await cur.fetchone():
        raise Problem(404, "That team is not on this project.", code="not_found")
    await audit(conn, "project.team_remove", actor_id=user["id"], project_id=project_id, target_type="team", target_id=team_id,
                ip=client_ip(request))
    return await _project_teams(conn, project_id)
