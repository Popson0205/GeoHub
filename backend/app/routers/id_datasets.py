"""Publishing to the Data hub from the other GeoEstate apps, with the person's own GeoEstate ID access token.

PolyGIS publishes a layer as a dataset: the app sends the features (WGS 84), Geohub keeps them as an immutable version,
exactly like a dataset published from a Geohub form or map, and the catalogue, previews and downloads work the same.
Later versions come from the app too. A dataset belongs to the person who published it (and their organization).

  GET  /id/data/datasets?ref=…             the person's datasets published from this app (optionally from one layer)
  POST /id/data/datasets                   publish: a new dataset, version 1
  POST /id/data/datasets/{slug}/versions   publish the layer again as the next version"""
import json
import re
import secrets
import tempfile
import uuid
from pathlib import Path
from typing import Literal

import anyio
from botocore.exceptions import ClientError
from fastapi import APIRouter, Depends, Query
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, field_validator

from .. import formats, storage
from ..audit import audit
from ..config import settings
from ..db import get_conn
from ..errors import Problem
from ..jobs import create_job, dispatch
from .datasets import SUMMARY_SQL, check_visibility
from .id_data import app_person

router = APIRouter(prefix="/id/data", tags=["GeoEstate ID"])
APP_NAMES = {"gis": "PolyGIS", "land": "Land Registry", "farm": "FarmScan", "check": "LandCheck"}
MAX_FEATURES = 50_000
KINDS = {"point": ("Point", "MultiPoint"), "line": ("LineString", "MultiLineString"), "area": ("Polygon", "MultiPolygon")}
TYPES = {"string": "text", "text": "text", "integer": "number", "number": "number", "decimal": "number", "date": "date", "boolean": "boolean"}


class AppField(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: str = "string"


class AppFeature(BaseModel):
    geometry: dict
    properties: dict = Field(default_factory=dict)


class AppVersionIn(BaseModel):
    geometry_type: Literal["point", "line", "area"]
    fields: list[AppField] = Field(default_factory=list, max_length=300)
    features: list[AppFeature] = Field(min_length=1, max_length=MAX_FEATURES)


class AppDatasetIn(AppVersionIn):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field("", max_length=5000)
    license: Literal["ODbL-1.0", "CC-BY-4.0", "CC0-1.0", "Private"] = "CC-BY-4.0"
    tags: list[str] = Field([], max_length=20)
    visibility: Literal["private", "organization", "public"] = "private"
    slug: str | None = Field(None, pattern=r"^[a-z0-9][a-z0-9-]{1,62}$")
    ref: str = Field(min_length=1, max_length=100, description="What the app published: e.g. the PolyGIS layer's id")
    label: str = Field("", max_length=300, description="Where it came from, in words: e.g. 'Bosso Estate › parcels'")


def _ids(names: list[str]) -> dict[str, str]:
    """Safe, unique column ids for the app's field names ("Area (ha)" → "area_ha")."""
    out, used = {}, set()
    for k in names:
        base = re.sub(r"[^a-z0-9_]+", "_", k.lower()).strip("_")[:40] or "field"
        if not base[0].isalpha():
            base = ("f_" + base)[:40]
        cand, i = base, 2
        while cand in used:
            cand, i = f"{base[:36]}_{i}", i + 1
        used.add(cand)
        out[k] = cand
    return out


def _sound(g: dict) -> bool:
    """A shape with enough points to be one: two for a line, four (closed) for each ring of a polygon."""
    def pos(p):
        return isinstance(p, list) and 2 <= len(p) <= 4 and all(isinstance(v, (int, float)) for v in p)

    def line(c, n):
        return isinstance(c, list) and len(c) >= n and all(pos(p) for p in c)

    t, c = g.get("type"), g.get("coordinates")
    if t == "Point":
        return pos(c)
    if t == "MultiPoint":
        return line(c, 1)
    if t == "LineString":
        return line(c, 2)
    if t == "MultiLineString":
        return isinstance(c, list) and bool(c) and all(line(x, 2) for x in c)
    if t == "Polygon":
        return isinstance(c, list) and bool(c) and all(line(r, 4) for r in c)
    if t == "MultiPolygon":
        return isinstance(c, list) and bool(c) and all(isinstance(pg, list) and pg and all(line(r, 4) for r in pg) for pg in c)
    return False


def _slug(title: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:48] or "dataset"
    if not base[0].isalnum():
        base = "d-" + base
    return f"{base}-{secrets.token_hex(3)}"


async def _version(conn, d: dict, body: AppVersionIn, person: dict) -> dict:
    """Keeps the features as the dataset's next version: rows for previews and a GeoJSON snapshot for downloads."""
    bad = [i for i, f in enumerate(body.features) if (f.geometry or {}).get("type") not in KINDS[body.geometry_type]]
    if bad:
        raise Problem(422, f"{len(bad)} feature(s) are not {body.geometry_type}s (the first is number {bad[0] + 1}).", code="validation",
                      fields={"features": [f"{len(bad)} of another kind"]})
    broken = [i for i, f in enumerate(body.features) if not _sound(f.geometry)]
    if broken:
        raise Problem(422, f"{len(broken)} shape(s) have too few points to be read (the first is number {broken[0] + 1}).", code="validation",
                      fields={"features": [f"{len(broken)} unreadable"]})
    ids = _ids([f.name for f in body.fields])
    fields = [{"id": ids[f.name], "label": f.name, "type": TYPES.get(f.type, "text"), "required": False, "choices": []} for f in body.fields]
    version = d["latest_version"] + 1
    skey = f"snapshots/{d['id']}/v{version}.geojson"
    await conn.execute("INSERT INTO dataset_versions (dataset_id, version, fields, geometry_type, snapshot_key, published_by) "
                       "VALUES (%s, %s, %s, %s, %s, %s)", (d["id"], version, Jsonb(fields), body.geometry_type, skey, person["sub"]))
    rows = [(d["id"], version, uuid.uuid4(), json.dumps(f.geometry), Jsonb({ids[k]: v for k, v in f.properties.items() if k in ids}))
            for f in body.features]
    async with conn.cursor() as c:
        try:
            await c.executemany("INSERT INTO dataset_features (dataset_id, version, feature_id, geom, properties) "
                                "VALUES (%s, %s, %s, ST_SetSRID(ST_GeomFromGeoJSON(%s), 4326), %s)", rows)
        except Exception as e:  # noqa: BLE001  (an unreadable geometry)
            raise Problem(422, f"A shape could not be read: {str(e).splitlines()[0][:160]}", code="validation") from None
    cur = await conn.execute("SELECT ARRAY[ST_XMin(e), ST_YMin(e), ST_XMax(e), ST_YMax(e)] AS b FROM "
                             "(SELECT ST_Extent(geom) AS e FROM dataset_features WHERE dataset_id = %s AND version = %s) x", (d["id"], version))
    bbox = (await cur.fetchone())["b"]

    def write():
        with tempfile.TemporaryDirectory() as t:
            path = Path(t) / "s.geojson"
            with path.open("w") as fh:
                fh.write('{"type":"FeatureCollection","name":%s,"features":[' % json.dumps(d["slug"]))
                for i, r in enumerate(rows):
                    fh.write(("," if i else "") + json.dumps({"type": "Feature", "id": str(r[2]), "geometry": json.loads(r[3]), "properties": r[4].obj}))
                fh.write("]}")
            storage.internal.upload_file(str(path), storage.B, skey, ExtraArgs={"ContentType": "application/geo+json"})
    await anyio.to_thread.run_sync(write)
    await conn.execute("UPDATE dataset_versions SET feature_count = %s, bbox = %s WHERE dataset_id = %s AND version = %s",
                       (len(rows), bbox, d["id"], version))
    await conn.execute("UPDATE datasets SET latest_version = %s, updated_at = now() WHERE id = %s", (version, d["id"]))
    return {"version": version, "feature_count": len(rows), "bbox": bbox}


def _user(person: dict) -> dict:
    return {"id": person["sub"], "name": person.get("name") or "", "email": person.get("email") or ""}


@router.get("/datasets", summary="The person's datasets published from this app")
async def my_datasets(ref: str | None = Query(None, max_length=100), person=Depends(app_person), conn=Depends(get_conn)):
    where, vals = ["d.source->>'app' = %s", "d.created_by = %s"], [person["aud"], person["sub"]]
    if ref:
        where.append("d.source->>'ref' = %s"); vals.append(ref)
    cur = await conn.execute(f"{SUMMARY_SQL} WHERE {' AND '.join(where)} ORDER BY d.updated_at DESC", vals)
    return await cur.fetchall()


@router.post("/datasets", status_code=201, summary="Publish to the Data hub from an app: a new dataset, version 1")
async def publish(body: AppDatasetIn, person=Depends(app_person), conn=Depends(get_conn)):
    await check_visibility(conn, _user(person), body.visibility)
    if body.license == "Private" and body.visibility == "public":
        raise Problem(422, "A Private licence cannot be published publicly.", code="validation", fields={"license": ["Private datasets must have visibility private"]})
    slug = body.slug or _slug(body.title)
    cur = await conn.execute("SELECT 1 FROM datasets WHERE slug = %s", (slug,))
    if await cur.fetchone():
        raise Problem(409, "That address is taken: choose another.", code="slug_taken", fields={"slug": ["already in use"]})
    app = person["aud"]
    source = {"app": app, "name": APP_NAMES.get(app, app), "ref": body.ref, "label": body.label.strip()}
    cur = await conn.execute(
        "INSERT INTO datasets (slug, org_id, source, title, description, license, tags, visibility, statuses, created_by) "
        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, '{approved}', %s) RETURNING *",
        (slug, person["org"]["id"], Jsonb(source), body.title.strip(), body.description.strip(), body.license,
         [t.lower()[:40] for t in body.tags], body.visibility, person["sub"]))
    d = await cur.fetchone()
    v = await _version(conn, d, body, person)
    await audit(conn, "dataset.publish", actor_id=person["sub"], target_type="dataset", target_id=d["id"], slug=slug,
                visibility=body.visibility, app=app)
    cur = await conn.execute(SUMMARY_SQL + "WHERE d.id = %s", (d["id"],))
    return {"dataset": await cur.fetchone(), **v}


@router.post("/datasets/{slug}/versions", status_code=201, summary="Publish the next version from the app")
async def publish_version(slug: str, body: AppVersionIn, person=Depends(app_person), conn=Depends(get_conn)):
    cur = await conn.execute("SELECT * FROM datasets WHERE slug = %s FOR UPDATE", (slug,))
    d = await cur.fetchone()
    if not d or not d["source"] or d["source"].get("app") != person["aud"] or str(d["created_by"]) != str(person["sub"]):
        raise Problem(404, "Dataset not found.", code="not_found")
    v = await _version(conn, d, body, person)
    await audit(conn, "dataset.version", actor_id=person["sub"], target_type="dataset", target_id=d["id"], slug=slug, app=person["aud"])
    cur = await conn.execute(SUMMARY_SQL + "WHERE d.id = %s", (d["id"],))
    return {"dataset": await cur.fetchone(), **v}


# ---------- rasters ----------
# A raster can be gigabytes, so it does not pass through this API: the app asks for upload addresses, sends the file in
# parts straight to storage, and says when it is done. Geohub's worker then turns it into a Cloud-Optimised GeoTIFF
# with its statistics, and the version appears in the Data hub, drawn as map tiles and downloadable as a GeoTIFF.
#
#   POST /id/data/rasters                  a new raster dataset, or (with `dataset`) the next version of one: upload parts
#   POST /id/data/rasters/{id}/complete    the parts are uploaded: convert it
#   GET  /id/data/rasters/{id}             how it is going: uploading, processing, ready or failed (and why)
COLORMAPS = {"viridis", "magma", "plasma", "inferno", "cividis", "terrain", "gist_earth", "gray", "greys", "greens", "blues", "reds",
             "rdylgn", "spectral", "ylgn", "rdylbu", "rdbu", "brbg"}


class RasterRender(BaseModel):
    colormap: str | None = Field(None, pattern=r"^[a-z_]{2,20}$", description=f"A single band is drawn with this colour ramp: one of "
                                 f"{', '.join(sorted(COLORMAPS))}, or one of them reversed (name_r)")
    rescale: tuple[float, float] | None = Field(None, description="The values drawn at either end of the ramp (else the band's min and max)")
    colors: list[str] | None = Field(None, min_length=2, max_length=16, description="The app's own ramp, low to high, as #rrggbb stops: "
                                     "drawn exactly so, instead of a named colormap")


    @field_validator("colormap")
    @classmethod
    def _known(cls, v: str | None) -> str | None:
        if v is not None and v.removesuffix("_r") not in COLORMAPS:
            raise ValueError(f"not a colour ramp Geohub draws: one of {', '.join(sorted(COLORMAPS))} (or name_r, reversed)")
        return v

    @field_validator("colors")
    @classmethod
    def _hex(cls, v: list[str] | None) -> list[str] | None:
        if v is not None and not all(re.fullmatch(r"#[0-9a-fA-F]{6}", c) for c in v):
            raise ValueError("colours are #rrggbb")
        return [c.lower() for c in v] if v else v


class RasterStartIn(BaseModel):
    filename: str = Field(min_length=1, max_length=300)
    size: int = Field(gt=0)
    dataset: str | None = Field(None, description="The slug of a raster dataset this app published: the upload becomes its next version")
    title: str | None = Field(None, min_length=1, max_length=200)
    description: str = Field("", max_length=5000)
    license: Literal["ODbL-1.0", "CC-BY-4.0", "CC0-1.0", "Private"] = "CC-BY-4.0"
    tags: list[str] = Field([], max_length=20)
    visibility: Literal["private", "organization", "public"] = "private"
    slug: str | None = Field(None, pattern=r"^[a-z0-9][a-z0-9-]{1,62}$")
    ref: str | None = Field(None, min_length=1, max_length=100)
    label: str = Field("", max_length=300)
    render: RasterRender | None = None


class PartIn(BaseModel):
    part_number: int = Field(ge=1, le=10000)
    etag: str = Field(min_length=1, max_length=200)


class RasterCompleteIn(BaseModel):
    parts: list[PartIn] = Field(min_length=1, max_length=10000)


async def _upload(conn, upload_id: uuid.UUID, person: dict) -> dict:
    cur = await conn.execute("SELECT * FROM dataset_uploads WHERE id = %s AND app = %s AND created_by = %s", (upload_id, person["aud"], person["sub"]))
    u = await cur.fetchone()
    if not u:
        raise Problem(404, "Upload not found.", code="not_found")
    return u


async def _upload_out(conn, u: dict) -> dict:
    out = {k: u[k] for k in ("id", "status", "version", "error", "error_code", "filename", "size")}
    out["dataset"] = None
    if u["dataset_id"]:
        cur = await conn.execute(SUMMARY_SQL + "WHERE d.id = %s", (u["dataset_id"],))
        out["dataset"] = await cur.fetchone()
    return out


@router.post("/rasters", status_code=201, summary="Publish a raster: where to upload it, in parts")
async def start_raster(body: RasterStartIn, person=Depends(app_person), conn=Depends(get_conn)):
    if not formats.is_raster(body.filename):
        raise Problem(422, f"That is not a raster file. Accepted: {formats.RASTER_LIST}.", code="unsupported_format", fields={"filename": ["not a raster"]})
    if body.size > settings.max_imagery_bytes:
        raise Problem(413, f"Rasters are limited to {settings.max_imagery_bytes // 1024**3} GB.", code="too_large")
    dataset_id, meta = None, {}
    if body.dataset:
        cur = await conn.execute("SELECT d.*, v.geometry_type FROM datasets d LEFT JOIN dataset_versions v ON v.dataset_id = d.id "
                                 "AND v.version = d.latest_version WHERE d.slug = %s", (body.dataset,))
        d = await cur.fetchone()
        if not d or not d["source"] or d["source"].get("app") != person["aud"] or str(d["created_by"]) != str(person["sub"]):
            raise Problem(404, "Dataset not found.", code="not_found")
        if (d["geometry_type"] or d["source"].get("kind")) != "raster":
            raise Problem(422, "That dataset holds features, not a raster: publish the raster as a dataset of its own.", code="validation")
        dataset_id = d["id"]
    else:
        if not body.title or not body.ref:
            raise Problem(422, "A new dataset needs a title, and what the app published (ref).", code="validation",
                          fields={k: ["required"] for k in ("title", "ref") if not getattr(body, k)})
        await check_visibility(conn, _user(person), body.visibility)
        if body.license == "Private" and body.visibility == "public":
            raise Problem(422, "A Private licence cannot be published publicly.", code="validation", fields={"license": ["Private datasets must have visibility private"]})
        if body.slug:
            cur = await conn.execute("SELECT 1 FROM datasets WHERE slug = %s", (body.slug,))
            if await cur.fetchone():
                raise Problem(409, "That address is taken: choose another.", code="slug_taken", fields={"slug": ["already in use"]})
        meta = body.model_dump(include={"title", "description", "license", "tags", "visibility", "slug", "ref", "label"})
    if body.render:
        meta["render"] = body.render.model_dump(exclude_none=True)
    part_size = max(64 * 1024 * 1024, -(-body.size // 9000))
    n_parts = -(-body.size // part_size)
    cur = await conn.execute("INSERT INTO dataset_uploads (app, org_id, created_by, dataset_id, meta, filename, size, source_key) "
                             "VALUES (%s, %s, %s, %s, %s, %s, %s, 'pending') RETURNING id",
                             (person["aud"], (person.get("org") or {}).get("id"), person["sub"], dataset_id, Jsonb(meta), body.filename[:300], body.size))
    uid = (await cur.fetchone())["id"]
    key = f"uploads/rasters/{uid}/source{formats.ext(body.filename)}"
    mp = await storage.run(storage.internal.create_multipart_upload, Bucket=settings.s3_bucket, Key=key, ContentType=formats.RASTER[formats.ext(body.filename)])
    await conn.execute("UPDATE dataset_uploads SET source_key = %s, upload_id = %s WHERE id = %s", (key, mp["UploadId"], uid))
    return {"id": uid, "part_size": part_size,
            "parts": [{"part_number": i, "url": storage.presign_part(key, mp["UploadId"], i)} for i in range(1, n_parts + 1)]}


@router.post("/rasters/{upload_id}/complete", status_code=202, summary="The raster is uploaded: turn it into a dataset version")
async def complete_raster(upload_id: uuid.UUID, body: RasterCompleteIn, person=Depends(app_person), conn=Depends(get_conn)):
    u = await _upload(conn, upload_id, person)
    if u["status"] != "uploading":
        raise Problem(409, "This upload was already completed.", code="already_completed")
    parts = [{"PartNumber": p.part_number, "ETag": p.etag} for p in sorted(body.parts, key=lambda p: p.part_number)]
    try:
        await storage.run(storage.internal.complete_multipart_upload, Bucket=settings.s3_bucket, Key=u["source_key"],
                          UploadId=u["upload_id"], MultipartUpload={"Parts": parts})
    except ClientError as e:
        raise Problem(422, "Storage rejected the list of parts: check the part numbers and ETags.", code="upload_incomplete",
                      reason=e.response["Error"].get("Code")) from None
    dataset_id = u["dataset_id"]
    if not dataset_id:                                   # a new dataset: made now, with no version until the raster is ready
        m = u["meta"]
        slug = m.get("slug") or _slug(m["title"])
        cur = await conn.execute("SELECT 1 FROM datasets WHERE slug = %s", (slug,))
        if await cur.fetchone():
            raise Problem(409, "That address is taken: choose another.", code="slug_taken", fields={"slug": ["already in use"]})
        source = {"app": u["app"], "name": APP_NAMES.get(u["app"], u["app"]), "ref": m["ref"], "label": (m.get("label") or "").strip(), "kind": "raster"}
        cur = await conn.execute(
            "INSERT INTO datasets (slug, org_id, source, title, description, license, tags, visibility, statuses, created_by) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, '{approved}', %s) RETURNING id",
            (slug, u["org_id"], Jsonb(source), m["title"].strip(), (m.get("description") or "").strip(), m["license"],
             [t.lower()[:40] for t in m.get("tags") or []], m["visibility"], person["sub"]))
        dataset_id = (await cur.fetchone())["id"]
        await audit(conn, "dataset.publish", actor_id=person["sub"], target_type="dataset", target_id=dataset_id, slug=slug,
                    visibility=m["visibility"], app=u["app"], kind="raster")
    job = await create_job(conn, "raster_dataset", {"upload_id": str(upload_id)}, created_by=person["sub"])
    await conn.execute("UPDATE dataset_uploads SET status = 'processing', upload_id = NULL, dataset_id = %s, job_id = %s WHERE id = %s",
                       (dataset_id, job["id"], upload_id))
    await dispatch(conn, job)
    return await _upload_out(conn, await _upload(conn, upload_id, person))


@router.get("/rasters/{upload_id}", summary="How a raster's publishing is going")
async def raster_status(upload_id: uuid.UUID, person=Depends(app_person), conn=Depends(get_conn)):
    return await _upload_out(conn, await _upload(conn, upload_id, person))
