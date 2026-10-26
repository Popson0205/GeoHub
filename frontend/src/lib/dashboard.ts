// The numbers behind a dashboard. Pure functions: records in, chart data out, so they are easy to test and the
// charts only draw. Nothing here is stored: a dashboard saves which pages and charts it has, and this works the rest out
// (including where every chart goes: see autoLayout).
import { columnFields } from "./fieldSpec";
import { uuid } from "./forms";
import { cleanTheme } from "./dashboardThemes";
import type { Bucket, DashboardConfig, DashPage, Feature, FeatureStatus, FieldType, Form, Metric, TimeFilter, TimePreset, Widget, WidgetType } from "./types";

export const STATUS_LABEL: Record<FeatureStatus, string> = { draft: "Draft", submitted: "Waiting", approved: "Approved", rejected: "Rejected" };

/** A field a chart can use: a form field, or one of the extra values every record has. */
export interface FieldDef {
  id: string; label: string; type: FieldType | "status" | "updated";
  choices?: string[]; true_label?: string; false_label?: string; unit?: string;
}
export const STATUS_ID = "__status";
export const UPDATED_ID = "__updated";
const STATUS_DEF: FieldDef = { id: STATUS_ID, label: "Review status", type: "status" };
const UPDATED_DEF: FieldDef = { id: UPDATED_ID, label: "Date record changed", type: "updated" };
// Recorded by the collector with each GPS point (see lib/gps.ts)
const GPS_DEFS: FieldDef[] = [
  { id: "gps_elev_m", label: "Elevation (m)", type: "number", unit: "m" },
  { id: "gps_hacc_m", label: "GPS accuracy (m)", type: "number", unit: "m" },
];

/** Every field a dashboard can use for this form. */
export function dashboardFields(form?: Form): FieldDef[] {
  if (!form) return [];
  const own = columnFields(form.fields).map((f): FieldDef => ({ id: f.id, label: f.label || f.id, type: f.type, choices: f.choices, true_label: f.true_label, false_label: f.false_label, unit: f.unit }));
  const taken = new Set(own.map((f) => f.id));
  return [...own, ...GPS_DEFS.filter((g) => !taken.has(g.id))];
}
const GROUP_TYPES = new Set(["choice", "multi_choice", "boolean", "text", "barcode", "number", "date", "datetime"]);
export const numberFields = (d: FieldDef[]) => d.filter((f) => f.type === "number" || f.type === "calculation");
export const groupFields = (d: FieldDef[]) => [STATUS_DEF, ...d.filter((f) => GROUP_TYPES.has(f.type))];
export const dateFields = (d: FieldDef[]) => [UPDATED_DEF, ...d.filter((f) => f.type === "date" || f.type === "datetime")];
export const findField = (defs: FieldDef[], id?: string): FieldDef | undefined =>
  id === STATUS_ID ? STATUS_DEF : id === UPDATED_ID ? UPDATED_DEF : defs.find((f) => f.id === id);

const raw = (f: Feature, d: FieldDef): unknown => (d.type === "status" ? f.status : d.type === "updated" ? f.updated_at : f.properties[d.id]);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

// ---------- numbers for display ----------
export function fmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${trim((n / 1e6).toFixed(1))}M`;
  if (a >= 1e4) return `${trim((n / 1e3).toFixed(1))}k`;
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return trim(n.toFixed(a < 10 ? 2 : 1));
}
const trim = (s: string) => s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (k: string) => `${MONTHS[Number(k.slice(5, 7)) - 1] ?? k.slice(5, 7)} ${k.slice(0, 4)}`;
const dayLabel = (k: string) => `${Number(k.slice(8, 10))} ${MONTHS[Number(k.slice(5, 7)) - 1]}`;

// ---------- filters ----------
export interface Filters {
  status: "all" | FeatureStatus;
  from?: string;   // YYYY-MM-DD, on the date the record changed
  to?: string;
  equals: { field: string; value: string; label: string }[];   // set by clicking a bar or slice
}
export const noFilters = (): Filters => ({ status: "all", equals: [] });
export const isFiltered = (f: Filters) => f.status !== "all" || !!f.from || !!f.to || f.equals.length > 0;

export function filterFeatures(features: Feature[], f: Filters, defs: FieldDef[]): Feature[] {
  const bins = new Map<string, Binner | null>();
  return features.filter((r) => {
    if (f.status !== "all" && r.status !== f.status) return false;
    const day = r.updated_at.slice(0, 10);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    for (const e of f.equals) {
      const d = findField(defs, e.field);
      if (!d) continue;
      if (d.type === "number" && !bins.has(d.id)) bins.set(d.id, makeBinner(features.map((x) => num(raw(x, d))).filter((n): n is number => n != null)));
      if (!categories(r, d, bins.get(d.id) ?? null).some((c) => c.key === e.value)) return false;
    }
    return true;
  });
}

// ---------- grouping ----------
type Binner = (n: number) => { key: string; label: string };
function makeBinner(values: number[], bins = 5): Binner | null {
  if (!values.length) return null;
  const lo = Math.min(...values), hi = Math.max(...values);
  if (lo === hi) return () => ({ key: "00", label: fmt(lo) });
  const w = (hi - lo) / bins;
  return (n) => {
    const i = Math.min(bins - 1, Math.floor((n - lo) / w));
    return { key: String(i).padStart(2, "0"), label: `${fmt(lo + i * w)} – ${fmt(lo + (i + 1) * w)}` };
  };
}
const BLANK = { key: "", label: "(blank)" };

/** The group(s) a record falls in for a field. A multiple-choice record falls in each of its choices. */
export function categories(f: Feature, d: FieldDef, binner: Binner | null): { key: string; label: string }[] {
  const v = raw(f, d);
  switch (d.type) {
    case "status": return [{ key: String(v), label: STATUS_LABEL[v as FeatureStatus] ?? String(v) }];
    case "boolean": return typeof v === "boolean" ? [{ key: String(v), label: v ? d.true_label || "Yes" : d.false_label || "No" }] : [BLANK];
    case "multi_choice": { const a = Array.isArray(v) ? v.map(String).filter(Boolean) : []; return a.length ? a.map((x) => ({ key: x, label: x })) : [BLANK]; }
    case "number": case "calculation": { const n = num(v); return n == null || !binner ? [BLANK] : [binner(n)]; }
    case "date": case "datetime": case "updated": { const s = typeof v === "string" ? v.slice(0, 7) : ""; return /^\d{4}-\d{2}$/.test(s) ? [{ key: s, label: monthLabel(s) }] : [BLANK]; }
    default: { const s = v == null ? "" : String(v).trim(); return s ? [{ key: s, label: s }] : [BLANK]; }
  }
}

export interface Slice { key: string; label: string; value: number; count: number }
interface Acc { n: number; sum: number; min: number; max: number; k: number }
const add = (a: Acc, n: number | null) => { a.n++; if (n != null) { a.k++; a.sum += n; a.min = Math.min(a.min, n); a.max = Math.max(a.max, n); } };
const result = (a: Acc, m: Metric): number | null => (m === "count" ? a.n : !a.k ? null : m === "sum" ? a.sum : m === "avg" ? a.sum / a.k : m === "min" ? a.min : a.max);
const blankAcc = (): Acc => ({ n: 0, sum: 0, min: Infinity, max: -Infinity, k: 0 });
const ordered = (d: FieldDef) => d.type === "number" || d.type === "date" || d.type === "datetime" || d.type === "updated";

/** Count (or sum, average, min, max of a number field) per group, biggest first. */
export function groupBy(features: Feature[], d: FieldDef, metric: Metric, mf: FieldDef | undefined, limit = 8): Slice[] {
  const binner = d.type === "number" ? makeBinner(features.map((r) => num(raw(r, d))).filter((n): n is number => n != null)) : null;
  const groups = new Map<string, { label: string; acc: Acc }>();
  for (const r of features) {
    const n = mf ? num(raw(r, mf)) : null;
    for (const c of categories(r, d, binner)) {
      let g = groups.get(c.key);
      if (!g) groups.set(c.key, (g = { label: c.label, acc: blankAcc() }));
      add(g.acc, n);
    }
  }
  let out: Slice[] = [...groups].flatMap(([key, g]) => { const v = result(g.acc, metric); return v == null ? [] : [{ key, label: g.label, value: v, count: g.acc.n }]; });
  if (ordered(d)) {
    out.sort((a, b) => (a.key === "" ? 1 : b.key === "" ? -1 : a.key < b.key ? -1 : 1));
    if (d.type !== "number" && out.length > limit) out = out.slice(-limit);          // dates: the most recent
    return out;
  }
  out.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  if (out.length > limit) {
    const rest = out.slice(limit);
    out = out.slice(0, limit);
    if (metric === "count" || metric === "sum") out.push({ key: "__other", label: `Other (${rest.length})`, value: rest.reduce((s, x) => s + x.value, 0), count: rest.reduce((s, x) => s + x.count, 0) });
  }
  return out;
}

/** One number for the whole set. Null when there is nothing to average (no records with a value). */
export function kpi(features: Feature[], metric: Metric, mf?: FieldDef): number | null {
  const a = blankAcc();
  for (const r of features) add(a, mf ? num(raw(r, mf)) : null);
  return result(a, metric);
}

// ---------- over time ----------
const parseDay = (k: string) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);
export function bucketKey(iso: string, bucket: Bucket): string {
  const day = iso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  if (bucket === "day") return day;
  if (bucket === "month") return day.slice(0, 7);
  const t = parseDay(day), dow = (new Date(t).getUTCDay() + 6) % 7;   // Monday = 0
  return dayKey(t - dow * 86400000);
}
function nextKey(k: string, bucket: Bucket): string {
  if (bucket === "month") { const y = Number(k.slice(0, 4)), m = Number(k.slice(5, 7)); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; }
  return dayKey(parseDay(k) + (bucket === "day" ? 1 : 7) * 86400000);
}
const MAX_POINTS = 120;

/** Records (or a sum or average) per day, week or month. Empty periods in between show as zero, so gaps are visible. */
export function timeSeries(features: Feature[], d: FieldDef, bucket: Bucket, metric: Metric, mf?: FieldDef): Slice[] {
  const groups = new Map<string, Acc>();
  for (const r of features) {
    const v = raw(r, d);
    const k = typeof v === "string" ? bucketKey(v, bucket) : "";
    if (!k) continue;
    let a = groups.get(k);
    if (!a) groups.set(k, (a = blankAcc()));
    add(a, mf ? num(raw(r, mf)) : null);
  }
  const keys = [...groups.keys()].sort();
  if (!keys.length) return [];
  const out: Slice[] = [];
  for (let k = keys[0]; k <= keys[keys.length - 1] && out.length < 5000; k = nextKey(k, bucket)) {
    const a = groups.get(k);
    const v = a ? result(a, metric) : metric === "count" || metric === "sum" ? 0 : null;
    out.push({ key: k, label: bucket === "month" ? monthLabel(k) : dayLabel(k), value: v ?? 0, count: a?.n ?? 0 });
  }
  return out.slice(-MAX_POINTS);
}

// ---------- table ----------
export function display(f: Feature, d: FieldDef): string {
  const v = raw(f, d);
  if (v == null || v === "") return "";
  if (d.type === "status") return STATUS_LABEL[v as FeatureStatus] ?? String(v);
  if (d.type === "boolean") return v ? d.true_label || "Yes" : d.false_label || "No";
  if (d.type === "updated") return String(v).slice(0, 10);
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join("; ");
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}
export function tableRows(features: Feature[], cols: FieldDef[], limit: number) {
  return [...features].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)).slice(0, limit).map((f) => ({ id: f.id, cells: cols.map((c) => display(f, c)) }));
}

// ---------- widgets ----------
export const WIDGET_LABEL: Record<Widget["type"], string> = {
  kpi: "Number", bar: "Bar chart", pie: "Pie chart", line: "Line chart", table: "Table", map: "Map",
  gauge: "Gauge", list: "List", details: "Details", rich_text: "Rich text", embedded: "Embedded content",
};
/** Elements that show something the author typed, not the collected records, so they need no form. */
export const isStatic = (t: WidgetType): boolean => t === "rich_text" || t === "embedded";
/** Elements that count, add up or average (so they have a "Show" setting). */
export const usesMetric = (t: WidgetType): boolean => t === "kpi" || t === "bar" || t === "pie" || t === "line" || t === "gauge";
export const METRIC_LABEL: Record<Metric, string> = { count: "Number of records", sum: "Sum", avg: "Average", min: "Smallest", max: "Largest" };

export function newWidget(type: Widget["type"], defs: FieldDef[], mkId: () => string = () => uuid().slice(0, 8)): Widget {
  const w: Widget = { id: mkId(), type, title: "", metric: "count", bucket: "month", limit: type === "table" || type === "list" ? 10 : 8, columns: [] };
  if (type === "bar" || type === "pie") w.field = (groupFields(defs).find((f) => f.type === "choice" || f.type === "boolean" || f.type === "multi_choice") ?? groupFields(defs)[0])?.id;
  if (type === "line") w.field = UPDATED_ID;
  if (type === "table") w.columns = defs.filter((f) => f.type !== "calculation").slice(0, 5).map((f) => f.id);
  if (type === "list") { w.title_field = (defs.find((f) => f.type === "text" || f.type === "choice") ?? defs[0])?.id; w.subtitle_fields = []; }
  if (type === "rich_text") w.content = "";
  if (type === "embedded") w.url = "";
  return w;
}
export function defaultTitle(w: Widget, defs: FieldDef[]): string {
  if (w.title.trim()) return w.title.trim();
  const mf = findField(defs, w.metric_field), f = findField(defs, w.field);
  const what = w.metric === "count" ? "Records" : `${METRIC_LABEL[w.metric]} of ${mf?.label ?? "…"}`;
  switch (w.type) {
    case "kpi": return w.metric === "count" ? "Total records" : what;
    case "bar": case "pie": return `${what} by ${f?.label ?? "…"}`;
    case "line": return `${what} over time`;
    case "table": return "Latest records";
    case "map": return "Where records were collected";
    case "gauge": return w.metric === "count" ? "Records so far" : what;
    case "list": return "Records";
    case "details": return "Latest record";
    case "rich_text": return "Notes";
    case "embedded": return "Embedded content";
  }
}
/** Why a chart can't be drawn yet, or null when it can. A field removed from the form is reported, never a crash. */
export function widgetProblem(w: Widget, defs: FieldDef[]): string | null {
  if (usesMetric(w.type) && w.metric !== "count") {
    if (!w.metric_field) return `Pick the number field to ${w.metric === "avg" ? "average" : w.metric === "sum" ? "add up" : "measure"}.`;
    if (!numberFields(defs).some((f) => f.id === w.metric_field)) return "The number field this uses is no longer in the form.";
  }
  if (w.type === "bar" || w.type === "pie") {
    if (!w.field) return "Pick a field to group by.";
    if (!groupFields(defs).some((f) => f.id === w.field)) return "The field this groups by is no longer in the form.";
  }
  if (w.type === "line") {
    if (!w.field) return "Pick the date to plot.";
    if (!dateFields(defs).some((f) => f.id === w.field)) return "The date field this uses is no longer in the form.";
  }
  if (w.type === "table" && !w.columns.some((c) => findField(defs, c))) return "Pick at least one column.";
  if (w.type === "gauge") {
    if (!(w.target != null && w.target > 0) && !w.target_field) return "Set the target the gauge measures against.";
    if (!(w.target != null && w.target > 0) && !numberFields(defs).some((f) => f.id === w.target_field)) return "The number field the target uses is no longer in the form.";
  }
  if (w.type === "list") {
    if (!w.title_field) return "Pick the field to use as each row's heading.";
    if (!findField(defs, w.title_field)) return "The heading field this uses is no longer in the form.";
  }
  if (w.type === "embedded" && !safeEmbedUrl(w.url)) return "Enter a web address that starts with https://.";
  return null;
}

/** A sensible first dashboard for a form, so a new one is never an empty page. */
export function starterWidgets(form: Form, mkId?: () => string): Widget[] {
  const defs = dashboardFields(form);
  const mk = (type: Widget["type"], patch: Partial<Widget> = {}) => ({ ...newWidget(type, defs, mkId), ...patch });
  const picks = defs.filter((f) => f.type === "choice" || f.type === "boolean" || f.type === "multi_choice");
  const nums = numberFields(defs).filter((f) => f.type === "number" && !f.id.startsWith("gps_"));
  const out: Widget[] = [mk("kpi")];
  if (nums[0]) out.push(mk("kpi", { metric: "avg", metric_field: nums[0].id }));
  out.push(mk("pie", { field: STATUS_ID, title: "Review status" }));
  if (picks[0]) out.push(mk("bar", { field: picks[0].id }));
  if (picks[1]) out.push(mk("pie", { field: picks[1].id }));
  out.push(mk("line", { field: UPDATED_ID }));
  if (form.geometry_type === "Point" || form.geometry_type) out.push(mk("map"));
  out.push(mk("table"));
  return out;
}

/** Chart data as a CSV the person can open in a spreadsheet. */
export function slicesCsv(rows: Slice[], labelHeader: string, valueHeader: string): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [`${q(labelHeader)},${q(valueHeader)},Records`, ...rows.map((r) => `${q(r.label)},${r.value},${r.count}`)].join("\n");
}


// ---------- automatic layout ----------
// By default nobody sizes or places a chart (see "manual layout" below for dragging and resizing). Each type has a preferred width (out of 12 columns) and height (in fixed row units);
// the engine packs charts, in order, into rows that always add up to 12 columns, and gives every chart in a row the
// same height. So there are never gaps or ragged edges, and the same dashboard looks the same for everyone.
export const GRID_COLUMNS = 12;
export const PREFERRED: Record<WidgetType, { span: number; rows: number }> = {
  kpi: { span: 3, rows: 2 }, bar: { span: 4, rows: 5 }, pie: { span: 4, rows: 5 },
  line: { span: 6, rows: 5 }, map: { span: 6, rows: 6 }, table: { span: 12, rows: 7 },
  gauge: { span: 3, rows: 4 }, list: { span: 4, rows: 5 }, details: { span: 4, rows: 5 }, rich_text: { span: 4, rows: 3 }, embedded: { span: 6, rows: 6 },
};
export interface Placed { w: Widget; span: number; rows: number; col?: number; row?: number }
const pref = (w: Widget) => ({ span: w.wide ? GRID_COLUMNS : PREFERRED[w.type].span, rows: PREFERRED[w.type].rows });
const isStrip = (w: Widget) => w.type === "kpi" && !w.wide;

export function autoLayout(all: Widget[]): Placed[] {
  const widgets = all.filter(inBody);
  const rows: Widget[][] = [];
  let cur: Widget[] = [], sum = 0;
  const flush = () => { if (cur.length) rows.push(cur); cur = []; sum = 0; };
  for (let i = 0; i < widgets.length;) {
    const w = widgets[i];
    if (isStrip(w)) {
      // A run of number cards is a strip of at most four per line, split evenly (5 cards = 3 + 2, never 4 + 1).
      flush();
      let j = i;
      while (j < widgets.length && isStrip(widgets[j])) j++;
      const run = widgets.slice(i, j), per = Math.ceil(run.length / Math.ceil(run.length / 4));
      for (let k = 0; k < run.length; k += per) rows.push(run.slice(k, k + per));
      i = j;
      continue;
    }
    const p = pref(w).span;
    if (cur.length && sum + p > GRID_COLUMNS) flush();
    cur.push(w); sum += p; i++;
  }
  flush();
  return rows.flatMap((r) => {
    const prefs = r.map((w) => pref(w).span);
    const fits = prefs.reduce((a, b) => a + b, 0) === GRID_COLUMNS;
    const height = Math.max(...r.map((w) => pref(w).rows));
    return r.map((w, i): Placed => ({ w, span: fits ? prefs[i] : GRID_COLUMNS / r.length, rows: height }));
  });
}

// ---------- manual layout ----------
// In edit mode a chart can be dragged and resized. That stores a rectangle on the chart (col, row, cols, rows on the same
// 12-column grid). The first time anything is moved, the automatic layout is frozen into rectangles for every chart on the
// page, so nothing jumps. "Reset layout" removes them again. Charts never overlap: whatever is in the way is pushed down,
// and the others then settle upward so no gaps are left behind. The chart you are moving stays exactly where you drop it.
export interface Rect { col: number; row: number; cols: number; rows: number }
export const MIN_COLS = 2, MIN_ROWS = 2, MAX_ROWS = 40, MAX_ROW_INDEX = 200;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(n) ? n : lo)));
export const hasRect = (w: Widget): boolean => [w.col, w.row, w.cols, w.rows].every((n) => typeof n === "number" && Number.isFinite(n));
/** Elements in the side column are not on the grid, so the grid layout never sees them. */
export const inBody = (w: Widget): boolean => w.region !== "sidebar";
export const inSidebar = (w: Widget): boolean => w.region === "sidebar";
export const isManualLayout = (widgets: Widget[]): boolean => widgets.some((w) => inBody(w) && hasRect(w));

/** Keep a rectangle on the grid: at least 2 x 2, inside the 12 columns, never above the top. */
export function clampRect(r: Rect): Rect {
  const cols = clamp(r.cols, MIN_COLS, GRID_COLUMNS), rows = clamp(r.rows, MIN_ROWS, MAX_ROWS);
  return { cols, rows, col: clamp(r.col, 0, GRID_COLUMNS - cols), row: clamp(r.row, 0, MAX_ROW_INDEX) };
}
const overlaps = (a: Rect, b: Rect) => a.col < b.col + b.cols && b.col < a.col + a.cols && a.row < b.row + b.rows && b.row < a.row + a.rows;

/** Where the automatic layout puts each chart, as rectangles. */
function autoRects(widgets: Widget[]): Map<string, Rect> {
  const out = new Map<string, Rect>();
  let col = 0, row = 0, tall = 0;
  for (const p of autoLayout(widgets)) {
    out.set(p.w.id, { col, row, cols: p.span, rows: p.rows });
    col += p.span; tall = Math.max(tall, p.rows);
    if (col >= GRID_COLUMNS) { col = 0; row += tall; tall = 0; }
  }
  return out;
}
/** The first free spot of a given size, scanning down the page from the top. */
function firstFit(taken: Rect[], cols: number, rows: number): Rect {
  for (let row = 0; ; row++) for (let col = 0; col + cols <= GRID_COLUMNS; col++) {
    const r = { col, row, cols, rows };
    if (!taken.some((t) => overlaps(r, t))) return r;
  }
}

/** Every chart's rectangle: the saved ones, the automatic layout when none are saved, and a free spot for a chart that has none yet. */
export function layoutRects(widgets: Widget[]): Map<string, Rect> {
  if (!isManualLayout(widgets)) return autoRects(widgets);
  const out = new Map<string, Rect>(), taken: Rect[] = [];
  for (const w of widgets) if (inBody(w) && hasRect(w)) { const r = clampRect({ col: w.col!, row: w.row!, cols: w.cols!, rows: w.rows! }); out.set(w.id, r); taken.push(r); }
  for (const w of widgets) if (inBody(w) && !hasRect(w)) { const r = firstFit(taken, PREFERRED[w.type].span, PREFERRED[w.type].rows); out.set(w.id, r); taken.push(r); }
  return out;
}

/** Place `moved` exactly where asked (it stays there), push whatever it lands on downward, then let all the others settle upward. */
export function arrangeRects(rects: Map<string, Rect>, movedId?: string, moved?: Rect): Map<string, Rect> {
  const placed: { id: string; r: Rect }[] = [];
  const pin = movedId && moved ? { id: movedId, r: clampRect(moved) } : null;
  if (pin) placed.push(pin);
  const rest = [...rects].filter(([id]) => id !== pin?.id).map(([id, r]) => ({ id, r: { ...r } }))
    .sort((a, b) => a.r.row - b.r.row || a.r.col - b.r.col);
  for (const it of rest) {
    while (it.r.row > 0 && !placed.some((o) => overlaps({ ...it.r, row: it.r.row - 1 }, o.r))) it.r.row--;
    while (placed.some((o) => overlaps(it.r, o.r))) it.r.row++;
    placed.push(it);
  }
  return new Map(placed.map((o) => [o.id, o.r]));
}

/** The charts with their rectangles written onto them (this is what gets saved). */
export function withRects(widgets: Widget[], rects: Map<string, Rect>): Widget[] {
  return widgets.map((w) => { const r = rects.get(w.id); return r ? { ...w, ...r } : w; });
}
/** Move or resize one chart; the others make way. Works from the automatic layout the first time. */
export function setWidgetRect(widgets: Widget[], id: string, patch: Partial<Rect>): Widget[] {
  const rects = layoutRects(widgets), cur = rects.get(id);
  return cur ? withRects(widgets, arrangeRects(rects, id, { ...cur, ...patch })) : widgets;
}
/** Settle the charts after one is removed, so a gap closes. A page on the automatic layout needs nothing. */
export function settle(widgets: Widget[]): Widget[] {
  return isManualLayout(widgets) ? withRects(widgets, arrangeRects(layoutRects(widgets))) : widgets;
}
/** Move an element between the grid and the side column. Its place on the grid is dropped, and the others close the gap. */
export function setRegion(widgets: Widget[], id: string, region: "body" | "sidebar"): Widget[] {
  const next = widgets.map((w) => {
    if (w.id !== id) return w;
    const { col: _c, row: _r, cols: _s, rows: _h, region: _g, ...rest } = w;
    return region === "sidebar" ? { ...rest, region: "sidebar" as const } : rest;
  });
  return settle(next);
}
/** Back to the automatic layout. */
export const resetRects = (widgets: Widget[]): Widget[] => widgets.map(({ col: _c, row: _r, cols: _s, rows: _h, ...w }) => w);

/** What the grid draws: with manual rectangles (or a drag in progress), the rectangles; otherwise the automatic layout. */
export function placeAll(widgets: Widget[], override?: Map<string, Rect>): Placed[] {
  if (!override && !isManualLayout(widgets)) return autoLayout(widgets);
  const rects = override ?? layoutRects(widgets);
  return widgets.flatMap((w): Placed[] => { const r = rects.get(w.id); return r ? [{ w, span: r.cols, rows: r.rows, col: r.col, row: r.row }] : []; })
    .sort((a, b) => a.row! - b.row! || a.col! - b.col!);   // reading order, so a phone shows them in a sensible sequence
}

/** How many grid rows a page's body needs, so the grid can stretch those rows to fill the screen exactly. */
export function totalRows(placed: Placed[]): number {
  let col = 0, row = 0, tall = 0, max = 1;
  for (const p of placed) {
    if (p.col != null && p.row != null) { max = Math.max(max, p.row + p.rows); continue; }
    max = Math.max(max, row + p.rows); col += p.span; tall = Math.max(tall, p.rows);
    if (col >= GRID_COLUMNS) { col = 0; row += tall; tall = 0; }
  }
  return max;
}

// ---------- pages ----------
export const MAX_PAGES = 12;
export const MAX_WIDGETS_PER_PAGE = 30;
const newId = () => uuid().slice(0, 8);

export const newPage = (title: string, form_id?: string, mkId: () => string = newId): DashPage => ({ id: mkId(), title, form_id, widgets: [] });

/** Every form a page draws on: its own, plus any a chart picks for itself. */
export function pageFormIds(p: DashPage): string[] {
  return [...new Set([p.form_id, ...p.widgets.map((w) => w.form_id)].filter((x): x is string => !!x))];
}

/** One number card and one review-status pie per form: a joint view across, say, Army, Air Force and Navy. */
export function overviewWidgets(forms: Form[], mkId: () => string = newId): Widget[] {
  const list = forms.slice(0, 8);
  const mk = (type: WidgetType, f: Form, patch: Partial<Widget>): Widget => ({ ...newWidget(type, dashboardFields(f), mkId), form_id: f.id, ...patch });
  return [
    ...list.map((f) => mk("kpi", f, { title: f.name })),
    ...list.map((f) => mk("pie", f, { field: STATUS_ID, title: `${f.name}: review status` })),
  ];
}

/** A new dashboard's pages: one per chosen form, plus an overview when there are several. Never empty. */
export function starterPages(forms: Form[], overview: boolean, mkId: () => string = newId): DashPage[] {
  const pages = forms.slice(0, MAX_PAGES - 1).map((f): DashPage => ({ id: mkId(), title: f.name.slice(0, 60), form_id: f.id, widgets: starterWidgets(f, mkId) }));
  if (overview && forms.length > 1) pages.unshift({ id: mkId(), title: "Overview", widgets: overviewWidgets(forms, mkId) });
  return pages.length ? pages : [newPage("Overview", undefined, mkId)];
}

/**
 * Whatever the server (or an older saved copy) sends becomes the current shape. Dashboards saved before pages existed
 * ({ form_id, widgets, and a width of 1 to 3 on each chart }) become a single page named Overview.
 */
/** A saved rectangle, only when all four numbers are there (and sane). */
function rectOf(x: Record<string, unknown>): Partial<Rect> {
  const n = [x.col, x.row, x.cols, x.rows];
  return n.every((v) => typeof v === "number" && Number.isFinite(v)) ? clampRect({ col: x.col as number, row: x.row as number, cols: x.cols as number, rows: x.rows as number }) : {};
}
export function normalizeConfig(raw: unknown): DashboardConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  const widget = (x: Record<string, unknown>): Widget => ({
    id: String(x.id), type: x.type as WidgetType, title: String(x.title ?? ""),
    ...(x.wide === true || x.width === 3 ? { wide: true } : {}),
    form_id: (x.form_id as string | null | undefined) ?? undefined,
    metric: (x.metric as Metric | undefined) ?? "count", metric_field: (x.metric_field as string | null | undefined) ?? undefined,
    field: (x.field as string | null | undefined) ?? undefined, bucket: (x.bucket as Bucket | undefined) ?? "month",
    limit: Number(x.limit ?? 8), columns: (x.columns as string[] | undefined) ?? [],
    ...rectOf(x),
    ...(x.region === "sidebar" ? { region: "sidebar" as const } : {}),
    ...(typeof x.target === "number" && Number.isFinite(x.target) ? { target: x.target } : {}),
    ...(typeof x.target_field === "string" && x.target_field ? { target_field: x.target_field } : {}),
    ...(typeof x.title_field === "string" && x.title_field ? { title_field: x.title_field } : {}),
    ...(Array.isArray(x.subtitle_fields) ? { subtitle_fields: (x.subtitle_fields as unknown[]).filter((s): s is string => typeof s === "string") } : {}),
    ...(typeof x.content === "string" ? { content: x.content } : {}),
    ...(typeof x.url === "string" ? { url: x.url } : {}),
  });
  const pageOf = (x: Record<string, unknown>): DashPage => ({
    id: String(x.id), title: String(x.title ?? ""), form_id: (x.form_id as string | null | undefined) ?? undefined,
    widgets: ((x.widgets as Record<string, unknown>[] | undefined) ?? []).map(widget),
  });
  const pages = Array.isArray(c.pages)
    ? (c.pages as Record<string, unknown>[]).map(pageOf)
    : [pageOf({ id: "main", title: "Overview", form_id: c.form_id, widgets: c.widgets })];
  const theme = cleanTheme(c.theme), time_filter = cleanTimeFilter(c.time_filter);
  return { description: (c.description as string | null | undefined) || undefined, pages: pages.length ? pages : [newPage("Overview")], ...(theme ? { theme } : {}), ...(time_filter ? { time_filter } : {}) };
}

// ---------- filters in the address ----------
// Filters sit in the page address, so a view can be sent as a link, survives a refresh, and carries from page to page.
const STATUSES = ["draft", "submitted", "approved", "rejected"];
const FILTER_KEYS = ["status", "from", "to", "eq"];
export function filtersToParams(f: Filters, into: URLSearchParams = new URLSearchParams()): URLSearchParams {
  const out = new URLSearchParams(into);
  FILTER_KEYS.forEach((k) => out.delete(k));
  if (f.status !== "all") out.set("status", f.status);
  if (f.from) out.set("from", f.from);
  if (f.to) out.set("to", f.to);
  for (const e of f.equals) out.append("eq", [e.field, e.value, e.label].map(encodeURIComponent).join("|"));
  return out;
}
export function filtersFromParams(p: URLSearchParams): Filters {
  const s = p.get("status") ?? "";
  const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  const equals = p.getAll("eq").flatMap((x) => {
    try {
      const [field, value, label] = x.split("|").map(decodeURIComponent);
      return field && value !== undefined ? [{ field, value, label: label ?? value }] : [];
    } catch { return []; }
  });
  return { status: STATUSES.includes(s) ? (s as FeatureStatus) : "all", from: day(p.get("from")), to: day(p.get("to")), equals };
}

// ---------- the records a page draws on, and what each element shows ----------
/** The records one element draws: a form, its fields, every record of it, and the ones that pass the filters. */
export interface Source { form: Form; defs: FieldDef[]; base: Feature[]; rows: Feature[] }

export function buildSources(formIds: string[], forms: Form[], features: Feature[], filters: Filters): Map<string, Source> {
  const m = new Map<string, Source>();
  for (const id of formIds) {
    const form = forms.find((f) => f.id === id);
    if (!form) continue;
    const defs = dashboardFields(form);
    const base = features.filter((f) => f.form_id === id && !f.deleted);
    m.set(id, { form, defs, base, rows: filterFeatures(base, filters, defs) });
  }
  return m;
}

/** An https address that is safe to put in a frame, or null. No other schemes, no embedded passwords. */
export function safeEmbedUrl(raw?: string): string | null {
  const s = (raw ?? "").trim();
  if (!s || s.length > 500) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname.includes(".") && !u.username && !u.password ? u.toString() : null;
  } catch { return null; }
}

export interface RichSpan { text: string; bold?: boolean; italic?: boolean }
/** **bold**, *italic* and line breaks, as plain pieces to draw. Nothing is ever treated as HTML. */
export function parseRich(content: string): RichSpan[][] {
  return content.split(/\r?\n/).map((line) => {
    const out: RichSpan[] = [], re = /\*\*(.+?)\*\*|\*(.+?)\*/g;
    let last = 0, m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      if (m.index > last) out.push({ text: line.slice(last, m.index) });
      out.push(m[1] != null ? { text: m[1], bold: true } : { text: m[2]!, italic: true });
      last = m.index + m[0].length;
    }
    if (last < line.length) out.push({ text: line.slice(last) });
    return out;
  });
}

export type WidgetData =
  | { kind: "problem"; message: string }
  | { kind: "empty"; message: string }
  | { kind: "number"; value: number | null; unit?: string }
  | { kind: "gauge"; value: number | null; max: number | null; percent: number | null; unit?: string }
  | { kind: "slices"; chart: "bar" | "pie" | "line"; slices: Slice[]; unit: string }
  | { kind: "table"; columns: FieldDef[]; rows: { id: string; cells: string[] }[] }
  | { kind: "list"; rows: { id: string; title: string; subtitle: string }[] }
  | { kind: "details"; items: { label: string; value: string }[] }
  | { kind: "text"; content: string }
  | { kind: "embed"; url: string }
  | { kind: "map"; count: number };

const newestFirst = (features: Feature[]) => [...features].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));

/** Everything one element shows, worked out from the records. The page draws it; a report prints it. Never throws on a removed field. */
export function widgetData(w: Widget, source: Source | undefined, hasForm: boolean): WidgetData {
  if (w.type === "rich_text") return { kind: "text", content: w.content ?? "" };
  if (w.type === "embedded") { const url = safeEmbedUrl(w.url); return url ? { kind: "embed", url } : { kind: "problem", message: widgetProblem(w, []) ?? "Enter a web address that starts with https://." }; }
  if (!source) return { kind: "problem", message: hasForm ? "The form this uses is no longer available." : "Choose the form this uses." };
  const { defs, rows } = source;
  const problem = widgetProblem(w, defs);
  if (problem) return { kind: "problem", message: problem };
  const mf = findField(defs, w.metric_field), f = findField(defs, w.field);
  const none: WidgetData = { kind: "empty", message: "No records match the filters." };
  const unit = mf?.unit && w.metric !== "count" ? mf.unit : undefined;
  switch (w.type) {
    case "kpi": return { kind: "number", value: kpi(rows, w.metric, mf), unit };
    case "gauge": {
      const value = kpi(rows, w.metric, mf), tf = findField(defs, w.target_field);
      const max = w.target != null && w.target > 0 ? w.target : tf ? kpi(rows, "sum", tf) : null;
      return { kind: "gauge", value, max, percent: value != null && max != null && max > 0 ? (value / max) * 100 : null, unit };
    }
    case "bar": case "pie": { const s = groupBy(rows, f!, w.metric, mf, w.limit); return s.length ? { kind: "slices", chart: w.type, slices: s, unit: unit ?? "" } : none; }
    case "line": { const s = timeSeries(rows, f!, w.bucket, w.metric, mf); return s.length ? { kind: "slices", chart: "line", slices: s, unit: unit ?? "" } : none; }
    case "table": {
      const columns = w.columns.map((c) => findField(defs, c)).filter((c): c is FieldDef => !!c);
      const t = tableRows(rows, columns, w.limit);
      return t.length ? { kind: "table", columns, rows: t } : none;
    }
    case "list": {
      const head = findField(defs, w.title_field), subs = (w.subtitle_fields ?? []).map((id) => findField(defs, id)).filter((d): d is FieldDef => !!d);
      const out = newestFirst(rows).slice(0, w.limit).map((r) => ({ id: r.id, title: (head && display(r, head)) || "(blank)", subtitle: subs.map((d) => display(r, d)).filter(Boolean).join(" · ") }));
      return out.length ? { kind: "list", rows: out } : none;
    }
    case "details": {
      const r = newestFirst(rows)[0];
      if (!r) return none;
      const shown = w.columns.length ? w.columns.map((c) => findField(defs, c)).filter((d): d is FieldDef => !!d) : defs;
      return { kind: "details", items: shown.map((d) => ({ label: d.label, value: display(r, d) || "–" })) };
    }
    case "map": return rows.length ? { kind: "map", count: rows.length } : none;
  }
}

// ---------- the dashboard's own date range ----------
export const TIME_PRESETS: { value: TimePreset; label: string }[] = [
  { value: "all_time", label: "All time" }, { value: "last_7_days", label: "Last 7 days" }, { value: "last_30_days", label: "Last 30 days" },
  { value: "last_90_days", label: "Last 90 days" }, { value: "last_year", label: "Last year" }, { value: "custom", label: "Custom range" },
];
const PRESET_DAYS: Partial<Record<TimePreset, number>> = { last_7_days: 7, last_30_days: 30, last_90_days: 90, last_year: 365 };
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

export function cleanTimeFilter(raw: unknown): TimeFilter | undefined {
  const t = raw as { preset?: unknown; start?: unknown; end?: unknown } | null | undefined;
  if (!t || typeof t.preset !== "string" || !TIME_PRESETS.some((p) => p.value === t.preset) || t.preset === "all_time") return undefined;
  if (t.preset === "custom") return isDay(t.start) && isDay(t.end) ? { preset: "custom", start: t.start, end: t.end } : undefined;
  return { preset: t.preset as TimePreset };
}
/** The first and last day (YYYY-MM-DD, inclusive) a time filter allows. Empty = no limit. */
export function timeRange(tf: TimeFilter | undefined, now: Date = new Date()): { from?: string; to?: string } {
  const t = cleanTimeFilter(tf);
  if (!t) return {};
  if (t.preset === "custom") return { from: t.start, to: t.end };
  return { from: dayKey(now.getTime() - (PRESET_DAYS[t.preset] ?? 0) * 86400000) };
}
/** The viewer's own date filter, narrowed by the dashboard's range: a record has to pass both. */
export function withTimeRange(f: Filters, r: { from?: string; to?: string }): Filters {
  const from = [f.from, r.from].filter((x): x is string => !!x).sort().pop();
  const to = [f.to, r.to].filter((x): x is string => !!x).sort()[0];
  return from === f.from && to === f.to ? f : { ...f, from, to };
}
export const timeLabel = (tf: TimeFilter | undefined): string => {
  const t = cleanTimeFilter(tf);
  return !t ? "" : t.preset === "custom" ? `${t.start} to ${t.end}` : TIME_PRESETS.find((p) => p.value === t.preset)?.label ?? "";
};
