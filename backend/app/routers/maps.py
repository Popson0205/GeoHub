"""Standalone mapping workspaces. A map belongs to its owner, who can invite reviewers and contributors (by link), run it as a
mapping campaign or competition, review what people draw, and publish the approved features to the Data hub. It has nothing
to do with projects or forms:
it holds free-form features (points, lines, areas with key/value tags) digitised over imagery, plus the imagery
itself: either XYZ tile URLs (stored here, fetched by the browser) or uploaded files (see imagery.py)."""
import json
import re
import secrets
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Query, Response
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field

from .. import storage
from ..db import get_conn
from ..audit import audit
from ..deps import current_user, require_map
from ..errors import Problem
from ..jobs import create_job, dispatch
from ..schemas import DatasetCreated, DatasetSummary, Geometry, GeometryType
from ..security import make_tile_token
from ..config import settings
from ..services.geo import check_geometry
from .datasets import SUMMARY_SQL
from .jobs import job_out

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
    is_campaign: bool | None = None
    goal: str | None = Field(None, max_length=2000)
    starts_at: datetime | None = None           # send null to clear
    ends_at: datetime | None = None             # send null to clear
    competition: bool | None = Field(None, description="Show a public leaderboard to members")
    join_open: bool | None = Field(None, description="Turn the join link on or off")


class MapOut(BaseModel):
    id: UUID
    name: str
    description: str
    sources: list[dict[str, Any]]
    feature_count: int
    created_at: datetime
    updated_at: datetime
    role: Literal["owner", "reviewer", "contributor"]
    owner_name: str
    member_count: int = Field(description="Including the owner")
    is_campaign: bool
    goal: str
    starts_at: datetime | None
    ends_at: datetime | None
    competition: bool
    campaign_status: Literal["upcoming", "open", "ended"] | None
    join_code: str | None = Field(None, description="Only the owner sees it. NULL means joining by link is closed.")


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
    status: Literal["submitted", "approved", "rejected"]
    created_by: UUID | None
    author: str | None
    review_note: str


class ReviewIn(BaseModel):
    ids: list[UUID] = Field(min_length=1, max_length=1000)
    status: Literal["approved", "rejected", "submitted"]
    note: str = Field("", max_length=500)


class MemberOut(BaseModel):
    user_id: UUID
    name: str
    email: str | None = Field(None, description="Only the owner sees emails")
    role: Literal["owner", "reviewer", "contributor"]
    joined_at: datetime | None


class MemberPatch(BaseModel):
    role: Literal["reviewer", "contributor"]


class JoinPreview(BaseModel):
    name: str
    description: str
    goal: str
    owner_name: str
    member_count: int
    competition: bool
    starts_at: datetime | None
    ends_at: datetime | None
    campaign_status: Literal["upcoming", "open", "ended"] | None
    already_member: bool


class ContributorOut(BaseModel):
    user_id: UUID
    name: str
    role: Literal["owner", "reviewer", "contributor", "former"]
    rank: int
    added: int = Field(description="Features drawn (rejected ones do not count)")
    approved: int
    pending: int
    rejected: int
    edited: int = Field(description="Other people's features this person changed")
    first_at: datetime | None
    last_at: datetime | None


class ContributorsOut(BaseModel):
    contributors: list[ContributorOut]
    totals: dict[str, int]
    daily: list[dict[str, Any]]
    starts_at: datetime | None
    ends_at: datetime | None


class ActivityOut(BaseModel):
    feature_id: UUID
    user_id: UUID | None
    name: str | None
    action: Literal["added", "edited"]
    at: datetime
    geometry_type: str
    status: str


class PublishIn(BaseModel):
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,62}$")
    title: str = Field(min_length=1, max_length=200)
    description: str = Field("", max_length=5000)
    license: Literal["ODbL-1.0", "CC-BY-4.0", "CC0-1.0", "Private"] = "CC-BY-4.0"
    tags: list[str] = Field([], max_length=20)
    visibility: Literal["private", "public"] = "private"
    geometry_type: GeometryType = Field(description="A dataset holds one kind of feature. Publish points, lines and areas as separate datasets.")
    credit_contributors: bool = Field(True, description="List contributor names on the dataset page")


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


FEATURE_SQL = ("f.id, ST_AsGeoJSON(f.geom, 7)::jsonb AS geometry, f.properties, f.version, f.created_at, f.updated_at, "
               "f.status, f.created_by, u.name AS author, f.review_note")
FEATURE_FROM = "FROM workspace_features f LEFT JOIN users u ON u.id = f.created_by"
_KIND_NAME = {"point": "point", "line": "line", "area": "polygon"}      # what people see
GEOM_LIKE = {"point": "%POINT", "line": "%LINESTRING", "area": "%POLYGON"}      # matched against GeometryType(geom)

MAP_SELECT = (
    "SELECT m.id, m.name, m.description, m.sources, m.created_at, m.updated_at, m.is_campaign, m.goal, m.starts_at, "
    "m.ends_at, m.competition, CASE WHEN m.owner_id = %s THEN 'owner' ELSE mm.role END AS role, u.name AS owner_name, "
    "CASE WHEN m.owner_id = %s THEN m.join_code END AS join_code, "
    "CASE WHEN NOT m.is_campaign THEN NULL WHEN m.starts_at IS NOT NULL AND m.starts_at > now() THEN 'upcoming' "
    "WHEN m.ends_at IS NOT NULL AND m.ends_at < now() THEN 'ended' ELSE 'open' END AS campaign_status, "
    "(SELECT count(*) FROM map_members x WHERE x.map_id = m.id)::int + 1 AS member_count, "
    "(SELECT count(*) FROM workspace_features f WHERE f.map_id = m.id)::int AS feature_count "
    "FROM workspace_maps m JOIN users u ON u.id = m.owner_id LEFT JOIN map_members mm ON mm.map_id = m.id AND mm.user_id = %s ")


async def _map_out(conn, map_id, uid) -> dict:
    cur = await conn.execute(MAP_SELECT + "WHERE m.id = %s", (uid, uid, uid, map_id))
    return await cur.fetchone()


def _check_open(m: dict):
    """Contributors can only draw while a campaign is running. The owner and reviewers can always edit."""
    if m["role"] != "contributor" or not m["is_campaign"]:
        return
    now = datetime.now(timezone.utc)
    if m["starts_at"] and m["starts_at"] > now:
        raise Problem(409, "This campaign has not started yet.", code="campaign_closed")
    if m["ends_at"] and m["ends_at"] < now:
        raise Problem(409, "This campaign has ended, so contributors can no longer add or change features.", code="campaign_closed")


def _can_change(m: dict, f: dict, user_id) -> bool:
    """The owner and reviewers can change anything. A contributor can change their own features until they are approved."""
    return m["role"] in ("owner", "reviewer") or (f["created_by"] == user_id and f["status"] != "approved")


def _new_status(role: str) -> str:
    return "approved" if role in ("owner", "reviewer") else "submitted"      # what a reviewer draws needs no second look


# ------------------------------------------------------------------ maps
@router.get("/maps", response_model=list[MapOut])
async def list_maps(user=Depends(current_user), conn=Depends(get_conn)):
    u = user["id"]
    cur = await conn.execute(MAP_SELECT + "WHERE m.owner_id = %s OR mm.user_id = %s ORDER BY m.updated_at DESC", (u, u, u, u, u))
    return await cur.fetchall()


@router.post("/maps", response_model=MapOut, status_code=201)
async def create_map(body: MapIn, user=Depends(current_user), conn=Depends(get_conn)):
    cur = await conn.execute("INSERT INTO workspace_maps (owner_id, name, description) VALUES (%s, %s, %s) RETURNING id",
                             (user["id"], body.name.strip(), body.description))
    return await _map_out(conn, (await cur.fetchone())["id"], user["id"])


@router.get("/maps/{map_id}", response_model=MapOut)
async def get_map(map_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    await require_map(conn, map_id, user["id"])
    return await _map_out(conn, map_id, user["id"])


@router.patch("/maps/{map_id}", response_model=MapOut)
async def update_map(map_id: UUID, body: MapPatch, user=Depends(current_user), conn=Depends(get_conn)):
    await require_map(conn, map_id, user["id"], "owner")
    sets, params = [], []
    for col in ("name", "description", "goal"):
        v = getattr(body, col)
        if v is not None:
            sets.append(f"{col} = %s"); params.append(v.strip() if col == "name" else v)
    if body.sources is not None:
        sets.append("sources = %s"); params.append(Jsonb(_clean_sources(body.sources)))
    for col in ("is_campaign", "competition"):
        v = getattr(body, col)
        if v is not None:
            sets.append(f"{col} = %s"); params.append(v)
    for col in ("starts_at", "ends_at"):                     # explicit null clears the date
        if col in body.model_fields_set:
            sets.append(f"{col} = %s"); params.append(getattr(body, col))
    start = body.starts_at if "starts_at" in body.model_fields_set else None
    end = body.ends_at if "ends_at" in body.model_fields_set else None
    if start and end and end <= start:
        raise Problem(422, "The end date must be after the start date.", code="validation", fields={"ends_at": ["must be after the start"]})
    if body.join_open is not None:
        sets.append("join_code = %s"); params.append(None)
        if body.join_open:
            params[-1] = secrets.token_urlsafe(6)
    if sets:
        await conn.execute(f"UPDATE workspace_maps SET {', '.join(sets)}, updated_at = now() WHERE id = %s", (*params, map_id))
    return await _map_out(conn, map_id, user["id"])


@router.delete("/maps/{map_id}", status_code=204)
async def delete_map(map_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    await require_map(conn, map_id, user["id"], "owner")
    cur = await conn.execute("SELECT source_key, storage_key FROM imagery_assets WHERE map_id = %s", (map_id,))
    keys = [k for r in await cur.fetchall() for k in (r["source_key"], r["storage_key"]) if k]
    await conn.execute("DELETE FROM workspace_maps WHERE id = %s", (map_id,))       # features, members and imagery rows cascade
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
                        status: Literal["submitted", "approved", "rejected"] | None = None, author: UUID | None = None,
                        user=Depends(current_user), conn=Depends(get_conn)):
    await require_map(conn, map_id, user["id"])
    where, params = ["f.map_id = %s"], [map_id]
    if bbox:
        try:
            minx, miny, maxx, maxy = (float(v) for v in bbox.split(","))
        except ValueError:
            raise Problem(422, "bbox must be minx,miny,maxx,maxy", code="validation", fields={"bbox": ["invalid"]})
        where.append("f.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)")
        params += [minx, miny, maxx, maxy]
    if status:
        where.append("f.status = %s"); params.append(status)
    if author:
        where.append("f.created_by = %s"); params.append(author)
    cur = await conn.execute(f"SELECT {FEATURE_SQL} {FEATURE_FROM} WHERE {' AND '.join(where)} ORDER BY f.created_at LIMIT %s",
                             (*params, MAX_FEATURES_LISTED))
    return await cur.fetchall()


async def _feature(conn, fid):
    cur = await conn.execute(f"SELECT {FEATURE_SQL} {FEATURE_FROM} WHERE f.id = %s", (fid,))
    return await cur.fetchone()


@router.post("/maps/{map_id}/features", response_model=MapFeatureOut, status_code=201)
async def create_feature(map_id: UUID, body: MapFeatureIn, user=Depends(current_user), conn=Depends(get_conn)):
    m = await require_map(conn, map_id, user["id"])
    _check_open(m)
    err = _check_feature(body.geometry, body.properties)
    if err:
        raise Problem(422, err, code="validation", fields={"geometry": [err]})
    fid, status = body.id or uuid4(), _new_status(m["role"])
    cur = await conn.execute(
        "INSERT INTO workspace_features (id, map_id, geom, properties, created_by, status, reviewed_by, reviewed_at) "
        "VALUES (%s, %s, geom_from_json(%s), %s, %s, %s, %s, CASE WHEN %s = 'approved' THEN now() END) "
        "ON CONFLICT (id) DO NOTHING RETURNING id",
        (fid, map_id, json.dumps(body.geometry), Jsonb(body.properties), user["id"], status,
         user["id"] if status == "approved" else None, status))
    if not await cur.fetchone():
        raise Problem(409, "A feature with this id already exists.", code="already_exists")
    await conn.execute("UPDATE workspace_maps SET updated_at = now() WHERE id = %s", (map_id,))
    return await _feature(conn, fid)


@router.patch("/maps/{map_id}/features/{feature_id}", response_model=MapFeatureOut)
async def update_feature(map_id: UUID, feature_id: UUID, body: MapFeaturePatch, user=Depends(current_user),
                         conn=Depends(get_conn)):
    m = await require_map(conn, map_id, user["id"])
    _check_open(m)
    cur = await conn.execute(f"SELECT {FEATURE_SQL} {FEATURE_FROM} WHERE f.id = %s AND f.map_id = %s FOR UPDATE OF f",
                             (feature_id, map_id))
    cur_row = await cur.fetchone()
    if not cur_row:
        raise Problem(404, "Feature not found.", code="not_found")
    if not _can_change(m, cur_row, user["id"]):
        raise Problem(403, "You can only change your own features, and not once a reviewer has approved them.", code="forbidden")
    if body.base_version is not None and body.base_version != cur_row["version"]:
        raise Problem(409, "This feature changed since you opened it. Reload and try again.", code="conflict",
                      server=json.loads(json.dumps(cur_row, default=str)))
    geometry = body.geometry if body.geometry is not None else cur_row["geometry"]
    properties = body.properties if body.properties is not None else cur_row["properties"]
    err = _check_feature(geometry, properties)
    if err:
        raise Problem(422, err, code="validation", fields={"geometry": [err]})
    # A contributor's change sends the feature back for review. A reviewer's change keeps the current status.
    resubmit = m["role"] == "contributor"
    await conn.execute(
        "UPDATE workspace_features SET geom = geom_from_json(%s), properties = %s, version = version + 1, updated_at = now(), "
        "updated_by = %s, status = CASE WHEN %s THEN 'submitted' ELSE status END, "
        "review_note = CASE WHEN %s THEN '' ELSE review_note END WHERE id = %s",
        (json.dumps(geometry), Jsonb(properties), user["id"], resubmit, resubmit, feature_id))
    await conn.execute("UPDATE workspace_maps SET updated_at = now() WHERE id = %s", (map_id,))
    return await _feature(conn, feature_id)


@router.delete("/maps/{map_id}/features/{feature_id}", status_code=204)
async def delete_feature(map_id: UUID, feature_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    m = await require_map(conn, map_id, user["id"])
    _check_open(m)
    cur = await conn.execute("SELECT created_by, status FROM workspace_features WHERE id = %s AND map_id = %s FOR UPDATE",
                             (feature_id, map_id))
    row = await cur.fetchone()
    if not row:
        raise Problem(404, "Feature not found.", code="not_found")
    if not _can_change(m, row, user["id"]):
        raise Problem(403, "You can only delete your own features, and not once a reviewer has approved them.", code="forbidden")
    await conn.execute("DELETE FROM workspace_features WHERE id = %s", (feature_id,))
    await conn.execute("UPDATE workspace_maps SET updated_at = now() WHERE id = %s", (map_id,))
    return Response(status_code=204)


@router.post("/maps/{map_id}/features/import", response_model=ImportOut)
async def import_features(map_id: UUID, body: ImportIn, user=Depends(current_user), conn=Depends(get_conn)):
    """Bulk-add features (the browser reads GeoJSON, KML or GPX and sends the features). Invalid ones are skipped
    and reported; the rest are added."""
    m = await require_map(conn, map_id, user["id"])
    _check_open(m)
    status = _new_status(m["role"])
    imported, errors = 0, []
    async with conn.cursor() as cur:
        for i, f in enumerate(body.features):
            err = _check_feature(f.geometry, f.properties)
            if err:
                errors.append({"row": i + 1, "message": err})
                continue
            await cur.execute(
                "INSERT INTO workspace_features (id, map_id, geom, properties, created_by, status, reviewed_by, reviewed_at) "
                "VALUES (%s, %s, geom_from_json(%s), %s, %s, %s, %s, CASE WHEN %s = 'approved' THEN now() END) "
                "ON CONFLICT (id) DO NOTHING",
                (f.id or uuid4(), map_id, json.dumps(f.geometry), Jsonb(f.properties), user["id"], status,
                 user["id"] if status == "approved" else None, status))
            imported += cur.rowcount
    await conn.execute("UPDATE workspace_maps SET updated_at = now() WHERE id = %s", (map_id,))
    return {"imported": imported, "rejected": len(body.features) - imported, "errors": errors[:20]}


@router.get("/maps/{map_id}/export.geojson")
async def export_geojson(map_id: UUID, status: Literal["submitted", "approved", "rejected"] | None = None,
                         user=Depends(current_user), conn=Depends(get_conn)):
    m = await require_map(conn, map_id, user["id"])
    cur = await conn.execute(
        f"SELECT {FEATURE_SQL} {FEATURE_FROM} WHERE f.map_id = %s AND (%s::text IS NULL OR f.status = %s) ORDER BY f.created_at",
        (map_id, status, status))
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "id": str(r["id"]), "geometry": r["geometry"], "properties": r["properties"]}
        for r in await cur.fetchall()]}
    name = re.sub(r"[^A-Za-z0-9._-]+", "-", m["name"]).strip("-") or "map"
    return Response(json.dumps(fc), media_type="application/geo+json",
                    headers={"Content-Disposition": f'attachment; filename="{name}.geojson"'})


# ------------------------------------------------------------------ review
@router.post("/maps/{map_id}/features/review")
async def review_features(map_id: UUID, body: ReviewIn, user=Depends(current_user), conn=Depends(get_conn)):
    """Approve, reject or send back features. Only approved features are published to the Data hub."""
    await require_map(conn, map_id, user["id"], "reviewer")
    cur = await conn.execute(
        "UPDATE workspace_features SET status = %s, review_note = %s, reviewed_by = %s, reviewed_at = now() "
        "WHERE map_id = %s AND id = ANY(%s) RETURNING id",
        (body.status, body.note.strip() if body.status != "approved" else "", user["id"], map_id, body.ids))
    n = len(await cur.fetchall())
    await audit(conn, "map.review", actor_id=user["id"], target_type="map", target_id=map_id, status=body.status, count=n)
    return {"updated": n}


# ------------------------------------------------------------------ members and joining
@router.get("/maps/{map_id}/members", response_model=list[MemberOut])
async def list_members(map_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    m = await require_map(conn, map_id, user["id"])
    cur = await conn.execute(
        "SELECT u.id AS user_id, u.name, u.email, 'owner' AS role, NULL::timestamptz AS joined_at FROM workspace_maps m "
        "JOIN users u ON u.id = m.owner_id WHERE m.id = %s "
        "UNION ALL SELECT u.id, u.name, u.email, mm.role, mm.joined_at FROM map_members mm JOIN users u ON u.id = mm.user_id "
        "WHERE mm.map_id = %s ORDER BY joined_at NULLS FIRST, name", (map_id, map_id))
    rows = await cur.fetchall()
    return [{**r, "email": r["email"] if m["role"] == "owner" else None} for r in rows]


@router.patch("/maps/{map_id}/members/{user_id}", response_model=MemberOut)
async def change_member(map_id: UUID, user_id: UUID, body: MemberPatch, user=Depends(current_user), conn=Depends(get_conn)):
    await require_map(conn, map_id, user["id"], "owner")
    cur = await conn.execute("UPDATE map_members SET role = %s WHERE map_id = %s AND user_id = %s RETURNING user_id",
                             (body.role, map_id, user_id))
    if not await cur.fetchone():
        raise Problem(404, "That person is not a member of this map.", code="not_found")
    await audit(conn, "map.member_role", actor_id=user["id"], target_type="map", target_id=map_id, member=str(user_id), role=body.role)
    cur = await conn.execute("SELECT u.id AS user_id, u.name, u.email, mm.role, mm.joined_at FROM map_members mm "
                             "JOIN users u ON u.id = mm.user_id WHERE mm.map_id = %s AND mm.user_id = %s", (map_id, user_id))
    return await cur.fetchone()


@router.delete("/maps/{map_id}/members/{user_id}", status_code=204)
async def remove_member(map_id: UUID, user_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    """The owner can remove anyone. Members can remove themselves (leave). What they drew stays on the map."""
    await require_map(conn, map_id, user["id"], "owner" if user_id != user["id"] else "contributor")
    cur = await conn.execute("DELETE FROM map_members WHERE map_id = %s AND user_id = %s RETURNING user_id", (map_id, user_id))
    if not await cur.fetchone():
        raise Problem(404, "That person is not a member of this map.", code="not_found")
    await audit(conn, "map.member_removed", actor_id=user["id"], target_type="map", target_id=map_id, member=str(user_id))
    return Response(status_code=204)


async def _by_code(conn, code: str, uid) -> dict:
    cur = await conn.execute(
        "SELECT m.id, m.name, m.description, m.goal, m.competition, m.starts_at, m.ends_at, m.is_campaign, u.name AS owner_name, "
        "(SELECT count(*) FROM map_members x WHERE x.map_id = m.id)::int + 1 AS member_count, "
        "CASE WHEN NOT m.is_campaign THEN NULL WHEN m.starts_at IS NOT NULL AND m.starts_at > now() THEN 'upcoming' "
        "WHEN m.ends_at IS NOT NULL AND m.ends_at < now() THEN 'ended' ELSE 'open' END AS campaign_status, "
        "(m.owner_id = %s OR EXISTS (SELECT 1 FROM map_members y WHERE y.map_id = m.id AND y.user_id = %s)) AS already_member "
        "FROM workspace_maps m JOIN users u ON u.id = m.owner_id WHERE m.join_code = %s", (uid, uid, code))
    row = await cur.fetchone()
    if not row:
        raise Problem(404, "This invitation link is not valid any more.", code="not_found")
    return row


@router.get("/join/{code}", response_model=JoinPreview)
async def join_preview(code: str, user=Depends(current_user), conn=Depends(get_conn)):
    """What the invitation page shows before the person agrees to join."""
    return await _by_code(conn, code, user["id"])


@router.post("/join/{code}", response_model=MapOut)
async def join_map(code: str, user=Depends(current_user), conn=Depends(get_conn)):
    """Join as a contributor. Joining twice is harmless."""
    m = await _by_code(conn, code, user["id"])
    if m["campaign_status"] == "ended":
        raise Problem(409, "This campaign has ended.", code="campaign_closed")
    await conn.execute("INSERT INTO map_members (map_id, user_id, role) SELECT %s, %s, 'contributor' "
                       "WHERE NOT EXISTS (SELECT 1 FROM workspace_maps WHERE id = %s AND owner_id = %s) "
                       "ON CONFLICT DO NOTHING", (m["id"], user["id"], m["id"], user["id"]))
    return await _map_out(conn, m["id"], user["id"])


# ------------------------------------------------------------------ contributors portal
CONTRIB_SQL = """
WITH m AS (SELECT owner_id, starts_at, ends_at FROM workspace_maps WHERE id = %(m)s),
fs AS (
  SELECT f.id, f.created_by, f.status, f.created_at FROM workspace_features f, m
  WHERE f.map_id = %(m)s AND (m.starts_at IS NULL OR f.created_at >= m.starts_at) AND (m.ends_at IS NULL OR f.created_at <= m.ends_at)),
people AS (
  SELECT owner_id AS user_id, 'owner' AS role FROM m
  UNION ALL SELECT user_id, role FROM map_members WHERE map_id = %(m)s
  UNION ALL SELECT DISTINCT created_by, 'former' FROM fs WHERE created_by IS NOT NULL
     AND created_by NOT IN (SELECT owner_id FROM m) AND created_by NOT IN (SELECT user_id FROM map_members WHERE map_id = %(m)s))
SELECT p.user_id, u.name, p.role,
  count(fs.id) FILTER (WHERE fs.status <> 'rejected')::int AS added,
  count(fs.id) FILTER (WHERE fs.status = 'approved')::int AS approved,
  count(fs.id) FILTER (WHERE fs.status = 'submitted')::int AS pending,
  count(fs.id) FILTER (WHERE fs.status = 'rejected')::int AS rejected,
  (SELECT count(*) FROM workspace_features e WHERE e.map_id = %(m)s AND e.updated_by = p.user_id
     AND e.created_by IS DISTINCT FROM p.user_id)::int AS edited,
  min(fs.created_at) AS first_at, max(fs.created_at) AS last_at
FROM people p JOIN users u ON u.id = p.user_id LEFT JOIN fs ON fs.created_by = p.user_id
GROUP BY p.user_id, u.name, p.role
ORDER BY added DESC, approved DESC, u.name
"""


@router.get("/maps/{map_id}/contributors", response_model=ContributorsOut)
async def contributors(map_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    """Who mapped what. If the map is a campaign with dates, only features drawn inside the window count. People are
    ranked by features added; rejected features are not counted, so spam does not win."""
    m = await require_map(conn, map_id, user["id"])
    cur = await conn.execute(CONTRIB_SQL, {"m": map_id})
    rows = await cur.fetchall()
    for r in rows:
        r["rank"] = 1 + sum(1 for o in rows if o["added"] > r["added"])
    cur = await conn.execute(
        "SELECT (f.created_at AT TIME ZONE 'UTC')::date AS day, count(*)::int AS count FROM workspace_features f "
        "WHERE f.map_id = %s AND f.created_at >= now() - interval '60 days' GROUP BY 1 ORDER BY 1", (map_id,))
    daily = await cur.fetchall()
    totals = {"contributors": sum(1 for r in rows if r["added"] or r["rejected"]), "added": sum(r["added"] for r in rows),
              "approved": sum(r["approved"] for r in rows), "pending": sum(r["pending"] for r in rows),
              "rejected": sum(r["rejected"] for r in rows)}
    return {"contributors": rows, "totals": totals, "daily": daily, "starts_at": m["starts_at"], "ends_at": m["ends_at"]}


@router.get("/maps/{map_id}/activity", response_model=list[ActivityOut])
async def activity(map_id: UUID, limit: int = Query(30, ge=1, le=100), user=Depends(current_user), conn=Depends(get_conn)):
    """The most recent changes on the map, newest first."""
    await require_map(conn, map_id, user["id"])
    cur = await conn.execute(
        "SELECT f.id AS feature_id, COALESCE(f.updated_by, f.created_by) AS user_id, u.name, "
        "CASE WHEN f.version > 1 THEN 'edited' ELSE 'added' END AS action, f.updated_at AS at, "
        "CASE WHEN GeometryType(f.geom) ILIKE '%%POINT' THEN 'point' WHEN GeometryType(f.geom) ILIKE '%%LINESTRING' THEN 'line' "
        "ELSE 'area' END AS geometry_type, f.status FROM workspace_features f "
        "LEFT JOIN users u ON u.id = COALESCE(f.updated_by, f.created_by) WHERE f.map_id = %s "
        "ORDER BY f.updated_at DESC LIMIT %s", (map_id, limit))
    return await cur.fetchall()


# ------------------------------------------------------------------ publishing to the Data hub
@router.get("/maps/{map_id}/datasets", response_model=list[DatasetSummary])
async def map_datasets(map_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    """Datasets already published from this map."""
    await require_map(conn, map_id, user["id"])
    cur = await conn.execute(SUMMARY_SQL + "WHERE d.map_id = %s ORDER BY d.created_at DESC", (map_id,))
    return await cur.fetchall()


@router.post("/maps/{map_id}/publish", response_model=DatasetCreated, status_code=202)
async def publish_map(map_id: UUID, body: PublishIn, user=Depends(current_user), conn=Depends(get_conn)):
    """Publish the approved features of one kind (points, lines or areas) as a Data hub dataset. Features that are
    waiting for review or were rejected are left out. Publish again later with POST /datasets/{slug}/versions."""
    await require_map(conn, map_id, user["id"], "owner")
    if body.license == "Private" and body.visibility == "public":
        raise Problem(422, "A Private licence cannot be published publicly.", code="validation",
                      fields={"license": ["Private datasets must have visibility private"]})
    cur = await conn.execute("SELECT 1 FROM datasets WHERE slug = %s", (body.slug,))
    if await cur.fetchone():
        raise Problem(409, "That slug is taken.", code="slug_taken", fields={"slug": ["already in use"]})
    cur = await conn.execute("SELECT count(*)::int AS n FROM workspace_features WHERE map_id = %s AND status = 'approved' "
                             "AND GeometryType(geom) ILIKE %s", (map_id, GEOM_LIKE[body.geometry_type]))
    if (await cur.fetchone())["n"] == 0:
        raise Problem(409, f"There are no approved {_KIND_NAME[body.geometry_type]} features yet. Approve some in the Review tab first.",
                      code="empty_dataset")
    cur = await conn.execute(
        "INSERT INTO datasets (slug, map_id, map_geometry, title, description, license, tags, visibility, statuses, "
        "credit_contributors, created_by) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, '{approved}', %s, %s) RETURNING id",
        (body.slug, map_id, body.geometry_type, body.title, body.description, body.license,
         [t.lower() for t in body.tags], body.visibility, body.credit_contributors, user["id"]))
    did = (await cur.fetchone())["id"]
    await audit(conn, "dataset.publish", actor_id=user["id"], target_type="dataset", target_id=did, slug=body.slug,
                visibility=body.visibility, map_id=str(map_id))
    job = await create_job(conn, "snapshot", {"dataset_id": str(did), "statuses": None}, created_by=user["id"])
    await dispatch(conn, job)
    cur = await conn.execute("SELECT * FROM jobs WHERE id = %s", (job["id"],))
    cur2 = await conn.execute(SUMMARY_SQL + "WHERE d.id = %s", (did,))
    return {"dataset": await cur2.fetchone(), "job": job_out(await cur.fetchone())}
