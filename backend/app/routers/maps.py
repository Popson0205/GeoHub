"""Standalone mapping workspaces. A map is private to its owner and has nothing to do with projects or forms:
it holds free-form features (points, lines, areas with key/value tags) digitised over imagery, plus the imagery
itself: either XYZ tile URLs (stored here, fetched by the browser) or uploaded files (see imagery.py)."""
import json
import re
from datetime import datetime
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Query, Response
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import storage
from ..db import get_conn
from ..deps import current_user, require_map
from ..errors import Problem
from ..schemas import Geometry
from ..security import make_tile_token
from ..config import settings
from ..services.geo import check_geometry

router = APIRouter(tags=["maps"])

MAX_SOURCES = 25
MAX_TAGS = 100
MAX_IMPORT = 10000
MAX_FEATURES_LISTED = 50000
CATEGORY = {"Point": "point", "MultiPoint": "point", "LineString": "line", "MultiLineString": "line",
            "Polygon": "area", "MultiPolygon": "area"}


# ------------------------------------------------------------------ schemas
class SourceIn(BaseModel):
    id: str | None = Field(None, max_length=64)
    name: str = Field(min_length=1, max_length=120)
    type: str = Field("xyz", pattern="^xyz$")
    url: str = Field(min_length=10, max_length=2000,
                     description="Tile URL template with {z}, {x} and {y}, e.g. https://example.com/{z}/{x}/{y}.png")
    maxzoom: int | None = Field(None, ge=0, le=24)
    attribution: str | None = Field(None, max_length=300)


class MapIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field("", max_length=2000)


class MapPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    description: str | None = Field(None, max_length=2000)
    sources: list[SourceIn] | None = None


class MapOut(BaseModel):
    id: UUID
    name: str
    description: str
    sources: list[dict[str, Any]]
    feature_count: int
    created_at: datetime
    updated_at: datetime


class MapFeatureIn(BaseModel):
    id: UUID | None = None
    geometry: Geometry
    properties: dict[str, Any] = Field(default_factory=dict)


class MapFeaturePatch(BaseModel):
    geometry: Geometry | None = None
    properties: dict[str, Any] | None = None
    base_version: int | None = Field(None, ge=1)


class MapFeatureOut(BaseModel):
    id: UUID
    geometry: Geometry
    properties: dict[str, Any]
    version: int
    created_at: datetime
    updated_at: datetime


class ImportIn(BaseModel):
    features: list[MapFeatureIn] = Field(min_length=1, max_length=MAX_IMPORT)


class ImportOut(BaseModel):
    imported: int
    rejected: int
    errors: list[dict[str, Any]]


# ------------------------------------------------------------------ helpers
def _check_url(url: str) -> str | None:
    if not re.match(r"^https?://", url, re.I):
        return "must start with http:// or https://"
    missing = [t for t in ("{z}", "{x}") if t not in url]
    if "{y}" not in url and "{-y}" not in url:
        missing.append("{y}")
    if missing:
        return f"must contain {', '.join(missing)} (for example https://host/{{z}}/{{x}}/{{y}}.png)"
    return None


def _clean_sources(sources: list[SourceIn]) -> list[dict]:
    if len(sources) > MAX_SOURCES:
        raise Problem(422, f"A map can have at most {MAX_SOURCES} imagery sources.", code="validation")
    out, seen = [], set()
    for i, s in enumerate(sources):
        err = _check_url(s.url)
        if err:
            raise Problem(422, f"Imagery source \"{s.name}\": the URL {err}.", code="validation",
                          fields={f"sources.{i}.url": [err]})
        sid = s.id or uuid4().hex[:12]
        if sid in seen:
            raise Problem(422, "Imagery source ids must be unique.", code="validation")
        seen.add(sid)
        out.append({**s.model_dump(exclude_none=True), "id": sid})
    return out


def _check_feature(g: dict, properties: dict) -> str | None:
    if not isinstance(g, dict) or g.get("type") not in CATEGORY:
        return "geometry must be a GeoJSON Point, LineString, Polygon or a Multi* form"
    err = check_geometry(CATEGORY[g["type"]], g)
    if err:
        return f"geometry: {err}"
    if len(properties) > MAX_TAGS:
        return f"at most {MAX_TAGS} tags per feature"
    for k, v in properties.items():
        if not isinstance(k, str) or not k.strip() or len(k) > 100:
            return "tag names must be 1 to 100 characters"
        if v is not None and not isinstance(v, (str, int, float, bool)):
            return f"tag \"{k}\" must be text, a number, true/false or empty"
        if isinstance(v, str) and len(v) > 2000:
            return f"tag \"{k}\" is too long"
    return None


FEATURE_SQL = ("id, ST_AsGeoJSON(geom, 7)::jsonb AS geometry, properties, version, created_at, updated_at")


def _map_out(r: dict) -> dict:
    return r


MAP_SELECT = ("SELECT m.id, m.name, m.description, m.sources, m.created_at, m.updated_at, "
              "(SELECT count(*) FROM map_features f WHERE f.map_id = m.id)::int AS feature_count FROM maps m ")


# ------------------------------------------------------------------ maps
@router.get("/maps", response_model=list[MapOut])
async def list_maps(user=Depends(current_user), conn=Depends(get_conn)):
    cur = await conn.execute(MAP_SELECT + "WHERE m.owner_id = %s ORDER BY m.updated_at DESC", (user["id"],))
    return await cur.fetchall()


@router.post("/maps", response_model=MapOut, status_code=201)
async def create_map(body: MapIn, user=Depends(current_user), conn=Depends(get_conn)):
    cur = await conn.execute("INSERT INTO maps (owner_id, name, description) VALUES (%s, %s, %s) RETURNING id",
                             (user["id"], body.name.strip(), body.description))
    mid = (await cur.fetchone())["id"]
    cur = await conn.execute(MAP_SELECT + "WHERE m.id = %s", (mid,))
    return await cur.fetchone()


@router.get("/maps/{map_id}", response_model=MapOut)
async def get_map(map_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    await require_map(conn, map_id, user["id"])
    cur = await conn.execute(MAP_SELECT + "WHERE m.id = %s", (map_id,))
    return await cur.fetchone()


@router.patch("/maps/{map_id}", response_model=MapOut)
async def update_map(map_id: UUID, body: MapPatch, user=Depends(current_user), conn=Depends(get_conn)):
    await require_map(conn, map_id, user["id"])
    sets, params = [], []
    if body.name is not None:
        sets.append("name = %s"); params.append(body.name.strip())
    if body.description is not None:
        sets.append("description = %s"); params.append(body.description)
    if body.sources is not None:
        sets.append("sources = %s"); params.append(Jsonb(_clean_sources(body.sources)))
    if sets:
        await conn.execute(f"UPDATE maps SET {', '.join(sets)}, updated_at = now() WHERE id = %s", (*params, map_id))
    cur = await conn.execute(MAP_SELECT + "WHERE m.id = %s", (map_id,))
    return await cur.fetchone()


@router.delete("/maps/{map_id}", status_code=204)
async def delete_map(map_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    await require_map(conn, map_id, user["id"])
    cur = await conn.execute("SELECT source_key, storage_key FROM imagery_assets WHERE map_id = %s", (map_id,))
    keys = [k for r in await cur.fetchall() for k in (r["source_key"], r["storage_key"]) if k]
    await conn.execute("DELETE FROM maps WHERE id = %s", (map_id,))       # features and imagery rows cascade
    if keys:
        await storage.run(storage.delete_keys, *keys)
    return Response(status_code=204)


@router.get("/maps/{map_id}/layers")
async def map_layers(map_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    """Everything to draw under the features: URL sources plus uploaded imagery that is ready. Uploaded imagery tile
    URLs carry a short-lived `sig`; call this again when `expires_in` runs out."""
    m = await require_map(conn, map_id, user["id"])
    sig = make_tile_token(map_id, user["id"])
    cur = await conn.execute("SELECT id, name, bounds FROM imagery_assets WHERE map_id = %s AND status = 'ready' "
                             "ORDER BY created_at", (map_id,))
    uploaded = [{"id": r["id"], "name": r["name"], "bounds": r["bounds"], "minzoom": 0, "maxzoom": 22,
                 "tiles_url": f"{settings.public_base_url}/tiles/imagery/{r['id']}/{{z}}/{{x}}/{{y}}.png?sig={sig}"}
                for r in await cur.fetchall()]
    return {"expires_in": settings.tile_token_minutes * 60, "sources": m["sources"], "imagery": uploaded}


# ------------------------------------------------------------------ features
@router.get("/maps/{map_id}/features", response_model=list[MapFeatureOut])
async def list_features(map_id: UUID, bbox: str | None = Query(None, description="minx,miny,maxx,maxy"),
                        user=Depends(current_user), conn=Depends(get_conn)):
    await require_map(conn, map_id, user["id"])
    where, params = ["map_id = %s"], [map_id]
    if bbox:
        try:
            minx, miny, maxx, maxy = (float(v) for v in bbox.split(","))
        except ValueError:
            raise Problem(422, "bbox must be minx,miny,maxx,maxy", code="validation", fields={"bbox": ["invalid"]})
        where.append("geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)")
        params += [minx, miny, maxx, maxy]
    cur = await conn.execute(f"SELECT {FEATURE_SQL} FROM map_features WHERE {' AND '.join(where)} "
                             "ORDER BY created_at LIMIT %s", (*params, MAX_FEATURES_LISTED))
    return await cur.fetchall()


@router.post("/maps/{map_id}/features", response_model=MapFeatureOut, status_code=201)
async def create_feature(map_id: UUID, body: MapFeatureIn, user=Depends(current_user), conn=Depends(get_conn)):
    await require_map(conn, map_id, user["id"])
    err = _check_feature(body.geometry, body.properties)
    if err:
        raise Problem(422, err, code="validation", fields={"geometry": [err]})
    fid = body.id or uuid4()
    cur = await conn.execute(
        "INSERT INTO map_features (id, map_id, geom, properties, created_by) VALUES (%s, %s, geom_from_json(%s), %s, %s) "
        "ON CONFLICT (id) DO NOTHING RETURNING id", (fid, map_id, json.dumps(body.geometry), Jsonb(body.properties), user["id"]))
    if not await cur.fetchone():
        raise Problem(409, "A feature with this id already exists.", code="already_exists")
    await conn.execute("UPDATE maps SET updated_at = now() WHERE id = %s", (map_id,))
    cur = await conn.execute(f"SELECT {FEATURE_SQL} FROM map_features WHERE id = %s", (fid,))
    return await cur.fetchone()


@router.patch("/maps/{map_id}/features/{feature_id}", response_model=MapFeatureOut)
async def update_feature(map_id: UUID, feature_id: UUID, body: MapFeaturePatch, user=Depends(current_user),
                         conn=Depends(get_conn)):
    await require_map(conn, map_id, user["id"])
    cur = await conn.execute(f"SELECT {FEATURE_SQL} FROM map_features WHERE id = %s AND map_id = %s FOR UPDATE",
                             (feature_id, map_id))
    cur_row = await cur.fetchone()
    if not cur_row:
        raise Problem(404, "Feature not found.", code="not_found")
    if body.base_version is not None and body.base_version != cur_row["version"]:
        raise Problem(409, "This feature changed since you opened it. Reload and try again.", code="conflict",
                      server=json.loads(json.dumps(cur_row, default=str)))
    geometry = body.geometry if body.geometry is not None else cur_row["geometry"]
    properties = body.properties if body.properties is not None else cur_row["properties"]
    err = _check_feature(geometry, properties)
    if err:
        raise Problem(422, err, code="validation", fields={"geometry": [err]})
    await conn.execute("UPDATE map_features SET geom = geom_from_json(%s), properties = %s, version = version + 1, "
                       "updated_at = now() WHERE id = %s", (json.dumps(geometry), Jsonb(properties), feature_id))
    await conn.execute("UPDATE maps SET updated_at = now() WHERE id = %s", (map_id,))
    cur = await conn.execute(f"SELECT {FEATURE_SQL} FROM map_features WHERE id = %s", (feature_id,))
    return await cur.fetchone()


@router.delete("/maps/{map_id}/features/{feature_id}", status_code=204)
async def delete_feature(map_id: UUID, feature_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    await require_map(conn, map_id, user["id"])
    cur = await conn.execute("DELETE FROM map_features WHERE id = %s AND map_id = %s RETURNING id", (feature_id, map_id))
    if not await cur.fetchone():
        raise Problem(404, "Feature not found.", code="not_found")
    await conn.execute("UPDATE maps SET updated_at = now() WHERE id = %s", (map_id,))
    return Response(status_code=204)


@router.post("/maps/{map_id}/features/import", response_model=ImportOut)
async def import_features(map_id: UUID, body: ImportIn, user=Depends(current_user), conn=Depends(get_conn)):
    """Bulk-add features (the browser reads GeoJSON, KML or GPX and sends the features). Invalid ones are skipped
    and reported; the rest are added."""
    await require_map(conn, map_id, user["id"])
    imported, errors = 0, []
    async with conn.cursor() as cur:
        for i, f in enumerate(body.features):
            err = _check_feature(f.geometry, f.properties)
            if err:
                errors.append({"row": i + 1, "message": err})
                continue
            await cur.execute(
                "INSERT INTO map_features (id, map_id, geom, properties, created_by) "
                "VALUES (%s, %s, geom_from_json(%s), %s, %s) ON CONFLICT (id) DO NOTHING",
                (f.id or uuid4(), map_id, json.dumps(f.geometry), Jsonb(f.properties), user["id"]))
            imported += cur.rowcount
    await conn.execute("UPDATE maps SET updated_at = now() WHERE id = %s", (map_id,))
    return {"imported": imported, "rejected": len(body.features) - imported, "errors": errors[:20]}


@router.get("/maps/{map_id}/export.geojson")
async def export_geojson(map_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    m = await require_map(conn, map_id, user["id"])
    cur = await conn.execute(f"SELECT {FEATURE_SQL} FROM map_features WHERE map_id = %s ORDER BY created_at", (map_id,))
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "id": str(r["id"]), "geometry": r["geometry"], "properties": r["properties"]}
        for r in await cur.fetchall()]}
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", m["name"]).strip("-") or "map"
    return Response(json.dumps(fc), media_type="application/geo+json",
                    headers={"Content-Disposition": f'attachment; filename="{name}.geojson"'})
