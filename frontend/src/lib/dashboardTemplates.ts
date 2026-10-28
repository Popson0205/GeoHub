// Dashboard templates: ready-made page layouts that adapt to the form they are applied to.
// A template never names a field. It looks at what the form has (choice fields, number fields, a location) and builds the
// charts from that, so the same template works on any form. Every template except "standard" places its charts on the 12-column
// grid, so after choosing one the person can drag, resize and change any chart like normal.
import {
  STATUS_ID, UPDATED_ID, dashboardFields, newPage, newWidget, numberFields, overviewWidgets, MAX_PAGES, layoutRects,
  type FieldDef,
} from "./dashboard";
import { uuid } from "./forms";
import type { DashPage, Form, Widget, WidgetType } from "./types";

export type TemplateId = "standard" | "executive" | "map" | "review" | "trends" | "blank";
export interface TemplateInfo { id: TemplateId; name: string; description: string }

export const TEMPLATES: TemplateInfo[] = [
  { id: "standard", name: "Standard overview", description: "Numbers, charts, a map and a table, arranged automatically." },
  { id: "executive", name: "Executive summary", description: "Headline numbers on top, breakdowns in the middle, activity over time at the bottom." },
  { id: "map", name: "Map focus", description: "A large map with the key numbers beside it and the records underneath. Forms with no locations get a time chart instead." },
  { id: "review", name: "Review queue", description: "Where records stand in review, with a records table front and centre." },
  { id: "trends", name: "Trends and analysis", description: "A big time chart, key figures and the main breakdowns." },
  { id: "blank", name: "Blank", description: "An empty page. Add charts one at a time." },
];
export const templateInfo = (id: TemplateId): TemplateInfo => TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];

interface Ctx {
  defs: FieldDef[];
  geo: boolean;
  mk: (type: WidgetType, patch?: Partial<Widget>) => Widget;
}
const ctxOf = (defs: FieldDef[], geo: boolean, mkId: () => string): Ctx => ({
  defs, geo, mk: (type, patch = {}) => ({ ...newWidget(type, defs, mkId), ...patch }),
});

const GRID = 12;
const at = (w: Widget, col: number, row: number, cols: number, rows: number): Widget => ({ ...w, col, row, cols, rows });
const some = <T,>(xs: (T | false | null | undefined)[]): T[] => xs.filter((x): x is T => !!x);
/** Lay charts side by side on one band, sharing the 12 columns as evenly as they divide (5 + 5 + 4, never a ragged edge). */
function strip(ws: Widget[], row: number, rows: number): Widget[] {
  const base = Math.floor(GRID / Math.max(ws.length, 1)), extra = GRID % Math.max(ws.length, 1);
  let col = 0;
  return ws.map((w, i) => { const cols = base + (i < extra ? 1 : 0); const out = at(w, col, row, cols, rows); col += cols; return out; });
}
const bottom = (ws: Widget[]): number => ws.reduce((m, w) => Math.max(m, (w.row ?? 0) + (w.rows ?? 0)), 0);

/** The charts a template puts on a page for this form. */
function build(id: TemplateId, c: Ctx): Widget[] {
  const { mk, defs } = c;
  const picks = defs.filter((f) => f.type === "choice" || f.type === "boolean" || f.type === "multi_choice");
  const nums = numberFields(defs).filter((f) => f.type === "number" && !f.id.startsWith("gps_"));
  const total = () => mk("kpi");
  const statusPie = () => mk("pie", { field: STATUS_ID, title: "Review status" });
  const activity = () => mk("line", { field: UPDATED_ID });
  const breakdowns = (n: number): Widget[] => {
    const out = some<Widget>([picks[0] && mk("bar", { field: picks[0].id }), picks[1] && mk("pie", { field: picks[1].id })]).slice(0, n);
    return out.length ? out : [statusPie()];
  };

  if (id === "blank") return [];
  if (id === "standard") return standard(c, picks, nums);

  if (id === "executive") {
    const kpis = some<Widget>([
      total(),
      nums[0] && mk("kpi", { metric: "avg", metric_field: nums[0].id }),
      nums[0] && mk("kpi", { metric: "sum", metric_field: nums[0].id }),
      nums[1] && mk("kpi", { metric: "avg", metric_field: nums[1].id }),
    ]);
    const mid = [statusPie(), ...breakdowns(2).filter((w) => w.field !== STATUS_ID)];
    const out = strip(kpis, 0, 2);
    if (mid.length < 2) return [...out, ...strip([...mid, activity()], 2, 5)];
    return [...out, ...strip(mid, 2, 5), at(activity(), 0, 7, GRID, 5)];
  }

  if (id === "map") {
    const main = c.geo ? mk("map") : activity();
    const bar = picks[0] && mk("bar", { field: picks[0].id });
    const side = some<Widget>([at(total(), 8, 0, 4, 2), at(statusPie(), 8, 2, 4, 4), bar && at(bar, 8, 6, 4, 4)]);
    const h = bottom(side);
    return [at(main, 0, 0, 8, h), ...side, at(mk("table", { columns: tableColumns(defs), limit: 15 }), 0, h, GRID, 6)];
  }

  if (id === "review") {
    const left = [at(total(), 0, 0, 4, 2), at(statusPie(), 0, 2, 4, 4)];
    const table = at(mk("table", { columns: [STATUS_ID, UPDATED_ID, ...tableColumns(defs)].slice(0, 6), limit: 15 }), 4, 0, 8, 6);
    const lower = some<Widget>([activity(), picks[0] && mk("bar", { field: picks[0].id })]);
    return [...left, table, ...strip(lower, 6, 5)];
  }

  // trends
  const kpis = some<Widget>([
    total(),
    nums[0] && mk("kpi", { metric: "avg", metric_field: nums[0].id }),
    nums[1] && mk("kpi", { metric: "avg", metric_field: nums[1].id }),
  ]);
  return [at(activity(), 0, 0, GRID, 5), ...strip(kpis, 5, 2), ...strip(breakdowns(2), 7, 5)];
}

/** The first few ordinary fields, for a records table. */
const tableColumns = (defs: FieldDef[]) =>
  defs.filter((f) => f.type !== "calculation" && f.type !== "status" && f.type !== "updated" && !f.id.startsWith("gps_")).slice(0, 4).map((f) => f.id);

/** "Standard overview" is the long-standing starter set, laid out automatically (no saved positions). */
function standard(c: Ctx, picks: FieldDef[], nums: FieldDef[]): Widget[] {
  const { mk } = c;
  const out: Widget[] = [mk("kpi")];
  if (nums[0]) out.push(mk("kpi", { metric: "avg", metric_field: nums[0].id }));
  out.push(mk("pie", { field: STATUS_ID, title: "Review status" }));
  if (picks[0]) out.push(mk("bar", { field: picks[0].id }));
  if (picks[1]) out.push(mk("pie", { field: picks[1].id }));
  out.push(mk("line", { field: UPDATED_ID }));
  if (c.geo) out.push(mk("map"));
  out.push(mk("table"));
  return out;
}

/** The charts for one form. */
export function templateWidgets(id: TemplateId, form: Form, mkId: () => string = () => uuid().slice(0, 8)): Widget[] {
  return build(id, ctxOf(dashboardFields(form), !!form.geometry_type, mkId));
}

/** One page per form, as the New dashboard screen builds them, plus a joint overview when there are several. */
export function templatePages(id: TemplateId, forms: Form[], overview: boolean, mkId: () => string = () => uuid().slice(0, 8)): DashPage[] {
  const list = forms.slice(0, MAX_PAGES - 1);
  const pages = list.map((f): DashPage => ({ id: mkId(), title: f.name.slice(0, 60), form_id: f.id, widgets: templateWidgets(id, f, mkId) }));
  if (overview && id !== "blank" && forms.length > 1) pages.unshift({ id: mkId(), title: "Overview", widgets: overviewWidgets(forms, mkId) });
  return pages.length ? pages : [newPage("Overview", undefined, mkId)];
}

// ---- thumbnails: what a template looks like, drawn from a made-up form with a bit of everything ----
const SAMPLE: FieldDef[] = [
  { id: "a", label: "Type", type: "choice", choices: ["x", "y"] }, { id: "b", label: "Condition", type: "choice", choices: ["x", "y"] },
  { id: "n1", label: "Size", type: "number" }, { id: "n2", label: "Depth", type: "number" }, { id: "d", label: "Date", type: "date" },
];
export interface Sketch { type: WidgetType; col: number; row: number; cols: number; rows: number }
export function templateSketch(id: TemplateId): Sketch[] {
  let k = 0;
  const ws = build(id, ctxOf(SAMPLE, true, () => `s${k++}`));
  const rects = layoutRects(ws);
  return ws.flatMap((w) => { const r = rects.get(w.id); return r ? [{ type: w.type, ...r }] : []; });
}
