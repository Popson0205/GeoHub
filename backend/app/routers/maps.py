"""Maps: the free-form web-mapping workspace. Independent of collection projects, forms and sync.

A map has layers (each with its own attribute fields), features drawn on layers, and imagery sources
(XYZ tile URL templates the browser loads directly). Roles: owner > editor > viewer."""
import re
from typing import Any, Literal
from uuid import UUID

import psycopg
from fastapi import APIRouter, Depends, Query, Response
from fastapi.encoders import jsonable_encoder
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, field_validator

from ..audit import audit
from ..db import get_conn
from ..deps import current_user
from ..errors import Problem
from ..pagination import Page, decode_cursor, encode_cursor

router = APIRouter(tags=["maps"])
RANK = {"viewer": 1, "editor": 2, "owner": 3}
FIELD_TYPES = {"text", "number", "choice", "date", "checkbox"}
TILE_URL = re.compile(r"^https?://[^\s]+$", re.I)


# ---------- schemas ----------
class MapIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field("", max_length=2000)


class MapPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    description: str | None = Field(None, max_length=2000)


class MapOut(BaseModel):
    id: UUID
    name: str
    description: str
    role: str
    layer_count: int
    feature_count: int
    created_at: Any
    updated_at: Any


class LayerField(BaseModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{0,39}$")
    label: str = Field(min_length=1, max_length=80)
    type: Literal["text", "number", "choice", "date", "checkbox"] = "text"
    choices: list[str] = Field(default_factory=list, max_length=100)


class LayerIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    geometry_type: Literal["point", "line", "area", "any"] = "any"
    fields: list[LayerField] = Field(default_factory=list, max_length=60)
    style: dict = Field(default_factory=dict)

    @field_validator("fields")
    @classmethod
    def unique_ids(cls, v):
        ids = [f.id for f in v]
        if len(ids) != len(set(ids)):
            raise ValueError("field ids must be unique")
        return v


class LayerPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    fields: list[LayerField] | None = Field(None, max_length=60)
    style: dict | None = None
    position: int | None = Field(None, ge=0)


class LayerOut(BaseModel):
    id: UUID
    map_id: UUID
    name: str
    geometry_type: str
    fields: list[dict]
    style: dict
    position: int


class MapFeatureCreate(BaseModel):
    id: UUID
    layer_id: UUID
    geometry: dict
    properties: dict = Field(default_factory=dict)


class MapFeaturePatch(BaseModel):
    base_version: int = Field(ge=1)
    geometry: dict | None = None
    properties: dict | None = None


class MapFeatureOut(BaseModel):
    id: UUID
    map_id: UUID
    layer_id: UUID
    geometry: dict
    properties: dict
    version: int
    updated_at: Any


class ImageryIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    url_template: str = Field(max_length=1000)
    attribution: str = Field("", max_length=500)
    min_zoom: int = Field(0, ge=0, le=24)
    max_zoom: int = Field(19, ge=0, le=24)
    tile_size: Literal[256, 512] = 256

    @field_validator("url_template")
    @classmethod
    def tile_template(cls, v):
        v = v.strip()
        if not TILE_URL.match(v):
            raise ValueError("must start with http:// or https://")
        if not all(t in v for t in ("{z}", "{x}", "{y}")):
            raise ValueError("must contain {z}, {x} and {y}")
        if "{s}" in v or "{q}" in v:
            raise ValueError("{s} subdomains and {q} quadkeys are not supported; use a fixed host and {z}/{x}/{y}")
        return v

    @field_validator("max_zoom")
    @classmethod
    def zoom_order(cls, v, info):
        if "min_zoom" in info.data and v < info.data["min_zoom"]:
            raise ValueError("max_zoom must be at least min_zoom")
        return v


class ImageryPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    attribution: str | None = Field(None, max_length=500)
    position: int | None = Field(None, ge=0)


class ImageryOut(BaseModel):
    id: UUID
    map_id: UUID
    name: str
    kind: str
    url_template: str
    attribution: str
    min_zoom: int
    max_zoom: int
    tile_size: int
    position: int


class MemberIn(BaseModel):
    email: str = Field(max_length=254)
    role: Literal["editor", "viewer"] = "editor"


# ---------- access ----------
async def map_role(conn, map_id, user_id, minimum: str = "viewer") -> str:
    """Non-members get 404 (a map's existence is not revealed); members below `minimum` get 403."""
    cur = await conn.execute("SELECT role FROM map_members WHERE map_id = %s AND user_id = %s", (map_id, user_id))
    row = await cur.fetchone()
    if not row:
        raise Problem(404, "Map not found.", code="not_found")
    if RANK[row["role"]] < RANK[minimum]:
        raise Problem(403, f"This action needs the {minimum} role or higher.", code="forbidden")
    return row["role"]


async def _owner_of(conn, table: str, row_id, label: str):
    cur = await conn.execute(f"SELECT * FROM {table} WHERE id = %s", (row_id,))
    row = await cur.fetchone()
    if not row:
        raise Problem(404, f"{label} not found.", code="not_found")
    return row


MAP_SELECT = ("SELECT m.id, m.name, m.description, mm.role, m.created_at, m.updated_at, "
              "(SELECT count(*) FROM map_layers l WHERE l.map_id = m.id)::int AS layer_count, "
              "(SELECT count(*) FROM map_features f WHERE f.map_id = m.id AND f.deleted_at IS NULL)::int AS feature_count "
              "FROM maps m JOIN map_members mm ON mm.map_id = m.id AND mm.user_id = %s")

FEATURE_SELECT = ("f.id, f.map_id, f.layer_id, ST_AsGeoJSON(f.geom)::jsonb AS geometry, f.properties, f.version, "
                  "f.updated_at")


def _geometry_ok(layer_type: str, geom_type: str) -> bool:
    kinds = {"point": {"Point", "MultiPoint"}, "line": {"LineString", "MultiLineString"},
             "area": {"Polygon", "MultiPolygon"}}
    return layer_type == "any" or geom_type in kinds[layer_type]


def _check_properties(layer: dict, props: dict):
    """Light validation against the layer's fields: unknown keys are allowed, known keys must match their type."""
    errors: dict[str, list[str]] = {}
    for f in layer["fields"]:
        v = props.get(f["id"])
        if v is None or v == "":
            continue
        t = f["type"]
        if t == "number" and (isinstance(v, bool) or not isinstance(v, (int, float))):
            errors[f["id"]] = ["must be a number"]
        elif t == "checkbox" and not isinstance(v, bool):
            errors[f["id"]] = ["must be true or false"]
        elif t == "choice" and f.get("choices") and v not in f["choices"]:
            errors[f["id"]] = ["is not one of the choices"]
        elif t in ("text", "date") and not isinstance(v, str):
            errors[f["id"]] = ["must be text"]
    if errors:
        raise Problem(422, "Some attributes are not valid.", code="validation", fields=errors)


async def _fetch_feature(conn, fid):
    cur = await conn.execute(f"SELECT {FEATURE_SELECT} FROM map_features f WHERE f.id = %s AND f.deleted_at IS NULL", (fid,))
    row = await cur.fetchone()
    if not row:
        raise Problem(404, "Feature not found.", code="not_found")
    return row


async def _geom_type(conn, geometry: dict) -> str:
    """Parses the GeoJSON in PostGIS (same normalisation as the collection features) and returns its type."""
    import json
    try:
        cur = await conn.execute("SELECT GeometryType(geom_from_json(%s)) AS t", (json.dumps(geometry),))
        t = (await cur.fetchone())["t"]
    except (psycopg.errors.InternalError_, psycopg.errors.DataException):
        raise Problem(422, "The geometry could not be read.", code="validation",
                      fields={"geometry": ["could not be read as a valid geometry"]})
    return {"POINT": "Point", "MULTIPOINT": "MultiPoint", "LINESTRING": "LineString",
            "MULTILINESTRING": "MultiLineString", "POLYGON": "Polygon", "MULTIPOLYGON": "MultiPolygon"}.get(t, t)


# ---------- maps ----------
@router.post("/maps", response_model=MapOut, status_code=201)
async def create_map(body: MapIn, user=Depends(current_user), conn=Depends(get_conn)):
    cur = await conn.execute("INSERT INTO maps (name, description, created_by) VALUES (%s, %s, %s) RETURNING id",
                             (body.name.strip(), body.description, user["id"]))
    mid = (await cur.fetchone())["id"]
    await conn.execute("INSERT INTO map_members (map_id, user_id, role) VALUES (%s, %s, 'owner')", (mid, user["id"]))
    await audit(conn, "map.create", actor_id=user["id"], target_type="map", target_id=mid)
    cur = await conn.execute(MAP_SELECT + " WHERE m.id = %s", (user["id"], mid))
    return await cur.fetchone()


@router.get("/maps", response_model=Page[MapOut])
async def list_maps(limit: int = Query(50, ge=1, le=200), cursor: str | None = None,
                    user=Depends(current_user), conn=Depends(get_conn)):
    offset = decode_cursor(cursor).get("o", 0)
    cur = await conn.execute(MAP_SELECT + " ORDER BY m.updated_at DESC, m.id LIMIT %s OFFSET %s",
                             (user["id"], limit + 1, offset))
    rows = await cur.fetchall()
    more = len(rows) > limit
    return {"items": rows[:limit], "next_cursor": encode_cursor(o=offset + limit) if more else None}


@router.get("/maps/{map_id}", response_model=MapOut)
async def get_map(map_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    await map_role(conn, map_id, user["id"])
    cur = await conn.execute(MAP_SELECT + " WHERE m.id = %s", (user["id"], map_id))
    return await cur.fetchone()


@router.patch("/maps/{map_id}", response_model=MapOut)
async def update_map(map_id: UUID, body: MapPatch, user=Depends(current_user), conn=Depends(get_conn)):
    await map_role(conn, map_id, user["id"], "owner")
    await conn.execute("UPDATE maps SET name = COALESCE(%s, name), description = COALESCE(%s, description), "
                       "updated_at = now() WHERE id = %s",
                       (body.name.strip() if body.name else None, body.description, map_id))
    cur = await conn.execute(MAP_SELECT + " WHERE m.id = %s", (user["id"], map_id))
    return await cur.fetchone()


@router.delete("/maps/{map_id}", status_code=204)
async def delete_map(map_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    await map_role(conn, map_id, user["id"], "owner")
    await conn.execute("DELETE FROM maps WHERE id = %s", (map_id,))
    await audit(conn, "map.delete", actor_id=user["id"], target_type="map", target_id=map_id)
    return Response(status_code=204)


@router.post("/maps/{map_id}/members", status_code=201)
async def add_member(map_id: UUID, body: MemberIn, user=Depends(current_user), conn=Depends(get_conn)):
    """Share a map with an existing user by email. (Email invitations for new users come later.)"""
    await map_role(conn, map_id, user["id"], "owner")
    cur = await conn.execute("SELECT id FROM users WHERE lower(email) = lower(%s)", (body.email.strip(),))
    target = await cur.fetchone()
    if not target:
        raise Problem(404, "No account with that email yet.", code="user_not_found", fields={"email": ["unknown"]})
    await conn.execute("INSERT INTO map_members (map_id, user_id, role) VALUES (%s, %s, %s) "
                       "ON CONFLICT (map_id, user_id) DO UPDATE SET role = EXCLUDED.role "
                       "WHERE map_members.role <> 'owner'", (map_id, target["id"], body.role))
    return {"user_id": target["id"], "role": body.role}


# ---------- layers ----------
@router.get("/maps/{map_id}/layers", response_model=list[LayerOut])
async def list_layers(map_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    await map_role(conn, map_id, user["id"])
    cur = await conn.execute("SELECT id, map_id, name, geometry_type, fields, style, position FROM map_layers "
                             "WHERE map_id = %s ORDER BY position, created_at", (map_id,))
    return await cur.fetchall()


@router.post("/maps/{map_id}/layers", response_model=LayerOut, status_code=201)
async def create_layer(map_id: UUID, body: LayerIn, user=Depends(current_user), conn=Depends(get_conn)):
    await map_role(conn, map_id, user["id"], "editor")
    cur = await conn.execute(
        "INSERT INTO map_layers (map_id, name, geometry_type, fields, style, position) VALUES (%s, %s, %s, %s, %s, "
        "(SELECT COALESCE(max(position) + 1, 0) FROM map_layers WHERE map_id = %s)) "
        "RETURNING id, map_id, name, geometry_type, fields, style, position",
        (map_id, body.name.strip(), body.geometry_type, Jsonb([f.model_dump() for f in body.fields]),
         Jsonb(body.style), map_id))
    await conn.execute("UPDATE maps SET updated_at = now() WHERE id = %s", (map_id,))
    return await cur.fetchone()


@router.patch("/layers/{layer_id}", response_model=LayerOut)
async def update_layer(layer_id: UUID, body: LayerPatch, user=Depends(current_user), conn=Depends(get_conn)):
    layer = await _owner_of(conn, "map_layers", layer_id, "Layer")
    await map_role(conn, layer["map_id"], user["id"], "editor")
    fields = Jsonb([f.model_dump() for f in body.fields]) if body.fields is not None else None
    cur = await conn.execute(
        "UPDATE map_layers SET name = COALESCE(%s, name), fields = COALESCE(%s, fields), "
        "style = COALESCE(%s, style), position = COALESCE(%s, position) WHERE id = %s "
        "RETURNING id, map_id, name, geometry_type, fields, style, position",
        (body.name.strip() if body.name else None, fields, Jsonb(body.style) if body.style is not None else None,
         body.position, layer_id))
    return await cur.fetchone()


@router.delete("/layers/{layer_id}", status_code=204)
async def delete_layer(layer_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    layer = await _owner_of(conn, "map_layers", layer_id, "Layer")
    await map_role(conn, layer["map_id"], user["id"], "editor")
    await conn.execute("DELETE FROM map_layers WHERE id = %s", (layer_id,))
    return Response(status_code=204)


# ---------- features ----------
@router.get("/maps/{map_id}/features", response_model=Page[MapFeatureOut])
async def list_features(map_id: UUID, layer_id: UUID | None = None,
                        bbox: str | None = Query(None, description="minx,miny,maxx,maxy (EPSG:4326)"),
                        limit: int = Query(500, ge=1, le=2000), cursor: str | None = None,
                        user=Depends(current_user), conn=Depends(get_conn)):
    await map_role(conn, map_id, user["id"])
    where, params = ["f.map_id = %s", "f.deleted_at IS NULL"], [map_id]
    last = decode_cursor(cursor).get("id")
    if last:
        where.append("f.id > %s::uuid"); params.append(last)
    if layer_id:
        where.append("f.layer_id = %s"); params.append(layer_id)
    if bbox:
        try:
            minx, miny, maxx, maxy = (float(v) for v in bbox.split(","))
        except ValueError:
            raise Problem(422, "bbox must be minx,miny,maxx,maxy", code="validation", fields={"bbox": ["invalid"]})
        where.append("f.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)"); params += [minx, miny, maxx, maxy]
    cur = await conn.execute(f"SELECT {FEATURE_SELECT} FROM map_features f WHERE {' AND '.join(where)} "
                             "ORDER BY f.id LIMIT %s", (*params, limit + 1))
    rows = await cur.fetchall()
    more = len(rows) > limit
    rows = rows[:limit]
    return {"items": rows, "next_cursor": encode_cursor(id=str(rows[-1]["id"])) if more else None}


@router.post("/maps/{map_id}/features", response_model=MapFeatureOut, status_code=201)
async def create_feature(map_id: UUID, body: MapFeatureCreate, user=Depends(current_user), conn=Depends(get_conn)):
    import json
    await map_role(conn, map_id, user["id"], "editor")
    layer = await _owner_of(conn, "map_layers", body.layer_id, "Layer")
    if layer["map_id"] != map_id:
        raise Problem(404, "Layer not found.", code="not_found")
    gtype = await _geom_type(conn, body.geometry)
    if not _geometry_ok(layer["geometry_type"], gtype):
        raise Problem(422, f"This layer holds {layer['geometry_type']} features, not {gtype}.", code="validation",
                      fields={"geometry": [f"{gtype} does not fit a {layer['geometry_type']} layer"]})
    _check_properties(layer, body.properties)
    cur = await conn.execute("SELECT 1 FROM map_features WHERE id = %s", (body.id,))
    if await cur.fetchone():
        raise Problem(409, "A feature with this id already exists.", code="already_exists")
    await conn.execute("INSERT INTO map_features (id, map_id, layer_id, geom, properties, created_by, updated_by) "
                       "VALUES (%s, %s, %s, geom_from_json(%s), %s, %s, %s)",
                       (body.id, map_id, body.layer_id, json.dumps(body.geometry), Jsonb(body.properties),
                        user["id"], user["id"]))
    await conn.execute("UPDATE maps SET updated_at = now() WHERE id = %s", (map_id,))
    return await _fetch_feature(conn, body.id)


@router.patch("/map-features/{feature_id}", response_model=MapFeatureOut)
async def update_feature(feature_id: UUID, body: MapFeaturePatch, user=Depends(current_user), conn=Depends(get_conn)):
    import json
    cur = await conn.execute("SELECT * FROM map_features WHERE id = %s AND deleted_at IS NULL FOR UPDATE", (feature_id,))
    cur_row = await cur.fetchone()
    if not cur_row:
        raise Problem(404, "Feature not found.", code="not_found")
    await map_role(conn, cur_row["map_id"], user["id"], "editor")
    if body.base_version != cur_row["version"]:
        raise Problem(409, "Someone else changed this feature. Reload and try again.", code="conflict",
                      server=jsonable_encoder(await _fetch_feature(conn, feature_id)))
    layer = await _owner_of(conn, "map_layers", cur_row["layer_id"], "Layer")
    if body.geometry is not None:
        gtype = await _geom_type(conn, body.geometry)
        if not _geometry_ok(layer["geometry_type"], gtype):
            raise Problem(422, f"This layer holds {layer['geometry_type']} features, not {gtype}.", code="validation",
                          fields={"geometry": [f"{gtype} does not fit a {layer['geometry_type']} layer"]})
    if body.properties is not None:
        _check_properties(layer, body.properties)
    await conn.execute(
        "UPDATE map_features SET geom = COALESCE(geom_from_json(%s), geom), properties = COALESCE(%s, properties), "
        "version = version + 1, updated_by = %s, updated_at = now() WHERE id = %s",
        (json.dumps(body.geometry) if body.geometry is not None else None,
         Jsonb(body.properties) if body.properties is not None else None, user["id"], feature_id))
    return await _fetch_feature(conn, feature_id)


@router.delete("/map-features/{feature_id}", status_code=204)
async def delete_feature(feature_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    row = await _owner_of(conn, "map_features", feature_id, "Feature")
    await map_role(conn, row["map_id"], user["id"], "editor")
    await conn.execute("UPDATE map_features SET deleted_at = now(), updated_by = %s, updated_at = now() WHERE id = %s",
                       (user["id"], feature_id))
    return Response(status_code=204)


# ---------- imagery sources ----------
IMG_COLS = "id, map_id, name, kind, url_template, attribution, min_zoom, max_zoom, tile_size, position"


@router.get("/maps/{map_id}/imagery-sources", response_model=list[ImageryOut])
async def list_imagery_sources(map_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    await map_role(conn, map_id, user["id"])
    cur = await conn.execute(f"SELECT {IMG_COLS} FROM map_imagery_sources WHERE map_id = %s ORDER BY position, created_at",
                             (map_id,))
    return await cur.fetchall()


@router.post("/maps/{map_id}/imagery-sources", response_model=ImageryOut, status_code=201)
async def add_imagery_source(map_id: UUID, body: ImageryIn, user=Depends(current_user), conn=Depends(get_conn)):
    """Register an XYZ tile URL (e.g. https://host/{z}/{x}/{y}.png). The browser loads the tiles directly from the
    provider, so check the provider's terms of use for the source you add."""
    await map_role(conn, map_id, user["id"], "editor")
    cur = await conn.execute(
        f"INSERT INTO map_imagery_sources (map_id, name, url_template, attribution, min_zoom, max_zoom, tile_size, "
        f"created_by, position) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, "
        f"(SELECT COALESCE(max(position) + 1, 0) FROM map_imagery_sources WHERE map_id = %s)) RETURNING {IMG_COLS}",
        (map_id, body.name.strip(), body.url_template, body.attribution, body.min_zoom, body.max_zoom,
         body.tile_size, user["id"], map_id))
    return await cur.fetchone()


@router.patch("/imagery-sources/{source_id}", response_model=ImageryOut)
async def update_imagery_source(source_id: UUID, body: ImageryPatch, user=Depends(current_user), conn=Depends(get_conn)):
    src = await _owner_of(conn, "map_imagery_sources", source_id, "Imagery source")
    await map_role(conn, src["map_id"], user["id"], "editor")
    cur = await conn.execute(
        f"UPDATE map_imagery_sources SET name = COALESCE(%s, name), attribution = COALESCE(%s, attribution), "
        f"position = COALESCE(%s, position) WHERE id = %s RETURNING {IMG_COLS}",
        (body.name.strip() if body.name else None, body.attribution, body.position, source_id))
    return await cur.fetchone()


@router.delete("/imagery-sources/{source_id}", status_code=204)
async def delete_imagery_source(source_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    src = await _owner_of(conn, "map_imagery_sources", source_id, "Imagery source")
    await map_role(conn, src["map_id"], user["id"], "editor")
    await conn.execute("DELETE FROM map_imagery_sources WHERE id = %s", (source_id,))
    return Response(status_code=204)
