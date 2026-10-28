from .. import storage


async def media_for_feature(conn, feature_id) -> list[dict]:
    cur = await conn.execute(
        "SELECT id, feature_id, field_id, kind, status, width, height, size, storage_key, web_key FROM media "
        "WHERE feature_id = %s AND status IN ('uploaded','ready') ORDER BY created_at", (feature_id,))
    return [media_out(r) for r in await cur.fetchall()]


def media_out(r: dict) -> dict:
    orig = storage.presign_get(r["storage_key"]) if r["storage_key"] else None
    web = storage.presign_get(r["web_key"]) if r.get("web_key") else None
    return {"id": r["id"], "feature_id": r["feature_id"], "field_id": r["field_id"], "kind": r["kind"],
            "status": r["status"], "width": r["width"], "height": r["height"], "size": r["size"],
            "url": web or orig, "original_url": orig}
