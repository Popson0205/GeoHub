"""What a public dashboard link is allowed to show.

A shared dashboard needs no sign-in, so this is the only door through which collected data leaves a project without one.
It is deliberately narrow, and it is a pure function of the dashboard's saved layout and the rows it is handed, so the
rules can be tested without a database:

* only the fields the dashboard actually draws are sent, never the whole record;
* photos, recordings, files and signatures are never sent;
* locations are sent only for forms the dashboard shows on a map (otherwise the geometry is left out);
* the route that calls this only reads approved records; drafts and rejected records never leave the project.
"""
from typing import Any
from uuid import UUID

from ..schemas import DashboardConfig

MEDIA_TYPES = {"photo", "audio", "video", "file", "signature"}
NOT_VALUES = {"note", "group", "repeat"}                       # layout, or rows of answers: nothing a chart reads
GPS_IDS = {"gps_elev_m", "gps_hacc_m"}                         # recorded with each point; a dashboard can chart them
PUBLIC_FIELD_KEYS = ("id", "label", "type", "choices", "unit", "true_label", "false_label", "integer", "decimals")
STATIC_ELEMENTS = {"rich_text", "embedded"}
MAX_PUBLIC_RECORDS = 20000


def _widget_fields(w) -> set[str] | None:
    """The field ids one element reads. None means every field (a details card with no fields chosen)."""
    if w.type == "details":
        return set(w.columns) if w.columns else None
    ids: set[str | None] = set()
    if w.type in ("kpi", "bar", "pie", "line", "gauge"):
        ids |= {w.field, w.metric_field, w.target_field}
    elif w.type == "table":
        ids |= set(w.columns)
    elif w.type == "list":
        ids |= {w.title_field, *w.subtitle_fields}
    return {i for i in ids if i}


def used_fields(config: DashboardConfig) -> dict[UUID, set[str] | None]:
    """Per form the dashboard draws on: the field ids it reads, or None for all of them."""
    out: dict[UUID, set[str] | None] = {}
    for p in config.pages:
        if p.form_id is not None:
            out.setdefault(p.form_id, set())
        for w in p.widgets:
            fid = w.form_id or p.form_id
            if fid is None or w.type in STATIC_ELEMENTS:
                continue
            need = _widget_fields(w)
            if need is None:
                out[fid] = None
            elif out.get(fid, set()) is not None:
                out[fid] = (out.get(fid) or set()) | need
    return out


def map_forms(config: DashboardConfig) -> set[UUID]:
    """Forms whose record locations the dashboard shows on a map."""
    return {w.form_id or p.form_id for p in config.pages for w in p.widgets if w.type == "map" and (w.form_id or p.form_id)}


def _leaves(fields: list[dict]) -> list[dict]:
    """Answerable fields, flattened out of groups (a group's children are stored flat). Repeat sections are left out."""
    out: list[dict] = []
    for f in fields or []:
        if f.get("type") == "group":
            out += _leaves(f.get("children") or [])
        elif f.get("type") not in NOT_VALUES and f.get("type") not in MEDIA_TYPES:
            out.append(f)
    return out


def public_fields(form_fields: list[dict], used: set[str] | None) -> list[dict]:
    leaves = _leaves(form_fields)
    chosen = leaves if used is None else [f for f in leaves if f["id"] in used]
    return [{k: f[k] for k in PUBLIC_FIELD_KEYS if f.get(k) is not None} for f in chosen]


def shape_public_dashboard(*, token: str, name: str, project_name: str, config: DashboardConfig, updated_at: Any,
                           forms: list[dict], features: list[dict], truncated: bool) -> dict:
    """`forms`: id, name, geometry_type, version, fields. `features`: id, form_id, geometry, properties, updated_at."""
    used, on_map = used_fields(config), map_forms(config)
    shown = {f["id"]: public_fields(f["fields"], used.get(f["id"])) for f in forms if f["id"] in used}
    allowed = {fid: {f["id"] for f in fs} for fid, fs in shown.items()}
    out_features = []
    for r in features:
        fid = r["form_id"]
        if fid not in shown:
            continue
        keep = allowed[fid] | (GPS_IDS if used.get(fid) is None else GPS_IDS & used[fid])     # only the GPS values it charts
        out_features.append({"id": r["id"], "form_id": fid, "updated_at": r["updated_at"],
                             "geometry": r["geometry"] if fid in on_map else None,
                             "properties": {k: v for k, v in (r["properties"] or {}).items() if k in keep}})
    return {"token": token, "name": name, "project_name": project_name, "config": config.model_dump(mode="json"),
            "updated_at": updated_at, "truncated": truncated,
            "forms": [{"id": f["id"], "name": f["name"], "geometry_type": f["geometry_type"], "version": f["version"],
                       "fields": shown[f["id"]]} for f in forms if f["id"] in shown],
            "features": out_features}
