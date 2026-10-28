// Draws the Dashboard app's screens on the server with sample data, to catch crashes the type checker can't see.
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { AddElementPanel, BuilderSidebar, DataSourcesPanel, EmptyCanvas, ThemePanel, TimePanel, ViewPanel } from "../src/components/dashboard/Panels";
import { WidgetSettings } from "../src/components/dashboard/WidgetSettings";
import ReportView from "../src/components/dashboard/ReportView";
import { DashboardGallery } from "../src/pages/DashboardApp";
import { DashboardView } from "../src/pages/DashboardPage";
import { ConfirmProvider, ToastProvider } from "../src/components/ui";
import { buildReport } from "../src/lib/dashboardReport";
import { dashboardFields, newWidget } from "../src/lib/dashboard";
import { ELEMENT_TYPES } from "../src/components/dashboard/Elements";
import type { Dashboard, DashboardConfig, Feature, Form, Widget } from "../src/lib/types";

const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const clean = (h: string) => h.replace(/<!-- -->/g, "");
const form = { id: "f", project_id: "p", name: "Water point", geometry_type: "Point", version: 1, status: "published", fields: [
  { id: "type", label: "Type", type: "choice", choices: ["Well", "Tap"] }, { id: "village", label: "Village", type: "text" }, { id: "depth", label: "Depth", type: "number", unit: "m" },
] } as unknown as Form;
const feats: Feature[] = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, project_id: "p", form_id: "f", form_version: 1, geometry: { type: "Point", coordinates: [4, 7] },
  properties: { type: i % 2 ? "Well" : "Tap", village: `V${i}`, depth: 10 + i }, status: "approved" as const, version: 1, updated_at: `2026-03-${10 + i}T10:00:00Z` }));
const defs = dashboardFields(form);
const mk = (type: Widget["type"], patch: Partial<Widget> = {}): Widget => ({ ...newWidget(type, defs, () => type), ...patch });
const all: Widget[] = [
  mk("kpi"), mk("gauge", { metric: "sum", metric_field: "depth", target: 500 }), mk("list", { title_field: "village", subtitle_fields: ["type"] }), mk("details"),
  mk("rich_text", { content: "Hello **team** <b>x</b>" }), mk("embedded", { url: "https://example.com/page" }), mk("bar", { field: "type" }), mk("table"),
  mk("pie", { field: "type", region: "sidebar" }),
];
const dash: Dashboard = { id: "d", project_id: "p", name: "Water", updated_at: "2026-03-01T00:00:00Z", config: { description: "All wells", pages: [{ id: "main", title: "Overview", form_id: "f", widgets: all }] } };
const view = (config: DashboardConfig = dash.config, canEdit = true) => clean(renderToString(
  <MemoryRouter><ToastProvider><ConfirmProvider><DashboardView projectId="p" dashboard={{ ...dash, config }} forms={[form]} features={feats} canEdit={canEdit} onRefresh={() => {}} /></ConfirmProvider></ToastProvider></MemoryRouter>));

// ---- the builder with every element ----
let h = "";
try { h = view(); ok(true, "a dashboard with every element draws without crashing"); } catch (e) { ok(false, "every element draws: " + (e as Error).message); }
ok(h.includes("gauge-fill") && h.includes("of 500") && h.includes("item-list") && h.includes("details-list") && h.includes("rich-text") && h.includes("<iframe"), "gauge, list, details, note and embedded page all draw");
ok(h.includes("<strong>team</strong>") && !h.includes("<b>x</b>") && h.includes("&lt;b&gt;x&lt;/b&gt;"), "a note's markup is shown as text, never run");
ok(h.includes('sandbox="') && h.includes('referrerPolicy="no-referrer"') || h.includes('referrerpolicy="no-referrer"'), "the embedded page is sandboxed, with no referrer");
ok(h.includes("dash-side-col") && h.includes("is-side"), "an element in the side column is drawn beside the grid");
ok(h.includes("dashboard-builder") && h.includes("Add element") && h.includes("Data sources") && h.includes("Time and region") && h.includes("Theme"), "the sidebar has every tool");
const vh = view(dash.config, false);
ok(!vh.includes("+ Add page") && !vh.includes("rh-se") && !vh.includes("Save") && vh.includes("Data sources"), "a viewer sees the data but no editing handles or Save");
ok(vh.includes("Print / PDF") && vh.includes("Refresh data") && vh.includes("Back to dashboards"), "everyone can refresh, print and go back");
const themed = view({ ...dash.config, theme: { preset: "dark" }, time_filter: { preset: "last_7_days" } }, false);
ok(themed.includes("--dash-bg:#12161c") && themed.includes("Last 7 days"), "a saved theme and date range are applied and shown");
ok(view({ pages: [{ id: "m", title: "Overview", widgets: [mk("rich_text", { content: "Only a note" })] }] }).includes("Only a note"), "a page with no form can still hold a note");

// ---- element settings for all eleven types ----
for (const { type } of ELEMENT_TYPES) {
  try {
    const out = renderToString(<WidgetSettings w={mk(type)} defs={defs} index={0} count={1} onChange={() => {}} onMove={() => {}} onRemove={() => {}} onClose={() => {}} onRegion={() => {}} />);
    ok(out.includes("Title") && out.includes("Remove") && out.includes("Show in the side column"), `settings draw for ${type}`);
  } catch (e) { ok(false, `settings draw for ${type}: ` + (e as Error).message); }
}
const gs = renderToString(<WidgetSettings w={mk("gauge")} defs={defs} index={0} count={1} onChange={() => {}} onMove={() => {}} onRemove={() => {}} onClose={() => {}} />);
ok(gs.includes("Target (full dial)") && gs.includes("total of a number field"), "a gauge asks for its target");
ok(renderToString(<WidgetSettings w={mk("pie", { region: "sidebar" })} defs={defs} index={0} count={1} onChange={() => {}} onMove={() => {}} onRemove={() => {}} onClose={() => {}} onRegion={() => {}} />).includes("side column stacks"), "a side element has no grid position box");

// ---- panels ----
const noop = () => {};
const pr = (el: JSX.Element) => clean(renderToString(<MemoryRouter>{el}</MemoryRouter>));
const add = pr(<AddElementPanel onPick={noop} onClose={noop} full={false} hasSource />);
ok(ELEMENT_TYPES.length === 11 && ["Map", "Bar chart", "Line chart", "Pie chart", "Indicator", "Gauge", "List", "Table", "Details", "Rich text", "Embedded content"].every((l) => add.includes(l)), "Add element offers all eleven elements");
ok(pr(<AddElementPanel onPick={noop} onClose={noop} full hasSource />).includes("most elements it can hold"), "a full page says so");
const vp = (tab: "body" | "header" | "sidebar" | "pages", canEdit = true) => pr(<ViewPanel initialTab={tab} canEdit={canEdit} onClose={noop} name="Water" description="d" onName={noop} onDescription={noop}
  pages={dash.config.pages} page={dash.config.pages[0]} forms={[form]} selectedId={null} onSelect={noop} onRemove={noop} onRegion={noop} onPageTitle={noop} onPageForm={noop} onApplyTemplate={noop} onMovePage={noop} onRemovePage={noop} onAddPage={noop} />);
ok(["Number", "Gauge", "List", "Details", "Rich text", "Embedded content", "Bar chart", "Table", "Pie chart"].every((l) => vp("body").includes(l)) && vp("body").includes("side column"), "View > Body lists every element on the page, and marks the one in the side column");
ok(vp("header").includes("Dashboard title") && !vp("header", false).includes("Dashboard title"), "View > Header edits the title for editors only");
ok(vp("sidebar").includes("Move to grid") && vp("sidebar").includes("Move to side"), "View > Sidebar moves elements between grid and side column");
const pages = vp("pages");
ok(pages.includes("Page name") && pages.includes("Records from") && pages.includes("Apply to this page") && (pages.match(/type="radio"/g) ?? []).length === 6, "View > Pages has page settings and the template gallery");
ok(pr(<DataSourcesPanel forms={[form]} features={feats} pages={dash.config.pages} pageFormId="f" canEdit onUse={noop} onClose={noop} />).includes("12 records · used on 1 page"), "Data sources shows counts and where each form is used");
ok(pr(<DataSourcesPanel forms={[]} features={[]} pages={[]} canEdit onUse={noop} onClose={noop} />).includes("No forms yet"), "Data sources with no forms says so");
const th = pr(<ThemePanel canEdit onChange={noop} onClose={noop} />);
ok(["Light", "Dark", "Ocean", "Earth", "Violet"].every((l) => th.includes(l)) && th.includes("Customize colours"), "Theme offers the presets and customizing");
ok(pr(<TimePanel canEdit onChange={noop} onClose={noop} />).includes("Last 30 days") && pr(<TimePanel canEdit={false} value={{ preset: "last_7_days" }} onChange={noop} onClose={noop} />).includes("Last 7 days"), "Time and region offers ranges; viewers just see the current one");
const sb = pr(<BuilderSidebar active="data" onToggle={noop} canEdit dirty saving={false} saved={false} onSave={noop} onDiscard={noop} collapsed={false} onCollapse={noop} />);
ok(sb.includes("Save*") && sb.includes("Discard"), "unsaved changes show Save* and Discard");
ok(!pr(<BuilderSidebar active={null} onToggle={noop} canEdit={false} dirty={false} saving={false} saved={false} onSave={noop} onDiscard={noop} collapsed={false} onCollapse={noop} />).includes("Save"), "a viewer has no Save");
const em = pr(<EmptyCanvas canEdit onPick={noop} onPanel={noop} />);
ok(em.includes("Visualize, monitor, and share information") && em.includes("Browse data sources") && em.includes("Choose a theme"), "the empty canvas matches your design");
ok(!pr(<EmptyCanvas canEdit={false} onPick={noop} onPanel={noop} />).includes("dashboard-add-fab"), "a viewer gets no add button on an empty page");

// ---- gallery and report ----
const gal = pr(<DashboardGallery dashboards={[dash, { ...dash, id: "e", name: "Empty", config: { pages: [{ id: "x", title: "A", widgets: [] }] } }]} canEdit onDelete={noop} />);
ok(gal.includes('href="/dashboards/d"') && gal.includes("9 elements") && gal.includes("0 elements") && gal.includes("All wells") && gal.includes("Delete Water"), "gallery cards link to the workspace and show element counts");
ok(!pr(<DashboardGallery dashboards={[dash]} canEdit={false} onDelete={noop} />).includes("Delete Water"), "viewers cannot delete");
const rep = clean(renderToString(<ReportView report={buildReport({ projectName: "Proj", dashboards: [dash], forms: [form], features: feats, now: new Date("2026-03-30T00:00:00Z") })} />));
ok(rep.includes("Proj: dashboard report") && rep.includes("Overview") && rep.includes("500") && rep.includes("Hello") && rep.includes("data-table"), "the report prints every kind of element");
ok(!rep.includes("<b>x</b>") && !rep.includes("<iframe"), "a report never runs markup or frames");
