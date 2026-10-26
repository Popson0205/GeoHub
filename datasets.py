from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request

from .. import ratelimit
from ..audit import audit
from ..config import settings
from ..db import get_conn
from ..deps import current_user, optional_user, require_map, require_role, role_in
from ..errors import Problem
from ..jobs import create_job, dispatch
from ..logging_setup import client_ip
from ..pagination import Page, decode_cursor, encode_cursor, page_from_offset
from ..schemas import (DatasetCreated, DatasetIn, DatasetOut, DatasetPatch, DatasetSummary, ExportIn, JobOut,
                       NewVersionIn)
from .jobs import job_out

router = APIRouter(tags=["datasets"])
FORMATS = ["geojson", "gpkg", "shp", "csv"]
EXT = {"geojson": "geojson", "gpkg": "gpkg", "shp": "zip", "csv": "csv"}

SUMMARY_SQL = (
    "SELECT d.id, d.slug, d.title, d.description, d.license, d.tags, d.visibility, d.latest_version, d.project_id, d.map_id, "
    "d.statuses, COALESCE(v.geometry_type, f.geometry_type, d.map_geometry) AS geometry_type, COALESCE(v.feature_count, 0) AS feature_count, "
    "v.bbox, COALESCE(v.published_at, d.created_at) AS published_at, "
    "(SELECT COALESCE(sum(x.download_count), 0)::bigint FROM dataset_versions x WHERE x.dataset_id = d.id) AS download_count "
    "FROM datasets d LEFT JOIN forms f ON f.id = d.form_id "
    "LEFT JOIN dataset_versions v ON v.dataset_id = d.id AND v.version = d.latest_version ")


async def _anon_read_limit(request: Request, user):
    if not user:
        await ratelimit.hit(f"hubread:{client_ip(request)}", settings.rate_anon_read_per_min, 60)


async def _dataset_role(conn, d: dict, user) -> str | None:
    """The person's role on whatever the dataset came from: a project (members) or a map (owner, reviewers, contributors)."""
    if not user:
        return None
    if d["map_id"]:
        cur = await conn.execute(
            "SELECT CASE WHEN m.owner_id = %s THEN 'owner' ELSE mm.role END AS role FROM workspace_maps m "
            "LEFT JOIN map_members mm ON mm.map_id = m.id AND mm.user_id = %s WHERE m.id = %s", (user["id"], user["id"], d["map_id"]))
        row = await cur.fetchone()
        return row["role"] if row else None
    return await role_in(conn, d["project_id"], user["id"]) if d["project_id"] else None


async def _require_owner(conn, d: dict, user):
    """Project datasets are managed by the project owner, map datasets by the map owner. If the map was deleted the person
    who published the dataset keeps control of it."""
    if d["map_id"]:
        await require_map(conn, d["map_id"], user["id"], "owner")
    elif d["project_id"]:
        await require_role(conn, d["project_id"], user["id"], "owner")
    elif d["created_by"] != user["id"]:
        raise Problem(404, "Dataset not found.", code="not_found")


async def _get_readable(conn, slug: str, user) -> tuple[dict, str | None]:
    cur = await conn.execute(SUMMARY_SQL + "WHERE d.slug = %s", (slug,))
    d = await cur.fetchone()
    role = await _dataset_role(conn, d, user) if d else None
    if not d or (d["visibility"] != "public" and not role):
        raise Problem(404, "Dataset not found.", code="not_found")   # private datasets are invisible to outsiders
    return d, role


@router.get("/datasets", response_model=Page[DatasetSummary])
async def catalogue(request: Request, q: str | None = None, type: str | None = Query(None, pattern="^(point|line|area)$"),
                    license: str | None = None, tag: str | None = None,
                    sort: str = Query("recent", pattern="^(recent|name|downloads)$"),
                    limit: int = Query(24, ge=1, le=100), cursor: str | None = None, user=Depends(optional_user),
                    conn=Depends(get_conn)):
    """Public catalogue. No login needed; signed-in users also see private datasets of their projects."""
    await _anon_read_limit(request, user)
    where, params = ["d.latest_version > 0",
                     "(d.visibility = 'public' OR d.project_id IN (SELECT project_id FROM members WHERE user_id = %s) "
                     "OR d.map_id IN (SELECT id FROM workspace_maps WHERE owner_id = %s UNION SELECT map_id FROM map_members WHERE user_id = %s))"], \
                    [user["id"] if user else None] * 3
    if q:
        where.append("(d.title ILIKE %s OR d.description ILIKE %s OR %s = ANY(d.tags))")
        params += [f"%{q}%", f"%{q}%", q.lower()]
    if type:
        where.append("v.geometry_type = %s"); params.append(type)
    if license:
        where.append("d.license = %s"); params.append(license)
    if tag:
        where.append("%s = ANY(d.tags)"); params.append(tag.lower())
    order = {"recent": "v.published_at DESC", "name": "lower(d.title)", "downloads": "download_count DESC"}[sort]
    off = decode_cursor(cursor).get("o", 0)
    cur = await conn.execute(f"{SUMMARY_SQL} WHERE {' AND '.join(where)} ORDER BY {order}, d.slug LIMIT %s OFFSET %s",
                             (*params, limit + 1, off))
    items, nxt = page_from_offset(await cur.fetchall(), limit, off)
    return {"items": items, "next_cursor": nxt}


@router.get("/datasets/{slug}", response_model=DatasetOut)
async def get_dataset(slug: str, request: Request, user=Depends(optional_user), conn=Depends(get_conn)):
    await _anon_read_limit(request, user)
    d, role = await _get_readable(conn, slug, user)
    cur = await conn.execute("SELECT version, feature_count, bbox, published_at, download_count FROM dataset_versions "
                             "WHERE dataset_id = %s ORDER BY version DESC", (d["id"],))
    versions = await cur.fetchall()
    fields, contributors = [], []
    if versions:
        cur = await conn.execute("SELECT fields, contributors FROM dataset_versions WHERE dataset_id = %s AND version = %s",
                                 (d["id"], d["latest_version"]))
        row = await cur.fetchone()
        fields, contributors = row["fields"], row["contributors"]
    return {**d, "project_id": d["project_id"] if role else None, "map_id": d["map_id"] if role else None,
            "contributors": contributors, "fields": fields, "versions": versions, "formats": FORMATS}


@router.get("/datasets/{slug}/features")
async def dataset_features(slug: str, request: Request, bbox: str | None = None,
                           version: int | None = Query(None, ge=1), limit: int = Query(100, ge=1, le=1000),
                           cursor: str | None = None, user=Depends(optional_user), conn=Depends(get_conn)):
    """GeoJSON FeatureCollection from the immutable snapshot (latest version unless `version` is given).
    Page with `next_cursor`; `bbox` filters spatially."""
    await _anon_read_limit(request, user)
    d, _ = await _get_readable(conn, slug, user)
    v = version or d["latest_version"]
    if v == 0:
        raise Problem(409, "This dataset has no published version yet.", code="not_published")
    where, params = ["dataset_id = %s", "version = %s", "feature_id > %s"], \
                    [d["id"], v, decode_cursor(cursor).get("f", "00000000-0000-0000-0000-000000000000")]
    if bbox:
        try:
            a, b, c, e = (float(p) for p in bbox.split(","))
        except ValueError:
            raise Problem(422, "bbox must be minx,miny,maxx,maxy", code="validation", fields={"bbox": ["invalid"]})
        where.append("geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)"); params += [a, b, c, e]
    cur = await conn.execute(
        "SELECT feature_id, ST_AsGeoJSON(geom, 7)::jsonb AS geometry, properties FROM dataset_features "
        f"WHERE {' AND '.join(where)} ORDER BY feature_id LIMIT %s", (*params, limit + 1))
    rows = await cur.fetchall()
    more = len(rows) > limit
    rows = rows[:limit]
    return {"type": "FeatureCollection", "version": v,
            "next_cursor": encode_cursor(f=str(rows[-1]["feature_id"])) if more else None,
            "features": [{"type": "Feature", "id": str(r["feature_id"]), "geometry": r["geometry"],
                          "properties": r["properties"]} for r in rows]}


async def _snapshot_job(conn, d_id, project_id, user_id, statuses=None):
    return await create_job(conn, "snapshot", {"dataset_id": str(d_id), "statuses": statuses},
                            project_id=project_id, created_by=user_id)


@router.post("/projects/{project_id}/datasets", response_model=DatasetCreated, status_code=202)
async def publish_dataset(project_id: UUID, body: DatasetIn, request: Request, user=Depends(current_user),
                          conn=Depends(get_conn)):
    """Creates the dataset and queues its first snapshot (version 1). Poll the job, then the dataset appears
    in the catalogue. Only approved features are included unless `statuses` says otherwise."""
    await require_role(conn, project_id, user["id"], "owner")
    if body.license == "Private" and body.visibility == "public":
        raise Problem(422, "A Private licence cannot be published publicly.", code="validation",
                      fields={"license": ["Private datasets must have visibility private"]})
    cur = await conn.execute("SELECT version FROM forms WHERE id = %s AND project_id = %s", (body.form_id, project_id))
    form = await cur.fetchone()
    if not form:
        raise Problem(404, "Form not found in this project.", code="not_found")
    if form["version"] == 0:
        raise Problem(409, "Publish the form before publishing a dataset from it.", code="form_not_published")
    cur = await conn.execute("SELECT 1 FROM datasets WHERE slug = %s", (body.slug,))
    if await cur.fetchone():
        raise Problem(409, "That slug is taken.", code="slug_taken", fields={"slug": ["already in use"]})
    cur = await conn.execute(
        "INSERT INTO datasets (slug, project_id, form_id, title, description, license, tags, visibility, statuses, "
        "created_by) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
        (body.slug, project_id, body.form_id, body.title, body.description, body.license,
         [t.lower() for t in body.tags], body.visibility, body.statuses, user["id"]))
    did = (await cur.fetchone())["id"]
    await audit(conn, "dataset.publish", actor_id=user["id"], project_id=project_id, target_type="dataset",
                target_id=did, ip=client_ip(request), slug=body.slug, visibility=body.visibility)
    job = await _snapshot_job(conn, did, project_id, user["id"])
    await dispatch(conn, job)
    cur = await conn.execute("SELECT * FROM jobs WHERE id = %s", (job["id"],))
    cur2 = await conn.execute(SUMMARY_SQL + "WHERE d.id = %s", (did,))
    return {"dataset": await cur2.fetchone(), "job": job_out(await cur.fetchone())}


@router.post("/datasets/{slug}/versions", response_model=JobOut, status_code=202)
async def new_version(slug: str, request: Request, body: NewVersionIn | None = None, user=Depends(current_user),
                      conn=Depends(get_conn)):
    """Take a fresh snapshot as the next version. Earlier versions never change."""
    cur = await conn.execute("SELECT id, project_id, map_id, created_by FROM datasets WHERE slug = %s", (slug,))
    d = await cur.fetchone()
    if not d:
        raise Problem(404, "Dataset not found.", code="not_found")
    await _require_owner(conn, d, user)
    statuses = body.statuses if body and not d["map_id"] else None      # map datasets always publish approved features only
    if statuses:
        await conn.execute("UPDATE datasets SET statuses = %s WHERE id = %s", (statuses, d["id"]))
    await audit(conn, "dataset.version", actor_id=user["id"], project_id=d["project_id"], target_type="dataset",
                target_id=d["id"], ip=client_ip(request), slug=slug)
    job = await _snapshot_job(conn, d["id"], d["project_id"], user["id"], statuses)
    await dispatch(conn, job)
    cur = await conn.execute("SELECT * FROM jobs WHERE id = %s", (job["id"],))
    return job_out(await cur.fetchone())


@router.patch("/datasets/{slug}", response_model=DatasetOut)
async def update_dataset(slug: str, body: DatasetPatch, request: Request, user=Depends(current_user),
                         conn=Depends(get_conn)):
    cur = await conn.execute("SELECT id, project_id, map_id, created_by, license, visibility FROM datasets WHERE slug = %s", (slug,))
    d = await cur.fetchone()
    if not d:
        raise Problem(404, "Dataset not found.", code="not_found")
    await _require_owner(conn, d, user)
    lic, vis = body.license or d["license"], body.visibility or d["visibility"]
    if lic == "Private" and vis == "public":
        raise Problem(422, "A Private licence cannot be published publicly.", code="validation",
                      fields={"license": ["Private datasets must have visibility private"]})
    await conn.execute(
        "UPDATE datasets SET title = COALESCE(%s, title), description = COALESCE(%s, description), license = %s, "
        "tags = COALESCE(%s, tags), visibility = %s, updated_at = now() WHERE id = %s",
        (body.title, body.description, lic, [t.lower() for t in body.tags] if body.tags is not None else None, vis, d["id"]))
    if vis != d["visibility"]:
        await audit(conn, "dataset.visibility", actor_id=user["id"], project_id=d["project_id"],
                    target_type="dataset", target_id=d["id"], ip=client_ip(request), old=d["visibility"], new=vis)
    return await get_dataset(slug, request, user, conn)


@router.post("/datasets/{slug}/exports", response_model=JobOut, status_code=202)
async def request_export(slug: str, body: ExportIn, request: Request, user=Depends(optional_user),
                         conn=Depends(get_conn)):
    """Start an export of one dataset version. Poll GET /jobs/{id} for the signed download URL. Identical
    exports are generated once and reused."""
    ip = client_ip(request)
    if not user:
        await ratelimit.hit(f"export:{ip}", settings.rate_anon_export_per_hour, 3600)
    d, _ = await _get_readable(conn, slug, user)
    v = body.version or d["latest_version"]
    cur = await conn.execute("SELECT snapshot_key FROM dataset_versions WHERE dataset_id = %s AND version = %s", (d["id"], v))
    ver = await cur.fetchone()
    if not ver:
        raise Problem(404 if body.version else 409, "That dataset version does not exist yet.", code="not_published")
    fname = f"{slug}-v{v}.{EXT[body.format]}"
    public = d["visibility"] == "public"
    await conn.execute("UPDATE dataset_versions SET download_count = download_count + 1 "
                       "WHERE dataset_id = %s AND version = %s", (d["id"], v))
    await audit(conn, "export.request", actor_id=user["id"] if user else None, project_id=d["project_id"],
                target_type="dataset", target_id=d["id"], ip=ip, format=body.format, version=v)
    key, size = (ver["snapshot_key"], None) if body.format == "geojson" else (None, None)
    if body.format != "geojson":
        cur = await conn.execute("SELECT storage_key, size FROM dataset_exports WHERE dataset_id = %s AND version = %s "
                                 "AND format = %s", (d["id"], v, body.format))
        cached = await cur.fetchone()
        key, size = (cached["storage_key"], cached["size"]) if cached else (None, None)
    params = {"dataset_id": str(d["id"]), "version": v, "format": body.format}
    if key:
        job = await create_job(conn, "export", params, project_id=d["project_id"], public=public,
                               created_by=user["id"] if user else None, status="done",
                               result={"storage_key": key, "filename": fname, "format": body.format, "size": size})
    else:
        job = await create_job(conn, "export", params, project_id=d["project_id"], public=public,
                               created_by=user["id"] if user else None)
        await dispatch(conn, job)
    await conn.commit()
    cur = await conn.execute("SELECT * FROM jobs WHERE id = %s", (job["id"],))
    return job_out(await cur.fetchone())
