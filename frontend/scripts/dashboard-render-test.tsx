// Draws the dashboard on the server with sample data to catch crashes the type checker can't see.
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { DashboardView } from "../src/pages/DashboardPage";
import { ConfirmProvider, ToastProvider } from "../src/components/ui";
import { starterWidgets } from "../src/lib/dashboard";
import type { Dashboard, Feature, Form } from "../src/lib/types";

const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const form = { id: "f", project_id: "p", name: "Water point", geometry_type: "Point", version: 1, status: "published", fields: [
  { id: "type", label: "Type", type: "choice", choices: ["Well", "Tap"] }, { id: "working", label: "Working?", type: "boolean" },
  { id: "depth", label: "Depth", type: "number", unit: "m" },
] } as unknown as Form;
const feats: Feature[] = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, project_id: "p", form_id: "f", form_version: 1, geometry: { type: "Point", coordinates: [4 + i / 100, 7] },
  properties: { type: i % 3 ? "Well" : "Tap", working: i % 4 !== 0, depth: 10 + i }, status: (["approved", "submitted", "rejected"] as const)[i % 3], version: 1, updated_at: `2026-0${1 + (i % 6)}-1${i % 9}T10:00:00Z` }));
const dash: Dashboard = { id: "d", project_id: "p", name: "Overview", updated_at: "", config: { form_id: "f", widgets: starterWidgets(form) } };

const view = (extra: Partial<Dashboard["config"]> = {}, canEdit = true) => renderToString(
  <MemoryRouter><ToastProvider><ConfirmProvider>
    <DashboardView projectId="p" dashboard={{ ...dash, config: { ...dash.config, ...extra } }} forms={[form]} features={feats} canEdit={canEdit} onRefresh={() => {}} />
  </ConfirmProvider></ToastProvider></MemoryRouter>);

let html = "";
try { html = view(); ok(true, "the starter dashboard draws without crashing"); } catch (e) { ok(false, "the starter dashboard draws without crashing: " + (e as Error).message); }
ok(html.includes("Total records") && html.includes("Review status"), "titles are shown");
ok(html.includes("30</div>") || html.includes(">30<"), "the total number card counts every record");
ok(html.includes("bar-row") && html.includes("legend") && html.includes("line-chart") && html.includes("data-table"), "bar, pie, line and table all draw");
ok(html.includes("Edit dashboard") && !html.includes("Save dashboard"), "viewers of an admin see Edit, not Save");
ok(!view({}, false).includes("Edit dashboard"), "a read-only viewer gets no Edit button");
const missing = view({ widgets: [{ ...dash.config.widgets[0], type: "bar", field: "removed_field" }] });
ok(missing.includes("no longer in the form"), "a chart on a removed field explains itself");
const none = view({ form_id: undefined, widgets: [] });
ok(none.includes("No form chosen") || none.includes("Choose a form"), "a dashboard with no form asks for one");

// ---- edit mode and the settings panel ----
import { WidgetSettings } from "../src/pages/DashboardPage";
import { dashboardFields, newWidget } from "../src/lib/dashboard";
const editHtml = (h => h.replace(/<!-- -->/g, ""))(renderToString(
  <MemoryRouter initialEntries={[{ pathname: "/", state: { edit: true } }]}><ToastProvider><ConfirmProvider>
    <DashboardView projectId="p" dashboard={dash} forms={[form]} features={feats} canEdit onRefresh={() => {}} />
  </ConfirmProvider></ToastProvider></MemoryRouter>));
ok(editHtml.includes("Save dashboard") && editHtml.includes("+ Bar chart") && editHtml.includes("+ Map") && editHtml.includes("Cancel"), "edit mode shows the form picker, add buttons and Save");
const defs = dashboardFields(form);
for (const t of ["kpi", "bar", "pie", "line", "table", "map"] as const) {
  try {
    const h = renderToString(<WidgetSettings w={newWidget(t, defs)} defs={defs} index={1} count={3} onChange={() => {}} onMove={() => {}} onRemove={() => {}} onClose={() => {}} />);
    ok(h.includes("Title") && h.includes("Width") && h.includes("Remove"), `settings panel draws for a ${t}`);
  } catch (e) { ok(false, `settings panel draws for a ${t}: ${(e as Error).message}`); }
}
const tbl = renderToString(<WidgetSettings w={newWidget("table", defs)} defs={defs} index={0} count={1} onChange={() => {}} onMove={() => {}} onRemove={() => {}} onClose={() => {}} />);
ok(tbl.includes("Elevation (m)") && tbl.includes("Review status"), "table columns offer the form's fields, GPS elevation and status");
