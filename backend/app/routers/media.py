from uuid import UUID

from fastapi import APIRouter, Depends, Response

from .. import storage
from ..config import settings
from ..db import get_conn
from ..deps import current_user, require_role
from ..errors import Problem
from ..jobs import dispatch_photo
from ..schemas import MediaCompleteIn, MediaOut, MediaUploadIn, MediaUploadOut
from ..services.media import media_out

router = APIRouter(tags=["media"])
EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}


async def _media(conn, media_id) -> dict:
    cur = await conn.execute("SELECT * FROM media WHERE id = %s", (media_id,))
    m = await cur.fetchone()
    if not m:
        raise Problem(404, "Media not found.", code="not_found")
    return m


@router.post("/media/upload-url", response_model=MediaUploadOut)
async def upload_url(body: MediaUploadIn, user=Depends(current_user), conn=Depends(get_conn)):
    """Photos upload separately from their feature, so a feature never waits for its photos. Calling this
    again with the same id returns a fresh URL (use it to resume after a dropped connection)."""
    await require_role(conn, body.project_id, user["id"], "collector")
    if body.size > settings.max_photo_bytes:
        raise Problem(413, f"Photos are limited to {settings.max_photo_bytes // 1024 // 1024} MB.", code="too_large")
    key = f"media/{body.project_id}/{body.id}/original.{EXT[body.content_type]}"
    await conn.execute(
        "INSERT INTO media (id, project_id, content_type, storage_key, size, created_by) "
        "VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (id) DO NOTHING",
        (body.id, body.project_id, body.content_type, key, body.size, user["id"]))
    m = await _media(conn, body.id)
    if m["project_id"] != body.project_id or m["created_by"] != user["id"]:
        raise Problem(409, "That media id is already in use.", code="id_in_use")
    if m["status"] in ("uploaded", "ready"):
        raise Problem(409, "This photo was already uploaded.", code="already_uploaded")
    return {"id": body.id, "upload_url": storage.presign_put(m["storage_key"], m["content_type"]),
            "headers": {"Content-Type": m["content_type"]}, "max_bytes": settings.max_photo_bytes}


@router.post("/media/{media_id}/complete", response_model=MediaOut)
async def complete(media_id: UUID, body: MediaCompleteIn, user=Depends(current_user), conn=Depends(get_conn)):
    m = await _media(conn, media_id)
    role = await require_role(conn, m["project_id"], user["id"], "collector")
    cur = await conn.execute("SELECT project_id, created_by FROM features WHERE id = %s AND deleted_at IS NULL",
                             (body.feature_id,))
    f = await cur.fetchone()
    if not f or f["project_id"] != m["project_id"]:
        raise Problem(409, "Feature not found. Sync the feature before completing its photo.",
                      code="feature_not_synced")
    if role == "collector" and f["created_by"] != user["id"]:
        raise Problem(403, "Collectors can attach photos only to their own features.", code="forbidden")
    head = await storage.run(storage.head, m["storage_key"])
    if not head:
        raise Problem(409, "The file has not been uploaded yet.", code="upload_missing")
    if head["ContentLength"] > settings.max_photo_bytes:
        await storage.run(storage.delete_keys, m["storage_key"])
        await conn.execute("DELETE FROM media WHERE id = %s", (media_id,))
        await conn.commit()
        raise Problem(413, "The uploaded file is over the size limit and was removed.", code="too_large")
    await conn.execute(
        "UPDATE media SET feature_id = %s, field_id = %s, width = COALESCE(%s, width), height = COALESCE(%s, height), "
        "size = %s, status = CASE WHEN status = 'ready' THEN status ELSE 'uploaded' END, uploaded_at = now() "
        "WHERE id = %s", (body.feature_id, body.field_id, body.width, body.height, head["ContentLength"], media_id))
    await conn.commit()
    await dispatch_photo(str(media_id))          # resize in the worker; the original is always kept
    return media_out(await _media(conn, media_id))


@router.get("/media/{media_id}", response_model=MediaOut)
async def get_media(media_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    m = await _media(conn, media_id)
    await require_role(conn, m["project_id"], user["id"])
    return media_out(m)


@router.delete("/media/{media_id}", status_code=204)
async def delete_media(media_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    m = await _media(conn, media_id)
    role = await require_role(conn, m["project_id"], user["id"], "collector")
    if role == "collector" and m["created_by"] != user["id"]:
        raise Problem(403, "Collectors can delete only their own photos.", code="forbidden")
    await conn.execute("DELETE FROM media WHERE id = %s", (media_id,))
    await storage.run(storage.delete_keys, m["storage_key"], m["web_key"])
    return Response(status_code=204)
