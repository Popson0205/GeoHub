// The same rules as backend/tests/test_dashboard_share_rules.py, in TypeScript, so the demo API can never promise more than the server allows.
import { MAX_PUBLIC_RECORDS, NO_LOCATION, mapForms, publicDashboard, publicFields, usedFields } from "../src/lib/dashboardShare";
import { normalizeConfig } from "../src/lib/dashboard";
import type { Dashboard, Feature, Form, FormField } from "../src/lib/types";

const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const F1 = "f1", F2 = "f2";
const FIELDS = [
  { id: "type", label: "Type", type: "choice", choices: ["Well", "Tap"], required: true, hint: "internal" },
  { id: "depth", label: "Depth", type: "number", unit: "m" }, { id: "village", label: "Village", type: "text" }, { id: "phone", label: "Owner phone", type: "text" },
  { id: "photo", label: "Photo", type: "photo" }, { id: "sig", label: "Signature", type: "signature" },
  { id: "sec", label: "Section", type: "group", children: [{ id: "inner", label: "Inner", type: "number" }] },
  { id: "rows", label: "Rows", type: "repeat", children: [{ id: "r1", label: "R1", type: "text" }] },
] as unknown as FormField[];
const form = (id: string, name = "Water"): Form => ({ id, project_id: "p", name, geometry_type: "Point", version: 2, status: "published", fields: FIELDS });
const ALL = { type: "Well", depth: 10, village: "Aba", phone: "0803", photo: "media-id", sig: "m2", inner: 3, rows: [{ r1: "x" }], secret_extra: 1 };
let n = 0;
const rec = (props: Record<string, unknown>, o: Partial<Feature> = {}): Feature => ({ id: `r${n++}`, project_id: "p", form_id: F1, form_version: 2, geometry: { type: "Point", coordinates: [3.4, 6.5] } as never,
  properties: props, status: "approved", version: 1, updated_at: `2026-03-01T00:00:${String(n % 60).padStart(2, "0")}Z`, ...o });
const dash = (widgets: unknown[], formId: string | null = F1): Dashboard => ({ id: "d", project_id: "p", name: "D", updated_at: "2026-03-01T00:00:00Z", config: normalizeConfig({ pages: [{ id: "p", title: "P", form_id: formId, widgets }] }) });
const share = (d: Dashboard, features: Feature[], forms = [form(F1)]) => publicDashboard({ token: "t", dashboard: d, projectName: "Proj", forms, features });

let out = share(dash([{ id: "w", type: "bar", field: "type" }, { id: "k", type: "kpi", metric: "sum", metric_field: "depth" }]), [rec(ALL)]);
ok(JSON.stringify(out.features[0].properties) === JSON.stringify({ type: "Well", depth: 10 }), "only the fields a dashboard uses are sent");
ok(!JSON.stringify(out).includes("0803") && !JSON.stringify(out).includes("phone"), "an unused field never leaves");
const f = publicFields(FIELDS, new Set(["type"]))[0] as unknown as Record<string, unknown>;
ok(Object.keys(f).sort().join() === "choices,id,label,type", "field definitions are trimmed to what a chart needs");

out = share(dash([{ id: "t", type: "table", columns: ["photo", "sig", "rows", "village"] }]), [rec(ALL)]);
ok(JSON.stringify(out.features[0].properties) === JSON.stringify({ village: "Aba" }), "media and repeat sections are never sent, even when asked for");
out = share(dash([{ id: "d", type: "details" }]), [rec(ALL)]);
const keys = Object.keys(out.features[0].properties).sort().join();
ok(keys === "depth,inner,phone,type,village", "a details card with no fields chosen sends everything except media, repeats and unknown keys");

out = share(dash([{ id: "k", type: "kpi", metric: "avg", metric_field: "gps_hacc_m" }]), [rec({ ...ALL, gps_hacc_m: 4, gps_elev_m: 90 })]);
ok(JSON.stringify(out.features[0].properties) === JSON.stringify({ gps_hacc_m: 4 }), "only the GPS values it charts");

ok(share(dash([{ id: "w", type: "bar", field: "type" }]), [rec(ALL)]).features[0].geometry === NO_LOCATION, "no map, no locations");
ok(JSON.stringify(share(dash([{ id: "m", type: "map" }]), [rec(ALL)]).features[0].geometry) === JSON.stringify({ type: "Point", coordinates: [3.4, 6.5] }), "a map gets locations");
ok([...mapForms(dash([{ id: "m", type: "map" }]).config)].join() === F1, "forms shown on a map");

out = share(dash([{ id: "w", type: "bar", field: "type" }]), [rec(ALL), rec(ALL, { form_id: F2 })], [form(F1), form(F2, "Secret survey")]);
ok(out.forms.length === 1 && out.features.length === 1 && !JSON.stringify(out).includes("Secret survey"), "only forms the dashboard uses are sent");
ok([...usedFields(dash([{ id: "k", type: "kpi", form_id: F2 }]).config).keys()].sort().join() === "f1,f2", "an element can draw on another form than its page");
ok(usedFields(dash([{ id: "n", type: "rich_text", content: "hi" }, { id: "e", type: "embedded", url: "https://example.com" }], null).config).size === 0, "notes and embedded pages pull in no data");

out = share(dash([{ id: "w", type: "bar", field: "type" }]), [rec(ALL, { status: "submitted" }), rec(ALL, { status: "draft" }), rec(ALL, { status: "rejected" }), rec(ALL, { deleted: true }), rec(ALL)]);
ok(out.features.length === 1, "only approved, undeleted records are public");
ok(out.features.every((x) => x.project_id === "" && x.status === "approved"), "records carry no project id");

const many = Array.from({ length: MAX_PUBLIC_RECORDS + 5 }, () => rec({ type: "Well" }));
out = share(dash([{ id: "w", type: "bar", field: "type" }]), many);
ok(out.features.length === MAX_PUBLIC_RECORDS && out.truncated === true, "a very large dataset is cut at the limit and says so");
ok(share(dash([{ id: "w", type: "bar", field: "type", title: "By type" }]), []).config.pages[0].widgets[0].title === "By type", "the saved layout comes through");
