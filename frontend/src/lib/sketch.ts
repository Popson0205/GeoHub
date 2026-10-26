import type { Position } from "./types";

/** The shape being drawn, as map features: translucent fill, solid line, dashed segment to the pointer, and the vertices.
 *  `kind` tells the map how to style each piece. The first vertex of a polygon is "first" (click it to close). */
export function draftFeatures(polygon: boolean, v: Position[], cursor: Position | null) {
  const f = (kind: string, geometry: unknown) => ({ type: "Feature" as const, geometry, properties: { kind } });
  const line = (c: Position[]) => ({ type: "LineString", coordinates: c });
  const out: ReturnType<typeof f>[] = [];
  if (!v.length) return out;
  const path = cursor ? [...v, cursor] : v;
  if (polygon && path.length >= 3) out.push(f("fill", { type: "Polygon", coordinates: [[...path, path[0]]] }));
  if (v.length > 1) out.push(f("line", line(v)));
  if (cursor) {
    out.push(f("rubber", line([v[v.length - 1], cursor])));
    if (polygon && v.length >= 2) out.push(f("rubber", line([cursor, v[0]])));          // where the polygon will close
  } else if (polygon && v.length > 2) out.push(f("rubber", line([v[v.length - 1], v[0]])));
  v.forEach((c, i) => out.push(f(polygon && i === 0 ? "first" : i === v.length - 1 && !cursor ? "last" : "v", { type: "Point", coordinates: c })));
  if (cursor && !(polygon && v.length === 1)) out.push(f("last", { type: "Point", coordinates: v[v.length - 1] }));
  return out;
}

/** Distance in metres along a path (haversine). */
export function pathLength(c: Position[]): number {
  const R = 6371008.8, rad = Math.PI / 180;
  let m = 0;
  for (let i = 1; i < c.length; i++) {
    const [x1, y1] = c[i - 1], [x2, y2] = c[i];
    const a = Math.sin(((y2 - y1) * rad) / 2) ** 2 + Math.cos(y1 * rad) * Math.cos(y2 * rad) * Math.sin(((x2 - x1) * rad) / 2) ** 2;
    m += 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return m;
}
/** Area in square metres of a small polygon (flat-earth approximation around its centre, fine for digitizing). */
export function polygonArea(c: Position[]): number {
  const R = 6371008.8, rad = Math.PI / 180, lat0 = c.reduce((t, p) => t + p[1], 0) / c.length;
  const pts = c.map(([x, y]) => [x * rad * R * Math.cos(lat0 * rad), y * rad * R]);
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a / 2);
}
export const fmtLength = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(m < 10 ? 1 : 0)} m`);
export const fmtArea = (m2: number) => (m2 >= 1e6 ? `${(m2 / 1e6).toFixed(2)} km²` : m2 >= 1e4 ? `${(m2 / 1e4).toFixed(2)} ha` : `${m2.toFixed(0)} m²`);
/** "124 m" for a line, "1.2 ha · 480 m" (area and perimeter) for a polygon. */
export function measure(polygon: boolean, c: Position[]): string {
  if (c.length < 2) return "";
  return polygon ? (c.length >= 3 ? `${fmtArea(polygonArea(c))} · ${fmtLength(pathLength([...c, c[0]]))}` : fmtLength(pathLength(c))) : fmtLength(pathLength(c));
}
