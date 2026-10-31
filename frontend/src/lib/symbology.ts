// How a layer is drawn on the map viewer (and on a dashboard's map): one colour for everything, a colour per value of a
// field, or a colour ramp over a number. Pure functions, so the viewer, the dashboard and the tests all agree.
import type { Feature, SymbolSpec } from "./types";
import { cleanSymbolSpec } from "./symbols";

export const PALETTE = ["#1f6b52", "#2f6fb0", "#d98a0b", "#7b5ea7", "#c0392b", "#0f8b8d", "#b8431a", "#6b7a1f", "#d1478c", "#555f6b"];
export const RAMPS: { id: string; label: string; colors: string[] }[] = [
  { id: "green", label: "Greens", colors: ["#e3f2ea", "#a9d8bd", "#5fb287", "#2f8a5f", "#145a3c"] },
  { id: "blue", label: "Blues", colors: ["#e4eefa", "#b3cdee", "#6f9fdb", "#2f6fb0", "#163f73"] },
  { id: "heat", label: "Yellow to red", colors: ["#fff3c4", "#fdc96b", "#f58f3b", "#d8512a", "#8f1d1d"] },
  { id: "purple", label: "Purples", colors: ["#efe9f7", "#cdbfe6", "#a28ccd", "#7b5ea7", "#472f73"] },
];

export interface SymbolStyle {
  color: string;      // fill (areas), dot (points), stroke (lines)
  outline: string;    // outline of areas and dots
  size: number;       // dot radius in px
  width: number;      // line and outline width in px
  opacity: number;    // 0.1 – 1
}
export type Renderer =
  | { kind: "single" }
  | { kind: "unique"; field: string; classes: { value: string; color: string; /** A symbol for this value; wins over the layer's. */ icon?: SymbolSpec }[]; other: string }
  | { kind: "graduated"; field: string; ramp: string; classes: { min: number; max: number; color: string }[] };

/** `icon`: draw points as this symbol instead of a dot (in the class colour unless the symbol has its own). */
export interface LayerStyle { visible: boolean; symbol: SymbolStyle; renderer: Renderer; icon?: SymbolSpec }
export const BASEMAPS = [
  { id: "streets", label: "Streets" },
  { id: "light", label: "Light" },
  { id: "none", label: "No basemap" },
] as const;
export type BasemapId = (typeof BASEMAPS)[number]["id"];
/** Everything the viewer remembers about how a project's data is drawn. */
export interface ViewerStyle { basemap: BasemapId; layers: Record<string, LayerStyle> }

export const DEFAULT_SYMBOL: SymbolStyle = { color: PALETTE[0], outline: "#ffffff", size: 7, width: 2.5, opacity: 0.85 };
export const defaultLayer = (index: number): LayerStyle => ({ visible: true, symbol: { ...DEFAULT_SYMBOL, color: PALETTE[index % PALETTE.length] }, renderer: { kind: "single" } });
export const emptyViewerStyle = (): ViewerStyle => ({ basemap: "streets", layers: {} });
export const layerOf = (v: ViewerStyle, formId: string, index = 0): LayerStyle => v.layers[formId] ?? defaultLayer(index);

const HEX = /^#[0-9a-fA-F]{6}$/;
const hex = (v: unknown, fallback: string) => (typeof v === "string" && HEX.test(v) ? v : fallback);
const num = (v: unknown, fallback: number, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);

/** Anything read back from storage or the server is checked before use: a bad value falls back to the default instead of breaking the map. */
export function cleanLayer(raw: unknown, index = 0): LayerStyle {
  const base = defaultLayer(index);
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<LayerStyle>;
  const s = (r.symbol ?? {}) as Partial<SymbolStyle>;
  const symbol: SymbolStyle = { color: hex(s.color, base.symbol.color), outline: hex(s.outline, base.symbol.outline), size: num(s.size, base.symbol.size, 3, 20), width: num(s.width, base.symbol.width, 0.5, 8), opacity: num(s.opacity, base.symbol.opacity, 0.1, 1) };
  const rr = r.renderer as Renderer | undefined;
  let renderer: Renderer = { kind: "single" };
  if (rr?.kind === "unique" && typeof rr.field === "string" && Array.isArray(rr.classes)) {
    renderer = { kind: "unique", field: rr.field, other: hex(rr.other, "#9aa3ad"), classes: rr.classes.slice(0, 30).filter((c) => c && typeof c.value === "string").map((c) => { const icon = cleanSymbolSpec(c.icon); return { value: c.value, color: hex(c.color, PALETTE[0]), ...(icon ? { icon } : {}) }; }) };
  } else if (rr?.kind === "graduated" && typeof rr.field === "string" && Array.isArray(rr.classes)) {
    renderer = { kind: "graduated", field: rr.field, ramp: typeof rr.ramp === "string" ? rr.ramp : "green", classes: rr.classes.slice(0, 10).filter((c) => c && Number.isFinite(c.min) && Number.isFinite(c.max)).map((c) => ({ min: c.min, max: c.max, color: hex(c.color, PALETTE[0]) })) };
  }
  const icon = cleanSymbolSpec(r.icon);
  return { visible: r.visible !== false, symbol, renderer, ...(icon ? { icon } : {}) };
}
export function cleanViewerStyle(raw: unknown): ViewerStyle {
  const out = emptyViewerStyle();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Partial<ViewerStyle>;
  if (BASEMAPS.some((b) => b.id === r.basemap)) out.basemap = r.basemap as BasemapId;
  if (r.layers && typeof r.layers === "object") for (const [k, v] of Object.entries(r.layers).slice(0, 40)) out.layers[k] = cleanLayer(v);
  return out;
}

const key = (projectId: string) => `geohub:viewer-style:${projectId}`;
/** The project's saved look, kept in this browser. The dashboard map starts from it and then keeps its own copy. */
export function loadViewerStyle(projectId: string): ViewerStyle {
  try { const t = localStorage.getItem(key(projectId)); return t ? cleanViewerStyle(JSON.parse(t)) : emptyViewerStyle(); } catch { return emptyViewerStyle(); }
}
export function saveViewerStyle(projectId: string, v: ViewerStyle): void {
  try { localStorage.setItem(key(projectId), JSON.stringify(v)); } catch { /* private mode or full: the style just is not remembered */ }
}

// ---- turning a record into a colour ----
/** What a symbology needs from a record. The review status can be used like any field, under this name (same as the dashboards). */
export type Rec = Pick<Feature, "properties" | "status">;
export const STATUS_KEY = "__status";
const STATUS_NAMES: Record<string, string> = { draft: "Draft", submitted: "Waiting for review", approved: "Approved", rejected: "Rejected" };
/** What a class is called to people: raw status codes get their usual names, everything else is shown as it is. */
export const classLabel = (field: string, value: string): string => (field === STATUS_KEY ? STATUS_NAMES[value] ?? value : value);
/** How a dashboard map is drawn until someone styles it: by review status, as dashboard maps always were. */
export const statusLayer = (): LayerStyle => ({
  visible: true, symbol: { ...DEFAULT_SYMBOL },
  renderer: { kind: "unique", field: STATUS_KEY, other: "#9aa3ad", classes: [{ value: "approved", color: "#1f6b52" }, { value: "submitted", color: "#d98a0b" }, { value: "rejected", color: "#c0392b" }, { value: "draft", color: "#9aa3ad" }] },
});
const get = (f: Rec, field: string): unknown => (field === STATUS_KEY ? f.status : f.properties[field]);
const asNumber = (v: unknown): number | null => { if (typeof v === "number") return Number.isFinite(v) ? v : null; if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v); return null; };
/** The text a value is grouped under. Several choices count as one group per choice, so a record can sit in more than one class. */
export const valueKeys = (v: unknown): string[] => (v == null || v === "" ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

export function colorOf(f: Rec, ls: LayerStyle): string {
  const r = ls.renderer;
  if (r.kind === "unique") {
    for (const k of valueKeys(get(f, r.field))) { const c = r.classes.find((x) => x.value === k); if (c) return c.color; }
    return r.other;
  }
  if (r.kind === "graduated") {
    const n = asNumber(get(f, r.field));
    if (n == null) return "#9aa3ad";
    const last = r.classes.length - 1;
    const c = r.classes.find((x, i) => n >= x.min && (n < x.max || i === last));
    return c ? c.color : "#9aa3ad";
  }
  return ls.symbol.color;
}

/** The symbol a record is drawn with: its class's own, else the layer's, else none (a dot). */
export function iconOf(f: Rec, ls: LayerStyle): SymbolSpec | undefined {
  const r = ls.renderer;
  if (r.kind === "unique") for (const k of valueKeys(get(f, r.field))) { const c = r.classes.find((x) => x.value === k); if (c) return c.icon ?? ls.icon; }
  return ls.icon;
}
/** Classes for "a colour per value": the most common values first, everything else falls into "Other". */
export function uniqueClasses(features: Rec[], field: string, max = 8): Extract<Renderer, { kind: "unique" }> {
  const counts = new Map<string, number>();
  for (const f of features) for (const k of valueKeys(get(f, field))) counts.set(k, (counts.get(k) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max);
  return { kind: "unique", field, other: "#9aa3ad", classes: top.map(([value], i) => ({ value, color: PALETTE[i % PALETTE.length] })) };
}
/** Classes for "a colour ramp over a number": equal steps from the lowest to the highest value. */
export function graduatedClasses(features: Rec[], field: string, ramp = "green", steps = 5): Extract<Renderer, { kind: "graduated" }> {
  const vals = features.map((f) => asNumber(get(f, field))).filter((n): n is number => n != null);
  const colors = (RAMPS.find((r) => r.id === ramp) ?? RAMPS[0]).colors;
  const n = Math.min(steps, colors.length);
  if (!vals.length) return { kind: "graduated", field, ramp, classes: [] };
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const step = (hi - lo) / n || 1;
  const pick = (i: number) => colors[n === 1 ? colors.length - 1 : Math.round((i * (colors.length - 1)) / (n - 1))];
  return { kind: "graduated", field, ramp, classes: Array.from({ length: n }, (_, i) => ({ min: lo + step * i, max: i === n - 1 ? hi : lo + step * (i + 1), color: pick(i) })) };
}
const round = (n: number) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100);

/** One row of a legend: what it means, its colour, and how many records have it. */
export interface LegendRow { label: string; color: string; count: number; icon?: SymbolSpec }
export function legendOf(features: Rec[], ls: LayerStyle): LegendRow[] {
  const r = ls.renderer;
  if (r.kind === "single") return [{ label: "All records", color: ls.symbol.color, count: features.length, ...(ls.icon ? { icon: ls.icon } : {}) }];
  const rows: LegendRow[] = [];
  if (r.kind === "unique") {
    for (const c of r.classes) rows.push({ label: classLabel(r.field, c.value), color: c.color, count: features.filter((f) => valueKeys(get(f, r.field)).includes(c.value)).length, ...((c.icon ?? ls.icon) ? { icon: c.icon ?? ls.icon } : {}) });
    const known = new Set(r.classes.map((c) => c.value));
    const other = features.filter((f) => !valueKeys(get(f, r.field)).some((k) => known.has(k))).length;
    if (other) rows.push({ label: "Other / blank", color: r.other, count: other, ...(ls.icon ? { icon: ls.icon } : {}) });
    return rows;
  }
  const last = r.classes.length - 1;
  for (const [i, c] of r.classes.entries()) rows.push({ label: `${round(c.min)} – ${round(c.max)}`, color: c.color, count: features.filter((f) => { const n = asNumber(get(f, r.field)); return n != null && n >= c.min && (n < c.max || i === last); }).length });
  const none = features.filter((f) => asNumber(get(f, r.field)) == null).length;
  if (none) rows.push({ label: "No value", color: "#9aa3ad", count: none });
  return rows;
}
