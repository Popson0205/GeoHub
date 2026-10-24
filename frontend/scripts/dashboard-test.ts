import { autoLayout, bucketKey, categories, dashboardFields, filterFeatures, filtersFromParams, filtersToParams, fmt, groupBy, kpi, newWidget, noFilters, normalizeConfig, overviewWidgets, pageFormIds, slicesCsv, starterPages, starterWidgets, tableRows, timeSeries, widgetProblem, findField, STATUS_ID, UPDATED_ID } from "../src/lib/dashboard";
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
