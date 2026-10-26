/** Which uploads the editor accepts, and where each kind goes. Mirrors backend/app/formats.py. */
export const RASTER_EXTS = [".tif", ".tiff", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".jp2", ".j2k", ".img", ".asc"];
export const VECTOR_EXTS = [".geojson", ".json", ".csv", ".kml", ".gpx", ".gpkg", ".gml", ".zip"];
/** Plain pictures carry no coordinates; the user can type in where they belong. */
export const NEEDS_BOUNDS_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"];
export const ACCEPT = [...RASTER_EXTS, ...VECTOR_EXTS].join(",");

export type FileKind = "raster" | "vector" | "unsupported";
export const extOf = (name: string): string => { const i = name.lastIndexOf("."); return i < 0 ? "" : name.slice(i).toLowerCase(); };
export function classifyFile(name: string): FileKind {
  const e = extOf(name);
  return RASTER_EXTS.includes(e) ? "raster" : VECTOR_EXTS.includes(e) ? "vector" : "unsupported";
}
export type Bounds = [number, number, number, number]; // west, south, east, north (EPSG:4326)
