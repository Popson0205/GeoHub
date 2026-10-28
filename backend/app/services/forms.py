"""Form fields: the type table, design checks (when a form is saved) and answer checks (when a feature is saved).

A form is a tree of fields. Groups only organise: their children are stored flat, next to the group's siblings.
A repeat stores a list of rows under its own id. Everything here mirrors frontend/src/lib/{fieldSpec,logic,forms}.ts;
backend/tests/test_form_fields.py checks the two type tables agree.
"""
import math
import secrets
from typing import Any
import re
from datetime import date, datetime, timezone
from uuid import UUID, uuid4

RESERVED_IDS = {"feature_id", "longitude", "latitude", "wkt", "geometry", "status", "uuid"}
TEXT_CAP = 5000
MAX_FIELDS = 500
MAX_DEPTH = 3
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$")

_BASE = ["hint", "visible", "required", "required_if", "readonly", "default"]
_MEDIA = ["hint", "visible", "required", "required_if"]


def _spec(label, stores, answers, appearances, props, *, children=False, media=False, export_as="column"):
    return {"label": label, "stores": stores, "answers": answers, "appearances": appearances, "props": set(props),
            "children": children, "media": media, "export_as": export_as}


TYPE_SPECS: dict[str, dict] = {
    "text": _spec("Text", "scalar", True, ["single_line", "multiline"], _BASE + ["placeholder", "min_length", "max_length", "pattern", "pattern_message"]),
    "number": _spec("Number", "scalar", True, ["input", "stepper", "slider"], _BASE + ["placeholder", "integer", "decimals", "unit", "min", "max"]),
    "date": _spec("Date", "scalar", True, ["picker"], _BASE + ["min", "max"]),
    "time": _spec("Time", "scalar", True, ["picker"], _BASE + ["min", "max"]),
    "datetime": _spec("Date and time", "scalar", True, ["picker"], _BASE + ["min", "max"]),
    "barcode": _spec("Barcode / QR code", "scalar", True, ["scan_or_type"], _BASE + ["placeholder", "pattern", "pattern_message"]),
    "choice": _spec("Single choice", "scalar", True, ["auto", "buttons", "radio", "dropdown"], _BASE + ["choices"]),
    "multi_choice": _spec("Multiple choice", "array", True, ["checkbox", "chips", "dropdown"], _BASE + ["choices", "min_items", "max_items"], export_as="joined"),
    "boolean": _spec("Yes / No", "scalar", True, ["switch", "checkbox", "yes_no_buttons"], _BASE + ["true_label", "false_label", "must_be_true"]),
    "ranking": _spec("Ranking", "array", True, ["list"], [p for p in _BASE if p != "default"] + ["choices"], export_as="joined"),
    "photo": _spec("Photo", "array", True, ["camera_or_gallery", "camera_only"], _MEDIA + ["min_items", "max_items"], media=True, export_as="skip"),
    "audio": _spec("Audio", "array", True, ["recorder"], _MEDIA + ["max_items"], media=True, export_as="skip"),
    "video": _spec("Video", "array", True, ["recorder"], _MEDIA + ["max_items"], media=True, export_as="skip"),
    "file": _spec("File", "array", True, ["picker"], _MEDIA + ["max_items"], media=True, export_as="skip"),
    "signature": _spec("Signature", "array", True, ["pad"], _MEDIA, media=True, export_as="skip"),
    "note": _spec("Note", "none", False, ["plain", "info", "warning", "heading"], ["visible", "text"], export_as="skip"),
    "calculation": _spec("Calculation", "scalar", False, ["readonly_text", "hidden"], ["hint", "visible", "calc", "decimals", "unit", "store"]),
    "group": _spec("Group / Section", "none", False, ["section", "collapsible", "page"], ["hint", "visible"], children=True, export_as="skip"),
    "repeat": _spec("Repeat section", "rows", True, ["cards", "table"], ["hint", "visible", "required", "min_items", "max_items"], children=True, export_as="skip"),
}
HAS_CHOICES = {"choice", "multi_choice", "ranking"}
# Every optional property a field can carry, so a property that does not belong to its type is reported.
ALL_PROPS = {"appearance", "hint", "placeholder", "required", "required_if", "visible", "readonly", "default", "min", "max", "min_length",
             "max_length", "min_items", "max_items", "pattern", "pattern_message", "choices", "integer", "decimals", "unit",
             "must_be_true", "true_label", "false_label", "text", "calc", "store", "children"}
COND_OPS = {"eq", "ne", "gt", "gte", "lt", "lte", "in", "not_in", "contains", "filled", "empty"}
CALC_FNS = {"concat", "sum", "product", "min", "max", "avg", "diff", "ratio", "count_selected", "today", "now", "uuid", "short_id"}
GENERATED_FNS = {"uuid", "short_id"}          # made once when a record starts, then kept (never recomputed)
_ID_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"   # same as the client: no 0 O 1 I L


# ------------------------------------------------------------------------------------------ tree helpers
def all_fields(fields: list[dict]) -> list[dict]:
    out: list[dict] = []
    for f in fields:
        out.append(f)
        out.extend(all_fields(f.get("children") or []))
    return out


def top_level_fields(fields: list[dict]) -> list[dict]:
    """Fields whose values sit directly in feature.properties: groups are looked through, repeats stay one unit."""
    out: list[dict] = []
    for f in fields:
        if f["type"] == "group":
            out.extend(top_level_fields(f.get("children") or []))
        else:
            out.append(f)
    return out


def column_fields(fields: list[dict]) -> list[dict]:
    """What a dataset publishes as columns: answers and stored calculations, not media, notes or repeats."""
    return [f for f in top_level_fields(fields)
            if TYPE_SPECS[f["type"]]["export_as"] != "skip" and not (f["type"] == "calculation" and f.get("store") is False)]


def non_column_ids(fields: list[dict]) -> list[str]:
    """Ids that must be stripped from properties when publishing a dataset (media, repeats, unsaved calculations)."""
    keep = {f["id"] for f in column_fields(fields)}
    return [f["id"] for f in top_level_fields(fields) if f["id"] not in keep]


def _level_ids(fields: list[dict]) -> set[str]:
    ids: set[str] = set()
    for f in fields:
        ids.add(f["id"])
        if f["type"] == "group":
            ids |= _level_ids(f.get("children") or [])
    return ids


def _set(f: dict, k: str) -> bool:
    v = f.get(k)
    return v is not None and v is not False and v != [] and v != ""


# ------------------------------------------------------------------------------------------ conditions
def _empty(v) -> bool:
    return v is None or v == "" or v == []


def _s(v) -> str:
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _num(v):
    if isinstance(v, bool) or _empty(v):
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if math.isfinite(n) else None


def _compare(a, b):
    if _empty(a) or _empty(b):
        return None
    if isinstance(a, str) and isinstance(b, str):
        na, nb = (_num(a) if a.strip() else None), (_num(b) if b.strip() else None)
        if na is not None and nb is not None:
            return na - nb
        return -1 if a < b else 1 if a > b else 0
    na, nb = _num(a), _num(b)
    return None if na is None or nb is None else na - nb


def _same(a, b) -> bool:
    if _empty(a):
        return False
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b or a == b and type(a) is type(b)
    return _s(a) == _s(b)


def eval_condition(c: dict, get) -> bool:
    if "all" in c:
        return all(eval_condition(x, get) for x in c["all"])
    if "any" in c:
        return any(eval_condition(x, get) for x in c["any"])
    if "not" in c:
        return not eval_condition(c["not"], get)
    v, op, val = get(c["field"]), c["op"], c.get("value")
    if op == "filled":
        return not _empty(v)
    if op == "empty":
        return _empty(v)
    if op == "eq":
        return _same(v, val)
    if op == "ne":
        return not _same(v, val)
    if op in ("gt", "gte", "lt", "lte"):
        r = _compare(v, val)
        return r is not None and {"gt": r > 0, "gte": r >= 0, "lt": r < 0, "lte": r <= 0}[op]
    lst = val if isinstance(val, list) else [val]
    if op in ("in", "not_in"):
        hit = any(_same(x, y) for x in v for y in lst) if isinstance(v, list) else any(_same(v, y) for y in lst)
        return hit if op == "in" else not hit
    if op == "contains":
        if isinstance(v, list):
            return all(any(_same(x, y) for x in v) for y in lst)
        return isinstance(v, str) and all(_s(y) in v for y in lst)
    return False


def condition_refs(c: dict) -> list[str]:
    if "all" in c:
        return [r for x in c["all"] for r in condition_refs(x)]
    if "any" in c:
        return [r for x in c["any"] for r in condition_refs(x)]
    if "not" in c:
        return condition_refs(c["not"])
    return [c["field"]]


def calc_refs(c: dict) -> list[str]:
    return [a["field"] for a in c.get("args", []) if "field" in a]


def _round(n: float):
    r = round(n, 10)
    return int(r) if float(r).is_integer() else r


def eval_calc(c: dict, get):
    fn, args = c["fn"], c.get("args", [])

    def operand(a):
        return a["const"] if "const" in a else get(a["field"])

    def nums():
        return [n for n in (_num(operand(a)) for a in args) if n is not None]

    if fn in ("sum", "product", "min", "max", "avg"):
        n = nums()
        if not n:
            return None
        if fn == "sum":
            return _round(sum(n))
        if fn == "product":
            p = 1.0
            for x in n:
                p *= x
            return _round(p)
        if fn == "min":
            return _round(min(n))
        if fn == "max":
            return _round(max(n))
        return _round(sum(n) / len(n))
    if fn in ("diff", "ratio"):
        a, b = _num(operand(args[0])), _num(operand(args[1]))
        if a is None or b is None:
            return None
        if fn == "diff":
            return _round(a - b)
        return None if b == 0 else _round(a / b)
    if fn == "count_selected":
        v = operand(args[0])
        return len(v) if isinstance(v, list) else 0
    if fn == "concat":
        parts = [", ".join(map(_s, v)) if isinstance(v, list) else _s(v) for v in (operand(a) for a in args) if not _empty(v)]
        return c.get("sep", " ").join(parts) if parts else None
    if fn == "uuid":
        return str(uuid4())
    if fn == "short_id":
        return c.get("prefix", "") + "".join(secrets.choice(_ID_ALPHABET) for _ in range(8))
    if fn == "today":
        return date.today().isoformat()
    if fn == "now":
        return datetime.now(timezone.utc).isoformat()
    return None


# ------------------------------------------------------------------------------------------ resolve
def _scan(fields, nxt: dict, root: dict, ids: set, parent_visible: bool, prefix: str, st: dict) -> None:
    def get(i):
        in_level = i in ids
        if (prefix + i if in_level else i) in st["prev"]:
            return None  # a hidden answer counts as no answer
        return nxt.get(i) if in_level else root.get(i)

    for f in fields:
        key = prefix + f["id"]
        visible = parent_visible and (not f.get("visible") or eval_condition(f["visible"], get))
        if not visible:
            st["hidden"].add(key)
        elif f.get("required") or f.get("must_be_true") or (f.get("required_if") and eval_condition(f["required_if"], get)):
            st["required"].add(key)
        t = f["type"]
        if t == "calculation" and f.get("calc") and f["calc"].get("fn") in GENERATED_FNS:
            if visible and _empty(nxt.get(f["id"])):       # an id that is already there is kept
                nxt[f["id"]] = eval_calc(f["calc"], get)
        elif t == "calculation" and f.get("calc"):
            v = eval_calc(f["calc"], get)
            if isinstance(v, (int, float)) and f.get("decimals") is not None:
                v = round(v, f["decimals"])
            if v is None:
                nxt.pop(f["id"], None)
            else:
                nxt[f["id"]] = v
        elif t == "group":
            _scan(f.get("children") or [], nxt, root, ids, visible, prefix, st)
        elif t == "repeat" and isinstance(nxt.get(f["id"]), list):
            kids = f.get("children") or []
            kid_ids = _level_ids(kids)
            rows = []
            for i, row in enumerate(nxt[f["id"]]):
                r = dict(row) if isinstance(row, dict) else {}
                _scan(kids, r, root, kid_ids, visible, f"{f['id']}.{i}.", st)
                rows.append(r)
            nxt[f["id"]] = rows


def resolve(fields: list[dict], props: dict) -> tuple[dict, set, set]:
    """(values with calculations filled in, hidden keys, required keys). Keys inside repeats are 'repeat.row.field'."""
    values, hidden, required = dict(props), set(), set()
    ids = _level_ids(fields)
    for _ in range(3):
        st = {"prev": hidden, "hidden": set(), "required": set()}
        nxt = dict(values)
        _scan(fields, nxt, values, ids, True, "", st)
        values, hidden, required = nxt, st["hidden"], st["required"]
    return values, hidden, required


# ------------------------------------------------------------------------------------------ design checks
def _check_condition(c, depth=0) -> str | None:
    if depth > 4 or not isinstance(c, dict):
        return "the rule is too deeply nested or not an object"
    for k in ("all", "any"):
        if k in c:
            if set(c) != {k} or not isinstance(c[k], list) or not 0 < len(c[k]) <= 20:
                return f"'{k}' needs a list of 1 to 20 rules"
            for x in c[k]:
                e = _check_condition(x, depth + 1)
                if e:
                    return e
            return None
    if "not" in c:
        return "'not' needs exactly one rule" if set(c) != {"not"} else _check_condition(c["not"], depth + 1)
    if not isinstance(c.get("field"), str) or c.get("op") not in COND_OPS:
        return "a rule needs a field and one of: " + ", ".join(sorted(COND_OPS))
    if set(c) - {"field", "op", "value"}:
        return "a rule only has field, op and value"
    if c["op"] in ("filled", "empty"):
        return None if "value" not in c else "filled/empty rules take no value"
    v = c.get("value")
    scalar = lambda x: isinstance(x, (str, int, float, bool)) and not (isinstance(x, float) and not math.isfinite(x))  # noqa: E731
    if c["op"] in ("in", "not_in", "contains"):
        return None if scalar(v) or (isinstance(v, list) and len(v) <= 200 and all(scalar(x) for x in v)) else "the value must be text, a number or a list of them"
    return None if scalar(v) else "the value must be text, a number or yes/no"


def _check_calc(c) -> str | None:
    if not isinstance(c, dict) or c.get("fn") not in CALC_FNS:
        return "choose what to calculate: " + ", ".join(sorted(CALC_FNS))
    fn = c["fn"]
    if set(c) - {"fn", "args", "sep", "prefix"}:
        return "a calculation only has fn, args, sep and prefix"
    if "prefix" in c and (fn != "short_id" or not isinstance(c["prefix"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{0,10}", c["prefix"])):
        return "prefix is only for short_id: up to 10 letters, digits, - or _"
    if fn in ("today", "now", "uuid", "short_id"):
        return None if not c.get("args") else f"{fn} takes no values"
    args = c.get("args")
    if not isinstance(args, list) or len(args) > 50:
        return "the calculation needs a list of values"
    if (fn in ("diff", "ratio") and len(args) != 2) or (fn == "count_selected" and len(args) != 1):
        return f"{fn} needs exactly {1 if fn == 'count_selected' else 2} value(s)"
    if not args and fn != "concat":
        return "add at least one value"
    for a in args:
        if not isinstance(a, dict) or len(a) != 1 or not (isinstance(a.get("field"), str) or isinstance(a.get("const"), (str, int, float))):
            return "each value is {field: id} or {const: value}"
    if fn == "count_selected" and "field" not in args[0]:
        return "count_selected needs a field"
    if "sep" in c and (not isinstance(c["sep"], str) or len(c["sep"]) > 20):
        return "sep must be short text"
    return None


def _bound_ok(t: str, v) -> bool:
    if t == "number":
        return _num(v) is not None and not isinstance(v, str)
    if t == "date":
        return isinstance(v, str) and _is_date(v)
    if t == "time":
        return isinstance(v, str) and bool(TIME_RE.match(v))
    return isinstance(v, str) and _is_datetime(v)


def _check_pattern(p) -> str | None:
    if not isinstance(p, str) or len(p) > 200:
        return "the format pattern must be text up to 200 characters"
    if re.search(r"\([^)]*[+*][^)]*\)[+*{]", p):
        return "the format pattern repeats a repeat, which can hang the server; simplify it"
    try:
        re.compile(p)
    except re.error:
        return "the format pattern is not a valid regular expression"
    return None


def check_field_defs(fields: list[dict]) -> dict[str, list[str]]:
    """Validate a form's field list when it is saved. Error keys are paths: fields.2 or fields.2.children.0."""
    errors: dict[str, list[str]] = {}
    flat = all_fields(fields)
    if len(flat) > MAX_FIELDS:
        return {"fields": [f"a form can have at most {MAX_FIELDS} fields"]}
    owner: dict[str, str | None] = {}        # field id -> id of the repeat it sits in
    data_ids: set[str] = set()

    def index(lst, repeat):
        for f in lst:
            owner[f["id"]] = repeat
            if TYPE_SPECS[f["type"]]["stores"] != "none":
                data_ids.add(f["id"])
            index(f.get("children") or [], f["id"] if f["type"] == "repeat" else repeat)
    index(fields, None)

    seen: set[str] = set()

    def visit(lst, path, depth, repeat):
        for i, f in enumerate(lst):
            p = f"{path}.{i}"
            errs: list[str] = []
            t, spec = f["type"], TYPE_SPECS[f["type"]]
            if f["id"] in seen:
                errs.append(f"duplicate field id '{f['id']}'")
            if f["id"] in RESERVED_IDS:
                errs.append(f"'{f['id']}' is reserved")
            seen.add(f["id"])
            # properties that do not belong to this type
            for k in ALL_PROPS - spec["props"] - {"appearance", "children"}:
                if k == "max_items" and t == "choice" and f.get(k) in (None, 1):
                    continue
                if (k == "store" and f.get(k) is None) or (k != "store" and not _set(f, k)):
                    continue
                errs.append(f"'{k}' does not apply to {t} fields")
            if f.get("appearance") is not None and f["appearance"] not in spec["appearances"]:
                errs.append(f"appearance must be one of {spec['appearances']}")
            ch = f.get("choices") or []
            if t in HAS_CHOICES:
                if not ch:
                    errs.append("choices are required")
                if len(set(ch)) != len(ch) or any(not isinstance(c, str) or not c for c in ch):
                    errs.append("choices must be unique, non-empty text")
            if spec["children"]:
                if depth >= MAX_DEPTH:
                    errs.append(f"sections can be nested at most {MAX_DEPTH} levels")
                if t == "repeat" and repeat:
                    errs.append("a repeat section cannot sit inside another repeat section")
            elif f.get("children"):
                errs.append("only groups and repeat sections can hold fields")
            if t == "note" and not (f.get("text") or "").strip():
                errs.append("note text is required")
            if t == "calculation":
                e = _check_calc(f.get("calc")) if f.get("calc") else "a calculation needs 'calc'"
                if e:
                    errs.append(e)
            for k in ("visible", "required_if"):
                if f.get(k):
                    e = _check_condition(f[k])
                    if e:
                        errs.append(f"{k}: {e}")
            if t in ("number", "date", "time", "datetime"):
                for k in ("min", "max"):
                    if f.get(k) is not None and not _bound_ok(t, f[k]):
                        errs.append(f"'{k}' is not a valid {t} value")
                lo, hi = f.get("min"), f.get("max")
                if lo is not None and hi is not None and _bound_ok(t, lo) and _bound_ok(t, hi) and lo > hi:
                    errs.append("the minimum is larger than the maximum")
            for lo, hi in (("min_items", "max_items"), ("min_length", "max_length")):
                if f.get(lo) is not None and f.get(hi) is not None and f[lo] > f[hi]:
                    errs.append(f"{lo} is larger than {hi}")
            if f.get("decimals") is not None and not 0 <= f["decimals"] <= 10:
                errs.append("decimals must be between 0 and 10")
            if f.get("pattern"):
                e = _check_pattern(f["pattern"])
                if e:
                    errs.append(e)
            if f.get("default") is not None and t in TYPE_SPECS and "default" in spec["props"]:
                d = f["default"]
                tokens = {"date": "$today", "datetime": "$today", "time": "$now"}
                if not (isinstance(d, str) and tokens.get(t) == d):
                    e = check_value(f, d)
                    if e:
                        errs.append(f"default: {e}")
            refs = []
            if f.get("visible") and not _check_condition(f["visible"]):
                refs += condition_refs(f["visible"])
            if f.get("required_if") and not _check_condition(f["required_if"]):
                refs += condition_refs(f["required_if"])
            if f.get("calc") and not _check_calc(f["calc"]):
                refs += calc_refs(f["calc"])
            for r in refs:
                if r == f["id"]:
                    errs.append("a field cannot depend on itself")
                elif r not in data_ids:
                    errs.append(f"'{r}' is not a field that holds an answer")
                elif owner.get(r) and owner[r] != repeat:
                    errs.append(f"'{r}' is inside a repeat section and cannot be used outside it")
            if errs:
                errors[p] = errs
            visit(f.get("children") or [], f"{p}.children", depth + 1, f["id"] if t == "repeat" else repeat)

    visit(fields, "fields", 0, None)

    # calculations that depend on each other in a circle
    deps = {f["id"]: calc_refs(f["calc"]) for f in flat if f["type"] == "calculation" and f.get("calc") and not _check_calc(f["calc"])}
    state: dict[str, int] = {}

    def dfs(i) -> bool:
        if state.get(i) == 2:
            return False
        if state.get(i) == 1:
            return True
        state[i] = 1
        cyc = any(d in deps and dfs(d) for d in deps[i])
        state[i] = 2
        if cyc:
            errors.setdefault("fields", []).append(f"calculations refer to each other in a circle (including '{i}')")
        return cyc

    for i in list(deps):
        dfs(i)
    return errors


# ------------------------------------------------------------------------------------------ answers
def _is_date(v) -> bool:
    if not isinstance(v, str):
        return False
    try:
        date.fromisoformat(v)
        return True
    except ValueError:
        return _is_datetime(v)


def _is_datetime(v) -> bool:
    if not isinstance(v, str):
        return False
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


def check_value(f: dict, v) -> str | None:
    """One answer against its field. Returns a message, or None when fine. `v` is never empty here."""
    t = f["type"]
    if t in ("text", "barcode"):
        cap = f.get("max_length") or (500 if t == "barcode" else TEXT_CAP)
        if not isinstance(v, str):
            return f"must be text up to {cap} characters"
        if len(v) > cap:
            return f"must be text up to {cap} characters"
        if f.get("min_length") and len(v) < f["min_length"]:
            return f"needs at least {f['min_length']} characters"
        if f.get("pattern") and not re.search(f["pattern"], v):
            return f.get("pattern_message") or "is not in the expected format"
        return None
    if t == "number":
        if not (isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)):
            return "must be a number"
        if f.get("integer") and not float(v).is_integer():
            return "must be a whole number"
        if isinstance(f.get("min"), (int, float)) and v < f["min"]:
            return f"must be at least {f['min']}"
        if isinstance(f.get("max"), (int, float)) and v > f["max"]:
            return f"must be at most {f['max']}"
        return None
    if t in ("date", "time", "datetime"):
        ok = _is_date(v) if t == "date" else (isinstance(v, str) and bool(TIME_RE.match(v))) if t == "time" else _is_datetime(v)
        if not ok:
            return "must be an ISO 8601 date" if t == "date" else "must be a time such as 14:30" if t == "time" else "must be an ISO 8601 date and time"
        if isinstance(f.get("min"), str) and v < f["min"]:
            return f"cannot be before {f['min']}"
        if isinstance(f.get("max"), str) and v > f["max"]:
            return f"cannot be after {f['max']}"
        return None
    ch = f.get("choices") or []
    if t == "choice":
        return None if isinstance(v, str) and v in ch else f"must be one of {ch}"
    if t in ("multi_choice", "ranking"):
        if not isinstance(v, list) or len(set(map(str, v))) != len(v) or any(x not in ch for x in v):
            return f"must be a list of unique values from {ch}"
        if t == "ranking" and len(v) != len(ch):
            return "must rank every option"
        if f.get("min_items") and len(v) < f["min_items"]:
            return f"at least {f['min_items']} values"
        if f.get("max_items") and len(v) > f["max_items"]:
            return f"at most {f['max_items']} values"
        return None
    if t == "boolean":
        if not isinstance(v, bool):
            return "must be true or false"
        return "must be accepted" if f.get("must_be_true") and not v else None
    if spec_media(t):
        cap = f.get("max_items") or (20 if t == "photo" else 1 if t == "signature" else 10)
        if not isinstance(v, list) or not all(_is_uuid(x) for x in v):
            return "must be a list of media ids"
        if len(v) > cap:
            return f"at most {cap} files"
        if f.get("min_items") and len(v) < f["min_items"]:
            return f"at least {f['min_items']} files"
        return None
    if t == "calculation":
        ok = (isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)) or (isinstance(v, str) and len(v) <= TEXT_CAP)
        return None if ok else "must be a number or text"
    return None


def spec_media(t: str) -> bool:
    return TYPE_SPECS[t]["media"]


# Values the collector records from the device beside the form's own answers (location quality, not questions).
# Stored under the feature's properties and published as extra columns. Keys fit a shapefile's 10-character limit.
SYSTEM_FIELDS = [
    {"id": "gps_elev_m", "type": "number", "label": "Elevation (m)"},
    {"id": "gps_hacc_m", "type": "number", "label": "Horizontal accuracy (m)"},
    {"id": "gps_vacc_m", "type": "number", "label": "Vertical accuracy (m)"},
    {"id": "gps_src", "type": "text", "label": "Location source"},
]
SYSTEM_IDS = {f["id"] for f in SYSTEM_FIELDS}


def check_system_value(key: str, v: Any) -> str | None:
    if key == "gps_src":
        return None if v in ("gps", "map") else "must be \"gps\" or \"map\""
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        return "must be a number"
    if key == "gps_elev_m":
        return None if -1000 <= v <= 10000 else "must be between -1000 and 10000 metres"
    return None if 0 <= v <= 100000 else "must be zero or more"


def check_properties(fields: list[dict], props: dict, *, enforce_required: bool = True) -> dict[str, list[str]]:
    """Validate feature properties against a form version. Unknown keys are rejected; hidden fields are skipped
    (their answers are ignored, not an error, so an old client that still sends them keeps working)."""
    errors: dict[str, list[str]] = {}
    _, hidden, required = resolve(fields, props)

    def level(lst: list[dict], vals: dict, prefix: str) -> None:
        stored = {f["id"] for f in top_level_fields(lst) if TYPE_SPECS[f["type"]]["stores"] != "none"}
        for k in vals:
            if k in stored:
                continue
            if prefix == "" and k in SYSTEM_IDS:
                bad = check_system_value(k, vals[k])
                if bad:
                    errors.setdefault(k, []).append(bad)
                continue
            errors.setdefault(prefix + k, []).append("unknown field")
        for f in top_level_fields(lst):
            fid, t, key = f["id"], f["type"], prefix + f["id"]
            if key in hidden or TYPE_SPECS[t]["stores"] == "none":
                continue
            v = vals.get(fid)
            if t == "repeat":
                rows = v if isinstance(v, list) else None
                if v is not None and (rows is None or not all(isinstance(r, dict) for r in rows)):
                    errors.setdefault(key, []).append("must be a list of rows")
                    continue
                rows = rows or []
                if key in required and not rows and enforce_required:
                    errors.setdefault(key, []).append("required")
                if f.get("min_items") and len(rows) < f["min_items"] and enforce_required:
                    errors.setdefault(key, []).append(f"at least {f['min_items']} entries")
                if f.get("max_items") and len(rows) > f["max_items"]:
                    errors.setdefault(key, []).append(f"at most {f['max_items']} entries")
                for i, row in enumerate(rows[:200]):
                    level(f.get("children") or [], row, f"{fid}.{i}.")
                continue
            if _empty(v):
                if key in required and enforce_required and t != "calculation":
                    errors.setdefault(key, []).append("required")
                continue
            err = check_value(f, v)
            if err:
                errors.setdefault(key, []).append(err)

    level(fields, props, "")
    return errors


def flatten_errors(fields: dict[str, list[str]]) -> str:
    return "; ".join(f"{k}: {', '.join(v)}" for k, v in fields.items())
