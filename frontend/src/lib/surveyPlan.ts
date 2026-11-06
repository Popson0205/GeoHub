/**
 * Plotting a plot from its survey plan, on the phone and offline: a bearing-and-distance traverse from a starting
 * point, or beacon coordinates, on the grid the plan uses. The same sums as Land Registry's survey engine
 * (plane trigonometry on the grid, misclosure and closure ratio, Bowditch adjustment), so a boundary plotted in the
 * field and one checked in the registry agree. The plan itself is kept with the record (`plan_json`), and Land
 * Registry recomputes the boundary from it with its own engine and ground control.
 */
import proj4 from "proj4";
import type { Geometry } from "./types";

const MINNA = "+ellps=clrk80 +towgs84=-92,-93,122,0,0,0,0 +units=m +no_defs";
export const GRIDS: { epsg: number; name: string; def: string }[] = [
  { epsg: 26332, name: "Minna / UTM zone 32N (FCT, east and centre)", def: `+proj=utm +zone=32 ${MINNA}` },
  { epsg: 26331, name: "Minna / UTM zone 31N (south-west)", def: `+proj=utm +zone=31 ${MINNA}` },
  { epsg: 26391, name: "Minna / Nigeria West Belt", def: `+proj=tmerc +lat_0=4 +lon_0=4.5 +k=0.99975 +x_0=230738.26 +y_0=0 ${MINNA}` },
  { epsg: 26392, name: "Minna / Nigeria Mid Belt", def: `+proj=tmerc +lat_0=4 +lon_0=8.5 +k=0.99975 +x_0=670553.98 +y_0=0 ${MINNA}` },
  { epsg: 26393, name: "Minna / Nigeria East Belt", def: `+proj=tmerc +lat_0=4 +lon_0=12.5 +k=0.99975 +x_0=1110369.7 +y_0=0 ${MINNA}` },
  { epsg: 32632, name: "WGS 84 / UTM zone 32N", def: "+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs" },
  { epsg: 32631, name: "WGS 84 / UTM zone 31N", def: "+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs" },
];
/** Closures worse than this are refused, as in Land Registry's default rule. */
export const MIN_RATIO = 3000;

export type Leg = [string, string, string, string];            // degrees, minutes, seconds, distance (m)
export interface Plan { v: 1; grid: number; method: "traverse" | "coordinates"; start?: [number, number]; legs?: [number, number, number, number][];
  points?: [number, number][]; ratio: number | null; misclosure_m: number; area_m2: number; perimeter_m: number }
export type Plotted = { ok: true; plan: Plan; geometry: Geometry; warnings: string[] } | { ok: false; problem: string };

const num = (s: string) => (s.trim() === "" ? NaN : Number(s.replace(/,/g, "")));

/** Degrees from three boxes; an empty minute or second is 0. */
export function bearing(d: string, m: string, s: string): number | null {
  const D = num(d), M = m.trim() ? num(m) : 0, S = s.trim() ? num(s) : 0;
  if (!Number.isInteger(D) || D < 0 || D >= 360 || !Number.isInteger(M) || M < 0 || M >= 60 || !(S >= 0 && S < 60)) return null;
  return D + M / 60 + S / 3600;
}

function toLonLat(epsg: number, pts: [number, number][]): [number, number][] {
  const g = GRIDS.find((x) => x.epsg === epsg);
  if (!g) throw new Error(`Unknown grid ${epsg}`);
  const tr = proj4(g.def, "EPSG:4326");
  return pts.map((p) => tr.forward(p) as [number, number]);
}

function shoelace(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2;
}

function crosses(pts: [number, number][]): boolean {
  const n = pts.length;
  const ccw = (a: number[], b: number[], c: number[]) => (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0]);
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    const [a, b, c, d] = [pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n]];
    if (ccw(a, c, d) * ccw(b, c, d) < 0 && ccw(a, b, c) * ccw(a, b, d) < 0) return true;
  }
  return false;
}

function finish(grid: number, plan: Omit<Plan, "area_m2" | "perimeter_m">, pts: [number, number][], warnings: string[]): Plotted {
  if (pts.length < 3) return { ok: false, problem: "A plot needs at least 3 corners." };
  if (crosses(pts)) return { ok: false, problem: "The boundary crosses itself: check the order of the legs or beacons." };
  const area = shoelace(pts);
  if (area < 1) return { ok: false, problem: "The plot has no area: the corners are on one line." };
  const perim = pts.reduce((s, p, i) => s + Math.hypot(pts[(i + 1) % pts.length][0] - p[0], pts[(i + 1) % pts.length][1] - p[1]), 0);
  const ll = toLonLat(grid, pts);
  if (ll.some(([lon, lat]) => !(lon >= 2.5 && lon <= 15 && lat >= 4 && lat <= 14)))
    return { ok: false, problem: "The plot falls outside Nigeria: check the grid and the starting point." };
  const ring = [...ll.map(([x, y]) => [Math.round(x * 1e9) / 1e9, Math.round(y * 1e9) / 1e9]), [Math.round(ll[0][0] * 1e9) / 1e9, Math.round(ll[0][1] * 1e9) / 1e9]];
  return { ok: true, plan: { ...plan, area_m2: Math.round(area * 100) / 100, perimeter_m: Math.round(perim * 100) / 100 } as Plan,
    geometry: { type: "Polygon", coordinates: [ring] } as Geometry, warnings };
}

/** A traverse: start at (e, n), walk each leg, measure how far the last one ends from the start, spread that error. */
export function plotTraverse(grid: number, start: [string, string], legs: Leg[]): Plotted {
  const e0 = num(start[0]), n0 = num(start[1]);
  if (!Number.isFinite(e0) || !Number.isFinite(n0)) return { ok: false, problem: "Give the starting point's easting and northing." };
  const rows = legs.filter((l) => l.some((x) => x.trim()));
  if (rows.length < 3) return { ok: false, problem: "A plot's traverse needs at least 3 legs." };
  const walked: [number, number, number, number][] = [];
  for (const [i, [d, m, s, dist]] of rows.entries()) {
    const b = bearing(d, m, s), L = num(dist);
    if (b == null) return { ok: false, problem: `Leg ${i + 1}: degrees 0 to 359, minutes and seconds 0 to 59.` };
    if (!(L > 0)) return { ok: false, problem: `Leg ${i + 1} needs a distance.` };
    walked.push([num(d), m.trim() ? num(m) : 0, s.trim() ? num(s) : 0, L]);
  }
  let e = e0, n = n0;
  const raw: [number, number][] = [[e, n]];
  for (const [d, m, s, L] of walked) {
    const r = ((d + m / 60 + s / 3600) * Math.PI) / 180;
    e += L * Math.sin(r); n += L * Math.cos(r);
    raw.push([e, n]);
  }
  const per = walked.reduce((t, l) => t + l[3], 0);
  const de = e - e0, dn = n - n0, mis = Math.hypot(de, dn);
  const ratio = mis < 1e-6 ? null : Math.floor(per / mis);
  if (ratio != null && ratio < MIN_RATIO)
    return { ok: false, problem: `The traverse does not close: it ends ${mis.toFixed(2)} m from the start (1 in ${ratio.toLocaleString()}). Check each bearing and distance against the plan.` };
  let acc = 0;
  const pts = raw.slice(0, -1).map((p, i) => {                  // Bowditch: each corner moves in proportion to the distance walked to it
    if (i === 0) return p;
    acc += walked[i - 1][3];
    return [p[0] - (de * acc) / per, p[1] - (dn * acc) / per] as [number, number];
  });
  return finish(grid, { v: 1, grid, method: "traverse", start: [e0, n0], legs: walked, ratio, misclosure_m: Math.round(mis * 1000) / 1000 }, pts, []);
}

/** Beacon coordinates on the grid, in order around the plot. */
export function plotCoordinates(grid: number, rows: [string, string][]): Plotted {
  const filled = rows.filter((r) => r.some((x) => x.trim()));
  const pts: [number, number][] = [];
  for (const [i, [e, n]] of filled.entries()) {
    if (!Number.isFinite(num(e)) || !Number.isFinite(num(n))) return { ok: false, problem: `Beacon ${i + 1} needs both an easting and a northing.` };
    pts.push([num(e), num(n)]);
  }
  return finish(grid, { v: 1, grid, method: "coordinates", points: pts, ratio: null, misclosure_m: 0 }, pts, []);
}

/** The plan as kept with the record (a property of the feature), and back. */
export const planText = (p: Plan) => JSON.stringify(p);
export function readPlan(v: unknown): Plan | null {
  if (typeof v !== "string" || !v.startsWith("{")) return null;
  try { const p = JSON.parse(v); return p && p.v === 1 ? (p as Plan) : null; } catch { return null; }
}
