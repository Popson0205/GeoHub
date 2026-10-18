import math
from datetime import date, datetime
from uuid import UUID

RESERVED_IDS = {"feature_id", "longitude", "latitude", "wkt", "geometry", "status", "uuid"}


def check_field_defs(fields: list[dict]) -> dict[str, list[str]]:
    """Validate a form's field list when it is saved."""
    errors: dict[str, list[str]] = {}
    seen = set()
    for i, f in enumerate(fields):
        key = f"fields.{i}"
        errs = []
        if f["id"] in seen:
            errs.append(f"duplicate field id '{f['id']}'")
        if f["id"] in RESERVED_IDS:
            errs.append(f"'{f['id']}' is reserved")
        seen.add(f["id"])
        if f["type"] in ("choice", "multi_choice"):
            ch = f.get("choices") or []
            if not ch:
                errs.append("choices are required")
            if len(set(ch)) != len(ch) or any(not isinstance(c, str) or not c for c in ch):
                errs.append("choices must be unique, non-empty text")
        elif f.get("choices"):
            errs.append("choices only apply to choice and multi_choice fields")
        if f["type"] == "choice" and f.get("max_items") not in (None, 1):
            errs.append("choice fields allow exactly one value")
        if errs:
            errors[key] = errs
    return errors


def _is_date(v) -> bool:
    if not isinstance(v, str):
        return False
    try:
        date.fromisoformat(v)
        return True
    except ValueError:
        try:
            datetime.fromisoformat(v.replace("Z", "+00:00"))
            return True
        except ValueError:
            return False


def _is_uuid(v) -> bool:
    try:
        UUID(str(v))
        return isinstance(v, str)
    except ValueError:
        return False


def check_properties(fields: list[dict], props: dict, *, enforce_required: bool = True) -> dict[str, list[str]]:
    """Validate feature properties against a form version. Unknown keys are rejected."""
    errors: dict[str, list[str]] = {}
    known = {f["id"] for f in fields}
    for k in props:
        if k not in known:
            errors.setdefault(k, []).append("unknown field")
    for f in fields:
        fid, t, v = f["id"], f["type"], props.get(f["id"])
        empty = v is None or v == "" or v == []
        if empty:
            if f.get("required") and enforce_required:
                errors.setdefault(fid, []).append("required")
            continue
        err = None
        if t == "text":
            err = None if isinstance(v, str) and len(v) <= 5000 else "must be text up to 5000 characters"
        elif t == "number":
            err = None if (isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)) else "must be a number"
        elif t == "date":
            err = None if _is_date(v) else "must be an ISO 8601 date"
        elif t == "choice":
            err = None if v in f.get("choices", []) else f"must be one of {f.get('choices', [])}"
        elif t == "multi_choice":
            ch, cap = f.get("choices", []), f.get("max_items")
            if not isinstance(v, list) or len(set(map(str, v))) != len(v) or any(x not in ch for x in v):
                err = f"must be a list of unique values from {ch}"
            elif cap and len(v) > cap:
                err = f"at most {cap} values"
        elif t == "photo":
            cap = f.get("max_items") or 20
            if not isinstance(v, list) or not all(_is_uuid(x) for x in v):
                err = "must be a list of media ids"
            elif len(v) > cap:
                err = f"at most {cap} photos"
        if err:
            errors.setdefault(fid, []).append(err)
    return errors


def flatten_errors(fields: dict[str, list[str]]) -> str:
    return "; ".join(f"{k}: {', '.join(v)}" for k, v in fields.items())
