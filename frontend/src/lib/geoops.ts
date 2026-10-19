/**
 * Geometry operations for digitizing: move, split, merge, duplicate.
 * Pure functions on GeoJSON-like geometries. The heavy ones (cutting and merging polygons) load Turf on first use,
 * so the map editor opens as fast as before.
 */
import type { Geometry, Position } from "./types";

type LS = Extract<Geometry, { type: "LineString" }>;
type PG = Extract<Geometry, { type: "Polygon" }>;

const EPS = 1e-9;                  // degrees; about a tenth of a millimetre
const JOIN_TOL = 1e-7;             // degrees; about a centimetre. Line ends closer than this count as touching.
const eq = (a: Position, b: Position, tol = EPS) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;

/** Shift a geometry by a number of degrees. */
export function translate(g: Geometry, dx: number, dy: number): Geometry {
  const mv = (c: Position): Position => [c[0] + dx, c[1] + dy];
  if (g.type === "Point") return { type: "Point", coordinates: mv(g.coordinates) };
  if (g.type === "LineString") return { type: "LineString", coordinates: g.coordinates.map(mv) };
  return { type: "Polygon", coordinates: g.coordinates.map((r) => r.map(mv)) };
}

/** Where a point falls on a line: which segment, how far along it (0..1), the snapped position, and the distance to it. */
export function locateOnLine(coords: Position[], p: Position): { seg: number; t: number; pos: Position; dist: number } {
  const k = Math.cos((p[1] * Math.PI) / 180) || 1;           // squash longitude so degrees are comparable
  let best = { seg: 0, t: 0, pos: coords[0], dist: Infinity };
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i], b = coords[i + 1];
    const ax = a[0] * k, ay = a[1], bx = b[0] * k, by = b[1], px = p[0] * k, py = p[1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const qx = ax + t * dx, qy = ay + t * dy;
    const dist = Math.hypot(px - qx, py - qy);
    if (dist < best.dist) best = { seg: i, t, pos: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], dist };
  }
  return best;
}

/** Cut a line at the given positions (each assumed to lie on it). Returns the pieces in order, or null when nothing was cut. */
function cutLineAt(coords: Position[], points: Position[]): LS[] | null {
  const marks = points.map((p) => locateOnLine(coords, p)).sort((a, b) => a.seg + a.t - (b.seg + b.t));
  const add = (path: Position[], c: Position) => { if (!path.length || !eq(path[path.length - 1], c)) path.push(c); };
  const pieces: Position[][] = [];
  let cur: Position[] = [coords[0]];
  let next = 1;                                               // next original vertex not yet copied
  for (const m of marks) {
    for (; next <= m.seg; next++) add(cur, coords[next]);
    add(cur, m.pos);
    if (cur.length >= 2) pieces.push(cur);
    cur = [m.pos];
  }
  for (; next < coords.length; next++) add(cur, coords[next]);
  if (cur.length >= 2) pieces.push(cur);
  return pieces.length >= 2 ? pieces.map((c) => ({ type: "LineString" as const, coordinates: c })) : null;
}

/** Split a line where the user clicked. Returns null when the click is at an end of the line (nothing to split). */
export function splitLineAtPoint(line: LS, click: Position): LS[] | null {
  const m = locateOnLine(line.coordinates, click);
  return cutLineAt(line.coordinates, [m.pos]);
}

type Fc = { type: "FeatureCollection"; features: any[] };
const feat = (g: unknown) => ({ type: "Feature", properties: {}, geometry: g });
const fc = (...g: unknown[]): Fc => ({ type: "FeatureCollection", features: g.map(feat) });

/** Split a line or a polygon with a cutting line. Lines are cut where the cutter crosses them; a polygon must be crossed edge to edge. */
export async function cutByLine(target: Geometry, cutter: LS): Promise<Geometry[] | null> {
  if (target.type === "Point") return null;
  if (target.type === "LineString") {
    const { lineIntersect } = await import("@turf/line-intersect");
    const hits = (lineIntersect(feat(target) as never, feat(cutter) as never) as any).features.map((f: any) => f.geometry.coordinates as Position);
    return hits.length ? cutLineAt(target.coordinates, hits) : null;
  }
  const [{ buffer }, { difference }] = await Promise.all([import("@turf/buffer"), import("@turf/difference")]);
  // Take a sliver (2 mm wide) out of the area along the cutter. If the cutter goes edge to edge, the area falls into pieces.
  const sliver = buffer(feat(cutter) as never, 0.001, { units: "meters" }) as any;
  if (!sliver) return null;
  const rest = difference(fc(target, sliver.geometry) as never) as any;
  if (!rest) return null;
  const parts: PG[] = rest.geometry.type === "MultiPolygon" ? rest.geometry.coordinates.map((c: unknown) => ({ type: "Polygon" as const, coordinates: c as Position[][] })) : [rest.geometry as PG];
  return parts.length >= 2 ? parts : null;
}

/** Join lines end to end into one line. Returns null unless they form a single chain. */
function joinLines(lines: LS[]): LS | null {
  const rest = lines.map((l) => l.coordinates.slice());
  let chain = rest.shift()!;
  while (rest.length) {
    const i = rest.findIndex((c) => [chain[0], chain[chain.length - 1]].some((e) => [c[0], c[c.length - 1]].some((f) => eq(e, f, JOIN_TOL))));
    if (i < 0) return null;
    const c = rest.splice(i, 1)[0];
    const head = chain[0], tail = chain[chain.length - 1];
    if (eq(tail, c[0], JOIN_TOL)) chain = [...chain, ...c.slice(1)];
    else if (eq(tail, c[c.length - 1], JOIN_TOL)) chain = [...chain, ...c.slice(0, -1).reverse()];
    else if (eq(head, c[c.length - 1], JOIN_TOL)) chain = [...c, ...chain.slice(1)];
    else chain = [...c.slice().reverse(), ...chain.slice(1)];
  }
  return { type: "LineString", coordinates: chain };
}

/** Merge lines into one line (they must connect end to end) or polygons into one polygon (they must touch or overlap). */
export async function mergeGeometries(geoms: Geometry[]): Promise<{ geometry: Geometry } | { error: string }> {
  if (geoms.length < 2) return { error: "Select two or more features to merge." };
  const types = new Set(geoms.map((g) => g.type));
  if (types.size > 1) return { error: "You can only merge features of the same kind (all lines, or all polygons)." };
  if (geoms[0].type === "Point") return { error: "Points cannot be merged." };
  if (geoms[0].type === "LineString") {
    const joined = joinLines(geoms as LS[]);
    return joined ? { geometry: joined } : { error: "These lines do not connect end to end, so they cannot become one line." };
  }
  const { union } = await import("@turf/union");
  const u = union(fc(...geoms) as never) as any;
  if (!u || u.geometry.type !== "Polygon") return { error: "These polygons do not touch or overlap, so they cannot become one polygon." };
  return { geometry: u.geometry as PG };
}
