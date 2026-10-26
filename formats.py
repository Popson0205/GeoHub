"""Which uploads the API accepts, and how each kind is handled.

Raster images are converted to a Cloud-Optimised GeoTIFF with GDAL and served as map tiles.
Vector files (GeoJSON, KML, ...) are not imagery: they are imported as features into a form.
"""
from pathlib import PurePath

# extension -> content type used for the presigned upload
RASTER: dict[str, str] = {
    ".tif": "image/tiff", ".tiff": "image/tiff",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".bmp": "image/bmp",
    ".jp2": "image/jp2", ".j2k": "image/jp2",
    ".img": "application/octet-stream",     # ERDAS Imagine
    ".asc": "text/plain",                    # ESRI ASCII grid
}
GEOJSON = (".geojson", ".json")
CSV = (".csv",)
OGR = (".kml", ".gpx", ".gpkg", ".gml", ".zip")   # converted to GeoJSON with ogr2ogr; .zip = zipped shapefile

# .vrt is deliberately not accepted: a VRT can point at any file on the server.


def ext(filename: str) -> str:
    return PurePath((filename or "").lower()).suffix


def is_raster(filename: str) -> bool:
    return ext(filename) in RASTER


def vector_kind(filename: str) -> str | None:
    """'geojson', 'csv', 'ogr' or None."""
    e = ext(filename)
    return "geojson" if e in GEOJSON else "csv" if e in CSV else "ogr" if e in OGR else None


RASTER_LIST = ", ".join(sorted(RASTER))
VECTOR_LIST = ", ".join(sorted(GEOJSON + CSV + OGR))
