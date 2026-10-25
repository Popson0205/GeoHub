// The Dashboard app's logic: the new elements, the side column, the dashboard's date range, saved settings, themes and reports.
import {
  autoLayout, buildSources, dashboardFields, isManualLayout, layoutRects, newWidget, noFilters, normalizeConfig, parseRich, placeAll, safeEmbedUrl, setRegion, setWidgetRect,
  timeRange, widgetData, widgetProblem, withTimeRange, cleanTimeFilter,
} from "../src/lib/dashboard";
import { DASHBOARD_THEMES, cleanTheme, resolveThemeColors, themeToCssVars } from "../src/lib/dashboardThemes";
import { buildReport } from "../src/lib/dashboardReport";
import type { Dashboard, Feature, Form, Widget } from "../src/lib/types";

const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const form = { id: "f", project_id: "p", name: "Water point", geometry_type: "Point", version: 1, status: "published", fields: [
  { id: "type", label: "Type", type: "choice", choices: ["Well", "Tap"] }, { id: "village", label: "Village", type: "text" },
  { id: "depth", label: "Depth", type: "number", unit: "m" }, { id: "photo", label: "Photo", type: "photo" },
] } as unknown as Form;
let n = 0;
const rec = (props: Record<string, unknown>, updated: string, status: Feature["status"] = "approved"): Feature =>
  ({ id: `r${n++}`, project_id: "p", form_id: "f", form_version: 1, geometry: { type: "Point", coordinates: [0, 0] }, properties: props, status, version: 1, updated_at: updated });
const data = [
  rec({ type: "Well", village: "Aba", depth: 10 }, "2026-01-05T10:00:00Z"),
  rec({ type: "Tap", village: "Eko", depth: 30 }, "2026-02-10T10:00:00Z"),
  rec({ type: "Well", village: "Ife", depth: 60 }, "2026-03-15T10:00:00Z"),
];
const defs = dashboardFields(form);
const src = buildSources(["f"], [form], data, noFilters()).get("f")!;
const W = (t: Widget["type"], p: Partial<Widget> = {}): Widget => ({ ...newWidget(t, defs, () => t + (n++)), ...p });
const d = (w: Widget) => widgetData(w, src, true);

// ---- gauge ----
let g = d(W("gauge", { metric: "sum", metric_field: "depth", target: 200 }));
ok(g.kind === "gauge" && g.value === 100 && g.max === 200 && g.percent === 50, "a gauge compares a total with a fixed target");
g = d(W("gauge", { metric: "count", target_field: "depth" }));
ok(g.kind === "gauge" && g.value === 3 && g.max === 100, "a gauge target can be the total of a number field");
g = d(W("gauge", { metric: "sum", metric_field: "depth", target: 50 }));
ok(g.kind === "gauge" && g.percent === 200, "the real percentage is kept when the target is passed");
ok(widgetProblem(W("gauge"), defs) === "Set the target the gauge measures against.", "a gauge with no target says so");
ok(d(W("gauge", { target_field: "gone" })).kind === "problem", "a gauge on a removed target field explains itself");

// ---- list and details ----
const l = d(W("list", { title_field: "village", subtitle_fields: ["type", "depth"], limit: 2 }));
ok(l.kind === "list" && l.rows.length === 2 && l.rows[0].title === "Ife" && l.rows[0].subtitle === "Well · 60", "a list shows the latest records first, heading and subtitle");
ok(d(W("list", { title_field: undefined })).kind === "problem" && d(W("list", { title_field: "gone" })).kind === "problem", "a list needs a heading field that still exists");
const dt = d(W("details", { columns: ["village", "depth"] }));
ok(dt.kind === "details" && dt.items.length === 2 && dt.items[0].value === "Ife", "details shows the most recent record");
ok(d(W("details")).kind === "details" && (d(W("details")) as { items: unknown[] }).items.length >= 3, "details with no fields ticked shows all of them");
ok(widgetData(W("details"), { ...src, rows: [] }, true).kind === "empty", "details with no records says so");

// ---- static elements need no form ----
const t = widgetData(W("rich_text", { content: "**Hi**" }), undefined, false);
ok(t.kind === "text" && t.content === "**Hi**", "a note works on a page with no form");
ok(widgetData(W("kpi"), undefined, false).kind === "problem", "a number with no form asks for one");
ok(widgetData(W("embedded", { url: "https://example.com/x" }), undefined, false).kind === "embed", "an embedded page works with no form");
ok(widgetData(W("embedded", { url: "javascript:alert(1)" }), undefined, false).kind === "problem", "a javascript: address is refused");

// ---- addresses and rich text ----
const bad = ["http://example.com", "javascript:alert(1)", "data:text/html,x", "https://u:p@example.com", "https://localhost", "//example.com", "", "   ", "https://" + "a".repeat(600) + ".com"];
ok(bad.every((u) => safeEmbedUrl(u) === null), "only plain https addresses can be embedded");
ok(safeEmbedUrl(" https://example.com/map?a=1 ") === "https://example.com/map?a=1", "a good address is kept, trimmed");
const rich = parseRich("a **b** and *c*\n\n<script>x</script>");
ok(rich.length === 3 && rich[0].some((s) => s.bold && s.text === "b") && rich[0].some((s) => s.italic && s.text === "c") && rich[1].length === 0, "bold, italic and blank lines");
ok(rich[2].length === 1 && rich[2][0].text === "<script>x</script>", "markup stays plain text; it is never turned into HTML");

// ---- the side column ----
const a = W("kpi", { id: "a" }), b = W("pie", { id: "b" }), c = W("bar", { id: "c" });
const side = setRegion([a, b, c], "b", "sidebar");
ok(side.find((x) => x.id === "b")?.region === "sidebar" && autoLayout(side).every((p) => p.w.id !== "b"), "a side-column element is left out of the grid");
ok(!isManualLayout(side) && placeAll(side).length === 2, "moving to the side keeps an untouched page automatic");
const moved = setWidgetRect(side, "a", { col: 3 });
ok(isManualLayout(moved) && !layoutRects(moved).has("b") && moved.find((x) => x.id === "b")?.region === "sidebar", "arranging the grid never pulls a side element in");
const back = setRegion(moved, "b", "body");
ok(back.find((x) => x.id === "b")?.region === undefined && layoutRects(back).has("b"), "moving back gives it a free place on the grid");
const rs = [...layoutRects(back).values()];
ok(rs.every((r, i) => rs.every((o, j) => i === j || r.col >= o.col + o.cols || o.col >= r.col + r.cols || r.row >= o.row + o.rows || o.row >= r.row + r.rows)), "nothing overlaps after moving back");

// ---- the dashboard's date range ----
const now = new Date("2026-03-20T12:00:00Z");
ok(timeRange(undefined, now).from === undefined && timeRange({ preset: "all_time" }, now).from === undefined, "no range, no limit");
ok(timeRange({ preset: "last_30_days" }, now).from === "2026-02-18" && timeRange({ preset: "last_7_days" }, now).from === "2026-03-13", "last 30 / 7 days");
ok(timeRange({ preset: "custom", start: "2026-01-01", end: "2026-02-28" }, now).to === "2026-02-28", "a custom range has both ends");
ok(cleanTimeFilter({ preset: "custom", start: "nope", end: "2026-01-01" }) === undefined && cleanTimeFilter({ preset: "forever" }) === undefined, "a broken range is dropped, not trusted");
const both = withTimeRange({ ...noFilters(), from: "2026-02-01", to: "2026-12-31" }, { from: "2026-01-01", to: "2026-03-01" });
ok(both.from === "2026-02-01" && both.to === "2026-03-01", "a record must pass the viewer's dates and the dashboard's");
const ranged = buildSources(["f"], [form], data, withTimeRange(noFilters(), timeRange({ preset: "last_30_days" }, now))).get("f")!;
ok(ranged.base.length === 3 && ranged.rows.length === 1, "the range narrows what elements read, not what exists");

// ---- saved settings come back, junk does not ----
const cfg = normalizeConfig({ description: "x", theme: { preset: "dark", overrides: { accent: "#112233", evil: "#000000", background: "red" } }, time_filter: { preset: "last_90_days" },
  pages: [{ id: "p", title: "P", widgets: [{ id: "g", type: "gauge", target: 12, target_field: null, region: "sidebar" }, { id: "l", type: "list", title_field: "village", subtitle_fields: ["type", 3], limit: 5 }, { id: "r", type: "rich_text", content: "hi" }, { id: "e", type: "embedded", url: "https://example.com" }] }] });
const ws = cfg.pages[0].widgets;
ok(ws[0].target === 12 && ws[0].region === "sidebar" && ws[0].target_field === undefined, "gauge target and side region survive a round trip");
ok(ws[1].title_field === "village" && ws[1].subtitle_fields?.join() === "type", "list fields survive; non-text entries are dropped");
ok(ws[2].content === "hi" && ws[3].url === "https://example.com", "text and address survive");
ok(cfg.theme?.preset === "dark" && cfg.theme.overrides?.accent === "#112233" && Object.keys(cfg.theme.overrides ?? {}).length === 1, "theme keeps real colours only");
ok(cfg.time_filter?.preset === "last_90_days", "the date range survives");
ok(normalizeConfig(null).theme === undefined && normalizeConfig(null).time_filter === undefined, "an old dashboard has no theme or range");

// ---- themes ----
ok(resolveThemeColors({ preset: "nope" }).background === DASHBOARD_THEMES.light.colors.background, "an unknown theme falls back to the default");
ok(resolveThemeColors({ preset: "dark", overrides: { accent: "url(x)" } }).accent === DASHBOARD_THEMES.dark.colors.accent, "a colour that is not #rrggbb is ignored");
ok(cleanTheme({ preset: "ocean", overrides: { accent: "#abcdef" } })?.overrides?.accent === "#abcdef" && cleanTheme("x") === undefined, "cleanTheme");
const vars = themeToCssVars(resolveThemeColors({ preset: "dark" })) as Record<string, string>;
ok(vars["--card"] === DASHBOARD_THEMES.dark.colors.cardBackground && vars["--chart-1"] === DASHBOARD_THEMES.dark.colors.accent, "theme colours become the tokens the tiles already use");

// ---- reports ----
const dash: Dashboard = { id: "d1", project_id: "p", name: "Water", updated_at: "", config: { description: "All wells", time_filter: { preset: "last_30_days" }, pages: [
  { id: "m", title: "Overview", form_id: "f", widgets: [W("kpi", { id: "k" }), W("pie", { id: "p", field: "type" }), W("table", { id: "t", columns: ["village"] }), W("rich_text", { id: "n", content: "Note" })] }] } };
const rep = buildReport({ projectName: "Proj", dashboards: [dash], forms: [form], features: data, now });
const els = rep.dashboards[0].pages[0].elements;
ok(rep.totals.dashboards === 1 && rep.totals.pages === 1 && rep.totals.elements === 4, "report totals");
ok(els[0].data.kind === "number" && (els[0].data as { value: number }).value === 1, "the report honours the dashboard's own date range");
ok(rep.dashboards[0].range === "Last 30 days" && rep.dashboards[0].pages[0].formName === "Water point", "the report names the range and the form");
ok(rep.totals.records === 3, "records are counted once per form");
const short = buildReport({ projectName: "Proj", dashboards: [dash], forms: [form], features: data, now, options: { includeRecords: false } });
ok(short.dashboards[0].pages[0].elements.every((e) => e.type !== "table") && short.dashboards[0].pages[0].elements.length === 3, "a short report leaves out record tables");
const lost = buildReport({ projectName: "Proj", dashboards: [dash], forms: [], features: [], now });
ok(lost.dashboards[0].pages[0].elements.some((e) => e.data.kind === "problem"), "a report on a removed form says so instead of failing");
