"""Organizations: every person belongs to exactly one; projects and maps belong to one.

A shared deployment hosts many client organizations, each seeing only its own work. With SINGLE_ORG=true the
deployment is a private copy for one client: the first account creates the organization and everyone after
needs an invitation.
"""
import re

from .config import settings
from .errors import Problem

ORG_RANK = {"viewer": 0, "collector": 0, "member": 1, "admin": 2, "owner": 3}
ORG_ROLES = ("owner", "admin", "member", "collector", "viewer")

# Plans differ by how many people they hold, in three kinds; projects, maps, forms and records are unlimited.
# None = unlimited. A Custom plan's numbers, or any one-off change, go in the organization's `limits`.
PLANS = {
    "individual": {"seats": 1, "collectors": 5, "viewers": 5},
    "standard": {"seats": 10, "collectors": 50, "viewers": 50},
    "advanced": {"seats": 30, "collectors": 300, "viewers": None},
    "custom": {"seats": None, "collectors": None, "viewers": None},
}
PLAN_NAMES = {"individual": "Individual", "standard": "Organization Standard", "advanced": "Organization Advanced",
              "custom": "Custom"}
PEOPLE_KINDS = ("seats", "collectors", "viewers")
# Which count a role uses: team seats for those who build and run the work.
KIND_OF_ROLE = {"owner": "seats", "admin": "seats", "member": "seats", "collector": "collectors", "viewer": "viewers"}
# What each limit counts, in words. Projects and records are only capped when set by hand in `limits`.
LIMIT_LABEL = {"seats": "team seats", "collectors": "field collectors", "viewers": "viewers",
               "projects": "projects", "records": "records"}


def caps(plan: str, limits: dict | None) -> dict:
    """The people caps that apply: the plan's, with any per-organization numbers on top."""
    out = dict(PLANS.get(plan, PLANS["individual"]))
    for k, v in (limits or {}).items():
        out[k] = None if v is None else int(v)
    return out


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s[:48] or "organization"


async def create_org(conn, name: str, owner_id, plan: str = "individual") -> dict:
    """A new organization with `owner_id` as its owner. The slug is made unique by adding a number."""
    base = slugify(name)
    slug, n = base, 1
    while True:
        cur = await conn.execute("SELECT 1 FROM organizations WHERE slug = %s", (slug,))
        if not await cur.fetchone():
            break
        n += 1
        slug = f"{base}-{n}"
    cur = await conn.execute("INSERT INTO organizations (name, slug, plan) VALUES (%s, %s, %s) RETURNING id, name, slug",
                             (name.strip()[:120] or "My organization", slug, plan))
    org = await cur.fetchone()
    await conn.execute("INSERT INTO org_members (user_id, org_id, role) VALUES (%s, %s, 'owner')", (owner_id, org["id"]))
    return org


async def membership(conn, user_id) -> dict | None:
    """The person's organization and their role in it: {org_id, role, name, slug, plan, limits}."""
    cur = await conn.execute(
        "SELECT om.org_id, om.role, o.name, o.slug, o.plan, o.limits, o.subscription_starts, o.subscription_ends "
        "FROM org_members om "
        "JOIN organizations o ON o.id = om.org_id WHERE om.user_id = %s", (user_id,))
    return await cur.fetchone()


async def require_membership(conn, user: dict) -> dict:
    """The caller's organization. Someone removed from theirs gets a fresh personal one on a shared deployment;
    on a private copy they no longer have access."""
    m = await membership(conn, user["id"])
    if m:
        return m
    if settings.single_org:
        raise Problem(403, "You no longer have access to this organization. Ask an administrator to invite you.",
                      code="no_organization")
    await create_org(conn, f"{user['name']}'s organization", user["id"])
    return await membership(conn, user["id"])


async def require_org_role(conn, user: dict, minimum: str = "admin") -> dict:
    m = await require_membership(conn, user)
    if ORG_RANK[m["role"]] < ORG_RANK[minimum]:
        raise Problem(403, f"This needs an organization {minimum}.", code="forbidden")
    return m


async def usage(conn, org_id) -> dict:
    """People of each kind (pending invitations hold their place), plus projects and records for information."""
    cur = await conn.execute(
        "SELECT (SELECT count(*) FROM org_members WHERE org_id = %(o)s AND role IN ('owner','admin','member')) "
        "     + (SELECT count(*) FROM org_invitations WHERE org_id = %(o)s AND role IN ('admin','member')) AS seats, "
        "  (SELECT count(*) FROM org_members WHERE org_id = %(o)s AND role = 'collector') "
        "     + (SELECT count(*) FROM org_invitations WHERE org_id = %(o)s AND role = 'collector') AS collectors, "
        "  (SELECT count(*) FROM org_members WHERE org_id = %(o)s AND role = 'viewer') "
        "     + (SELECT count(*) FROM org_invitations WHERE org_id = %(o)s AND role = 'viewer') AS viewers, "
        "  (SELECT count(*) FROM projects WHERE org_id = %(o)s) AS projects, "
        "  (SELECT count(*) FROM features f JOIN projects p ON p.id = f.project_id "
        "     WHERE p.org_id = %(o)s AND f.deleted_at IS NULL) AS records", {"o": org_id})
    return dict(await cur.fetchone())


async def check_limit(conn, org_id, kind: str, adding: int = 1) -> None:
    """Refuse when `adding` more would go over the organization's cap for `kind`: a kind of person (seats,
    collectors, viewers) from its plan, or projects/records only when set by hand."""
    cur = await conn.execute("SELECT limits, plan FROM organizations WHERE id = %s", (org_id,))
    row = await cur.fetchone()
    if not row:
        return
    cap = caps(row["plan"], row["limits"]).get(kind) if kind in PEOPLE_KINDS else (row["limits"] or {}).get(kind)
    if cap is None:
        return
    used = (await usage(conn, org_id))[kind]
    if used + adding > int(cap):
        plan = PLAN_NAMES.get(row["plan"], row["plan"])
        raise Problem(402, f"Your plan ({plan}) includes {cap} {LIMIT_LABEL[kind]}, and all are in use. "
                           "Remove someone first, or contact GeoEstate to add more.",
                      code="plan_limit", fields={kind: [f"limit {cap}, using {used}"]})


async def is_empty_solo(conn, org_id) -> bool:
    """An organization with one person and no work: what a new sign-up gets before being invited elsewhere."""
    cur = await conn.execute(
        "SELECT (SELECT count(*) FROM org_members WHERE org_id = %(o)s) = 1 "
        "   AND NOT EXISTS (SELECT 1 FROM org_invitations WHERE org_id = %(o)s) "
        "   AND NOT EXISTS (SELECT 1 FROM projects WHERE org_id = %(o)s) "
        "   AND NOT EXISTS (SELECT 1 FROM workspace_maps WHERE org_id = %(o)s) AS empty", {"o": org_id})
    return (await cur.fetchone())["empty"]


async def bring_into(conn, user_id, org_id, role: str = "member") -> bool:
    """Make `user_id` a member of `org_id`. Someone in another organization can only be brought over when that one
    is an empty one-person organization (a fresh sign-up), which is then removed. Returns False when they are
    already a member."""
    cur = await conn.execute("SELECT org_id FROM org_members WHERE user_id = %s", (user_id,))
    cur_org = await cur.fetchone()
    if cur_org and cur_org["org_id"] == org_id:
        return False
    if cur_org and not await is_empty_solo(conn, cur_org["org_id"]):
        raise Problem(409, "That person already belongs to another organization. They need to leave it first, "
                           "or use a different email.", code="other_organization")
    await check_limit(conn, org_id, KIND_OF_ROLE[role])
    if cur_org:
        await conn.execute("DELETE FROM organizations WHERE id = %s", (cur_org["org_id"],))
    await conn.execute("INSERT INTO org_members (user_id, org_id, role) VALUES (%s, %s, %s)", (user_id, org_id, role))
    return True


async def join_on_signup(conn, user: dict, org_name: str | None) -> dict:
    """Put a new account in an organization: the one that invited them (to the organization or to one of its
    projects), else a new one they own. On a private copy only the very first account may create it."""
    cur = await conn.execute(
        "DELETE FROM org_invitations WHERE id = (SELECT id FROM org_invitations WHERE lower(email) = lower(%s) "
        "ORDER BY created_at LIMIT 1) RETURNING org_id, role", (user["email"],))
    inv = await cur.fetchone()
    if inv:
        # the invitation already held a seat: hand it over without counting twice
        await conn.execute("INSERT INTO org_members (user_id, org_id, role) VALUES (%s, %s, %s)", (user["id"], inv["org_id"], inv["role"]))
        await conn.execute("DELETE FROM org_invitations WHERE lower(email) = lower(%s)", (user["email"],))
        return await membership(conn, user["id"])
    cur = await conn.execute(
        "SELECT p.org_id, i.role FROM invitations i JOIN projects p ON p.id = i.project_id "
        "WHERE lower(i.email) = lower(%s) AND p.org_id IS NOT NULL ORDER BY i.created_at LIMIT 1", (user["email"],))
    via_project = await cur.fetchone()
    if via_project:
        # invited to collect or view a project: a field collector or viewer place; otherwise a team seat
        role = {"collector": "collector", "viewer": "viewer"}.get(via_project["role"], "member")
        await check_limit(conn, via_project["org_id"], KIND_OF_ROLE[role])
        await conn.execute("INSERT INTO org_members (user_id, org_id, role) VALUES (%s, %s, %s)", (user["id"], via_project["org_id"], role))
        return await membership(conn, user["id"])
    if settings.single_org:
        cur = await conn.execute("SELECT 1 FROM organizations LIMIT 1")
        if await cur.fetchone():
            raise Problem(403, "Sign-up is by invitation only. Ask an administrator to invite you.", code="invite_only")
        await create_org(conn, settings.org_name, user["id"], plan="custom")   # a private copy has no caps
        return await membership(conn, user["id"])
    # Anyone signing up themselves gets the free Individual plan; organizations are set up by GeoEstate.
    await create_org(conn, org_name or f"{user['name']}'s organization", user["id"], plan="individual")
    return await membership(conn, user["id"])


def org_out(m: dict | None) -> dict | None:
    return {"id": m["org_id"], "name": m["name"], "slug": m["slug"], "role": m["role"], "plan": m["plan"]} if m else None


# ---------- what field collectors and viewers may be given ----------
# Their places are cheaper than team seats, so inside projects and maps they keep to their role.
PROJECT_ROLE_FOR = {"collector": ("collector", "viewer"), "viewer": ("viewer",)}
MAP_ROLE_FOR = {"collector": ("contributor",), "viewer": ()}


async def org_role(conn, user_id) -> str | None:
    cur = await conn.execute("SELECT role FROM org_members WHERE user_id = %s", (user_id,))
    row = await cur.fetchone()
    return row["role"] if row else None


async def check_project_role(conn, user_id, project_role: str) -> None:
    allowed = PROJECT_ROLE_FOR.get(await org_role(conn, user_id) or "")
    if allowed is not None and project_role not in allowed:
        kind = "a field collector" if "collector" in allowed else "a viewer"
        can = " or ".join(allowed)
        raise Problem(422, f"This person is {kind} in your organization, so in projects they can only be {can}. "
                           "Change their organization role first.", code="role_not_allowed",
                      fields={"role": [f"only {can}"]})


async def check_map_role(conn, user_id, map_role: str) -> None:
    allowed = MAP_ROLE_FOR.get(await org_role(conn, user_id) or "")
    if allowed is not None and map_role not in allowed:
        raise Problem(403, "Viewers can open shared maps and dashboards but cannot join a map to edit it."
                      if not allowed else "Field collectors can only be contributors on a map.", code="role_not_allowed")


async def require_builder(conn, user: dict) -> dict:
    """Owners, admins and members build projects and maps; field collectors and viewers do not."""
    m = await require_membership(conn, user)
    if m["role"] in ("collector", "viewer"):
        raise Problem(403, "Field collectors and viewers cannot create projects or maps. Ask an organization admin.",
                      code="forbidden")
    return m
