// Read map data files in the browser (GeoJSON, KML, GPX) into plain features for a map.
// Multi-part geometries are split into single ones so every feature can be edited vertex by vertex.
import type { Geometry, Position, Props } from "./types";

export interface ParsedFeature { geometry: Geometry; properties: Props }
export const MAP_IMPORT_EXTS = [".geojson", ".json", ".kml", ".gpx"];

const pos = (c: unknown): Position | null => {
  if (!Array.isArray(c) || c.length < 2) return null;
  const x = Number(c[0]), y = Number(c[1]);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;                 // drops any altitude
};
const line = (c: unknown): Position[] | null => {
  if (!Array.isArray(c)) return null;
  const out = c.map(pos);
  return out.every(Boolean) ? (out as Position[]) : null;
};
const ring = (c: unknown): Position[] | null => {
  const r = line(c);
  if (!r || r.length < 3) return null;
  const [a, b] = [r[0], r[r.length - 1]];
  return a[0] === b[0] && a[1] === b[1] ? (r.length >= 4 ? r : null) : [...r, a];     // close open rings
};

/** Split any GeoJSON geometry into editable single geometries. Unusable parts are skipped. */
export function flattenGeometry(g: unknown): Geometry[] {
  if (!g || typeof g !== "object") return [];
  const { type, coordinates, geometries } = g as { type?: string; coordinates?: unknown; geometries?: unknown[] };
  switch (type) {
    case "Point": { const p = pos(coordinates); return p ? [{ type: "Point", coordinates: p }] : []; }
    case "MultiPoint": return (Array.isArray(coordinates) ? coordinates : []).flatMap((c) => flattenGeometry({ type: "Point", coordinates: c }));
    case "LineString": { const l = line(coordinates); return l && l.length >= 2 ? [{ type: "LineString", coordinates: l }] : []; }
    case "MultiLineString": return (Array.isArray(coordinates) ? coordinates : []).flatMap((c) => flattenGeometry({ type: "LineString", coordinates: c }));
    case "Polygon": {
      const rings = (Array.isArray(coordinates) ? coordinates : []).map(ring);
      return rings.length && rings.every(Boolean) ? [{ type: "Polygon", coordinates: rings as Position[][] }] : [];
    }
    case "MultiPolygon": return (Array.isArray(coordinates) ? coordinates : []).flatMap((c) => flattenGeometry({ type: "Polygon", coordinates: c }));
    case "GeometryCollection": return (geometries ?? []).flatMap(flattenGeometry);
    default: return [];
  }
}

/** Tags are flat key/value pairs: keep text, numbers and booleans; stringify anything nested; drop empties. */
function tags(p: unknown): Props {
  const out: Props = {};
  if (!p || typeof p !== "object") return out;
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    if (v === null || v === undefined || v === "") continue;
    out[k.slice(0, 100)] = typeof v === "object" ? JSON.stringify(v) : v;
  }
  return out;
}

function fromGeoJSON(text: string): ParsedFeature[] {
  let data: { type?: string; features?: { geometry?: unknown; properties?: unknown }[]; geometry?: unknown; properties?: unknown };
  try { data = JSON.parse(text); } catch { throw new Error("This file is not valid JSON."); }
  const items = data.type === "FeatureCollection" ? data.features ?? [] : data.type === "Feature" ? [data] : [{ geometry: data, properties: {} }];
  return items.flatMap((f) => flattenGeometry(f.geometry).map((geometry) => ({ geometry, properties: tags(f.properties) })));
}

const coords = (s: string | null | undefined): Position[] =>
  (s ?? "").trim().split(/\s+/).map((t) => t.split(",").map(Number)).filter((c) => c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])).map((c) => [c[0], c[1]] as Position);

function fromKML(text: string): ParsedFeature[] {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("This file is not valid KML.");
  const out: ParsedFeature[] = [];
  for (const pm of Array.from(doc.getElementsByTagName("Placemark"))) {
    const props: Props = {};
    const name = pm.getElementsByTagName("name")[0]?.textContent?.trim();
    const desc = pm.getElementsByTagName("description")[0]?.textContent?.trim();
    if (name) props.name = name;
    if (desc) props.description = desc;
    for (const d of Array.from(pm.getElementsByTagName("Data"))) {
      const k = d.getAttribute("name"), v = d.getElementsByTagName("value")[0]?.textContent?.trim();
      if (k && v) props[k] = v;
    }
    const geoms: Geometry[] = [];
    for (const p of Array.from(pm.getElementsByTagName("Point"))) geoms.push(...flattenGeometry({ type: "Point", coordinates: coords(p.getElementsByTagName("coordinates")[0]?.textContent)[0] }));
    for (const l of Array.from(pm.getElementsByTagName("LineString"))) geoms.push(...flattenGeometry({ type: "LineString", coordinates: coords(l.getElementsByTagName("coordinates")[0]?.textContent) }));
    for (const pg of Array.from(pm.getElementsByTagName("Polygon"))) {
      const rings = [...Array.from(pg.getElementsByTagName("outerBoundaryIs")), ...Array.from(pg.getElementsByTagName("innerBoundaryIs"))]
        .map((b) => coords(b.getElementsByTagName("coordinates")[0]?.textContent));
      geoms.push(...flattenGeometry({ type: "Polygon", coordinates: rings }));
    }
    for (const geometry of geoms) out.push({ geometry, properties: { ...props } });
  }
  return out;
}

function fromGPX(text: string): ParsedFeature[] {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("This file is not valid GPX.");
  const pt = (e: Element): Position => [Number(e.getAttribute("lon")), Number(e.getAttribute("lat"))];
  const meta = (e: Element): Props => {
    const p: Props = {};
    for (const k of ["name", "desc", "ele", "type"]) { const v = Array.from(e.children).find((c) => c.localName === k)?.textContent?.trim(); if (v) p[k === "desc" ? "description" : k] = v; }
    return p;
  };
  const out: ParsedFeature[] = [];
  for (const w of Array.from(doc.getElementsByTagName("wpt"))) out.push(...flattenGeometry({ type: "Point", coordinates: pt(w) }).map((geometry) => ({ geometry, properties: meta(w) })));
  for (const r of Array.from(doc.getElementsByTagName("rte"))) out.push(...flattenGeometry({ type: "LineString", coordinates: Array.from(r.getElementsByTagName("rtept")).map(pt) }).map((geometry) => ({ geometry, properties: meta(r) })));
  for (const t of Array.from(doc.getElementsByTagName("trk"))) {
    for (const seg of Array.from(t.getElementsByTagName("trkseg"))) {
      out.push(...flattenGeometry({ type: "LineString", coordinates: Array.from(seg.getElementsByTagName("trkpt")).map(pt) }).map((geometry) => ({ geometry, properties: meta(t) })));
    }
  }
  return out;
}

export async function readMapFile(file: File): Promise<ParsedFeature[]> {
  const name = file.name.toLowerCase();
  const text = await file.text();
  if (name.endsWith(".kml")) return fromKML(text);
  if (name.endsWith(".gpx")) return fromGPX(text);
  if (name.endsWith(".geojson") || name.endsWith(".json")) return fromGeoJSON(text);
  throw new Error("Import GeoJSON, KML or GPX files. For Shapefile or GeoPackage, convert to GeoJSON first (for example in QGIS).");
}

export const _test = { fromGeoJSON, fromKML, fromGPX };
