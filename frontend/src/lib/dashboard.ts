// The numbers behind a dashboard. Pure functions: records in, chart data out, so they are easy to test and the
// charts only draw. Nothing here is stored: a dashboard saves which charts it has, and this works the rest out.
import { columnFields } from "./fieldSpec";
import { uuid } from "./forms";
import type { Bucket, Feature, FeatureStatus, FieldType, Form, Metric, Widget } from "./types";

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
export const WIDGET_LABEL: Record<Widget["type"], string> = { kpi: "Number", bar: "Bar chart", pie: "Pie chart", line: "Line chart", table: "Table", map: "Map" };
export const METRIC_LABEL: Record<Metric, string> = { count: "Number of records", sum: "Sum", avg: "Average", min: "Smallest", max: "Largest" };

export function newWidget(type: Widget["type"], defs: FieldDef[], mkId: () => string = () => uuid().slice(0, 8)): Widget {
  const w: Widget = { id: mkId(), type, title: "", width: type === "table" || type === "map" ? 3 : type === "kpi" || type === "pie" ? 1 : 2, metric: "count", bucket: "month", limit: type === "table" ? 10 : 8, columns: [] };
  if (type === "bar" || type === "pie") w.field = (groupFields(defs).find((f) => f.type === "choice" || f.type === "boolean" || f.type === "multi_choice") ?? groupFields(defs)[0])?.id;
  if (type === "line") w.field = UPDATED_ID;
  if (type === "table") w.columns = defs.filter((f) => f.type !== "calculation").slice(0, 5).map((f) => f.id);
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
  }
}
/** Why a chart can't be drawn yet, or null when it can. A field removed from the form is reported, never a crash. */
export function widgetProblem(w: Widget, defs: FieldDef[]): string | null {
  if (w.type !== "map" && w.type !== "table" && w.metric !== "count") {
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
