"""Tile endpoints. Martin (vector) and TiTiler (imagery) are never exposed publicly: these routes check
project access and then proxy to them. Access is via the Authorization header, ?access_token=, or a
short-lived ?sig= token from GET /projects/{id}/layers (handy for MapLibre sources)."""
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, Request, Response

from ..config import settings
from ..db import get_conn
from ..deps import current_user, require_map, require_role, role_in
from ..errors import Problem
from ..schemas import LayersOut
from ..security import decode_token, make_tile_token

router = APIRouter(tags=["tiles"])
CACHE = {"Cache-Control": "private, max-age=60"}
TITILER_PASSTHROUGH = ("rescale", "bidx", "color_formula", "nodata", "resampling", "colormap_name")


def _tile_user(request: Request, scope_id: UUID) -> str:
    """The user behind a tile request. `scope_id` is the project or map the tile belongs to."""
    q = request.query_params
    if q.get("sig"):
        p = decode_token(q["sig"], "tile")
        if p["pid"] != str(scope_id):
            raise Problem(403, "This tile token is for a different project or map.", code="forbidden")
        return p["sub"]
    auth = request.headers.get("authorization", "")
    token = auth[7:] if auth.lower().startswith("bearer ") else q.get("access_token")
    if not token:
        raise Problem(401, "Sign in to view this map.", code="unauthenticated")
    return decode_token(token, "access")["sub"]


async def _authorise(request: Request, conn, project_id: UUID):
    user_id = _tile_user(request, project_id)
    if not await role_in(conn, project_id, user_id):
        raise Problem(404, "Project not found.", code="not_found")


async def _fetch(request: Request, url: str, params: dict, media_type: str) -> Response:
    try:
        r = await request.app.state.http.get(url, params=params)
    except httpx.HTTPError:
        raise Problem(502, "The tile service is unavailable.", code="tile_service_unavailable")
    if r.status_code in (204, 404):
        return Response(status_code=204, headers=CACHE)        # empty or outside the raster: nothing to draw
    if r.status_code >= 400:
        raise Problem(502, "The tile service returned an error.", code="tile_service_error")
    return Response(r.content, media_type=media_type, headers=CACHE)


@router.get("/tiles/features/{project_id}/{form_id}/{z}/{x}/{y:int}.pbf", include_in_schema=True)
async def feature_tile(project_id: UUID, form_id: UUID, z: int, x: int, y: int, request: Request,
                       conn=Depends(get_conn)):
    """Mapbox Vector Tile, layer name `features`, attributes: id, status, version, props (JSON text)."""
    await _authorise(request, conn, project_id)
    if not 0 <= z <= 22:
        raise Problem(422, "Zoom must be between 0 and 22.", code="validation")
    return await _fetch(request, f"{settings.martin_url}/feature_tiles/{z}/{x}/{y}",
                        {"project_id": str(project_id), "form_id": str(form_id)}, "application/x-protobuf")


@router.get("/tiles/imagery/{imagery_id}/{z}/{x}/{y:int}.png")
async def imagery_tile(imagery_id: UUID, z: int, x: int, y: int, request: Request, conn=Depends(get_conn)):
    cur = await conn.execute("SELECT project_id, map_id, status, storage_key FROM imagery_assets WHERE id = %s",
                             (imagery_id,))
    a = await cur.fetchone()
    if not a:
        raise Problem(404, "Imagery not found.", code="not_found")
    if a["project_id"]:
        await _authorise(request, conn, a["project_id"])
    else:
        await require_map(conn, a["map_id"], _tile_user(request, a["map_id"]))
    if a["status"] != "ready":
        raise Problem(409, "This imagery is not ready yet.", code="not_ready")
    params = {"url": f"s3://{settings.s3_bucket}/{a['storage_key']}"}
    params.update({k: v for k, v in request.query_params.items() if k in TITILER_PASSTHROUGH})
    return await _fetch(request, f"{settings.titiler_url}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png", params, "image/png")


@router.get("/projects/{project_id}/layers", response_model=LayersOut)
async def layers(project_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    """Map layer list with stable tile URLs. Each URL carries a short-lived `sig`; call this again when
    `expires_in` runs out and update the source's tile URL."""
    await require_role(conn, project_id, user["id"])
    sig = make_tile_token(project_id, user["id"])
    base = settings.public_base_url
    cur = await conn.execute("SELECT id, name, geometry_type FROM forms WHERE project_id = %s AND version > 0 "
                             "ORDER BY created_at", (project_id,))
    vector = [{"form_id": r["id"], "name": r["name"], "geometry_type": r["geometry_type"], "source_layer": "features",
               "minzoom": 0, "maxzoom": 16,
               "tiles_url": f"{base}/tiles/features/{project_id}/{r['id']}/{{z}}/{{x}}/{{y}}.pbf?sig={sig}"}
              for r in await cur.fetchall()]
    cur = await conn.execute("SELECT id, name, bounds FROM imagery_assets WHERE project_id = %s AND status = 'ready' "
                             "ORDER BY created_at", (project_id,))
    imagery = [{"id": r["id"], "name": r["name"], "bounds": r["bounds"], "minzoom": 0, "maxzoom": 22,
                "tiles_url": f"{base}/tiles/imagery/{r['id']}/{{z}}/{{x}}/{{y}}.png?sig={sig}"}
               for r in await cur.fetchall()]
    return {"expires_in": settings.tile_token_minutes * 60, "vector": vector, "imagery": imagery}
