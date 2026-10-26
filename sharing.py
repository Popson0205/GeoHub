"""Share a form by link. Admins choose who may use the link; the link itself never changes unless they regenerate it."""
from uuid import UUID

from fastapi import APIRouter, Depends, Request

from ..audit import audit
from ..config import settings
from ..db import get_conn
from ..deps import RANK, current_user, optional_user, require_role, role_in
from ..errors import Problem
from ..logging_setup import client_ip
from ..ratelimit import limit
from .. import storage
from ..jobs import dispatch_photo
from ..schemas import (MediaCompleteIn, MediaOut, MediaUploadOut, PublicFormOut, PublicMediaIn, PublicSubmit, SharingOut,
                       SharingPatch)
from ..services.media import media_out
from .media import EXT, _kind, _limit, _media
from ..services import features as svc

router = APIRouter(tags=["sharing"])


async def _form(conn, form_id) -> dict:
    cur = await conn.execute("SELECT id, project_id, version, share_mode, share_token FROM forms WHERE id = %s", (form_id,))
    f = await cur.fetchone()
    if not f:
        raise Problem(404, "Form not found.", code="not_found")
    return f


def _out(f: dict) -> dict:
    return {"share_mode": f["share_mode"], "share_token": f["share_token"], "published": f["version"] > 0}


@router.get("/forms/{form_id}/sharing", response_model=SharingOut)
async def get_sharing(form_id: UUID, user=Depends(current_user), conn=Depends(get_conn)):
    f = await _form(conn, form_id)
    await require_role(conn, f["project_id"], user["id"], "admin")
    return _out(f)


@router.patch("/forms/{form_id}/sharing", response_model=SharingOut)
async def set_sharing(form_id: UUID, body: SharingPatch, request: Request, user=Depends(current_user),
                      conn=Depends(get_conn)):
    f = await _form(conn, form_id)
    await require_role(conn, f["project_id"], user["id"], "admin")
    if body.share_mode == "public" and f["version"] == 0:
        raise Problem(409, "Publish the form before making its link public.", code="form_not_published")
    cur = await conn.execute(
        "UPDATE forms SET share_mode = COALESCE(%s, share_mode), "
        "share_token = CASE WHEN %s THEN replace(gen_random_uuid()::text, '-', '') ELSE share_token END "
        "WHERE id = %s RETURNING id, project_id, version, share_mode, share_token",
        (body.share_mode, body.regenerate_link, form_id))
    out = await cur.fetchone()
    await audit(conn, "form.sharing", actor_id=user["id"], project_id=f["project_id"], target_type="form",
                target_id=form_id, ip=client_ip(request), share_mode=out["share_mode"], regenerated=body.regenerate_link)
    return _out(out)


async def _by_token(conn, token: str) -> dict:
    cur = await conn.execute(
        "SELECT f.id, f.project_id, f.share_mode, f.version, p.name AS project_name, v.name, v.geometry_type, v.fields "
        "FROM forms f JOIN projects p ON p.id = f.project_id "
        "JOIN form_versions v ON v.form_id = f.id AND v.version = f.version WHERE f.share_token = %s AND f.version > 0",
        (token,))
    row = await cur.fetchone()
    if not row:
        raise Problem(404, "This form link is not valid, or the form is not published.", code="not_found")
    return row


@router.get("/public/forms/{token}", response_model=PublicFormOut,
            dependencies=[Depends(limit("public_form", lambda: settings.rate_anon_read_per_min))])
async def public_form(token: str, user=Depends(optional_user), conn=Depends(get_conn)):
    """The form behind a link. Public links need no sign-in. Collaborator-only links need a signed-in collaborator."""
    f = await _by_token(conn, token)
    access = "public"
    if f["share_mode"] != "public":
        if not user:
            raise Problem(401, "Sign in to use this form.", code="unauthenticated")
        role = await role_in(conn, f["project_id"], user["id"])
        if not role or RANK[role] < RANK["collector"]:
            raise Problem(403, "You have not been added to this form. Ask its owner to add you as a collaborator.",
                          code="not_collaborator")
        access = "member"
    return {"token": token, "form_id": f["id"], "project_id": f["project_id"], "project_name": f["project_name"],
            "name": f["name"], "geometry_type": f["geometry_type"], "version": f["version"], "fields": f["fields"],
            "access": access}


@router.post("/public/forms/{token}/submissions", status_code=201,
             dependencies=[Depends(limit("public_submit", lambda: settings.rate_public_submit_per_hour, 3600))])
async def public_submit(token: str, body: PublicSubmit, request: Request, conn=Depends(get_conn)):
    """Anonymous submission. Only works while the link is public; the result waits in the project for review."""
    f = await _by_token(conn, token)
    if f["share_mode"] != "public":
        raise Problem(403, "This form is not public.", code="not_public")
    res = await svc.apply_change(
        conn, project_id=f["project_id"], user_id=None, role="collector", ip=client_ip(request),
        ch={"id": body.id, "op": "create", "base_version": 0, "form_id": f["id"], "form_version": f["version"],
            "geometry": body.geometry.model_dump(), "properties": body.properties, "status": "submitted"})
    if res["status"] == "rejected" and res.get("code") == "ALREADY_EXISTS":
        return {"id": str(body.id), "received": True}          # a retry of a submission that already arrived
    if res["status"] != "applied":
        raise Problem(422, res.get("detail") or "The answers do not match the form.", code="validation",
                      fields=res.get("fields"))
    return {"id": str(body.id), "received": True}


@router.post("/public/forms/{token}/media/upload-url", response_model=MediaUploadOut,
             dependencies=[Depends(limit("public_media", lambda: settings.rate_public_submit_per_hour * 5, 3600))])
async def public_upload_url(token: str, body: PublicMediaIn, conn=Depends(get_conn)):
    """A photo, recording or file for an anonymous submission. Same flow as signed-in collectors: upload, then complete."""
    f = await _by_token(conn, token)
    if f["share_mode"] != "public":
        raise Problem(403, "This form is not public.", code="not_public")
    if body.content_type not in EXT:
        raise Problem(422, "This type of file is not accepted.", code="validation")
    lim = _limit(body.content_type)
    if body.size > lim:
        raise Problem(413, f"Files are limited to {lim // 1024 // 1024} MB.", code="too_large")
    key = f"media/{f['project_id']}/{body.id}/original.{EXT[body.content_type]}"
    await conn.execute(
        "INSERT INTO media (id, project_id, kind, content_type, storage_key, size, created_by) "
        "VALUES (%s, %s, %s, %s, %s, %s, NULL) ON CONFLICT (id) DO NOTHING",
        (body.id, f["project_id"], _kind(body.content_type), body.content_type, key, body.size))
    m = await _media(conn, body.id)
    if m["project_id"] != f["project_id"] or m["created_by"] is not None:
        raise Problem(409, "That media id is already in use.", code="id_in_use")
    if m["status"] in ("uploaded", "ready"):
        raise Problem(409, "This file was already uploaded.", code="already_uploaded")
    return {"id": body.id, "upload_url": storage.presign_put(m["storage_key"], m["content_type"]),
            "headers": {"Content-Type": m["content_type"]}, "max_bytes": lim}


@router.post("/public/forms/{token}/media/{media_id}/complete", response_model=MediaOut,
             dependencies=[Depends(limit("public_media_done", lambda: settings.rate_public_submit_per_hour * 5, 3600))])
async def public_media_complete(token: str, media_id: UUID, body: MediaCompleteIn, conn=Depends(get_conn)):
    f = await _by_token(conn, token)
    if f["share_mode"] != "public":
        raise Problem(403, "This form is not public.", code="not_public")
    m = await _media(conn, media_id)
    cur = await conn.execute("SELECT project_id, created_by FROM features WHERE id = %s AND deleted_at IS NULL",
                             (body.feature_id,))
    feat = await cur.fetchone()
    if m["project_id"] != f["project_id"] or m["created_by"] is not None:
        raise Problem(404, "Media not found.", code="not_found")
    if not feat or feat["project_id"] != f["project_id"] or feat["created_by"] is not None:
        raise Problem(409, "Feature not found. Send the record before completing its file.", code="feature_not_synced")
    head = await storage.run(storage.head, m["storage_key"])
    if not head:
        raise Problem(409, "The file has not been uploaded yet.", code="upload_missing")
    if head["ContentLength"] > _limit(m["content_type"]):
        await storage.run(storage.delete_keys, m["storage_key"])
        await conn.execute("DELETE FROM media WHERE id = %s", (media_id,))
        await conn.commit()
        raise Problem(413, "The uploaded file is over the size limit and was removed.", code="too_large")
    await conn.execute(
        "UPDATE media SET feature_id = %s, field_id = %s, width = COALESCE(%s, width), height = COALESCE(%s, height), "
        "size = %s, status = CASE WHEN status = 'ready' THEN status ELSE 'uploaded' END, uploaded_at = now() "
        "WHERE id = %s", (body.feature_id, body.field_id, body.width, body.height, head["ContentLength"], media_id))
    await conn.commit()
    if m["kind"] == "photo":
        await dispatch_photo(str(media_id))
    else:
        await conn.execute("UPDATE media SET status = 'ready' WHERE id = %s", (media_id,))
        await conn.commit()
    return media_out(await _media(conn, media_id))
