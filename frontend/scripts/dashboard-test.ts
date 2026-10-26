import { isFiltered, activeBuckets, bucketRange, facetOptions, toggleRange, filterOptions, filterableFields, selectedValues, toggleEquals, withoutField, widgetData, arrangeRects, autoLayout, bucketKey, isManualLayout, layoutRects, placeAll, resetRects, setWidgetRect, settle, categories, dashboardFields, filterFeatures, filtersFromParams, filtersToParams, fmt, groupBy, kpi, newWidget, noFilters, normalizeConfig, overviewWidgets, pageFormIds, slicesCsv, starterPages, starterWidgets, tableRows, timeSeries, widgetProblem, findField, STATUS_ID, UPDATED_ID } from "../src/lib/dashboard";
import { TEMPLATES, templatePages, templateSketch, templateWidgets, type TemplateId } from "../src/lib/dashboardTemplates";
import type { Feature, Form } from "../src/lib/types";

const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const form = { id: "f", project_id: "p", name: "Water point", geometry_type: "Point", version: 1, status: "published", fields: [
  { id: "type", label: "Type", type: "choice", choices: ["Well", "Borehole", "Tap"] },
  { id: "working", label: "Working?", type: "boolean", true_label: "Working", false_label: "Broken" },
  { id: "tags", label: "Tags", type: "multi_choice", choices: ["a", "b"] },
  { id: "depth", label: "Depth", type: "number" },
  { id: "visited", label: "Visited", type: "date" },
  { id: "photo", label: "Photo", type: "photo" },
] } as unknown as Form;
let n = 0;
const rec = (props: Record<string, unknown>, status: Feature["status"], updated: string): Feature =>
  ({ id: `r${n++}`, project_id: "p", form_id: "f", form_version: 1, geometry: { type: "Point", coordinates: [0, 0] }, properties: props, status, version: 1, updated_at: updated });
const data = [
  rec({ type: "Well", working: true, depth: 10, tags: ["a", "b"], visited: "2026-01-05" }, "approved", "2026-01-05T10:00:00Z"),
  rec({ type: "Well", working: false, depth: 30, tags: ["a"], visited: "2026-01-20" }, "submitted", "2026-01-20T10:00:00Z"),
  rec({ type: "Borehole", working: true, depth: 50, visited: "2026-03-02" }, "approved", "2026-03-02T10:00:00Z"),
  rec({ working: true }, "rejected", "2026-03-03T10:00:00Z"),
];
const defs = dashboardFields(form);
const f = (id: string) => findField(defs, id)!;

ok(!defs.some((d) => d.id === "photo") && defs.some((d) => d.id === "gps_elev_m"), "media fields are left out; GPS elevation and accuracy are offered");
let g = groupBy(data, f("type"), "count", undefined);
ok(g[0].label === "Well" && g[0].value === 2 && g.find((x) => x.label === "(blank)")?.value === 1, "count by choice, biggest first, blanks shown");
g = groupBy(data, f("type"), "avg", f("depth"));
ok(g.find((x) => x.label === "Well")?.value === 20 && g.find((x) => x.label === "Borehole")?.value === 50, "average of a number per group");
ok(!g.some((x) => x.label === "(blank)"), "a group with no numbers is left out of an average");
g = groupBy(data, f("working"), "count", undefined);
ok(g.some((x) => x.label === "Working" && x.value === 3) && g.some((x) => x.label === "Broken" && x.value === 1), "yes/no uses the form's own labels");
g = groupBy(data, f("tags"), "count", undefined);
ok(g.find((x) => x.label === "a")?.value === 2 && g.find((x) => x.label === "b")?.value === 1, "multiple choice counts each choice");
g = groupBy(data, f(STATUS_ID), "count", undefined);
ok(g.find((x) => x.label === "Approved")?.value === 2 && g.length === 3, "grouping by review status");
g = groupBy(data, f("visited"), "count", undefined);
ok(g.map((x) => x.key).join() === "2026-01,2026-03,", "dates group by month in time order, blank last");
g = groupBy(data, f("depth"), "count", undefined);
ok(g.reduce((s, x) => s + x.count, 0) === 4 && g[0].label.includes("–"), "numbers are grouped into ranges");

const many = Array.from({ length: 12 }, (_, i) => rec({ type: `T${i}` }, "approved", "2026-01-01T00:00:00Z"));
g = groupBy(many, f("type"), "count", undefined, 5);
ok(g.length === 6 && g[5].key === "__other" && g[5].value === 7, "extra groups are folded into 'Other'");

ok(kpi(data, "count") === 4 && kpi(data, "sum", f("depth")) === 90 && kpi(data, "avg", f("depth")) === 30 && kpi(data, "max", f("depth")) === 50 && kpi(data, "min", f("depth")) === 10, "number cards: count, sum, average, largest, smallest");
ok(kpi([], "avg", f("depth")) === null && kpi([], "count") === 0, "an empty set gives no average, but a count of zero");

ok(bucketKey("2026-10-24T09:00:00Z", "week") === "2026-10-19" && bucketKey("2026-10-19", "week") === "2026-10-19" && bucketKey("2026-10-25", "week") === "2026-10-19", "weeks start on Monday");
const ts = timeSeries(data, f(UPDATED_ID), "month", "count");
ok(ts.map((x) => x.key).join() === "2026-01,2026-02,2026-03" && ts[1].value === 0, "months with no records show as zero");
ok(timeSeries(data, f(UPDATED_ID), "day", "count").length === 58, "daily series fills the gaps");
ok(timeSeries([], f(UPDATED_ID), "month", "count").length === 0, "no records, no points");

let r = filterFeatures(data, { ...noFilters(), status: "approved" }, defs);
ok(r.length === 2, "filter by review status");
r = filterFeatures(data, { ...noFilters(), from: "2026-01-10", to: "2026-03-02" }, defs);
ok(r.length === 2, "filter by date range (inclusive)");
r = filterFeatures(data, { ...noFilters(), equals: [{ field: "type", value: "Well", label: "Well" }] }, defs);
ok(r.length === 2, "click-to-filter on a choice");
r = filterFeatures(data, { ...noFilters(), equals: [{ field: "tags", value: "b", label: "b" }] }, defs);
ok(r.length === 1, "click-to-filter on a multiple-choice value");
r = filterFeatures(data, { ...noFilters(), equals: [{ field: "type", value: "", label: "(blank)" }] }, defs);
ok(r.length === 1, "click-to-filter on (blank)");

const rows = tableRows(data, [f("type"), f("working"), f(STATUS_ID)], 2);
ok(rows.length === 2 && rows[0].cells.join("|") === "|Working|Rejected" && rows[1].cells.join("|") === "Borehole|Working|Approved", "table: latest first, readable values");

ok(fmt(1234) === "1,234" && fmt(12500) === "12.5k" && fmt(2.5) === "2.5" && fmt(3) === "3" && fmt(0.5) === "0.5" && fmt(2500000) === "2.5M", "numbers are shortened for display");
ok(widgetProblem({ id: "a", type: "bar", title: "", metric: "count", bucket: "month", limit: 8, columns: [], field: "gone" }, defs) !== null, "a chart on a removed field says so instead of failing");
ok(widgetProblem({ id: "a", type: "kpi", title: "", metric: "sum", bucket: "month", limit: 8, columns: [] }, defs) !== null, "a sum needs a number field");
ok(widgetProblem({ id: "a", type: "map", title: "", metric: "count", bucket: "month", limit: 8, columns: [] }, defs) === null, "a map needs nothing");
let k = 0;
const start = starterWidgets(form, () => `w${k++}`);
ok(start.length >= 6 && start.every((w) => widgetProblem(w, defs) === null) && new Set(start.map((w) => w.id)).size === start.length, "the starter dashboard is complete, valid, with unique ids");
ok(slicesCsv([{ key: "a", label: 'He said "hi", ok', value: 2, count: 2 }], "Type", "Records").split("\n")[1] === '"He said ""hi"", ok",2,2', "CSV quoting");
ok(categories(data[0], f("working"), null)[0].key === "true", "category keys are stable");


// ---------- automatic layout ----------
const mkw = (type: Parameters<typeof newWidget>[0], patch: Record<string, unknown> = {}) => ({ ...newWidget(type, defs, () => `w${k++}`), ...patch });
const spans = (ws: ReturnType<typeof mkw>[]) => autoLayout(ws).map((p) => p.span).join();
ok(spans([mkw("kpi"), mkw("kpi"), mkw("kpi"), mkw("kpi")]) === "3,3,3,3", "four number cards share a line");
ok(spans([mkw("kpi"), mkw("kpi")]) === "6,6" && spans([mkw("kpi")]) === "12", "fewer cards stretch to fill the line");
ok(spans(Array.from({ length: 5 }, () => mkw("kpi"))) === "4,4,4,6,6", "five cards are split 3 + 2, not 4 + 1");
ok(spans([mkw("bar"), mkw("pie"), mkw("bar")]) === "4,4,4" && spans([mkw("bar"), mkw("pie")]) === "6,6", "charts fill each row");
ok(spans([mkw("line"), mkw("bar")]) === "6,6" && spans([mkw("line"), mkw("map")]) === "6,6", "a row that does not add up to 12 is stretched evenly");
ok(spans([mkw("table"), mkw("bar")]) === "12,12", "a table takes a whole row");
ok(spans([mkw("bar", { wide: true }), mkw("pie")]) === "12,12", "a chart marked wide takes a whole row");
for (const sample of [[mkw("kpi"), mkw("bar"), mkw("pie"), mkw("line"), mkw("table"), mkw("map"), mkw("kpi"), mkw("pie"), mkw("pie"), mkw("line")], start]) {
  const placed = autoLayout(sample);
  let col = 0, tidy = true;
  for (const p of placed) { col += p.span; if (col > 12) tidy = false; if (col === 12) col = 0; }
  ok(tidy && col === 0 && placed.length === sample.length, "every row adds up to exactly 12 columns, with nothing lost");
}
const placedRows = autoLayout([mkw("kpi"), mkw("bar")]);
ok(placedRows[0].rows === 2 && placedRows[1].rows === 5, "a number strip and a chart row keep their own heights");
ok(autoLayout([mkw("line"), mkw("bar")]).every((p) => p.rows === 5) && autoLayout([mkw("pie"), mkw("map")]).every((p) => p.rows === 6), "charts in one row share one height");

// ---------- manual layout: drag, resize, keep ----------
const rectsOf = (ws: ReturnType<typeof mkw>[]) => [...layoutRects(ws)].map(([id, r]) => ({ id, ...r }));
const noOverlap = (ws: ReturnType<typeof mkw>[]) => { const r = rectsOf(ws); return r.every((a, i) => r.every((b, j) => i === j || !(a.col < b.col + b.cols && b.col < a.col + a.cols && a.row < b.row + b.rows && b.row < a.row + a.rows))); };
const inside = (ws: ReturnType<typeof mkw>[]) => rectsOf(ws).every((r) => r.col >= 0 && r.col + r.cols <= 12 && r.row >= 0 && r.cols >= 2 && r.rows >= 2);
{
  const base = [mkw("kpi"), mkw("kpi"), mkw("bar"), mkw("pie"), mkw("bar"), mkw("line"), mkw("table")];
  ok(!isManualLayout(base) && placeAll(base).every((p) => p.col === undefined), "a page nobody has touched stays on the automatic layout");
  const before = placeAll(base).map((p) => `${p.w.id}:${p.span}x${p.rows}`).join();
  const frozen = setWidgetRect(base, base[0].id, {});
  ok(isManualLayout(frozen) && frozen.every((w) => w.col !== undefined), "the first change saves a rectangle for every chart");
  ok(placeAll(frozen).map((p) => `${p.w.id}:${p.span}x${p.rows}`).sort().join() === before.split(",").sort().join(), "freezing the layout does not change any chart's size");
  ok(noOverlap(frozen) && inside(frozen), "a frozen automatic layout has no overlaps and stays on the grid");

  // move: drop the first chart on top of the third
  const third = layoutRects(frozen).get(base[2].id)!;
  const moved = setWidgetRect(frozen, base[0].id, { col: third.col, row: third.row });
  const mr = layoutRects(moved);
  ok(mr.get(base[0].id)!.col === third.col && mr.get(base[0].id)!.row === third.row, "the chart you move lands exactly where it was dropped");
  ok(noOverlap(moved) && inside(moved), "charts it lands on are pushed aside, never overlapped");
  ok(moved.length === frozen.length && new Set(moved.map((w) => w.id)).size === frozen.length, "nothing is lost or duplicated by a move");

  // resize
  const wide = setWidgetRect(frozen, base[2].id, { cols: 9, rows: 8 });
  const wr = layoutRects(wide).get(base[2].id)!;
  ok(wr.cols === 9 && wr.rows === 8 && noOverlap(wide) && inside(wide), "a chart can be made wider and taller, and the rest make way");
  const tiny = layoutRects(setWidgetRect(frozen, base[2].id, { cols: 0, rows: -4 })).get(base[2].id)!;
  ok(tiny.cols === 2 && tiny.rows === 2, "a chart cannot be shrunk below 2 x 2");
  const huge = layoutRects(setWidgetRect(frozen, base[2].id, { col: 11, cols: 30, rows: 99 })).get(base[2].id)!;
  ok(huge.col + huge.cols <= 12 && huge.rows <= 40, "a chart cannot be pushed off the right edge or made absurdly tall");

  // a new chart on a manual page gets a free spot; removing one closes the gap
  const extra = mkw("map");
  const grown = [...frozen, extra];
  ok(noOverlap(grown) && inside(grown) && layoutRects(grown).has(extra.id), "a chart added to a manual page gets a free place");
  const gone = settle(frozen.filter((w) => w.id !== base[0].id));
  ok(noOverlap(gone) && inside(gone), "removing a chart leaves a tidy layout");
  ok(settle(base) === base, "removing from an automatic page changes nothing else");

  // reset + persistence
  const back = resetRects(moved);
  ok(!isManualLayout(back) && back.every((w) => !("col" in w)), "Reset layout returns to the automatic layout");
  const saved = normalizeConfig(JSON.parse(JSON.stringify({ pages: [{ id: "p", title: "P", widgets: moved }] })));
  ok(JSON.stringify(saved.pages[0].widgets.map((w) => [w.col, w.row, w.cols, w.rows])) === JSON.stringify(moved.map((w) => [w.col, w.row, w.cols, w.rows])), "a saved layout comes back exactly as it was");
  ok(normalizeConfig({ pages: [{ id: "p", title: "P", widgets: [{ ...base[0], col: 3 }] }] }).pages[0].widgets[0].col === undefined, "a half-saved rectangle is ignored, not trusted");
  ok(normalizeConfig({ pages: [{ id: "p", title: "P", widgets: [{ ...base[0], col: 11, row: 0, cols: 12, rows: 3 }] }] }).pages[0].widgets[0].col === 0, "a rectangle running off the grid is pulled back on it");

  // the drag preview and the order a phone reads them in
  const preview = arrangeRects(layoutRects(frozen), base[0].id, { ...layoutRects(frozen).get(base[0].id)!, row: 4 });
  const order = placeAll(frozen, preview).map((p) => p.row! * 100 + p.col!);
  ok(order.every((v, i) => i === 0 || v >= order[i - 1]), "charts are listed top to bottom, left to right");
}

// ---------- templates ----------
{
  const bare = { id: "b", project_id: "p", name: "Bare", version: 1, status: "published", fields: [{ id: "note", label: "Note", type: "text" }] } as unknown as Form;   // no choices, no numbers, no location
  const flat = { ...form, id: "g", name: "No location", geometry_type: undefined } as unknown as Form;
  const overlap = (a: { col: number; row: number; cols: number; rows: number }, b: typeof a) => a.col < b.col + b.cols && b.col < a.col + a.cols && a.row < b.row + b.rows && b.row < a.row + a.rows;
  for (const t of TEMPLATES) {
    for (const [label, fm] of [["a form with everything", form], ["a bare form", bare], ["a form with no location", flat]] as const) {
      let i = 0;
      const ws = templateWidgets(t.id, fm, () => `t${i++}`), d = dashboardFields(fm);
      if (t.id === "blank") { ok(ws.length === 0, `blank is empty (${label})`); continue; }
      ok(ws.length > 0 && ws.length <= 30 && new Set(ws.map((w) => w.id)).size === ws.length, `${t.name}: charts with unique ids (${label})`);
      ok(ws.every((w) => widgetProblem(w, d) === null), `${t.name}: every chart can be drawn (${label})`);
      if (t.id === "standard") { ok(!isManualLayout(ws), "the standard overview stays on the automatic layout"); continue; }
      const r = [...layoutRects(ws)].map(([, x]) => x);
      ok(ws.every((w) => w.col !== undefined) && r.every((x) => x.col >= 0 && x.col + x.cols <= 12 && x.cols >= 2 && x.rows >= 2), `${t.name}: every chart sits on the grid (${label})`);
      ok(r.every((a, x) => r.every((b, y) => x === y || !overlap(a, b))), `${t.name}: nothing overlaps (${label})`);
      const same = (x: unknown): string => JSON.stringify(x, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([p], [q]) => p.localeCompare(q))) : v));
      ok(same(normalizeConfig({ pages: [{ id: "p", title: "P", widgets: ws }] }).pages[0].widgets) === same(ws), `${t.name}: survives saving and reopening (${label})`);
    }
  }
  ok(templateWidgets("map", form).some((w) => w.type === "map") && !templateWidgets("map", flat).some((w) => w.type === "map") && templateWidgets("map", flat).some((w) => w.type === "line"), "Map focus uses a map when the form has locations and a time chart when it has none");
  const two = { ...form, fields: [...(form as unknown as { fields: unknown[] }).fields, { id: "width", label: "Width", type: "number" }] } as unknown as Form;
  const kpis = (fm: Form) => templateWidgets("executive", fm).filter((w) => w.type === "kpi").length;
  ok(kpis(bare) === 1 && kpis(form) === 3 && kpis(two) === 4, "number cards follow the number fields the form has (1, 3 or 4)");
  ok(templateWidgets("review", form).find((w) => w.type === "table")!.columns.slice(0, 2).join() === "__status,__updated", "Review queue's table leads with status and date changed");
  const strips = templateWidgets("executive", form).filter((w) => w.row === 0);
  ok(strips.reduce((n, w) => n + w.cols!, 0) === 12, "a band of charts fills the whole 12 columns");
  let a = 0, b = 0;
  const std = templateWidgets("standard", form, () => `x${a++}`), old = starterWidgets(form, () => `x${b++}`);
  ok(JSON.stringify(std) === JSON.stringify(old), "the standard template is exactly the starter set it always was");
  ok(templatePages("blank", [form, bare], true).length === 2 && templatePages("blank", [form, bare], true).every((p) => p.widgets.length === 0), "a blank dashboard has one empty page per form and no overview");
  ok(templatePages("executive", [form, bare], true)[0].title === "Overview" && templatePages("executive", [form, bare], false).length === 2, "templates give a page per form, plus the overview when asked");
  ok(templatePages("trends", [], true).length === 1, "no forms still gives a page");
  for (const t of TEMPLATES) {
    const sk = templateSketch(t.id as TemplateId);
    ok(t.id === "blank" ? sk.length === 0 : sk.length > 2 && sk.every((x) => x.col + x.cols <= 12), `${t.name}: has a thumbnail`);
  }
}

// ---------- pages ----------
const old = normalizeConfig({ form_id: "f", widgets: [{ id: "a", type: "bar", title: "T", width: 3, metric: "count", bucket: "month", limit: 8, columns: [], field: "type" }, { id: "b", type: "kpi", width: 1 }] });
ok(old.pages.length === 1 && old.pages[0].title === "Overview" && old.pages[0].form_id === "f" && old.pages[0].widgets.length === 2, "a dashboard saved before pages becomes one page");
ok(old.pages[0].widgets[0].wide === true && old.pages[0].widgets[1].wide === undefined && !("width" in old.pages[0].widgets[0]), "the old full width becomes 'wide'; the other widths are chosen by the layout");
ok(normalizeConfig({}).pages.length === 1 && normalizeConfig(null).pages[0].widgets.length === 0, "an empty config still has a page");
const again = normalizeConfig(old);
ok(JSON.stringify(again) === JSON.stringify(old), "normalising twice changes nothing");

const f2 = { ...form, id: "f2", name: "Navy" } as unknown as Form, f3 = { ...form, id: "f3", name: "Air Force" } as unknown as Form;
let m = 0;
const pages = starterPages([form, f2, f3], true, () => `p${m++}`);
ok(pages.length === 4 && pages[0].title === "Overview" && pages.slice(1).map((p) => p.title).join() === "Water point,Navy,Air Force", "one page per form, with an overview first");
ok(new Set(pages.map((p) => p.id)).size === 4 && new Set(pages.flatMap((p) => p.widgets.map((w) => w.id))).size === pages.reduce((n, p) => n + p.widgets.length, 0), "page and chart ids are unique");
ok(pageFormIds(pages[0]).join() === "f,f2,f3" && pageFormIds(pages[2]).join() === "f2", "the overview draws on every form; a form page on its own");
ok(starterPages([form], true).length === 1 && starterPages([], true)[0].widgets.length === 0, "one form gets no overview; no forms still gives a page");
const ov = overviewWidgets([form, f2]);
ok(ov.filter((w) => w.type === "kpi").length === 2 && ov.every((w) => w.form_id), "the overview has a number card and a status pie for each form");

// ---------- filters in the address ----------
const fl = { status: "approved" as const, from: "2026-01-01", to: "2026-02-01", equals: [{ field: "type", value: "Well", label: "Type: Well" }, { field: "n", value: "", label: "N: (blank) | odd & text" }] };
const qs = filtersToParams(fl, new URLSearchParams("page=abc"));
ok(qs.get("page") === "abc" && JSON.stringify(filtersFromParams(new URLSearchParams(qs.toString()))) === JSON.stringify(fl), "filters survive the trip through the address, other parts untouched");
ok(filtersToParams(noFilters(), qs).toString() === "page=abc" && JSON.stringify(filtersFromParams(new URLSearchParams("status=bogus&from=nope&eq=%ZZ"))) === JSON.stringify(noFilters()), "clearing removes them; rubbish in the address is ignored");

// ---- header filters, multi-select, and empty states ----
const eq = (field: string, value: string) => ({ field, value, label: value });
r = filterFeatures(data, { ...noFilters(), equals: [eq("type", "Well"), eq("type", "Borehole")] }, defs);
ok(r.length === 3, "two values of one field are alternatives (Well or Borehole)");
r = filterFeatures(data, { ...noFilters(), equals: [eq("type", "Well"), eq("working", "false")] }, defs);
ok(r.length === 1, "different fields must all match");
const opts = filterOptions(data, f("type"));
ok(opts[0].label === "Well" && opts[0].count === 2 && opts[opts.length - 1].key === "", "filter options: most common first, (blank) last");
ok(filterableFields(defs).map((d) => d.id).join() === "type,working,tags" && !filterableFields(defs).some((d) => d.id === "depth"), "only choice, yes/no, multiple-choice and text fields are filterable");
let tf = toggleEquals(noFilters(), eq("type", "Well"));
tf = toggleEquals(tf, eq("type", "Tap"));
ok(selectedValues(tf, "type").join() === "Well,Tap" && selectedValues(withoutField(tf, "type"), "type").length === 0, "toggle adds values; withoutField drops one field's filters");
ok(toggleEquals(tf, eq("type", "Well")).equals.length === 1, "toggling a picked value removes it");
const np = normalizeConfig({ pages: [{ id: "a", title: "A", filters: ["type", "type", "", 5, "working"], widgets: [] }, { id: "b", title: "B", widgets: [] }] });
ok(np.pages[0].filters?.join() === "type,working" && np.pages[1].filters === undefined, "page filters are cleaned and optional");
const srcOf = (rows: Feature[], base = rows) => ({ form, defs, base, rows });
const W = (type: Parameters<typeof newWidget>[0], patch = {}) => ({ ...newWidget(type, defs), ...patch });
let e = widgetData(W("bar", { field: "type" }), srcOf([], []), true);
ok(e.kind === "empty" && e.reason === "no-records", "no records yet is said plainly");
e = widgetData(W("bar", { field: "type" }), srcOf([], data), true);
ok(e.kind === "empty" && e.reason === "filtered", "filters that leave nothing say so");
const blanks = [rec({ working: true }, "approved", "2026-01-01T00:00:00Z"), rec({ working: false }, "approved", "2026-01-02T00:00:00Z")];
e = widgetData(W("bar", { field: "type" }), srcOf(blanks), true);
ok(e.kind === "empty" && e.reason === "no-data" && e.message.includes("“Type”"), "a field blank in every record says No data for this field, not an empty chart");
e = widgetData(W("kpi", { metric: "avg", metric_field: "depth" }), srcOf(blanks), true);
ok(e.kind === "empty" && e.reason === "no-data", "an average of a blank number says no data");
ok(widgetData(W("kpi"), srcOf(blanks), true).kind === "number", "a plain count still shows a number");
e = widgetData(W("line", { field: "visited" }), srcOf(blanks), true);
ok(e.kind === "empty" && e.reason === "no-data", "a date nobody filled in says no data");

// ---- a line-chart point filters to its own day, week or month ----
ok(JSON.stringify(bucketRange("2026-03-05", "day")) === JSON.stringify({ from: "2026-03-05", to: "2026-03-05", label: "5 Mar 2026" }), "a day point is that one day");
ok(bucketRange("2026-03-02", "week").to === "2026-03-08" && bucketRange("2026-03-02", "week").label === "Week of 2 Mar 2026", "a week point runs Monday to Sunday");
ok(bucketRange("2026-02", "month").to === "2026-02-28" && bucketRange("2026-12", "month").to === "2026-12-31" && bucketRange("2024-02", "month").to === "2024-02-29", "a month point ends on the month's real last day");
const rg = (from: string, to: string) => ({ field: UPDATED_ID, from, to, label: "x" });
r = filterFeatures(data, { ...noFilters(), ranges: [rg("2026-01-01", "2026-01-31")] }, defs);
ok(r.length === 2, "a range keeps records on its days (ends included)");
r = filterFeatures(data, { ...noFilters(), ranges: [rg("2026-01-05", "2026-01-05")] }, defs);
ok(r.length === 1, "a one-day range matches only that day");
r = filterFeatures(data, { ...noFilters(), ranges: [rg("2026-01-01", "2026-01-31"), rg("2026-03-01", "2026-03-31")] }, defs);
ok(r.length === 4, "two ranges of one date are alternatives");
r = filterFeatures(data, { ...noFilters(), ranges: [{ field: "visited", from: "2026-03-01", to: "2026-03-31", label: "v" }] }, defs);
ok(r.length === 1, "a range on another date field uses that field; records with no date are outside it");
let tr = toggleRange(noFilters(), rg("2026-01-01", "2026-01-31"));
ok((tr.ranges ?? []).length === 1 && (toggleRange(tr, rg("2026-01-01", "2026-01-31")).ranges ?? []).length === 0, "clicking a point twice undoes it");
ok(isFiltered(tr) && !isFiltered(noFilters()) && (withoutField(tr, UPDATED_ID).ranges ?? []).length === 0, "a range counts as a filter; withoutField drops it");
ok(activeBuckets(tr, UPDATED_ID, "day", ["2026-01-05"]).length === 0 && activeBuckets(tr, UPDATED_ID, "month", ["2026-01", "2026-02"]).join() === "2026-01", "only the points whose exact range is picked show as picked");
const back = filtersFromParams(filtersToParams({ ...noFilters(), ranges: [{ field: UPDATED_ID, from: "2026-01-01", to: "2026-01-31", label: "Date changed: Jan 2026 | odd & text" }] }));
ok(back.ranges?.length === 1 && back.ranges[0].label === "Date changed: Jan 2026 | odd & text" && back.ranges[0].to === "2026-01-31", "ranges survive the page address");
ok(!("ranges" in filtersFromParams(new URLSearchParams("rg=x%7Cnope%7C2026-01-01%7Cl&rg=%ZZ"))), "rubbish in the address is ignored");

// ---- dropdown counts follow the other filters ----
const others = filterFeatures(data, { ...noFilters(), status: "approved" }, defs);
const fo = facetOptions(data, others, f("type"));
ok(fo.map((o) => o.label).join() === opts.map((o) => o.label).join(), "faceted options keep the same order as the plain ones");
ok(fo.find((o) => o.label === "Well")?.count === 1 && fo.find((o) => o.label === "Borehole")?.count === 1 && fo.find((o) => o.key === "")?.count === 0, "counts follow the other filters; a value with none shows 0");
ok(facetOptions(data, data, f("type")).every((o, i) => o.count === opts[i].count), "with no other filter the counts are the plain totals");
