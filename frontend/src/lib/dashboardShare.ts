// What a public dashboard link may show. The server (backend/app/services/dashboard_share.py) is the one that enforces this;
// this is the same rules in TypeScript so the demo/offline API behaves identically. Keep the two in step: the cases in
// scripts/dashboard-share-test.ts mirror backend/tests/test_dashboard_share_rules.py.
import type { Dashboard, DashboardConfig, Feature, Form, FormField, Geometry, PublicDashboard, Widget } from "./types";

/** Placeholder for a record whose location is not shared. Nothing draws it, because only maps read locations. */
export const NO_LOCATION: Geometry = { type: "Point", coordinates: [0, 0] } as Geometry;
const MEDIA = new Set(["photo", "audio", "video", "file", "signature"]);
const NOT_VALUES = new Set(["note", "group", "repeat"]);
const GPS_IDS = ["gps_elev_m", "gps_hacc_m"];
const STATIC = new Set(["rich_text", "embedded"]);
export const MAX_PUBLIC_RECORDS = 20000;

/** The field ids one element reads. null = every field (a details card with none chosen). */
function widgetFields(w: Widget): Set<string> | null {
  if (w.type === "details") return w.columns.length ? new Set(w.columns) : null;
  const ids: (string | undefined)[] = [];
  if (["kpi", "bar", "pie", "line", "gauge"].includes(w.type)) ids.push(w.field, w.metric_field, w.target_field);
  else if (w.type === "table") ids.push(...w.columns);
  else if (w.type === "list") ids.push(w.title_field, ...(w.subtitle_fields ?? []));
  return new Set(ids.filter((i): i is string => !!i));
}
/** Per form the dashboard draws on: the field ids it reads, or null for all of them. */
export function usedFields(config: DashboardConfig): Map<string, Set<string> | null> {
  const out = new Map<string, Set<string> | null>();
  for (const p of config.pages) {
    if (p.form_id && !out.has(p.form_id)) out.set(p.form_id, new Set());
    for (const w of p.widgets) {
      const fid = w.form_id ?? p.form_id;
      if (!fid || STATIC.has(w.type)) continue;
      const need = widgetFields(w);
      if (need === null) out.set(fid, null);
      else if (out.get(fid) !== null) out.set(fid, new Set([...(out.get(fid) ?? []), ...need]));
    }
  }
  return out;
}
export const mapForms = (config: DashboardConfig): Set<string> =>
  new Set(config.pages.flatMap((p) => p.widgets.filter((w) => w.type === "map").map((w) => w.form_id ?? p.form_id).filter((f): f is string => !!f)));

function leaves(fields: FormField[]): FormField[] {
  return fields.flatMap((f) => (f.type === "group" ? leaves(f.children ?? []) : NOT_VALUES.has(f.type) || MEDIA.has(f.type) ? [] : [f]));
}
export function publicFields(fields: FormField[], used: Set<string> | null): FormField[] {
  const l = leaves(fields);
  return (used === null ? l : l.filter((f) => used.has(f.id))).map((f) => ({
    id: f.id, label: f.label, type: f.type,
    ...(f.choices?.length ? { choices: f.choices } : {}), ...(f.unit ? { unit: f.unit } : {}),
    ...(f.true_label ? { true_label: f.true_label } : {}), ...(f.false_label ? { false_label: f.false_label } : {}),
  }) as FormField);
}

/** Only approved records, only the fields used, locations only for maps. */
export function publicDashboard(args: { token: string; dashboard: Dashboard; projectName: string; forms: Form[]; features: Feature[] }): PublicDashboard {
  const { dashboard: d } = args, used = usedFields(d.config), onMap = mapForms(d.config);
  const forms = args.forms.filter((f) => used.has(f.id) && f.version > 0).map((f) => ({ ...f, fields: publicFields(f.fields, used.get(f.id) ?? null) }));
  const allowed = new Map(forms.map((f) => [f.id, new Set(f.fields.map((x) => x.id))]));
  const pool = args.features.filter((r) => allowed.has(r.form_id) && !r.deleted && r.status === "approved")
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  const features = pool.slice(0, MAX_PUBLIC_RECORDS).map((r): Feature => {
    const u = used.get(r.form_id) ?? null, keep = new Set([...allowed.get(r.form_id)!, ...(u === null ? GPS_IDS : GPS_IDS.filter((g) => u.has(g)))]);
    return { id: r.id, project_id: "", form_id: r.form_id, form_version: 0, status: "approved", version: 0, updated_at: r.updated_at,
      geometry: onMap.has(r.form_id) ? r.geometry : NO_LOCATION, properties: Object.fromEntries(Object.entries(r.properties).filter(([k]) => keep.has(k))) };
  });
  return { token: args.token, name: d.name, project_name: args.projectName, config: d.config, updated_at: d.updated_at, truncated: pool.length > MAX_PUBLIC_RECORDS, forms, features };
}
