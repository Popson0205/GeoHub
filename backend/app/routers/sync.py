"""Offline sync for the mobile collector. See README for the full rules."""
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from ..config import settings
from ..db import get_conn
from ..deps import current_user, require_role
from ..logging_setup import client_ip
from ..pagination import decode_cursor, encode_cursor
from ..schemas import BundleOut, SyncPullOut, SyncPushIn, SyncPushOut
from ..services import features as svc

router = APIRouter(tags=["sync"])


async def _area_hex(conn, project_id, user_id) -> str | None:
    cur = await conn.execute("SELECT assigned_area::text AS a FROM members WHERE project_id = %s AND user_id = %s",
                             (project_id, user_id))
    return (await cur.fetchone())["a"]


def _area_clause(area_hex, user_id) -> tuple[str, list]:
    if not area_hex:
        return "", []
    return " AND (f.created_by = %s OR ST_Intersects(f.geom, %s::geometry))", [user_id, area_hex]


@router.post("/sync/push", response_model=SyncPushOut)
async def push(body: SyncPushIn, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    """Up to 200 changes. Every change gets its own result; one bad change never fails the batch.
    Retrying a change with the same change_id is safe."""
    role = await require_role(conn, body.project_id, user["id"])
    ip = client_ip(request)
    results = []
    for ch in body.changes:
        res = await svc.apply_change(conn, project_id=body.project_id, user_id=user["id"], role=role, ip=ip,
                                     ch=ch.model_dump())
        results.append(res)
    return {"results": results}


@router.get("/sync/pull", response_model=SyncPullOut)
async def pull(project_id: UUID, cursor: str | None = None, limit: int = Query(500, ge=1, le=2000),
               user=Depends(current_user), conn=Depends(get_conn)):
    """Changes by anyone, in per-project sequence order. Store `next_cursor` and ask again from there.
    Deleted features arrive with `op: delete` (and deleted_at set). Your own changes come back too."""
    await require_role(conn, project_id, user["id"])
    since = decode_cursor(cursor).get("s", 0)
    area_sql, area_params = _area_clause(await _area_hex(conn, project_id, user["id"]), user["id"])
    cur = await conn.execute(
        f"SELECT {svc.FEATURE_SELECT} FROM features f WHERE f.project_id = %s AND f.seq > %s{area_sql} "
        "ORDER BY f.seq LIMIT %s", (project_id, since, *area_params, limit + 1))
    rows = await cur.fetchall()
    more = len(rows) > limit
    rows = rows[:limit]
    return {"items": [{"seq": r["seq"], "op": "delete" if r["deleted_at"] else "upsert", "feature": r} for r in rows],
            "next_cursor": encode_cursor(s=rows[-1]["seq"] if rows else since), "has_more": more}


@router.get("/projects/{project_id}/bundle", response_model=BundleOut)
async def bundle(project_id: UUID, limit: int = Query(5000, ge=1, le=20000),
                 user=Depends(current_user), conn=Depends(get_conn)):
    """Everything needed to work offline: published forms, project settings and the features in the user's
    assigned area (or the whole project if no area is assigned). The cursor is read before the features, so
    nothing changed in between can be missed."""
    role = await require_role(conn, project_id, user["id"])
    cur = await conn.execute("SELECT id, name, description, seq_counter FROM projects WHERE id = %s", (project_id,))
    p = await cur.fetchone()
    cur = await conn.execute(
        "SELECT f.id AS form_id, v.version, v.name, v.geometry_type, v.fields, v.published_at FROM forms f "
        "JOIN form_versions v ON v.form_id = f.id AND v.version = f.version "
        "WHERE f.project_id = %s AND f.version > 0 ORDER BY f.created_at", (project_id,))
    forms = await cur.fetchall()
    area_hex = await _area_hex(conn, project_id, user["id"])
    area_sql, area_params = _area_clause(area_hex, user["id"])
    cur = await conn.execute(
        f"SELECT {svc.FEATURE_SELECT} FROM features f WHERE f.project_id = %s AND f.deleted_at IS NULL{area_sql} "
        "ORDER BY f.seq LIMIT %s", (project_id, *area_params, limit + 1))
    rows = await cur.fetchall()
    cur = await conn.execute("SELECT ST_AsGeoJSON(assigned_area)::jsonb AS a FROM members "
                             "WHERE project_id = %s AND user_id = %s", (project_id, user["id"]))
    return {"project": {"id": p["id"], "name": p["name"], "description": p["description"],
                        "assigned_area": (await cur.fetchone())["a"]},
            "role": role, "forms": forms, "features": rows[:limit], "truncated": len(rows) > limit,
            "cursor": encode_cursor(s=p["seq_counter"]),
            "limits": {"max_photo_bytes": settings.max_photo_bytes, "photo_web_px": settings.photo_web_px,
                       "max_sync_changes": 200}}
