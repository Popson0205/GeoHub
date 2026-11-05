"""Geohub's data for the other GeoEstate apps, read with the person's own GeoEstate ID access token.

Land Registry reads enumeration (the parcels a field team mapped with a Geohub form) through this; LandCheck and
FarmScan can read field data the same way. What an app sees is exactly what the person may see in Geohub: projects
of their own organization in which they have a role, and nothing they could not open themselves.

  GET /id/data/projects                       the person's projects, each with its published forms
  GET /id/data/forms/{form_id}/features       a form's features (paged by seq), optionally by review status and shape
  GET /id/data/features/{feature_id}          one feature, as it is now"""
import json
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from .. import geoestate_id as gid
from ..db import get_conn
from ..deps import require_role, role_in
from ..errors import Problem

router = APIRouter(prefix="/id/data", tags=["GeoEstate ID"])
SHAPES = {"area": ("ST_Polygon", "ST_MultiPolygon"), "point": ("ST_Point", "ST_MultiPoint"), "line": ("ST_LineString", "ST_MultiLineString")}


async def app_person(request: Request, conn=Depends(get_conn)) -> dict:
    """The person behind an app's access token, still a member of the organization the token names."""
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise Problem(401, "Send the access token as a Bearer token.", code="unauthenticated", headers={"WWW-Authenticate": "Bearer"})
    claims = gid.verify(auth[7:].strip())
    if not claims.get("aud") or claims["aud"] not in gid.clients():
        raise Problem(401, "That token is for an app Geohub no longer knows.", code="invalid_token")
    org = claims.get("org")
    if not org:
        raise Problem(403, "Geohub's data is read for a person in an organization.", code="no_org")
    cur = await conn.execute("SELECT 1 FROM org_members WHERE user_id = %s AND org_id = %s", (claims["sub"], org["id"]))
    if not await cur.fetchone():
        raise Problem(403, "You are no longer in this organization.", code="not_member")
    return claims


def _fields(fields: list) -> list[dict]:
    """The form's questions an app can map from: id, label, type and choices (groups opened up)."""
    out = []
    for f in fields or []:
        if f.get("type") in ("group", "repeat"):
            out += _fields(f.get("fields") or f.get("children") or [])
        elif f.get("type") not in ("note",):
            out.append({k: f[k] for k in ("id", "label", "type", "choices") if k in f})
    return out


@router.get("/projects", summary="The person's projects in their organization, each with its published forms")
async def projects(person=Depends(app_person), conn=Depends(get_conn)):
    cur = await conn.execute("SELECT id, name, description FROM projects WHERE org_id = %s ORDER BY lower(name)", (person["org"]["id"],))
    out = []
    for p in await cur.fetchall():
        role = await role_in(conn, p["id"], person["sub"])
        if not role:
            continue
        cur2 = await conn.execute(
            "SELECT f.id, v.name, v.geometry_type, f.version, v.fields, "
            "  (SELECT count(*) FROM features x WHERE x.form_id = f.id AND x.deleted_at IS NULL) AS features, "
            "  (SELECT count(*) FROM features x WHERE x.form_id = f.id AND x.deleted_at IS NULL AND x.status = 'approved') AS approved "
            "FROM forms f JOIN form_versions v ON v.form_id = f.id AND v.version = f.version "
            "WHERE f.project_id = %s AND f.version > 0 ORDER BY lower(v.name)", (p["id"],))
        forms = [{"id": f["id"], "name": f["name"], "geometry_type": f["geometry_type"], "version": f["version"],
                  "features": f["features"], "approved": f["approved"], "fields": _fields(f["fields"])} for f in await cur2.fetchall()]
        out.append({"id": p["id"], "name": p["name"], "description": p["description"], "role": role, "forms": forms})
    return out


FEATURE_SQL = ("SELECT x.id, x.seq, x.status, x.version, x.form_version, ST_AsGeoJSON(x.geom, 9) AS g, x.properties, x.review_note, "
               "  x.reviewed_at, x.created_at, x.updated_at, cu.name AS created_by_name, ru.name AS reviewed_by_name "
               "FROM features x LEFT JOIN users cu ON cu.id = x.created_by LEFT JOIN users ru ON ru.id = x.reviewed_by ")


def _feature(r: dict) -> dict:
    r = dict(r)
    r["geometry"] = json.loads(r.pop("g"))
    return r


async def _form(conn, form_id, person) -> dict:
    cur = await conn.execute("SELECT f.id, f.project_id, p.org_id FROM forms f JOIN projects p ON p.id = f.project_id WHERE f.id = %s", (form_id,))
    f = await cur.fetchone()
    if not f or f["org_id"] != UUID(person["org"]["id"]):
        raise Problem(404, "Form not found.", code="not_found")
    await require_role(conn, f["project_id"], person["sub"], "viewer")
    return f


@router.get("/forms/{form_id}/features", summary="A form's features, oldest first, paged by seq")
async def features(form_id: UUID, status: str | None = Query(None, pattern="^(draft|submitted|approved|rejected)$"),
                   shape: str | None = Query(None, pattern="^(area|point|line)$"), after: int = Query(0, ge=0),
                   limit: int = Query(200, ge=1, le=1000), person=Depends(app_person), conn=Depends(get_conn)):
    await _form(conn, form_id, person)
    where, params = ["x.form_id = %s", "x.deleted_at IS NULL", "x.seq > %s"], [form_id, after]
    if status:
        where.append("x.status = %s"); params.append(status)
    if shape:
        where.append("GeometryType(x.geom) = ANY(%s)"); params.append([s.removeprefix("ST_").upper() for s in SHAPES[shape]])
    cur = await conn.execute(FEATURE_SQL + f"WHERE {' AND '.join(where)} ORDER BY x.seq LIMIT %s", (*params, limit + 1))
    rows = [_feature(r) for r in await cur.fetchall()]
    more = len(rows) > limit
    rows = rows[:limit]
    return {"features": rows, "next": rows[-1]["seq"] if more else None}


@router.get("/features/{feature_id}", summary="One feature, as it is now")
async def feature(feature_id: UUID, person=Depends(app_person), conn=Depends(get_conn)):
    cur = await conn.execute("SELECT form_id FROM features WHERE id = %s AND deleted_at IS NULL", (feature_id,))
    row = await cur.fetchone()
    if not row:
        raise Problem(404, "Feature not found.", code="not_found")
    await _form(conn, row["form_id"], person)
    cur = await conn.execute(FEATURE_SQL + "WHERE x.id = %s", (feature_id,))
    return _feature(await cur.fetchone())
