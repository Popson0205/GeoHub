// The filter bar: category selectors (own records, another form, a web address), the Today / Last N days filter, and which element each filter reaches.
import {
  buildSources, cleanControls, cleanExclude, controlOptions, controlProblem, controlValues, dashboardFields, filterFeatures, filtersFromParams, filtersToParams, formValues,
  isScoped, newControl, newWidget, noFilters, normalizeConfig, parseExternalValues, safeHttpsUrl, scopeFilters, toggleEquals, STATUS_ID, UPDATED_ID, type Filters,
} from "../src/lib/dashboard";
import { TEMPLATES, templateControls, templatePages, templateSketch, templateWidgets } from "../src/lib/dashboardTemplates";
import { layoutRects } from "../src/lib/dashboard";
import type { DashControl, Feature, Form } from "../src/lib/types";

const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const form = { id: "f", project_id: "p", name: "Assets", geometry_type: "Point", version: 1, status: "published", fields: [
  { id: "zone", label: "Zone", type: "choice", choices: ["Academic", "Residential", "Sports"] },
  { id: "kva", label: "Rated kVA", type: "number" }, { id: "name", label: "Name", type: "text" },
] } as unknown as Form;
const zones = { id: "z", project_id: "p", name: "Zones", geometry_type: "Point", version: 1, status: "published", fields: [{ id: "zname", label: "Zone name", type: "text" }] } as unknown as Form;
const defs = dashboardFields(form);
let n = 0;
const rec = (props: Record<string, unknown>, updated: string, status: Feature["status"] = "approved", form_id = "f"): Feature =>
  ({ id: `r${n++}`, project_id: "p", form_id, form_version: 1, geometry: { type: "Point", coordinates: [0, 0] }, properties: props, status, version: 1, updated_at: updated });
const NOW = new Date("2026-10-29T12:00:00Z");
const data = [
  rec({ zone: "Academic", kva: 100 }, "2026-10-29T08:00:00Z"),   // today
  rec({ zone: "Academic", kva: 200 }, "2026-10-25T08:00:00Z"),   // 4 days ago
  rec({ zone: "Sports", kva: 300 }, "2026-10-01T08:00:00Z"),     // 28 days ago
  rec({ zone: "Residential", kva: 400 }, "2026-06-01T08:00:00Z"),
];

// --- the date filter ---
const last = (days: number): Filters => ({ ...noFilters(), last: { days } });
ok(filterFeatures(data, last(0), defs, NOW).length === 1, "Today keeps only records changed today");
ok(filterFeatures(data, last(7), defs, NOW).length === 2, "Last 7 days keeps the week");
ok(filterFeatures(data, last(30), defs, NOW).length === 3, "Last 30 days keeps the month");
ok(filterFeatures(data, noFilters(), defs, NOW).length === 4, "no date filter keeps everything");
ok(filterFeatures(data, { ...last(30), equals: [{ field: "zone", value: "Academic", label: "Zone: Academic" }] }, defs, NOW).length === 2, "the date filter and a category selector both apply");
const rt = filtersFromParams(filtersToParams({ ...last(0), equals: [{ field: "zone", value: "Sports", label: "Zone: Sports", src: "c1" }] }));
ok(rt.last?.days === 0 && rt.equals[0].src === "c1", "Today and a filter's source survive the address");
ok(filtersFromParams(new URLSearchParams("last=45")).last?.days === 45 && filtersFromParams(new URLSearchParams("last=-3")).last === undefined && filtersFromParams(new URLSearchParams("last=abc")).last === undefined && filtersFromParams(new URLSearchParams("last=99999")).last === undefined, "a typed number of days is checked");
ok(filtersFromParams(new URLSearchParams("eq=zone%7CSports%7CSports")).equals[0].src === undefined, "an older address with no source still reads");
const withField = filterFeatures([rec({ zone: "A" }, "2026-01-01T00:00:00Z")], { ...noFilters(), last: { days: 7, field: "gone" } }, defs, NOW);
ok(withField.length === 0, "a date filter on a missing field falls back to when the record changed");

// --- which filter reaches which element ---
const f1: Filters = toggleEquals(toggleEquals(noFilters(), { field: "zone", value: "Sports", label: "Zone: Sports", src: "selector" }), { field: "name", value: "x", label: "Name: x", src: "chartA" });
const exclude = { selector: ["kpi1"], chartA: ["kpi1", "table1"] };
ok(scopeFilters(f1, "kpi1", exclude).equals.length === 0, "an element left out of every filter is not filtered");
ok(scopeFilters(f1, "table1", exclude).equals.map((e) => e.src).join() === "selector", "an element left out of one filter still gets the other");
ok(scopeFilters(f1, "map1", exclude).equals.length === 2 && !isScoped(f1, "map1", exclude), "an element not mentioned is filtered by everything, with no extra work");
ok(scopeFilters(f1, "kpi1", undefined) === f1 && !isScoped(f1, "kpi1", undefined), "no exceptions means everything reaches everything");
ok(scopeFilters({ ...noFilters(), last: { days: 7, src: "date" } }, "kpi1", { date: ["kpi1"] }).last === undefined, "the date filter can be kept off one element");
ok(scopeFilters({ ...noFilters(), from: "2026-01-01" }, "kpi1", { selector: ["kpi1"] }).from === "2026-01-01", "the dashboard's own date range reaches every element");
ok(JSON.stringify(cleanExclude({ ok1: ["a", "a", "b c", 5, "d"], "bad key": ["x"], e: [], f: "no" })) === JSON.stringify({ ok1: ["a", "d"] }) && cleanExclude([]) === undefined && cleanExclude(null) === undefined, "exceptions are cleaned");

// --- controls ---
const c1 = cleanControls([
  { id: "a1", kind: "category", label: "Zone", field: "zone", multi: false },
  { id: "a1", kind: "category", field: "kva" },                       // duplicate id
  { id: "d1", kind: "date", label: "Date" }, { id: "d2", kind: "date" }, // second date filter
  { id: "x y", kind: "category" }, { id: "w", kind: "weird" }, null, 7,
  { id: "u1", kind: "category", field: "zone", source: { type: "url", url: "https://x.org/z.csv", column: "name" } },
  { id: "f1", kind: "category", field: "zone", source: { type: "form", form_id: "z", field: "zname" } },
], ["name", "zone"]);
ok(c1.map((c) => c.id).join() === "a1,d1,u1,f1,fc_name", "bad, duplicate and second date controls are dropped; an older field list adds selectors (a field already covered by plain records is skipped)");
ok(c1[0].multi === false && c1[2].source?.type === "url" && c1[3].source?.type === "form", "a control keeps its single-pick setting and its source");
ok(cleanControls(Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, kind: "category", field: "zone" }))).length === 6, "a page has at most six filters");
const np = normalizeConfig({ pages: [{ id: "p", title: "P", form_id: "f", widgets: [], controls: [{ id: "a1", kind: "category", field: "zone" }], exclude: { a1: ["w1"] } }] });
ok(np.pages[0].controls?.length === 1 && np.pages[0].exclude?.a1[0] === "w1", "controls and exceptions survive loading a saved dashboard");
const catC = (extra: Partial<DashControl> = {}): DashControl => ({ id: "c", kind: "category", label: "", field: "zone", ...extra });
ok(controlProblem(catC(), defs, [form, zones]) === null && controlProblem(catC({ field: undefined }), defs, [form]) !== null && controlProblem(catC({ field: "gone" }), defs, [form]) !== null, "a selector needs a field the form has");
ok(controlProblem(catC({ field: STATUS_ID }), defs, [form]) === null, "review status can be filtered by");
ok(controlProblem(catC({ source: { type: "url", url: "http://x.org/a" } }), defs, [form]) !== null && controlProblem(catC({ source: { type: "url", url: "https://x.org/a.json" } }), defs, [form]) === null, "a web address list must be https");
ok(controlProblem(catC({ source: { type: "form", form_id: "z", field: "zname" } }), defs, [form, zones]) === null && controlProblem(catC({ source: { type: "form", form_id: "nope", field: "zname" } }), defs, [form, zones]) !== null && controlProblem(catC({ source: { type: "form", form_id: "z", field: "zzz" } }), defs, [form, zones]) !== null, "a lookup form and field must exist");
ok(controlProblem({ id: "d", kind: "date", label: "", field: "gone" }, defs, [form]) !== null && controlProblem({ id: "d", kind: "date", label: "" }, defs, [form]) === null, "the date filter defaults to when the record changed");
ok(safeHttpsUrl("https://a.org/x") !== null && safeHttpsUrl("javascript:alert(1)") === null && safeHttpsUrl("http://a.org") === null && safeHttpsUrl("https://u:p@a.org/") === null, "only plain https addresses are accepted");

// --- where a selector's values come from ---
const src = buildSources(["f"], [form], data, noFilters(), NOW).get("f")!;
const own = controlOptions(catC(), defs.find((d) => d.id === "zone")!, src.base, src.rows);
ok(own.listed === false && own.options.find((o) => o.key === "Academic")?.count === 2, "from the page's own records: the values they hold, with counts");
const lookup = [rec({ zname: "Sports" }, "2026-01-01T00:00:00Z", "approved", "z"), rec({ zname: "Library" }, "2026-01-01T00:00:00Z", "approved", "z"), rec({ zname: "Sports" }, "2026-01-02T00:00:00Z", "approved", "z"), rec({}, "2026-01-02T00:00:00Z", "approved", "z")];
const fv = formValues([...data, ...lookup], zones, "zname");
ok(fv.join() === "Library,Sports", "from another form: each distinct value once, blanks left out, alphabetical");
const ext = controlOptions(catC({ source: { type: "form", form_id: "z", field: "zname" } }), defs.find((d) => d.id === "zone")!, src.base, src.rows, fv, ["Gone"]);
ok(ext.listed && ext.options.map((o) => o.label).join() === "Library,Sports,Gone" && ext.options.find((o) => o.key === "Sports")?.count === 1 && ext.options.find((o) => o.key === "Library")?.count === 0, "an outside list shows values with no records yet, and keeps a picked value that left the list");
ok(controlValues({ ...noFilters(), equals: [{ field: "zone", value: "A", label: "", src: "c" }, { field: "zone", value: "B", label: "", src: "other" }, { field: "zone", value: "C", label: "" }] }, catC()).join() === "A,C", "a selector shows its own values (and an older address's)");
ok(parseExternalValues('["a","b","a"," ",1]').join() === "a,b,1", "a JSON list: text and numbers, once each");
ok(parseExternalValues('[{"name":"North","x":1},{"name":"South"}]', "name").join() === "North,South" && parseExternalValues('[{"name":"North"}]').join() === "North", "a JSON list of objects reads the named property, or the first text one");
ok(parseExternalValues('{"features":[{"properties":{"lga":"Ife"}},{"properties":{"lga":"Ede"}}]}', "lga").join() === "Ife,Ede", "GeoJSON reads each feature's property");
ok(parseExternalValues('{"meta":1,"items":["x","y"]}').join() === "x,y", "an object holding a list uses that list");
ok(parseExternalValues('name,code\n"North, Zone",1\nSouth,2\n', "name").join() === "North, Zone,South" && parseExternalValues("zone\r\nA\r\nB").join() === "A,B", "a CSV: header row, quoted commas, first column when none is named");
ok(parseExternalValues("a,b\n1,2", "missing").length === 0 && parseExternalValues("").length === 0 && parseExternalValues("<html>nope</html>").length === 0, "a missing column or a web page gives no values");
ok(parseExternalValues(JSON.stringify(Array.from({ length: 900 }, (_, i) => `v${i}`))).length === 500, "a list is capped");

// --- the Monitoring board ---
ok(TEMPLATES[0].id === "monitor", "the Monitoring board is the first template");
let k = 0;
const ws = templateWidgets("monitor", form, () => `w${k++}`);
const r = layoutRects(ws);
const side = ws.filter((w) => w.region === "sidebar");
ok(side.length === 1 && side[0].type === "list" && ws.some((w) => w.type === "table") && ws.filter((w) => w.type === "kpi").length >= 2, "a list in the side column, key numbers on top, a table below");
ok([...r.values()].every((x) => x.col >= 0 && x.col + x.cols <= 12 && x.cols >= 2 && x.rows >= 2), "every element sits on the grid");
const boxes = [...r.values()]; let clash = false;
boxes.forEach((a, i) => boxes.forEach((b, j) => { if (i < j && a.col < b.col + b.cols && b.col < a.col + a.cols && a.row < b.row + b.rows && b.row < a.row + a.rows) clash = true; }));
ok(!clash, "nothing overlaps");
ok(side[0].rows === Math.max(...boxes.map((b) => b.row + b.rows)) , "the list column is as tall as the grid");
const tc = templateControls("monitor", form);
ok(tc.length === 2 && tc[0].kind === "category" && tc[0].field === "zone" && tc[1].kind === "date" && templateControls("standard", form).length === 0, "the board brings a selector and a date filter");
ok(templatePages("monitor", [form], false)[0].controls?.length === 2 && new Set(templatePages("monitor", [form], false)[0].controls!.map((c) => c.id)).size === 2, "new dashboards from it get those filters");
ok(templateSketch("monitor").some((s) => s.col === 0 && s.cols === 3) && templateSketch("monitor").every((s) => s.col + s.cols <= 12), "its thumbnail shows the side column");
ok(newControl("category", defs).field === "zone" && newControl("date", defs).field === UPDATED_ID && newWidget("list", defs).type === "list", "new controls start on a sensible field");

// ---- click actions ----
import { actionsOf, cleanActions, clickKind, filtersOthers, recordsOfSlice, toggleRecord, widgetData, tableRows } from "../src/lib/dashboard";
const W = (type: Parameters<typeof newWidget>[0], p: Record<string, unknown> = {}) => ({ ...newWidget(type, defs, () => `w${type}`), ...p });
ok(clickKind(W("list")) === "record" && clickKind(W("table")) === "record" && clickKind(W("map")) === "record" && clickKind(W("details")) === "record" && clickKind(W("bar")) === "group" && clickKind(W("kpi")) === "all" && clickKind(W("rich_text")) === null && clickKind(W("embedded")) === null, "every element that shows records, groups or a number can be clicked; text and embeds cannot");
ok(actionsOf(W("bar")).filter === true && actionsOf(W("list")).filter === false && actionsOf(W("bar", { actions: { filter: false } })).filter === false && actionsOf(W("list", { actions: { filter: true, zoom: ["m"] } })).zoom[0] === "m", "charts filter by default; lists, tables and maps only when set");
ok(actionsOf(W("kpi", { actions: { filter: true } })).filter === false && actionsOf(W("rich_text", { actions: { zoom: ["m"] } })).zoom.length === 0, "a number cannot filter, and text has no actions");
ok(filtersOthers(W("list", { actions: { filter: true } })) && !filtersOthers(W("list")) && filtersOthers(W("bar", { field: "zone" })) && !filtersOthers(W("bar", { field: undefined })), "the Filters panel lists an element as a source when its click filters");
ok(JSON.stringify(cleanActions({ filter: false, zoom: ["a", "a", "b c", 5, "m1"], junk: 1 })) === JSON.stringify({ filter: false, zoom: ["a", "m1"] }) && cleanActions({}) === undefined && cleanActions("x") === undefined, "saved actions are cleaned");
ok(normalizeConfig({ pages: [{ id: "p", title: "P", widgets: [{ id: "l1", type: "list", title: "", metric: "count", bucket: "month", limit: 3, columns: [], show_labels: true, actions: { zoom: ["m1"] }, subtitle_fields: Array.from({ length: 70 }, (_, i) => `f${i}`) }] }] }).pages[0].widgets[0].subtitle_fields?.length === 60, "a list can keep up to 60 fields");

// the record filter
const one = { ids: ["r1"], label: "Generator 31", src: "list1" };
ok(toggleRecord(noFilters(), one).record?.ids[0] === "r1" && toggleRecord(toggleRecord(noFilters(), one), one).record === undefined, "clicking a record again lets go of it");
ok(toggleRecord(toggleRecord(noFilters(), one), { ids: ["r2"], label: "x", src: "table1" }).record?.ids[0] === "r2", "clicking another record replaces the pick");
const picked = data.slice(0, 2).map((x) => x.id);
ok(filterFeatures(data, { ...noFilters(), record: { ids: [picked[1]], label: "x" } }, defs, NOW).length === 1 && filterFeatures(data, { ...noFilters(), record: { ids: picked, label: "x" }, ...{ equals: [{ field: "zone", value: "Sports", label: "" }] } }, defs, NOW).length === 0, "a record filter keeps only that record, together with the other filters");
ok(scopeFilters({ ...noFilters(), record: one }, "kpi", { list1: ["kpi"] }).record === undefined && scopeFilters({ ...noFilters(), record: one }, "other", { list1: ["kpi"] }).record !== undefined && isScoped({ ...noFilters(), record: one }, "kpi", { list1: ["kpi"] }), "an element can be left out of a record pick");
const rt2 = filtersFromParams(filtersToParams({ ...noFilters(), record: { ids: ["a1", "b-2"], label: "Pole, 7 | north", src: "l1" } }));
ok(rt2.record?.ids.join() === "a1,b-2" && rt2.record?.label === "Pole, 7 | north" && rt2.record?.src === "l1" && filtersFromParams(new URLSearchParams("rec=%3Cscript%3E")).record === undefined, "a picked record survives the address; odd ids are refused");
ok(recordsOfSlice(data, defs.find((d) => d.id === "zone"), "Academic").length === 2 && recordsOfSlice(data, undefined, "x").length === 0, "the records of a clicked bar or slice");

// list and table show everything
const big = Array.from({ length: 500 }, (_, i) => rec({ zone: "Academic", name: `n${i}`, kva: i }, "2026-10-01T00:00:00Z"));
const bigSrc = buildSources(["f"], [form], big, noFilters(), NOW).get("f")!;
const lw = widgetData(W("list", { title_field: "name", subtitle_fields: ["zone", "kva", "__status", "name", "kva"], limit: 5 }) as never, bigSrc, true);
ok(lw.kind === "list" && lw.rows.length === 500 && lw.rows[0].lines.length >= 4 && lw.rows[0].lines[0].label === "Zone", "a list shows all 500 records and a line for every field chosen");
const tw = widgetData(W("table", { columns: ["zone", "kva"], limit: 5, all_rows: true }) as never, bigSrc, true), tl = widgetData(W("table", { columns: ["zone", "kva"], limit: 5 }) as never, bigSrc, true);
ok(tw.kind === "table" && tw.rows.length === 500 && tl.kind === "table" && tl.rows.length === 5 && tableRows(big, [], Infinity).length === 500, "a table shows every record when asked, and keeps its row limit otherwise");
const dw = widgetData(W("details", { columns: [] }) as never, src, true);
ok(dw.kind === "details" && typeof dw.id === "string" && dw.id.length > 0, "the details card knows which record it shows");
let tk = 0; const mon = templateWidgets("monitor", form, () => `t${tk++}`), mapW = mon.find((x) => x.type === "map"), listW = mon.find((x) => x.type === "list");
ok(!!listW && listW.actions?.zoom?.[0] === mapW?.id && listW.show_labels === true && (listW.subtitle_fields?.length ?? 0) >= 1 && mon.find((x) => x.type === "table")?.actions?.zoom?.[0] === mapW?.id, "on the Monitoring board a click in the list or table zooms the map");
