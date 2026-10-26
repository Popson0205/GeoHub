import math

GEOM_TYPES = {"point": {"Point", "MultiPoint"}, "line": {"LineString", "MultiLineString"},
              "area": {"Polygon", "MultiPolygon"}}
ALL_TYPES = set().union(*GEOM_TYPES.values())


def _pos_ok(p) -> bool:
    return (isinstance(p, (list, tuple)) and 2 <= len(p) <= 3
            and all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in p)
            and -180 <= p[0] <= 180 and -90 <= p[1] <= 90)


def _line_ok(c, minimum=2) -> bool:
    return isinstance(c, list) and len(c) >= minimum and all(_pos_ok(p) for p in c)


def _ring_ok(c) -> bool:
    return _line_ok(c, 4) and list(c[0][:2]) == list(c[-1][:2])


def check_geometry(geometry_type: str, g) -> str | None:
    """Return an error message, or None if `g` is a usable GeoJSON geometry of the right kind (EPSG:4326)."""
    if not isinstance(g, dict) or g.get("type") not in ALL_TYPES:
        return "must be a GeoJSON Point, LineString, Polygon or their Multi* forms"
    t, c = g["type"], g.get("coordinates")
    if t not in GEOM_TYPES[geometry_type]:
        return f"this form collects {geometry_type} geometry, not {t}"
    ok = {
        "Point": lambda: _pos_ok(c),
        "MultiPoint": lambda: isinstance(c, list) and len(c) >= 1 and all(_pos_ok(p) for p in c),
        "LineString": lambda: _line_ok(c),
        "MultiLineString": lambda: isinstance(c, list) and len(c) >= 1 and all(_line_ok(l) for l in c),
        "Polygon": lambda: isinstance(c, list) and len(c) >= 1 and all(_ring_ok(r) for r in c),
        "MultiPolygon": lambda: isinstance(c, list) and len(c) >= 1 and all(
            isinstance(p, list) and p and all(_ring_ok(r) for r in p) for p in c),
    }[t]()
    return None if ok else "coordinates are invalid; use [longitude, latitude] within EPSG:4326 and closed rings for areas"
