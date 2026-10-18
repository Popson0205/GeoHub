import math
from uuid import UUID

from botocore.exceptions import ClientError
from psycopg.types.json import Jsonb
from fastapi import APIRouter, Depends, Query, Request, Response

from .. import formats, storage
from ..audit import audit
from ..config import settings
from ..db import get_conn
from ..deps import current_user, require_role
from ..errors import Problem
from ..jobs import create_job, dispatch
from ..logging_setup import client_ip
from ..pagination import Page, decode_cursor, page_from_offset
from ..schemas import ImageryCompleteIn, ImageryIn, ImageryOut, ImageryUploadOut

router = APIRouter(tags=["imagery"])
MB = 1024 * 1024


def _out(r: dict, job_id=None) -> dict:
    ready = r["status"] == "ready"
    return {**r, "job_id": job_id,
            "tiles_url": f"{settings.public_base_url}/tiles/imagery/{r['id']}/{{z}}/{{x}}/{{y}}.png" if ready else None}


async def _load(conn, imagery_id) -> dict:
    cur = await conn.execute("SELECT * FROM imagery_assets WHERE id = %s", (imagery_id,))
    a = await cur.fetchone()
    if not a:
        raise Problem(404, "Imagery not found.", code="not_found")
    return a


@router.post("/projects/{project_id}/imagery", response_model=ImageryUploadOut, status_code=201)
async def start_upload(project_id: UUID, body: ImageryIn, user=Depends(current_user), conn=Depends(get_conn)):
    """Returns presigned multipart URLs. PUT each part straight to storage, collect the ETag response
    headers, then call /imagery/{id}/complete."""
    await require_role(conn, project_id, user["id"], "admin")
    if formats.vector_kind(body.filename):
        raise Problem(422, "This is map data (points, lines, areas), not an image. Import it into a form with "
                           "POST /projects/{id}/import instead.", code="use_import",
                      fields={"filename": ["vector files are imported as features, not imagery"]})
    if not formats.is_raster(body.filename):
        raise Problem(422, f"Unsupported image type. Accepted: {formats.RASTER_LIST}.", code="unsupported_format",
                      fields={"filename": [f"must end in one of {formats.RASTER_LIST}"]})
    hint = None
    if body.bounds:
        w, s, e, n = body.bounds
        if not (w < e and s < n) or (body.crs == "EPSG:4326" and not (-180 <= w and e <= 180 and -90 <= s and n <= 90)):
            raise Problem(422, "bounds must be [west, south, east, north] with west < east and south < north.",
                          code="validation", fields={"bounds": ["invalid"]})
        hint = {"bounds": body.bounds, "crs": body.crs}
    if body.size > settings.max_imagery_bytes:
        raise Problem(413, f"Imagery uploads are limited to {settings.max_imagery_bytes // 1024**3} GB.", code="too_large")
    part_size = max(64 * MB, math.ceil(body.size / 9000 / MB) * MB)
    n_parts = math.ceil(body.size / part_size)
    cur = await conn.execute("INSERT INTO imagery_assets (project_id, name, source_key, size, created_by, georef_hint) "
                             "VALUES (%s, %s, 'pending', %s, %s, %s) RETURNING id",
                             (project_id, body.name, body.size, user["id"], Jsonb(hint) if hint else None))
    iid = (await cur.fetchone())["id"]
    ext = formats.ext(body.filename)
    key = f"imagery/{project_id}/{iid}/source{ext}"
    mp = await storage.run(storage.internal.create_multipart_upload, Bucket=settings.s3_bucket, Key=key,
                           ContentType=formats.RASTER[ext])
    await conn.execute("UPDATE imagery_assets SET source_key = %s, upload_id = %s WHERE id = %s",
                       (key, mp["UploadId"], iid))
    return {"id": iid, "upload_id": mp["UploadId"], "part_size": part_size,
            "parts": [{"part_number": i, "url": storage.presign_part(key, mp["UploadId"], i)}
                      for i in range(1, n_parts + 1)]}


@router.post("/imagery/{imagery_id}/complete", response_model=ImageryOut, status_code=202)
async def complete(imagery_id: UUID, body: ImageryCompleteIn, user=Depends(current_user), conn=Depends(get_conn)):
    a = await _load(conn, imagery_id)
    await require_role(conn, a["project_id"], user["id"], "admin")
    if a["status"] != "uploading":
        raise Problem(409, "This upload was already completed.", code="already_completed")
    parts = [{"PartNumber": p.part_number, "ETag": p.etag} for p in sorted(body.parts, key=lambda p: p.part_number)]
    try:
        await storage.run(storage.internal.complete_multipart_upload, Bucket=settings.s3_bucket, Key=a["source_key"],
                          UploadId=a["upload_id"], MultipartUpload={"Parts": parts})
    except ClientError as e:
        raise Problem(422, "Storage rejected the list of parts. Check the part numbers and ETags.",
                      code="upload_incomplete", reason=e.response["Error"].get("Code"))
    await conn.execute("UPDATE imagery_assets SET status = 'processing', upload_id = NULL WHERE id = %s", (imagery_id,))
    job = await create_job(conn, "imagery_convert", {"imagery_id": str(imagery_id)}, project_id=a["project_id"],
                           created_by=user["id"])
    await dispatch(conn, job)
    return _out(await _load(conn, imagery_id), job["id"])


@router.get("/projects/{project_id}/imagery", response_model=Page[ImageryOut])
async def list_imagery(project_id: UUID, limit: int = Query(50, ge=1, le=200), cursor: str | None = None,
                       user=Depends(current_user), conn=Depends(get_conn)):
    await require_role(conn, project_id, user["id"])
    off = decode_cursor(cursor).get("o", 0)
    cur = await conn.execute("SELECT * FROM imagery_assets WHERE project_id = %s ORDER BY created_at DESC, id "
                             "LIMIT %s OFFSET %s", (project_id, limit + 1, off))
    rows, nxt = page_from_offset(await cur.fetchall(), limit, off)
    return {"items": [_out(r) for r in rows], "next_cursor": nxt}


@router.get("/imagery/{imagery_id}", response_model=ImageryOut)
async def get_imagery(imagery_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    a = await _load(conn, imagery_id)
    await require_role(conn, a["project_id"], user["id"])
    return _out(a)


@router.delete("/imagery/{imagery_id}", status_code=204)
async def delete_imagery(imagery_id: UUID, request: Request, user=Depends(current_user), conn=Depends(get_conn)):
    a = await _load(conn, imagery_id)
    await require_role(conn, a["project_id"], user["id"], "admin")
    if a["status"] == "uploading" and a["upload_id"]:
        try:
            await storage.run(storage.internal.abort_multipart_upload, Bucket=settings.s3_bucket, Key=a["source_key"],
                              UploadId=a["upload_id"])
        except ClientError:
            pass
    await conn.execute("DELETE FROM imagery_assets WHERE id = %s", (imagery_id,))
    await storage.run(storage.delete_keys, a["source_key"], a["storage_key"])
    await audit(conn, "imagery.delete", actor_id=user["id"], project_id=a["project_id"], target_type="imagery",
                target_id=imagery_id, ip=client_ip(request), name=a["name"])
    return Response(status_code=204)
