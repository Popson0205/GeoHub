import type { Feature, Form, Geometry } from "./types";
import { columnFields } from "./fieldSpec";

/** Something about a record a reviewer should look at. Flags are hints, never blocks. */
export interface QualityFlag {
  kind: "gps" | "manual" | "duplicate";
  /** Short, for a chip: "GPS ±48 m". */
  label: string;
  /** One sentence, for a tooltip or the review screen. */
  detail: string;
  /** The other record, for a possible duplicate. */
  other?: string;
}

/** GPS readings worse than this are flagged. Phones outdoors usually manage 5 to 15 m. */
export const POOR_GPS_M = 30;
/** Two records of the same form this close are flagged whatever they are called. */
export const SAME_SPOT_M = 5;
/** Two records this close with the same name are flagged. */
export const SAME_NAME_M = 50;

const R = 6371000, RAD = Math.PI / 180;
function centre(g: Geometry): [number, number] {
  if (g.type === "Point") return g.coordinates as [number, number];
  const pts = (g.type === "LineString" ? g.coordinates : (g.coordinates as number[][][]).flat()) as number[][];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}
export function distanceM(a: [number, number], b: [number, number]): number {
  const dLat = (b[1] - a[1]) * RAD, dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const norm = (v: unknown) => (typeof v === "string" ? v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() : "");

/**
 * Flags for each record of one form. Duplicates are found with a grid of cells about 50 m across, so a
 * project with thousands of records is still checked in a moment. Rejected and deleted records are left out.
 */
export function qualityFlags(records: Feature[], form?: Form): Map<string, QualityFlag[]> {
  const out = new Map<string, QualityFlag[]>();
  const add = (id: string, f: QualityFlag) => { const l = out.get(id); if (l) l.push(f); else out.set(id, [f]); };
  const nameField = form ? columnFields(form.fields).find((f) => f.type === "text")?.id : undefined;
  const live = records.filter((r) => !r.deleted && r.status !== "rejected" && r.geometry);

  for (const r of live) {
    const acc = Number(r.properties.gps_hacc_m);
    if (Number.isFinite(acc) && acc > POOR_GPS_M) add(r.id, { kind: "gps", label: `GPS ±${Math.round(acc)} m`, detail: `The location may be off by up to ${Math.round(acc)} m. Readings under ${POOR_GPS_M} m are normal outdoors.` });
    else if (r.properties.gps_src === "map") add(r.id, { kind: "manual", label: "Placed by hand", detail: "The location was placed on the map, not taken from the phone's GPS." });
  }

  // possible duplicates: same form, very close, or close with the same name
  const items = live.map((r) => ({ r, c: centre(r.geometry), name: nameField ? norm(r.properties[nameField]) : "" }));
  const cellY = SAME_NAME_M / 111320;                    // degrees of latitude in one cell
  const meanLat = items.length ? items.reduce((s, i) => s + i.c[1], 0) / items.length : 0;
  const cellX = cellY / Math.max(Math.cos(meanLat * RAD), 0.1);   // a degree of longitude is shorter away from the equator
  const grid = new Map<string, { r: Feature; c: [number, number]; name: string }[]>();
  const keyOf = (c: [number, number]) => `${Math.floor(c[0] / cellX)}:${Math.floor(c[1] / cellY)}`;
  for (const it of items) { const k = keyOf(it.c); const l = grid.get(k); if (l) l.push(it); else grid.set(k, [it]); }
  const seen = new Set<string>();
  for (const a of items) {
    const [cx, cy] = [Math.floor(a.c[0] / cellX), Math.floor(a.c[1] / cellY)];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const b of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
        if (b.r.id <= a.r.id || b.r.form_id !== a.r.form_id) continue;      // each pair once, same form only
        const pair = `${a.r.id}|${b.r.id}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        const d = distanceM(a.c, b.c);
        const sameName = !!a.name && a.name === b.name;
        if (d <= SAME_SPOT_M || (sameName && d <= SAME_NAME_M)) {
          const why = sameName ? "same name" : "same spot";
          const metres = d < 1 ? "under 1 m" : `${Math.round(d)} m`;
          const title = (r: Feature) => (nameField && typeof r.properties[nameField] === "string" && r.properties[nameField]) || "another record";
          add(a.r.id, { kind: "duplicate", label: "Possible duplicate", detail: `“${title(b.r)}” is ${metres} away (${why}).`, other: b.r.id });
          add(b.r.id, { kind: "duplicate", label: "Possible duplicate", detail: `“${title(a.r)}” is ${metres} away (${why}).`, other: a.r.id });
        }
      }
    }
  }
  return out;
}
