"""Raster dataset tiles, drawn by the API itself with rio-tiler (the library TiTiler is built on), so a deployment
needs no TiTiler service, for the Data hub and for project and map imagery alike. Each tile is read straight from the version's Cloud-Optimised GeoTIFF in
storage, over HTTPS by a signed address (so any S3-compatible service works, whatever its endpoint looks like), and
drawn as a PNG: a photo (three bands), a band along a colour ramp, or classes each in its own colour."""
import threading
import time

import numpy as np
import rasterio
from rio_tiler.colormap import cmap
from rio_tiler.errors import TileOutsideBounds
from rio_tiler.io import Reader

from . import storage
from .config import settings

_urls: dict[str, tuple[str, float]] = {}
_lock = threading.Lock()
URL_LIFE = 3600
GDAL = {"GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR", "GDAL_HTTP_MERGE_CONSECUTIVE_RANGES": "YES", "GDAL_HTTP_MULTIPLEX": "YES",
        "VSI_CACHE": "TRUE", "VSI_CACHE_SIZE": "50000000", "CPL_VSIL_CURL_CACHE_SIZE": "100000000"}


def _url(key: str) -> str:
    """A signed address for the file, kept for most of its life: the same address lets GDAL reuse what it has read."""
    now = time.time()
    with _lock:
        hit = _urls.get(key)
        if hit and hit[1] > now + 300:
            return hit[0]
        url = storage.internal.generate_presigned_url("get_object", Params={"Bucket": settings.s3_bucket, "Key": key}, ExpiresIn=URL_LIFE)
        _urls[key] = (url, now + URL_LIFE)
        if len(_urls) > 500:
            for k in [k for k, (_, t) in _urls.items() if t < now + 300]:
                _urls.pop(k, None)
        return url


def _rgb(c: str) -> tuple[int, int, int]:
    return int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16)


def ramp(stops: list[str]) -> dict[int, tuple[int, int, int, int]]:
    """256 colours along the stops, for values rescaled to 0–255."""
    rgb = [_rgb(c) for c in stops]
    out = {}
    for v in range(256):
        t = v / 255 * (len(rgb) - 1)
        i = min(int(t), len(rgb) - 2)
        f = t - i
        out[v] = tuple(round(rgb[i][k] + (rgb[i + 1][k] - rgb[i][k]) * f) for k in range(3)) + (255,)
    return out


def render(key: str, z: int, x: int, y: int, how: dict) -> bytes | None:
    """The PNG tile, or None where the raster has nothing (outside it)."""
    kind = how.get("kind")
    with rasterio.Env(**GDAL), Reader(_url(key)) as src:
        try:
            if kind == "rgb":
                img = src.tile(x, y, z, indexes=tuple(how.get("bands") or (1, 2, 3)))
                return img.render(img_format="PNG")
            img = src.tile(x, y, z, indexes=(int(how.get("band") or 1),))
        except TileOutsideBounds:
            return None
        if kind == "classes":                                    # values without a class (or hidden ones) are left clear
            colours = {int(c["value"]): _rgb(c["color"]) + (255,) for c in how.get("classes") or []}
            return img.render(img_format="PNG", colormap=colours)
        lo, hi = how.get("rescale") or (float(np.nanmin(img.data)), float(np.nanmax(img.data)))
        img.rescale(in_range=((lo, hi if hi > lo else lo + 1),))
        cm = ramp(how["colors"]) if how.get("colors") else cmap.get(how.get("colormap") or "viridis")
        return img.render(img_format="PNG", colormap=cm)



_stretch: dict[str, tuple[float, float]] = {}


def _auto_range(key: str, src, indexes) -> tuple[float, float]:
    """For imagery that is not plain bytes (a DEM, 16-bit satellite bands): the 2nd to 98th percentile of a small
    preview, kept per file so every tile is stretched the same way."""
    k = f"{key}|{indexes}"
    if k in _stretch:
        return _stretch[k]
    prev = src.preview(indexes=indexes, max_size=512)
    vals = np.ma.masked_array(prev.array).compressed()
    vals = vals[np.isfinite(vals)]
    lo, hi = (float(np.percentile(vals, 2)), float(np.percentile(vals, 98))) if vals.size else (0.0, 255.0)
    if len(_stretch) > 500:
        _stretch.clear()
    _stretch[k] = (lo, hi if hi > lo else lo + 1)
    return _stretch[k]


def _floats(v: str) -> list[float]:
    return [float(x) for x in v.split(",") if x.strip()]


def render_imagery(key: str, z: int, x: int, y: int, q: dict) -> bytes | None:
    """An imagery tile, as TiTiler drew it: three or more bands as a photo, one band in grey (or a named colour ramp).
    Bytes are shown as they are; anything else is stretched, by `rescale` if given, else over most of its values.
    Takes TiTiler's options: bidx, rescale, colormap_name, nodata, resampling, color_formula."""
    opts = {}
    if q.get("nodata") not in (None, ""):
        opts["nodata"] = float(q["nodata"]) if q["nodata"].lower() != "nan" else float("nan")
    with rasterio.Env(**GDAL), Reader(_url(key), options=opts) as src:
        bidx = tuple(int(b) for b in _floats(q["bidx"])) if q.get("bidx") else None
        indexes = bidx or ((1, 2, 3) if src.dataset.count >= 3 else (1,))
        try:
            img = src.tile(x, y, z, indexes=indexes, resampling_method=q.get("resampling") or "nearest")
        except TileOutsideBounds:
            return None
        if q.get("rescale"):
            r = _floats(q["rescale"])
            img.rescale(in_range=tuple((r[0], r[1]) for _ in indexes))
        elif img.data.dtype != np.uint8:
            lo, hi = _auto_range(key, src, indexes)
            img.rescale(in_range=tuple((lo, hi) for _ in indexes))
        if q.get("color_formula"):
            img.apply_color_formula(q["color_formula"])
        cm = None
        if len(indexes) == 1 and q.get("colormap_name"):
            try:
                cm = cmap.get(q["colormap_name"])
            except Exception:  # noqa: BLE001 - an unknown name draws in grey rather than failing the tile
                cm = None
        return img.render(img_format="PNG", colormap=cm)
