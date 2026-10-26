"""Feature writes. One entry point (`apply_change`) serves REST and /sync/push so both follow the same rules:

  * every write is validated against the feature's form version
  * writes carry base_version; if the server moved on we merge (different properties, no geometry
    change on either side) or return a conflict with both versions
  * the same (feature id, change_id) is applied once; retries return the stored result
  * deletes win over later edits until an admin restores the feature
  * ordering comes from the per-project sequence, never from client clocks
"""
import json

import psycopg
from psycopg.types.json import Jsonb

from ..audit import audit
from ..db import reserve_seq
from ..deps import RANK
from ..errors import Problem
from .forms import check_properties
from .geo import check_geometry

FEATURE_SELECT = (
    "f.id, f.project_id, f.form_id, f.form_version, ST_AsGeoJSON(f.geom, 7)::jsonb AS geometry, "
    "f.properties, f.status, f.version, f.seq, f.review_note, f.created_by, f.updated_by, "
    "f.created_at, f.updated_at, f.deleted_at")
FEATURE_KEYS = ["id", "project_id", "form_id", "form_version", "geometry", "properties", "status", "version",
                "seq", "review_note", "created_by", "updated_by", "created_at", "updated_at", "deleted_at"]


class Reject(Exception):
    def __init__(self, code: str, detail: str, fields: dict | None = None):
        self.code, self.detail, self.fields = code, detail, fields


def _json(o):
    return json.dumps(o, default=str)


def public_feature(row: dict) -> dict:
    return {k: row[k] for k in FEATURE_KEYS}


def _result(ch, status, **kw) -> dict:
    return {"status": status, "change_id": ch.get("change_id"), "id": ch["id"], "merged": False, **kw}


async def fetch_feature(conn, feature_id) -> dict | None:
    cur = await conn.execute(f"SELECT {FEATURE_SELECT} FROM features f WHERE f.id = %s", (feature_id,))
    return await cur.fetchone()


async def apply_change(conn, *, project_id, user_id, role: str, ch: dict, ip: str | None = None) -> dict:
    """Apply one create/update/delete. Never raises for bad input: returns applied, conflict or rejected."""
    try:
        async with conn.transaction():  # savepoint, so one bad change never poisons a batch
            return await _apply(conn, project_id, user_id, role, ch, ip)
    except Reject as r:
        return _result(ch, "rejected", code=r.code, detail=r.detail, fields=r.fields)
    except (psycopg.errors.InternalError_, psycopg.errors.DataException) as e:
        return _result(ch, "rejected", code="VALIDATION", detail=str(e).splitlines()[0],
                       fields={"geometry": ["could not be read as a valid geometry"]})


async def _apply(conn, project_id, user_id, role, ch, ip) -> dict:
    fid = ch["id"]
    await conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (str(fid),))
    if ch.get("change_id"):
        cur = await conn.execute("SELECT result FROM sync_changes WHERE feature_id = %s AND change_id = %s",
                                 (fid, ch["change_id"]))
        done = await cur.fetchone()
        if done:
            return done["result"]
    if RANK[role] < RANK["collector"]:
        raise Reject("FORBIDDEN", "Viewers cannot change features.")

    cur = await conn.execute(
        f"SELECT {FEATURE_SELECT}, f.geom::text AS geom_hex, f.client_updated_at FROM features f "
        "WHERE f.id = %s FOR UPDATE", (fid,))
    ex = await cur.fetchone()
    if ex and ex["project_id"] != project_id:
        raise Reject("NOT_FOUND", "Feature not found.")

    if ch["op"] == "create":
        if ex:
            raise Reject("ALREADY_EXISTS", "A feature with this id already exists.")
        res = await _create(conn, project_id, user_id, ch)
    else:
        if not ex:
            raise Reject("NOT_FOUND", "Feature not found.")
        if role == "collector" and ex["created_by"] != user_id:
            raise Reject("FORBIDDEN", "Collectors can change only their own features.")
        res = await (_delete if ch["op"] == "delete" else _update)(conn, project_id, user_id, ch, ex, ip)

    if ch.get("change_id") and res["status"] in ("applied", "conflict"):
        await conn.execute(
            "INSERT INTO sync_changes (feature_id, change_id, project_id, result) VALUES (%s, %s, %s, %s) "
            "ON CONFLICT DO NOTHING", (fid, ch["change_id"], project_id, Jsonb(res, dumps=_json)))
    return res


# ---------- helpers ----------
async def load_form_version(conn, project_id, form_id, version):
    cur = await conn.execute("SELECT version FROM forms WHERE id = %s AND project_id = %s", (form_id, project_id))
    form = await cur.fetchone()
    if not form:
        raise Reject("FORM_NOT_FOUND", "That form does not exist in this project.", {"form_id": ["unknown form"]})
    if form["version"] == 0:
        raise Reject("FORM_NOT_PUBLISHED", "Publish the form before collecting data with it.")
    v = version or form["version"]
    cur = await conn.execute("SELECT geometry_type, fields FROM form_versions WHERE form_id = %s AND version = %s",
                             (form_id, v))
    row = await cur.fetchone()
    if not row:
        raise Reject("FORM_VERSION_NOT_FOUND", f"Form version {v} does not exist.", {"form_version": ["unknown version"]})
    return row["geometry_type"], row["fields"], v


async def _validate(conn, gtype, fields, geometry, props, status, *, check_db: bool):
    errs: dict[str, list[str]] = {}
    g = check_geometry(gtype, geometry)
    if g:
        errs["geometry"] = [g]
    errs.update(check_properties(fields, props, enforce_required=status != "draft"))
    if errs:
        raise Reject("VALIDATION", "The feature does not match its form.", errs)
    if check_db:
        cur = await conn.execute(
            "SELECT ST_IsValid(g) AS ok, ST_IsEmpty(g) AS empty, ST_IsValidReason(g) AS why "
            "FROM (SELECT geom_from_json(%s) AS g) t", (json.dumps(geometry),))
        r = await cur.fetchone()
        if r["empty"] or not r["ok"]:
            raise Reject("VALIDATION", "The geometry is not valid.", {"geometry": [r["why"] or "empty geometry"]})


async def _history(conn, fid, action, user_id):
    await conn.execute(
        "INSERT INTO feature_versions (feature_id, version, geom, properties, status, deleted, action, changed_by) "
        "SELECT id, version, geom, properties, status, deleted_at IS NOT NULL, %s, %s FROM features WHERE id = %s",
        (action, user_id, fid))


async def _geom_differs(conn, a_hex: str, b_json: dict) -> bool:
    cur = await conn.execute("SELECT NOT geom_same(%s::geometry, geom_from_json(%s)) AS d", (a_hex, json.dumps(b_json)))
    return (await cur.fetchone())["d"]


async def _geom_differs_hex(conn, a_hex: str, b_hex: str) -> bool:
    cur = await conn.execute("SELECT NOT geom_same(%s::geometry, %s::geometry) AS d", (a_hex, b_hex))
    return (await cur.fetchone())["d"]


# ---------- create / update / delete ----------
async def _create(conn, project_id, user_id, ch) -> dict:
    if not ch.get("form_id"):
        raise Reject("VALIDATION", "form_id is required to create a feature.", {"form_id": ["required"]})
    gtype, fields, fver = await load_form_version(conn, project_id, ch["form_id"], ch.get("form_version"))
    status = ch.get("status") or "submitted"
    props = ch.get("properties") or {}
    await _validate(conn, gtype, fields, ch.get("geometry"), props, status, check_db=True)
    seq = await reserve_seq(conn, project_id)
    await conn.execute(
        "INSERT INTO features (id, project_id, form_id, form_version, geom, properties, status, version, seq, "
        "client_updated_at, created_by, updated_by) "
        "VALUES (%s, %s, %s, %s, geom_from_json(%s), %s, %s, 1, %s, %s, %s, %s)",
        (ch["id"], project_id, ch["form_id"], fver, json.dumps(ch["geometry"]), Jsonb(props), status, seq,
         ch.get("client_updated_at"), user_id, user_id))
    await _history(conn, ch["id"], "create", user_id)
    return _result(ch, "applied", version=1)


async def _delete(conn, project_id, user_id, ch, ex, ip) -> dict:
    if ex["deleted_at"]:
        return _result(ch, "applied", version=ex["version"])      # already gone: deletes are idempotent
    seq = await reserve_seq(conn, project_id)
    cur = await conn.execute(
        "UPDATE features SET deleted_at = now(), version = version + 1, seq = %s, updated_by = %s, updated_at = now(), "
        "client_updated_at = COALESCE(%s, client_updated_at) WHERE id = %s RETURNING version",
        (seq, user_id, ch.get("client_updated_at"), ch["id"]))
    v = (await cur.fetchone())["version"]
    await _history(conn, ch["id"], "delete", user_id)
    await audit(conn, "feature.delete", actor_id=user_id, project_id=project_id, target_type="feature",
                target_id=ch["id"], ip=ip)
    return _result(ch, "applied", version=v)


async def _update(conn, project_id, user_id, ch, ex, ip) -> dict:
    fid = ch["id"]
    if ex["deleted_at"]:
        raise Reject("FEATURE_DELETED", "This feature was deleted. Only an admin can restore it.")
    base_v, cur_v = ch.get("base_version") or 0, ex["version"]
    if base_v < 1 or base_v > cur_v:
        raise Reject("INVALID_BASE_VERSION", f"base_version must be between 1 and {cur_v}.",
                     {"base_version": [f"must be between 1 and {cur_v}"]})
    new_geom, new_props = ch.get("geometry"), ch.get("properties")
    merged = False

    if base_v == cur_v:
        props = new_props if new_props is not None else ex["properties"]
        geom_json = new_geom
    else:
        cur = await conn.execute("SELECT geom::text AS geom_hex, properties FROM feature_versions "
                                 "WHERE feature_id = %s AND version = %s", (fid, base_v))
        base = await cur.fetchone()
        client_view = {"base_version": base_v, "geometry": new_geom, "properties": new_props, "status": ch.get("status")}
        conflict = _result(ch, "conflict", version=cur_v, code="CONFLICT", client=client_view,
                           detail="The feature changed on the server. Choose which version to keep.",
                           server=public_feature(ex))
        if not base:
            return conflict
        bp, sp = base["properties"] or {}, ex["properties"]
        cp = new_props if new_props is not None else bp
        client_changed = {k for k in bp.keys() | cp.keys() if bp.get(k) != cp.get(k)}
        server_changed = {k for k in bp.keys() | sp.keys() if bp.get(k) != sp.get(k)}
        client_geom = new_geom is not None and await _geom_differs(conn, base["geom_hex"], new_geom)
        if client_changed or client_geom:
            server_geom = await _geom_differs_hex(conn, base["geom_hex"], ex["geom_hex"])
            overlap = {k for k in client_changed & server_changed if cp.get(k) != sp.get(k)}
            if overlap or client_geom or server_geom:
                return conflict
        props = dict(sp)
        for k in client_changed:
            props.pop(k, None) if k not in cp else props.__setitem__(k, cp[k])
        geom_json, merged = None, bool(client_changed)

    status = ch.get("status") or ex["status"]
    geom_changed = geom_json is not None and await _geom_differs(conn, ex["geom_hex"], geom_json)
    content_changed = props != ex["properties"] or geom_changed
    if content_changed and not ch.get("status") and ex["status"] in ("approved", "rejected"):
        status = "submitted"                                     # edited after review: needs a fresh review

    fver = ex["form_version"]
    if ch.get("form_version") and ch["form_version"] > fver:
        fver = ch["form_version"]
    if not content_changed and status == ex["status"] and fver == ex["form_version"]:
        return _result(ch, "applied", version=cur_v)             # nothing to write

    gtype, fields, fver = await load_form_version(conn, project_id, ex["form_id"], fver)
    await _validate(conn, gtype, fields, geom_json or ex["geometry"], props, status, check_db=geom_json is not None)

    seq = await reserve_seq(conn, project_id)
    cur = await conn.execute(
        "UPDATE features SET geom = COALESCE(geom_from_json(%s), geom), properties = %s, status = %s, "
        "form_version = %s, version = version + 1, seq = %s, updated_by = %s, updated_at = now(), "
        "client_updated_at = COALESCE(%s, client_updated_at), "
        "review_note = CASE WHEN %s THEN NULL ELSE review_note END WHERE id = %s RETURNING version",
        (json.dumps(geom_json) if geom_json else None, Jsonb(props), status, fver, seq, user_id,
         ch.get("client_updated_at"), status != ex["status"], fid))
    v = (await cur.fetchone())["version"]
    await _history(conn, fid, "merge" if merged else "update", user_id)
    return _result(ch, "applied", version=v, merged=merged)


# ---------- restore and review (REST only) ----------
async def restore_feature(conn, project_id, feature_id, user_id, ip) -> dict:
    cur = await conn.execute("SELECT project_id, deleted_at FROM features WHERE id = %s FOR UPDATE", (feature_id,))
    ex = await cur.fetchone()
    if not ex or ex["project_id"] != project_id:
        raise Problem(404, "Feature not found.", code="not_found")
    if not ex["deleted_at"]:
        raise Problem(409, "This feature is not deleted.", code="not_deleted")
    seq = await reserve_seq(conn, project_id)
    await conn.execute("UPDATE features SET deleted_at = NULL, version = version + 1, seq = %s, updated_by = %s, "
                       "updated_at = now() WHERE id = %s", (seq, user_id, feature_id))
    await _history(conn, feature_id, "restore", user_id)
    await audit(conn, "feature.restore", actor_id=user_id, project_id=project_id, target_type="feature",
                target_id=feature_id, ip=ip)
    return await fetch_feature(conn, feature_id)


async def review_feature(conn, project_id, feature_id, user_id, decision: str, note: str | None, ip) -> dict:
    cur = await conn.execute("SELECT project_id, status, deleted_at FROM features WHERE id = %s FOR UPDATE",
                             (feature_id,))
    ex = await cur.fetchone()
    if not ex or ex["project_id"] != project_id or ex["deleted_at"]:
        raise Problem(404, "Feature not found.", code="not_found")
    if ex["status"] == "draft":
        raise Problem(409, "Draft features have not been submitted for review.", code="not_submitted")
    seq = await reserve_seq(conn, project_id)
    await conn.execute(
        "UPDATE features SET status = %s, review_note = %s, reviewed_by = %s, reviewed_at = now(), "
        "version = version + 1, seq = %s, updated_by = %s, updated_at = now() WHERE id = %s",
        (decision, note, user_id, seq, user_id, feature_id))
    await _history(conn, feature_id, "review", user_id)
    await audit(conn, "feature.review", actor_id=user_id, project_id=project_id, target_type="feature",
                target_id=feature_id, ip=ip, decision=decision)
    return await fetch_feature(conn, feature_id)
