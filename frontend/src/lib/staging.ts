/**
 * Staged edits for the map editor.
 *
 * Nothing here talks to the server. The editor keeps the server's features untouched and records what the
 * user has done on top of them as a small `Edits` record. "Save all" later turns that record into API calls.
 * Every function is pure and returns a new record, which makes undo and redo a matter of swapping records.
 */
import type { GeoFeature, Geometry, Props } from "./types";

export type Edit =
  | { kind: "new"; geometry: Geometry; properties: Props }
  | { kind: "mod"; base: GeoFeature; geometry: Geometry; properties: Props }
  | { kind: "del"; base: GeoFeature };
export type Edits = Record<string, Edit>;
export type FeatureState = "clean" | "new" | "mod";
/** Who drew a saved feature and where it stands in review. Missing for features that are not saved yet. */
export interface FeatureMeta { status?: GeoFeature["status"]; created_by?: string; author?: string; review_note?: string }
export interface WorkFeature { id: string; geometry: Geometry; properties: Props; state: FeatureState; meta?: FeatureMeta }
const metaOf = (f: GeoFeature): FeatureMeta => ({ status: f.status, created_by: f.created_by, author: f.author, review_note: f.review_note });

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The features as the user currently sees them: server features with the edits applied, then new ones. */
export function effective(server: GeoFeature[], edits: Edits): WorkFeature[] {
  const out: WorkFeature[] = [];
  for (const f of server) {
    const e = edits[f.id];
    if (!e) out.push({ id: f.id, geometry: f.geometry, properties: f.properties, state: "clean", meta: metaOf(f) });
    else if (e.kind === "mod") out.push({ id: f.id, geometry: e.geometry, properties: e.properties, state: "mod", meta: metaOf(f) });
    // "del": hidden
  }
  for (const [id, e] of Object.entries(edits)) if (e.kind === "new") out.push({ id, geometry: e.geometry, properties: e.properties, state: "new" });
  return out;
}

export function current(server: GeoFeature[], edits: Edits, id: string): WorkFeature | undefined {
  const e = edits[id];
  if (e) {
    if (e.kind === "new") return { id, geometry: e.geometry, properties: e.properties, state: "new" };
    if (e.kind === "mod") return { id, geometry: e.geometry, properties: e.properties, state: "mod", meta: metaOf(e.base) };
    return undefined;
  }
  const f = server.find((x) => x.id === id);
  return f ? { id, geometry: f.geometry, properties: f.properties, state: "clean", meta: metaOf(f) } : undefined;
}

/** Drop a "mod" that has been put back exactly as it was on the server. */
function tidy(edits: Edits, id: string): Edits {
  const e = edits[id];
  if (e?.kind === "mod" && same(e.geometry, e.base.geometry) && same(e.properties, e.base.properties)) {
    const { [id]: _gone, ...rest } = edits;
    return rest;
  }
  return edits;
}

export function addNew(edits: Edits, id: string, geometry: Geometry, properties: Props = {}): Edits {
  return { ...edits, [id]: { kind: "new", geometry, properties } };
}

function patch(edits: Edits, server: GeoFeature[], id: string, p: { geometry?: Geometry; properties?: Props }): Edits {
  const e = edits[id];
  if (e?.kind === "del") return edits;
  if (e?.kind === "new") return { ...edits, [id]: { ...e, ...p } };
  if (e?.kind === "mod") return tidy({ ...edits, [id]: { ...e, ...p } }, id);
  const base = server.find((f) => f.id === id);
  if (!base) return edits;
  return tidy({ ...edits, [id]: { kind: "mod", base, geometry: p.geometry ?? base.geometry, properties: p.properties ?? base.properties } }, id);
}
export const setGeometry = (edits: Edits, server: GeoFeature[], id: string, geometry: Geometry) => patch(edits, server, id, { geometry });
export const setProperties = (edits: Edits, server: GeoFeature[], id: string, properties: Props) => patch(edits, server, id, { properties });

export function removeFeature(edits: Edits, server: GeoFeature[], id: string): Edits {
  const e = edits[id];
  if (e?.kind === "new") { const { [id]: _gone, ...rest } = edits; return rest; }
  const base = e?.kind === "mod" ? e.base : server.find((f) => f.id === id);
  if (!base) return edits;
  return { ...edits, [id]: { kind: "del", base } };
}

/** Replace one feature by several pieces (a split). The first piece keeps the id and tags; the rest are new copies. */
export function replaceWithPieces(edits: Edits, server: GeoFeature[], id: string, pieces: Geometry[], newId: () => string): { edits: Edits; ids: string[] } {
  const cur = current(server, edits, id);
  if (!cur || pieces.length < 2) return { edits, ids: [id] };
  let next = setGeometry(edits, server, id, pieces[0]);
  const ids = [id];
  for (const g of pieces.slice(1)) { const nid = newId(); next = addNew(next, nid, g, { ...cur.properties }); ids.push(nid); }
  return { edits: next, ids };
}

/** Merge several features into the first one: it takes the merged shape, the others are removed. Tags of the first win. */
export function mergeInto(edits: Edits, server: GeoFeature[], ids: string[], geometry: Geometry): Edits {
  const [keep, ...rest] = ids;
  const cur = current(server, edits, keep);
  if (!cur) return edits;
  const props: Props = {};
  for (const id of [...rest].reverse()) Object.assign(props, current(server, edits, id)?.properties ?? {});
  Object.assign(props, cur.properties);
  let next = patch(edits, server, keep, { geometry, properties: props });
  for (const id of rest) next = removeFeature(next, server, id);
  return next;
}

export function summarize(edits: Edits) {
  let created = 0, modified = 0, deleted = 0;
  for (const e of Object.values(edits)) { if (e.kind === "new") created++; else if (e.kind === "mod") modified++; else deleted++; }
  return { created, modified, deleted, total: created + modified + deleted };
}

/** Undo/redo stack of Edits records. `key` lets a burst of similar edits (typing a tag) share one history step. */
export interface History { past: Edits[]; present: Edits; future: Edits[]; key: string | null }
export const newHistory = (): History => ({ past: [], present: {}, future: [], key: null });
export function commit(h: History, next: Edits, key: string | null = null): History {
  if (next === h.present) return h;
  if (key && key === h.key) return { ...h, present: next, future: [] };      // coalesce into the previous step
  return { past: [...h.past.slice(-99), h.present], present: next, future: [], key };
}
export const undo = (h: History): History => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], key: null } : h);
export const redo = (h: History): History => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), key: null } : h);
/** After a save everything staged is on the server; keep the stack but make it unreachable. */
export const reset = (edits: Edits = {}): History => ({ past: [], present: edits, future: [], key: null });
