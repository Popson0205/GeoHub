// Draws the dashboard on the server with sample data to catch crashes the type checker can't see.
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { DashboardView } from "../src/pages/DashboardPage";
import { ConfirmProvider, ToastProvider } from "../src/components/ui";
import { starterWidgets } from "../src/lib/dashboard";
import type { Dashboard, DashboardConfig, Feature, Form } from "../src/lib/types";

const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const form = { id: "f", project_id: "p", name: "Water point", geometry_type: "Point", version: 1, status: "published", fields: [
  { id: "type", label: "Type", type: "choice", choices: ["Well", "Tap"] }, { id: "working", label: "Working?", type: "boolean" },
  { id: "depth", label: "Depth", type: "number", unit: "m" },
] } as unknown as Form;
const feats: Feature[] = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, project_id: "p", form_id: "f", form_version: 1, geometry: { type: "Point", coordinates: [4 + i / 100, 7] },
  properties: { type: i % 3 ? "Well" : "Tap", working: i % 4 !== 0, depth: 10 + i }, status: (["approved", "submitted", "rejected"] as const)[i % 3], version: 1, updated_at: `2026-0${1 + (i % 6)}-1${i % 9}T10:00:00Z` }));
const dash: Dashboard = { id: "d", project_id: "p", name: "Overview", updated_at: "", config: { pages: [{ id: "main", title: "Overview", form_id: "f", widgets: starterWidgets(form) }] } };

const view = (config: DashboardConfig = dash.config, canEdit = true, url = "/") => renderToString(
  <MemoryRouter initialEntries={[url]}><ToastProvider><ConfirmProvider>
    <DashboardView projectId="p" dashboard={{ ...dash, config }} forms={[form]} features={feats} canEdit={canEdit} onRefresh={() => {}} />
  </ConfirmProvider></ToastProvider></MemoryRouter>);
const page0 = dash.config.pages[0];

let html = "";
try { html = view(); ok(true, "the starter dashboard draws without crashing"); } catch (e) { ok(false, "the starter dashboard draws without crashing: " + (e as Error).message); }
ok(html.includes("Total records") && html.includes("Review status"), "titles are shown");
ok(html.includes("30</div>") || html.includes(">30<"), "the total number card counts every record");
ok(html.includes("bar-row") && html.includes("legend") && html.includes("line-chart") && html.includes("data-table"), "bar, pie, line and table all draw");
ok(html.includes("Add element") && html.includes("Theme") && html.includes("Time and region") && !html.includes("Edit dashboard"), "an admin gets the builder toolbar straight away, with no separate Edit step");
ok(!view(dash.config, false).includes("Edit dashboard"), "a read-only viewer gets no Edit button");
const missing = view({ pages: [{ ...page0, widgets: [{ ...page0.widgets[0], type: "bar", field: "removed_field" }] }] });
ok(missing.includes("no longer in the form"), "a chart on a removed field explains itself");
const none = view({ pages: [{ id: "main", title: "Overview", widgets: [] }] });
ok(none.includes("Visualize, monitor, and share information") && none.includes("Start from a template"), "an empty page invites the first element");

// ---- edit mode and the settings panel ----
import { WidgetSettings } from "../src/pages/DashboardPage";
import TemplatePicker from "../src/components/TemplatePicker";
import { dashboardFields, newWidget } from "../src/lib/dashboard";
const editHtml = (h => h.replace(/<!-- -->/g, ""))(renderToString(
  <MemoryRouter initialEntries={[{ pathname: "/", state: { edit: true } }]}><ToastProvider><ConfirmProvider>
    <DashboardView projectId="p" dashboard={dash} forms={[form]} features={feats} canEdit onRefresh={() => {}} />
  </ConfirmProvider></ToastProvider></MemoryRouter>));
ok(editHtml.includes("Save") && editHtml.includes("+ Add page") && editHtml.includes("Drag an element by its title bar"), "the builder shows Save, Add page and the drag hint");
ok(editHtml.includes("Reset layout") === false && editHtml.includes("Dashboard pages"), "editors always see the page tabs");
const defs = dashboardFields(form);
for (const t of ["kpi", "bar", "pie", "line", "table", "map"] as const) {
  try {
    const h = renderToString(<WidgetSettings w={newWidget(t, defs)} defs={defs} index={1} count={3} onChange={() => {}} onMove={() => {}} onRemove={() => {}} onClose={() => {}} />);
    ok(h.includes("Title") && h.includes("Full row") && !h.includes("Width") && h.includes("Remove"), `settings panel draws for a ${t}`);
  } catch (e) { ok(false, `settings panel draws for a ${t}: ${(e as Error).message}`); }
}
{
  const h = renderToString(<WidgetSettings w={newWidget("bar", defs)} rect={{ col: 4, row: 2, cols: 6, rows: 5 }} manual onRect={() => {}} defs={defs} index={1} count={3} onChange={() => {}} onMove={() => {}} onRemove={() => {}} onClose={() => {}} />);
  ok(h.includes("Position and size") && h.includes("Left (column)") && h.includes("Top (row)") && h.includes("Tall (rows)") && h.includes("Full row"), "settings offer exact position and size once layout is free");
  ok(h.includes('value="5"') && h.includes('value="3"') && h.includes('value="6"'), "the boxes show the chart's current column (1-based), row, width and height");
  ok(!h.includes("Move earlier") && !h.includes("Move later"), "the order buttons go away when charts are placed by hand");
}
{
  const h = renderToString(<TemplatePicker value="executive" onChange={() => {}} />);
  ok(["Standard overview", "Executive summary", "Map focus", "Review queue", "Trends and analysis", "Blank"].every((n) => h.includes(n)), "the template picker offers every template");
  ok((h.match(/type="radio"/g) ?? []).length === 6 && h.includes("checked") && (h.match(/<svg/g) ?? []).length === 6, "one radio and one thumbnail per template, with the chosen one marked");
  ok(true, "template gallery drawn above");
}
const tbl = renderToString(<WidgetSettings w={newWidget("table", defs)} defs={defs} index={0} count={1} onChange={() => {}} onMove={() => {}} onRemove={() => {}} onClose={() => {}} />);
ok(tbl.includes("Elevation (m)") && tbl.includes("Review status"), "table columns offer the form's fields, GPS elevation and status");


// ---- several pages: a joint dashboard ----
const navy = { ...form, id: "f2", name: "Navy" } as unknown as Form;
const navyFeats: Feature[] = Array.from({ length: 5 }, (_, i) => ({ ...feats[i], id: `n${i}`, form_id: "f2", status: "approved" as const }));
const joint: DashboardConfig = { description: "Joint reporting", pages: [
  { id: "overview", title: "Overview", widgets: [
    { ...newWidget("kpi", defs), id: "k1", title: "Army", form_id: "f" }, { ...newWidget("kpi", defs), id: "k2", title: "Navy", form_id: "f2" }] },
  { id: "army", title: "Army", form_id: "f", widgets: starterWidgets(form) },
  { id: "navy", title: "Navy", form_id: "f2", widgets: starterWidgets(navy) },
] };
const jointView = (url: string, canEdit = true) => (h => h.replace(/<!-- -->/g, ""))(renderToString(
  <MemoryRouter initialEntries={[url]}><ToastProvider><ConfirmProvider>
    <DashboardView projectId="p" dashboard={{ ...dash, name: "Ministry of Defence", config: joint }} forms={[form, navy]} features={[...feats, ...navyFeats]} canEdit={canEdit} onRefresh={() => {}} />
  </ConfirmProvider></ToastProvider></MemoryRouter>));
const first = jointView("/");
ok(["Overview", "Army", "Navy"].every((t) => first.includes(`>${t}</a>`)) && first.includes("Ministry of Defence") && first.includes("Joint reporting"), "every page has a tab; the dashboard has its name and description");
const activeTab = (h: string) => h.match(/is-active" aria-current="page" href="[^"]*">([^<]*)</)?.[1];
ok(activeTab(first) === "Overview", "the first page opens first");
ok(first.includes(">30</div>") && first.includes(">5</div>"), "the overview's number cards each count their own form");
ok(first.includes("35 records"), "the record count adds up the forms the page uses");
const navyPage = jointView("/?page=navy");
ok(activeTab(navyPage) === "Navy" && navyPage.includes("5 records") && !navyPage.includes("30 records"), "the address picks the page, and the page only counts its own form");
ok(activeTab(jointView("/?page=nope")) === "Overview", "an unknown page falls back to the first");
const filtered = jointView("/?page=army&status=approved");
ok(filtered.includes("10 of 30 records") && filtered.includes('<option value="approved" selected'), "filters in the address are applied and shown");
ok(jointView("/?page=navy&status=approved").includes("5 records"), "the same filter carries to another page");
ok(/class="widget t-kpi s6[^"]*" style="grid-row:span 2"/.test(first), "two number cards share a line, two rows tall");
const army = jointView("/?page=army");
ok(/widget t-\w+ s4/.test(army) && /widget t-\w+ s6/.test(army) && army.includes("grid-row:span 5"), "a page of mixed charts is packed into rows");
ok(!jointView("/", false).includes("Edit dashboard") && !jointView("/", false).includes("Add page"), "viewers see the pages but cannot edit");
ok(!view(dash.config, false).includes("Dashboard pages"), "a one-page dashboard shows no tabs to a viewer");
