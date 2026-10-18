import json
from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, Query, Request, Response, UploadFile

from .. import formats, storage
from ..audit import audit
from ..config import settings
from ..db import get_conn
from ..deps import current_user, require_role
from ..errors import Problem
from ..jobs import create_job, dispatch
from ..logging_setup import client_ip
from ..pagination import Page, decode_cursor, encode_cursor
from ..schemas import (FeatureCreate, FeatureOut, FeaturePatch, FeatureVersionOut, JobOut, ReviewIn)
from ..services import features as svc
from ..services.media import media_for_feature

router = APIRouter(tags=["features"])

HTTP_FOR = {"FORBIDDEN": 403, "NOT_FOUND": 404, "ALREADY_EXISTS": 409, "FEATURE_DELETED": 409,
            "FORM_NOT_PUBLISHED": 409, "VALIDATION": 422}


def raise_for(res: dict):
    if res["status"] == "conflict":
        raise Problem(409, res["detail"], code="conflict", server=res["server"], client=res["client"])
    code = res.get("code") or "VALIDATION"
    raise Problem(HTTP_FOR.get(code, 422), res.get("detail"), code=code.lower(), fields=res.get("fields"))


async def _feature_project(conn, feature_id) -> UUID:
    cur = await conn.execute("SELECT project_id FROM features WHERE id = %s", (feature_id,))
    row = await cur.fetchone()
    if not row:
        raise Problem(404, "Feature not found.", code="not_found")
    return row["project_id"]


@router.get("/projects/{project_id}/features", response_model=Page[FeatureOut])
async def list_features(
        project_id: UUID, bbox: str | None = Query(None, description="minx,miny,maxx,maxy (EPSG:4326)"),
        status: str | None = Query(None, pattern="^(draft|submitted|approved|rejected)$"),
        form_id: UUID | None = None, updated_since: datetime | None = None,
        include_deleted: bool = Query(False, description="Admins only"),
        limit: int = Query(100, ge=1, le=1000), cursor: str | None = None,
        user=Depends(current_user), conn=Depends(get_conn)):
    await require_role(conn, project_id, user["id"])
    where, params = ["f.project_id = %s", "f.seq > %s"], [project_id, decode_cursor(cursor).get("s", 0)]
    if include_deleted:
        await require_role(conn, project_id, user["id"], "admin")
    else:
        where.append("f.deleted_at IS NULL")
    if bbox:
        try:
            minx, miny, maxx, maxy = (float(v) for v in bbox.split(","))
        except ValueError:
            raise Problem(422, "bbox must be minx,miny,maxx,maxy", code="validation", fields={"bbox": ["invalid"]})
        where.append("f.geom && ST_MakeEnvelope(%s, %s, %s, %s, 4326)")
        params += [minx, miny, maxx, maxy]
    if status:
        where.append("f.status = %s"); params.append(status)
    if form_id:
        where.append("f.form_id = %s"); params.append(form_id)
    if updated_since:
        where.append("f.updated_at > %s"); params.append(updated_since)
    cur = await conn.execute(f"SELECT {svc.FEATURE_SELECT} FROM features f WHERE {' AND '.join(where)} "
                             "ORDER BY f.seq LIMIT %s", (*params, limit + 1))
    rows = await cur.fetchall()
    more = len(rows) > limit
    rows = rows[:limit]
    return {"items": rows, "next_cursor": encode_cursor(s=rows[-1]["seq"]) if more else None}


@router.get("/features/{feature_id}", response_model=FeatureOut)
async def get_feature(feature_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    pid = await _feature_project(conn, feature_id)
    role = await require_role(conn, pid, user["id"])
    f = await svc.fetch_feature(conn, feature_id)
    if f["deleted_at"] and role not in ("admin", "owner"):
        raise Problem(404, "Feature not found.", code="not_found")
    return {**f, "media": await media_for_feature(conn, feature_id)}


@router.post("/projects/{project_id}/features", response_model=FeatureOut, status_code=201)
async def create_feature(project_id: UUID, body: FeatureCreate, request: Request,
                         user=Depends(current_user), conn=Depends(get_conn)):
    role = await require_role(conn, project_id, user["id"], "collector")
    res = await svc.apply_change(conn, project_id=project_id, user_id=user["id"], role=role, ip=client_ip(request),
                                 ch={**body.model_dump(), "op": "create", "base_version": 0})
    if res["status"] != "applied":
        raise_for(res)
    return await svc.fetch_feature(conn, body.id)


@router.patch("/features/{feature_id}", response_model=FeatureOut)
async def update_feature(feature_id: UUID, body: FeaturePatch, request: Request,
                         user=Depends(current_user), conn=Depends(get_conn)):
    """409 `conflict` responses carry `server` and `client` so the app can offer a choice."""
    pid = await _feature_project(conn, feature_id)
    role = await require_role(conn, pid, user["id"], "collector")
    res = await svc.apply_change(conn, project_id=pid, user_id=user["id"], role=role, ip=client_ip(request),
                                 ch={**body.model_dump(), "id": feature_id, "op": "update"})
    if res["status"] != "applied":
        raise_for(res)
    return await svc.fetch_feature(conn, feature_id)


@router.delete("/features/{feature_id}", status_code=204)
async def delete_feature(feature_id: UUID, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    pid = await _feature_project(conn, feature_id)
    role = await require_role(conn, pid, user["id"], "collector")
    res = await svc.apply_change(conn, project_id=pid, user_id=user["id"], role=role, ip=client_ip(request),
                                 ch={"id": feature_id, "op": "delete", "base_version": 0})
    if res["status"] != "applied":
        raise_for(res)
    return Response(status_code=204)


@router.post("/features/{feature_id}/restore", response_model=FeatureOut)
async def restore_feature(feature_id: UUID, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    pid = await _feature_project(conn, feature_id)
    await require_role(conn, pid, user["id"], "admin")
    return await svc.restore_feature(conn, pid, feature_id, user["id"], client_ip(request))


@router.get("/features/{feature_id}/history", response_model=Page[FeatureVersionOut])
async def feature_history(feature_id: UUID, limit: int = Query(50, ge=1, le=200), cursor: str | None = None,
                          user=Depends(current_user), conn=Depends(get_conn)):
    pid = await _feature_project(conn, feature_id)
    await require_role(conn, pid, user["id"])
    before = decode_cursor(cursor).get("v")
    cur = await conn.execute(
        "SELECT h.version, ST_AsGeoJSON(h.geom, 7)::jsonb AS geometry, h.properties, h.status, h.deleted, h.action, "
        "h.changed_by, u.name AS changed_by_name, h.changed_at FROM feature_versions h "
        "LEFT JOIN users u ON u.id = h.changed_by "
        "WHERE h.feature_id = %s AND (%s::int IS NULL OR h.version < %s) ORDER BY h.version DESC LIMIT %s",
        (feature_id, before, before, limit + 1))
    rows = await cur.fetchall()
    more = len(rows) > limit
    rows = rows[:limit]
    return {"items": rows, "next_cursor": encode_cursor(v=rows[-1]["version"]) if more else None}


@router.post("/features/{feature_id}/review", response_model=FeatureOut)
async def review(feature_id: UUID, body: ReviewIn, request: Request, user=Depends(current_user),
                 conn=Depends(get_conn)):
    pid = await _feature_project(conn, feature_id)
    await require_role(conn, pid, user["id"], "admin")
    return await svc.review_feature(conn, pid, feature_id, user["id"], body.decision, body.note, client_ip(request))


@router.post("/projects/{project_id}/import", response_model=JobOut, status_code=202)
async def import_features(
        project_id: UUID, request: Request,
        file: UploadFile = File(..., description="GeoJSON (.geojson/.json), CSV, KML, GPX, GeoPackage, GML or a zipped Shapefile (.zip)"),
        form_id: UUID = Form(...),
        mapping: str = Form("{}", description='JSON object: source column/property -> form field id'),
        lon_column: str | None = Form(None), lat_column: str | None = Form(None),
        wkt_column: str | None = Form(None),
        status: str = Form("submitted", pattern="^(draft|submitted|approved)$"),
        user=Depends(current_user), conn=Depends(get_conn)):
    """Bulk import (for example output from KoboToolbox, ODK or QField). Rows are validated against the form;
    bad rows are reported in the job result and good rows are kept."""
    role = await require_role(conn, project_id, user["id"], "admin")
    name = (file.filename or "").lower()
    kind = formats.vector_kind(name)
    if not kind:
        hint = " Images (JPEG, PNG, GeoTIFF...) go to the imagery upload instead." if formats.is_raster(name) else ""
        raise Problem(422, f"Unsupported file type. Accepted: {formats.VECTOR_LIST}.{hint}", code="unsupported_format")
    data = await file.read(settings.max_import_mb * 1024 * 1024 + 1)
    if len(data) > settings.max_import_mb * 1024 * 1024:
        raise Problem(413, f"Import files are limited to {settings.max_import_mb} MB.", code="too_large")
    try:
        mp = json.loads(mapping)
        assert isinstance(mp, dict)
    except Exception:  # noqa: BLE001
        raise Problem(422, "mapping must be a JSON object.", code="validation", fields={"mapping": ["invalid"]})
    if kind == "csv" and not (wkt_column or (lon_column and lat_column)):
        raise Problem(422, "CSV imports need lon_column and lat_column, or wkt_column.", code="validation",
                      fields={"lon_column": ["required with lat_column, or give wkt_column"]})
    cur = await conn.execute("SELECT version FROM forms WHERE id = %s AND project_id = %s", (form_id, project_id))
    form = await cur.fetchone()
    if not form:
        raise Problem(404, "Form not found in this project.", code="not_found")
    if form["version"] == 0:
        raise Problem(409, "Publish the form before importing into it.", code="form_not_published")
    if status == "approved" and role not in ("admin", "owner"):
        raise Problem(403, "Only admins can import approved features.", code="forbidden")
    key = (f"imports/{project_id}/{form_id}/{user['id']}/{datetime.utcnow():%Y%m%dT%H%M%S}-{kind}"
           f"{formats.ext(name) if kind == 'ogr' else ''}")
    await storage.run(storage.internal.put_object, Bucket=settings.s3_bucket, Key=key, Body=data)
    job = await create_job(conn, "import", {
        "kind": kind, "source_key": key, "form_id": str(form_id), "mapping": mp, "lon_column": lon_column,
        "lat_column": lat_column, "wkt_column": wkt_column, "status": status},
        project_id=project_id, created_by=user["id"])
    await audit(conn, "features.import", actor_id=user["id"], project_id=project_id, target_type="form",
                target_id=form_id, ip=client_ip(request), file=file.filename)
    await dispatch(conn, job)
    cur = await conn.execute("SELECT * FROM jobs WHERE id = %s", (job["id"],))
    return await cur.fetchone()
