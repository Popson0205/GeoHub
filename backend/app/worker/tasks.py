"""Background work, run by `rq worker default` (or inline when JOBS_INLINE=true).

Job kinds: imagery_convert, snapshot, export, import. Plus process_photo (no job row)."""
import csv
import json
import logging
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path
from uuid import uuid4

from psycopg.types.json import Jsonb

from .. import formats, storage
from ..config import settings
from ..db import connect_sync
from ..services.forms import check_properties
from ..services.geo import check_geometry

log = logging.getLogger("worker")
B = settings.s3_bucket


class JobFailed(Exception):
    """A failure whose message is safe to show to the user."""
    def __init__(self, message: str, code: str = "failed", result: dict | None = None):
        super().__init__(message)
        self.code, self.result = code, result


def _progress(conn, job_id, pct: int):
    conn.execute("UPDATE jobs SET progress = %s, updated_at = now() WHERE id = %s", (pct, job_id))
    conn.commit()


def run_job(job_id: str):
    with connect_sync() as conn:
        job = conn.execute("UPDATE jobs SET status = 'running', updated_at = now() "
                           "WHERE id = %s AND status = 'queued' RETURNING *", (job_id,)).fetchone()
        conn.commit()
        if not job:
            return
        try:
            result = HANDLERS[job["kind"]](conn, job)
            conn.execute("UPDATE jobs SET status = 'done', progress = 100, result = %s, updated_at = now() WHERE id = %s",
                         (Jsonb(result), job_id))
        except JobFailed as e:
            conn.rollback()
            conn.execute("UPDATE jobs SET status = 'failed', error = %s, result = %s, updated_at = now() WHERE id = %s",
                         (str(e), Jsonb(e.result) if e.result else None, job_id))
        except Exception:  # noqa: BLE001
            log.exception("job %s failed", job_id)
            conn.rollback()
            conn.execute("UPDATE jobs SET status = 'failed', error = %s, updated_at = now() WHERE id = %s",
                         ("Unexpected error while processing. Please try again or contact support.", job_id))
        conn.commit()


def _run(cmd: list[str]) -> str:
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"{cmd[0]} failed: {p.stderr.strip()[:400]}")
    return p.stdout


# ======================================================================== imagery
def imagery_convert(conn, job) -> dict:
    iid = job["params"]["imagery_id"]
    a = conn.execute("SELECT * FROM imagery_assets WHERE id = %s", (iid,)).fetchone()
    try:
        with tempfile.TemporaryDirectory() as d:
            src, out = Path(d) / f"source{Path(a['source_key']).suffix or '.tif'}", Path(d) / "cog.tif"
            storage.internal.download_file(B, a["source_key"], str(src))
            _progress(conn, job["id"], 15)
            try:
                info = json.loads(_run(["gdalinfo", "-json", str(src)]))
            except RuntimeError:
                raise JobFailed("This file could not be read as an image. Check that it is not damaged, and that it is "
                                "one of: " + formats.RASTER_LIST + ".", "not_a_raster")
            if not (info.get("coordinateSystem") or {}).get("wkt"):
                hint = a.get("georef_hint")
                if not hint:
                    raise JobFailed("This file has no georeference (no coordinate system), so it cannot be placed on the "
                                    "map. Either export it from your GIS or photogrammetry software as a GeoTIFF with "
                                    "coordinates, or upload it again and enter the image's bounds "
                                    "(west, south, east, north).", "no_georeference")
                # Plain JPEG/PNG etc.: stamp the user-supplied bounds onto the image.
                w, s, e, n = hint["bounds"]
                placed = Path(d) / "placed.tif"
                _run(["gdal_translate", "-of", "GTiff", "-a_srs", hint["crs"], "-a_ullr", str(w), str(n), str(e), str(s),
                      str(src), str(placed)])
                src = placed
                info = json.loads(_run(["gdalinfo", "-json", str(src)]))
            ext = info.get("wgs84Extent", {}).get("coordinates", [[]])[0]
            if not ext:
                raise JobFailed("The image footprint could not be worked out from its coordinates.", "bad_extent")
            bounds = [min(p[0] for p in ext), min(p[1] for p in ext), max(p[0] for p in ext), max(p[1] for p in ext)]
            wkt = info["coordinateSystem"]["wkt"]
            epsg = (info.get("stac") or {}).get("proj:epsg")
            m = re.match(r'\s*(?:PROJCRS|GEOGCRS|PROJCS|GEOGCS)\["([^"]+)"', wkt)
            crs = f"EPSG:{epsg}" if epsg else (m.group(1) if m else "unknown")
            _run(["gdal_translate", "-of", "COG", "-co", "COMPRESS=DEFLATE", "-co", "OVERVIEWS=AUTO",
                  "-co", "BIGTIFF=IF_SAFER", "-co", "NUM_THREADS=ALL_CPUS", str(src), str(out)])
            _progress(conn, job["id"], 70)
            key = f"imagery/{a['project_id'] or a['map_id']}/{iid}/cog.tif"
            storage.internal.upload_file(str(out), B, key)
        conn.execute(
            "UPDATE imagery_assets SET status = 'ready', storage_key = %s, bounds = %s, crs = %s, resolution = %s, "
            "bands = %s, error = NULL, error_code = NULL WHERE id = %s",
            (key, bounds, crs, abs(info["geoTransform"][1]), len(info.get("bands", [])), iid))
        return {"imagery_id": str(iid), "bounds": bounds, "crs": crs}
    except Exception as e:
        conn.rollback()
        msg, code = (str(e), e.code) if isinstance(e, JobFailed) else ("Conversion failed. Please try uploading again.", "convert_failed")
        conn.execute("UPDATE imagery_assets SET status = 'failed', error = %s, error_code = %s WHERE id = %s",
                     (msg, code, iid))
        conn.commit()
        if not isinstance(e, JobFailed):
            log.exception("imagery conversion failed")
            raise JobFailed(msg, code)
        raise


# ======================================================================== snapshot
def snapshot(conn, job) -> dict:
    did = job["params"]["dataset_id"]
    d = conn.execute("SELECT * FROM datasets WHERE id = %s FOR UPDATE", (did,)).fetchone()
    statuses = job["params"].get("statuses") or d["statuses"]
    form = conn.execute(
        "SELECT v.geometry_type, v.fields FROM forms f JOIN form_versions v ON v.form_id = f.id AND v.version = f.version "
        "WHERE f.id = %s", (d["form_id"],)).fetchone()
    fields = [f for f in form["fields"] if f["type"] != "photo"]      # media is not published in v1
    photo_ids = [f["id"] for f in form["fields"] if f["type"] == "photo"]
    version = d["latest_version"] + 1
    skey = f"snapshots/{did}/v{version}.geojson"
    conn.execute("INSERT INTO dataset_versions (dataset_id, version, fields, geometry_type, snapshot_key, published_by) "
                 "VALUES (%s, %s, %s, %s, %s, %s)", (did, version, Jsonb(fields), form["geometry_type"], skey, job["created_by"]))
    n = conn.execute(
        "INSERT INTO dataset_features (dataset_id, version, feature_id, geom, properties) "
        "SELECT %s, %s, f.id, f.geom, f.properties - %s::text[] FROM features f "
        "WHERE f.form_id = %s AND f.deleted_at IS NULL AND f.status = ANY(%s)",
        (did, version, photo_ids, d["form_id"], statuses)).rowcount
    if n == 0:
        raise JobFailed(f"No features to publish: there are none with status {', '.join(statuses)}. Approve features "
                        "first, or include submitted ones.", "empty_dataset")
    bbox = conn.execute("SELECT ARRAY[ST_XMin(e), ST_YMin(e), ST_XMax(e), ST_YMax(e)] AS b FROM "
                        "(SELECT ST_Extent(geom) AS e FROM dataset_features WHERE dataset_id = %s AND version = %s) x",
                        (did, version)).fetchone()["b"]
    with tempfile.TemporaryDirectory() as t:
        path = Path(t) / "s.geojson"
        with path.open("w") as fh, conn.cursor(name="snap") as c:
            fh.write('{"type":"FeatureCollection","name":%s,"features":[' % json.dumps(d["slug"]))
            c.itersize = 2000
            c.execute("SELECT feature_id, ST_AsGeoJSON(geom, 7) AS g, properties FROM dataset_features "
                      "WHERE dataset_id = %s AND version = %s ORDER BY feature_id", (did, version))
            for i, r in enumerate(c):
                fh.write(("," if i else "") + json.dumps({"type": "Feature", "id": str(r["feature_id"]),
                                                          "geometry": json.loads(r["g"]), "properties": r["properties"]}))
            fh.write("]}")
        storage.internal.upload_file(str(path), B, skey, ExtraArgs={"ContentType": "application/geo+json"})
    conn.execute("UPDATE dataset_versions SET feature_count = %s, bbox = %s WHERE dataset_id = %s AND version = %s",
                 (n, bbox, did, version))
    conn.execute("UPDATE datasets SET latest_version = %s, updated_at = now() WHERE id = %s", (version, did))
    conn.commit()
    return {"dataset": d["slug"], "version": version, "feature_count": n}


# ======================================================================== export
def shapefile_names(field_ids: list[str]) -> dict[str, str]:
    """Shapefile field names are limited to 10 characters. Build unique ones deterministically."""
    used, out = {"feature_id"}, {}
    for fid in field_ids:
        name = fid[:10]
        k = 1
        while name in used:
            suffix = f"_{k}"
            name, k = fid[:10 - len(suffix)] + suffix, k + 1
        used.add(name)
        out[fid] = name
    return out


def _flat(v):
    return "; ".join(map(str, v)) if isinstance(v, list) else v


def export(conn, job) -> dict:
    p = job["params"]
    did, version, fmt = p["dataset_id"], p["version"], p["format"]
    cached = conn.execute("SELECT storage_key, filename, size FROM dataset_exports WHERE dataset_id = %s AND version = %s "
                          "AND format = %s", (did, version, fmt)).fetchone()
    if cached:
        return {"storage_key": cached["storage_key"], "filename": cached["filename"], "format": fmt, "size": cached["size"]}
    d = conn.execute("SELECT slug, title, license FROM datasets WHERE id = %s", (did,)).fetchone()
    ver = conn.execute("SELECT fields, geometry_type, feature_count, published_at FROM dataset_versions "
                       "WHERE dataset_id = %s AND version = %s", (did, version)).fetchone()
    fields, gtype = ver["fields"], ver["geometry_type"]
    base = f"{d['slug']}-v{version}"
    ids = [f["id"] for f in fields]
    want_wkt = fmt == "csv" and gtype != "point"

    def rows():
        with conn.cursor(name="exp") as c:
            c.itersize = 2000
            c.execute("SELECT feature_id, ST_AsGeoJSON(geom, 7) AS g, " + ("ST_AsText(geom) AS wkt, " if want_wkt else "") +
                      "properties FROM dataset_features WHERE dataset_id = %s AND version = %s ORDER BY feature_id",
                      (did, version))
            yield from c

    with tempfile.TemporaryDirectory() as t:
        t = Path(t)
        if fmt == "geojson":
            return {"storage_key": conn.execute("SELECT snapshot_key FROM dataset_versions WHERE dataset_id = %s AND version = %s",
                                                (did, version)).fetchone()["snapshot_key"],
                    "filename": f"{base}.geojson", "format": fmt, "size": None}
        if fmt == "csv":
            out = t / f"{base}.csv"
            with out.open("w", newline="", encoding="utf-8") as fh:
                w = csv.writer(fh)
                w.writerow(["feature_id"] + (["longitude", "latitude"] if gtype == "point" else ["wkt"]) + ids)
                for r in rows():
                    g = json.loads(r["g"])
                    if gtype == "point":
                        c0 = g["coordinates"] if g["type"] == "Point" else g["coordinates"][0]   # MultiPoint: first point
                        lead = [c0[0], c0[1]]
                    else:
                        lead = [r["wkt"]]
                    w.writerow([r["feature_id"]] + lead + [_flat(r["properties"].get(i)) for i in ids])
            ctype, filename = "text/csv", out.name
        else:
            names = shapefile_names(ids) if fmt == "shp" else {i: i for i in ids}
            src = t / "in.geojson"
            with src.open("w") as fh:
                fh.write('{"type":"FeatureCollection","features":[')
                for i, r in enumerate(rows()):
                    props = {"feature_id": str(r["feature_id"])}
                    props.update({names[k]: _flat(r["properties"].get(k)) for k in ids})
                    fh.write(("," if i else "") + json.dumps({"type": "Feature", "geometry": json.loads(r["g"]), "properties": props}))
                fh.write("]}")
            nlt = [] if gtype == "point" else ["-nlt", "PROMOTE_TO_MULTI"]
            if fmt == "gpkg":
                out = t / f"{base}.gpkg"
                _run(["ogr2ogr", "-f", "GPKG", str(out), str(src), "-nln", re.sub(r"\W", "_", d["slug"]),
                      "-a_srs", "EPSG:4326", *nlt])
                ctype, filename = "application/geopackage+sqlite3", out.name
            else:
                sd = t / "shp"
                sd.mkdir()
                _run(["ogr2ogr", "-f", "ESRI Shapefile", str(sd / f"{base}.shp"), str(src), "-nln", base,
                      "-a_srs", "EPSG:4326", "-lco", "ENCODING=UTF-8", *nlt])
                with (sd / "field_mapping.csv").open("w", newline="", encoding="utf-8") as fh:
                    w = csv.writer(fh)
                    w.writerow(["field_id", "label", "shapefile_name", "type"])
                    w.writerow(["feature_id", "Feature id", "feature_id", "text"])
                    for f in fields:
                        w.writerow([f["id"], f["label"], names[f["id"]], f["type"]])
                (sd / "README.txt").write_text(
                    f"{d['title']} (version {version})\nLicence: {d['license']}\n"
                    f"Published: {ver['published_at']:%Y-%m-%d}\n\n"
                    "Shapefile field names are limited to 10 characters. field_mapping.csv maps every original\n"
                    "field id to its name in the .dbf. Multi-choice values are joined with '; '.\n")
                out = t / f"{base}.zip"
                with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
                    for f in sorted(sd.iterdir()):
                        z.write(f, f.name)
                ctype, filename = "application/zip", out.name
        key = f"exports/{did}/v{version}/{filename}"
        storage.internal.upload_file(str(out), B, key, ExtraArgs={"ContentType": ctype})
        size = out.stat().st_size
    conn.execute("INSERT INTO dataset_exports (dataset_id, version, format, storage_key, filename, size) "
                 "VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING", (did, version, fmt, key, filename, size))
    conn.commit()
    return {"storage_key": key, "filename": filename, "format": fmt, "size": size}


# ======================================================================== import
def _canon(choices: list[str], v: str) -> str | None:
    for c in choices:
        if c == v or c.lower() == v.strip().lower():
            return c
    return None


def _coerce(fields: dict[str, dict], key: str, raw):
    f = fields[key]
    if raw is None or raw == "":
        return None
    t = f["type"]
    if t == "number":
        return raw if isinstance(raw, (int, float)) and not isinstance(raw, bool) else float(str(raw).replace(",", "."))
    if t == "choice":
        return _canon(f["choices"], str(raw)) or str(raw)
    if t == "multi_choice":
        parts = raw if isinstance(raw, list) else re.split(r"[;|]", str(raw))
        return [_canon(f["choices"], p) or p.strip() for p in parts if str(p).strip()]
    if t == "photo":
        return None
    return raw if isinstance(raw, str) else str(raw)


def _ogr_to_geojson(src: Path, ext: str) -> str:
    """Convert any vector format GDAL reads into GeoJSON (WGS84) text. Uses the first layer that has geometry."""
    named = src.with_name("source" + ext)
    src.rename(named)
    target = f"/vsizip/{named}" if ext == ".zip" else str(named)
    try:
        layers = json.loads(_run(["ogrinfo", "-json", "-so", "-al", target])).get("layers", [])
        if not layers:
            raise RuntimeError("no layers")
        layer = next((l for l in layers if l.get("geometryFields")), layers[0])["name"]
        out = src.with_name("converted.geojson")
        _run(["ogr2ogr", "-f", "GeoJSON", "-t_srs", "EPSG:4326", "-skipfailures", str(out), target, layer])
    except (RuntimeError, ValueError):
        raise JobFailed("This file could not be read as map data. For a Shapefile, zip the .shp, .shx, .dbf and .prj "
                        "files together and upload the .zip.", "bad_file")
    return out.read_text(encoding="utf-8")


def import_features(conn, job) -> dict:
    p = job["params"]
    pid, uid, status = job["project_id"], job["created_by"], p["status"]
    form = conn.execute("SELECT f.id, f.version, v.geometry_type, v.fields FROM forms f JOIN form_versions v "
                        "ON v.form_id = f.id AND v.version = f.version WHERE f.id = %s", (p["form_id"],)).fetchone()
    fields = {f["id"]: f for f in form["fields"]}
    mapping = p["mapping"]
    kind = p["kind"]
    with tempfile.TemporaryDirectory() as t:
        src = Path(t) / "src"
        storage.internal.download_file(B, p["source_key"], str(src))
        if kind == "ogr":                                   # KML, GPX, GeoPackage, GML, zipped Shapefile
            text, kind = _ogr_to_geojson(src, Path(p["source_key"]).suffix), "geojson"
        else:
            text = src.read_text(encoding="utf-8-sig")
    if kind == "geojson":
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            raise JobFailed("The file is not valid JSON.", "bad_file")
        feats = data.get("features") if data.get("type") == "FeatureCollection" else [data] if data.get("type") == "Feature" else None
        if feats is None:
            raise JobFailed("Expected a GeoJSON FeatureCollection.", "bad_file")
        records = [(f.get("geometry"), f.get("properties") or {}) for f in feats]
    else:
        reader = csv.DictReader(text.splitlines())
        records = []
        for row in reader:
            geom = None
            if p.get("wkt_column"):
                geom = ("wkt", row.get(p["wkt_column"]))
            else:
                try:
                    geom = {"type": "Point", "coordinates": [float(row[p["lon_column"]]), float(row[p["lat_column"]])]}
                except (ValueError, KeyError, TypeError):
                    geom = None
            records.append((geom, row))

    seen_cols, dropped, errors, ok = set(), set(), [], 0
    pending: list[tuple[int, str, dict, dict]] = []

    def flush():
        nonlocal ok, pending
        if not pending:
            return
        first = conn.execute("UPDATE projects SET seq_counter = seq_counter + %s, last_activity_at = now() "
                             "WHERE id = %s RETURNING seq_counter", (len(pending), pid)).fetchone()["seq_counter"] - len(pending) + 1
        payload = [{"id": fid, "geom": g, "props": pr, "seq": first + i} for i, (_, fid, g, pr) in enumerate(pending)]
        returned = {str(r["id"]) for r in conn.execute(
            "INSERT INTO features (id, project_id, form_id, form_version, geom, properties, status, version, seq, "
            "created_by, updated_by) SELECT t.id, %s, %s, %s, g.geom, t.props, %s, 1, t.seq, %s, %s "
            "FROM jsonb_to_recordset(%s::jsonb) AS t(id uuid, geom jsonb, props jsonb, seq bigint) "
            "CROSS JOIN LATERAL (SELECT geom_from_json(t.geom::text) AS geom) g "
            "WHERE ST_IsValid(g.geom) AND NOT ST_IsEmpty(g.geom) RETURNING id",
            (pid, form["id"], form["version"], status, uid, uid, Jsonb(payload))).fetchall()}
        conn.execute("INSERT INTO feature_versions (feature_id, version, geom, properties, status, action, changed_by) "
                     "SELECT id, version, geom, properties, status, 'create', %s FROM features WHERE id = ANY(%s::uuid[])",
                     (uid, list(returned)))
        for rowno, fid, _, _ in pending:
            if fid in returned:
                ok += 1
            else:
                errors.append({"row": rowno, "message": "geometry is not valid"})
        pending = []
        conn.commit()
        _progress(conn, job["id"], min(95, int(100 * (ok + len(errors)) / max(len(records), 1))))

    for i, (geom, raw) in enumerate(records, start=1):
        rowno = i + (1 if kind == "csv" else 0)          # CSV row numbers count the header
        if isinstance(geom, tuple):                              # WKT column
            try:
                geom = json.loads(conn.execute("SELECT ST_AsGeoJSON(ST_GeomFromText(%s, 4326)) AS g", (geom[1],)).fetchone()["g"])
            except Exception:  # noqa: BLE001
                conn.rollback()
                geom = None
        props, bad = {}, []
        for col, val in raw.items():
            seen_cols.add(col)
            target = mapping.get(col, col if col in fields else None)
            if target is None or target not in fields:
                if col not in (p.get("lon_column"), p.get("lat_column"), p.get("wkt_column")):
                    dropped.add(col)
                continue
            try:
                v = _coerce(fields, target, val)
            except (ValueError, TypeError):
                bad.append(f"{target}: cannot read {val!r}")
                continue
            if v is not None:
                props[target] = v
        err = check_geometry(form["geometry_type"], geom) if geom else "missing or unreadable geometry"
        ferrs = check_properties(form["fields"], props, enforce_required=status != "draft")
        msgs = bad + ([f"geometry: {err}"] if err else []) + [f"{k}: {', '.join(v)}" for k, v in ferrs.items()]
        if msgs:
            errors.append({"row": rowno, "message": "; ".join(msgs)})
            continue
        pending.append((rowno, str(uuid4()), geom, props))
        if len(pending) >= 500:
            flush()
    flush()
    result = {"imported": ok, "rejected": len(errors), "errors": errors[:100], "dropped_columns": sorted(dropped)}
    if ok == 0:
        raise JobFailed("No rows could be imported. See the row errors.", "nothing_imported", result)
    return result


# ======================================================================== photos
def process_photo(media_id: str):
    """Make a web-size copy (long edge PHOTO_WEB_PX) and record the original's dimensions. The original is kept."""
    from PIL import Image, ImageOps
    with connect_sync() as conn:
        m = conn.execute("SELECT * FROM media WHERE id = %s", (media_id,)).fetchone()
        if not m or m["status"] not in ("uploaded", "ready"):
            return
        try:
            with tempfile.TemporaryDirectory() as t:
                src, out = Path(t) / "orig", Path(t) / "web.jpg"
                storage.internal.download_file(B, m["storage_key"], str(src))
                img = ImageOps.exif_transpose(Image.open(src))
                w, h = img.size
                img.thumbnail((settings.photo_web_px, settings.photo_web_px))
                img.convert("RGB").save(out, "JPEG", quality=85, optimize=True)
                web_key = f"media/{m['project_id']}/{m['id']}/web.jpg"
                storage.internal.upload_file(str(out), B, web_key, ExtraArgs={"ContentType": "image/jpeg"})
            conn.execute("UPDATE media SET status = 'ready', web_key = %s, width = %s, height = %s WHERE id = %s",
                         (web_key, w, h, media_id))
        except Exception:  # noqa: BLE001
            log.exception("photo processing failed for %s", media_id)
            conn.rollback()
            conn.execute("UPDATE media SET status = 'failed' WHERE id = %s", (media_id,))
        conn.commit()


HANDLERS = {"imagery_convert": imagery_convert, "snapshot": snapshot, "export": export, "import": import_features}
