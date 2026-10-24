import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { BarList, Donut, LineChart } from "../components/charts";
import MapView, { type MapFeature } from "../components/MapView";
import { Button, EmptyState, ErrorState, Loading, useConfirm, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { download } from "../lib/csv";
import {
  STATUS_LABEL, METRIC_LABEL, WIDGET_LABEL, dashboardFields, dateFields, defaultTitle, filterFeatures, findField, fmt, groupBy,
  groupFields, isFiltered, kpi, newWidget, noFilters, numberFields, slicesCsv, starterWidgets, tableRows, timeSeries, widgetProblem,
  type FieldDef, type Filters, type Slice,
} from "../lib/dashboard";
import { useAsync } from "../lib/hooks";
import type { Dashboard, DashboardConfig, Feature, FeatureStatus, Form, Metric, Widget, WidgetType } from "../lib/types";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "chart";

/** A saved dashboard: charts over one form's records. Anyone who may see the data views it; admins also edit it. */
export default function DashboardPage() {
  const { projectId = "", dashboardId = "" } = useParams();
  const project = useAsync((api) => api.getProject(projectId), [projectId]);
  const dash = useAsync((api) => api.getDashboard(dashboardId), [dashboardId]);
  const forms = useAsync((api) => api.listForms(projectId), [projectId]);
  const feats = useAsync((api) => api.listFeatures(projectId), [projectId]);

  if (project.loading || dash.loading || forms.loading || feats.loading) return <div className="container"><Loading label="Loading dashboard…" /></div>;
  const err = project.error ?? dash.error ?? forms.error ?? feats.error;
  if (err != null || !dash.data || !project.data) {
    return <div className="container"><ErrorState error={err ?? new Error("Dashboard not found.")} onRetry={() => { void project.reload(); void dash.reload(); void forms.reload(); void feats.reload(); }} /></div>;
  }
  const canEdit = project.data.role === "owner" || project.data.role === "admin";
  return <DashboardView key={dash.data.id} projectId={projectId} dashboard={dash.data} forms={forms.data ?? []} features={feats.data ?? []} canEdit={canEdit} onRefresh={() => void feats.reload()} />;
}

export function DashboardView({ projectId, dashboard, forms, features, canEdit, onRefresh }:
  { projectId: string; dashboard: Dashboard; forms: Form[]; features: Feature[]; canEdit: boolean; onRefresh: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const location = useLocation();
  const [editing, setEditing] = useState(canEdit && (location.state as { edit?: boolean } | null)?.edit === true);
  const [name, setName] = useState(dashboard.name);
  const [cfg, setCfg] = useState<DashboardConfig>(dashboard.config);
  const [snapshot, setSnapshot] = useState(JSON.stringify({ name: dashboard.name, cfg: dashboard.config }));
  const [selected, setSelected] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(noFilters());
  const [saving, setSaving] = useState(false);

  const dirty = JSON.stringify({ name, cfg }) !== snapshot;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const form = forms.find((f) => f.id === cfg.form_id);
  const defs = useMemo(() => dashboardFields(form), [form]);
  const base = useMemo(() => (form ? features.filter((f) => f.form_id === form.id && !f.deleted) : []), [features, form]);
  const rows = useMemo(() => filterFeatures(base, filters, defs), [base, filters, defs]);
  const statusCounts = useMemo(() => { const c: Partial<Record<FeatureStatus, number>> = {}; for (const f of base) c[f.status] = (c[f.status] ?? 0) + 1; return c; }, [base]);
  const sel = cfg.widgets.find((w) => w.id === selected) ?? null;

  const patch = (id: string, p: Partial<Widget>) => setCfg((c) => ({ ...c, widgets: c.widgets.map((w) => (w.id === id ? { ...w, ...p } : w)) }));
  function add(type: WidgetType) { const w = newWidget(type, defs); setCfg((c) => ({ ...c, widgets: [...c.widgets, w] })); setSelected(w.id); }
  function move(id: string, by: -1 | 1) {
    setCfg((c) => { const i = c.widgets.findIndex((w) => w.id === id), j = i + by; if (i < 0 || j < 0 || j >= c.widgets.length) return c; const a = [...c.widgets]; [a[i], a[j]] = [a[j], a[i]]; return { ...c, widgets: a }; });
  }
  function remove(id: string) { setCfg((c) => ({ ...c, widgets: c.widgets.filter((w) => w.id !== id) })); setSelected(null); }

  async function chooseForm(id: string) {
    const next = forms.find((f) => f.id === id);
    if (!next || next.id === cfg.form_id) return;
    if (cfg.widgets.length && !(await confirm({ title: "Switch form?", message: "The charts use fields from the current form. They are replaced with a starter set for the new one.", confirmLabel: "Switch form" }))) return;
    setCfg({ form_id: next.id, widgets: starterWidgets(next) });
    setFilters(noFilters()); setSelected(null);
  }
  function pick(field: string | undefined, s: Slice) {
    if (!field) return;
    setFilters((f) => {
      const has = f.equals.some((e) => e.field === field && e.value === s.key);
      const rest = f.equals.filter((e) => e.field !== field);
      return { ...f, equals: has ? rest : [...rest, { field, value: s.key, label: `${findField(defs, field)?.label ?? field}: ${s.label}` }] };
    });
  }
  async function save() {
    setSaving(true);
    try {
      const d = await (await loadApi()).saveDashboard({ id: dashboard.id, name: name.trim() || dashboard.name, config: cfg });
      setName(d.name); setCfg(d.config); setSnapshot(JSON.stringify({ name: d.name, cfg: d.config }));
      setEditing(false); setSelected(null); toast("Dashboard saved.", "success");
    } catch (e) { toast(e instanceof Error ? e.message : "Could not save.", "error"); }
    finally { setSaving(false); }
  }
  async function cancel() {
    if (dirty && !(await confirm({ title: "Discard your changes?", message: "The dashboard goes back to how it was last saved.", confirmLabel: "Discard", danger: true }))) return;
    const s = JSON.parse(snapshot) as { name: string; cfg: DashboardConfig };
    setName(s.name); setCfg(s.cfg); setEditing(false); setSelected(null);
  }

  return (
    <div className="container" style={{ width: "100%" }}>
      <div className="page-head">
        {editing
          ? <input type="text" aria-label="Dashboard name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} style={{ fontSize: "var(--fs-2xl)", fontWeight: 600 }} />
          : <h1>{name}</h1>}
        <span className="grow" />
        <Link className="btn" to={`/collect/${projectId}/dashboards`}>All dashboards</Link>
      </div>

      <div className="dash-toolbar">
        {form && !editing && <span className="meta">Showing records from <strong>{form.name}</strong></span>}
        <span className="grow" />
        {!editing && <Button onClick={onRefresh}>Refresh data</Button>}
        {!editing && <Button onClick={() => window.print()}>Print / PDF</Button>}
        {canEdit && !editing && <Button variant="primary" onClick={() => setEditing(true)}>Edit dashboard</Button>}
        {editing && <>
          <label className="meta" htmlFor="dform">Form</label>
          <select id="dform" value={cfg.form_id ?? ""} onChange={(e) => void chooseForm(e.target.value)}>
            <option value="" disabled>Choose a form…</option>
            {forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          {form && (["kpi", "bar", "pie", "line", "table", "map"] as WidgetType[]).map((t) => <Button key={t} small onClick={() => add(t)}>+ {WIDGET_LABEL[t]}</Button>)}
          <span className="grow" />
          <Button onClick={() => void cancel()}>Cancel</Button>
          <Button variant="primary" busy={saving} disabled={!dirty} onClick={() => void save()}>Save dashboard</Button>
        </>}
      </div>

      {!form
        ? <EmptyState title={editing ? "Choose a form to start" : "No form chosen yet"}>{editing ? "Pick which form's records this dashboard shows, then add charts." : canEdit ? "Click Edit dashboard and pick a form." : "An administrator has not finished setting this dashboard up."}</EmptyState>
        : <>
          <div className="dash-filters" aria-label="Filters">
            <div><label htmlFor="fstatus">Review status</label>
              <select id="fstatus" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as Filters["status"] })}>
                <option value="all">All ({base.length})</option>
                {(Object.keys(STATUS_LABEL) as FeatureStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]} ({statusCounts[s] ?? 0})</option>)}
              </select></div>
            <div><label htmlFor="ffrom">Changed from</label><input id="ffrom" type="date" value={filters.from ?? ""} onChange={(e) => setFilters({ ...filters, from: e.target.value || undefined })} /></div>
            <div><label htmlFor="fto">to</label><input id="fto" type="date" value={filters.to ?? ""} onChange={(e) => setFilters({ ...filters, to: e.target.value || undefined })} /></div>
            {filters.equals.length > 0 && <div className="chips">{filters.equals.map((e) => (
              <span key={e.field + e.value} className="chip-x">{e.label}<button type="button" aria-label={`Remove filter ${e.label}`} onClick={() => setFilters({ ...filters, equals: filters.equals.filter((x) => x !== e) })}>×</button></span>
            ))}</div>}
            {isFiltered(filters) && <Button small variant="ghost" onClick={() => setFilters(noFilters())}>Clear filters</Button>}
            <span className="count">{rows.length === base.length ? `${base.length} records` : `${rows.length} of ${base.length} records`}</span>
          </div>

          {cfg.widgets.length === 0
            ? <EmptyState title="No charts yet">{editing ? "Use the + buttons above to add a number, chart, table or map." : "Nothing has been added to this dashboard."}</EmptyState>
            : <div className={`dash-layout${editing && sel ? " has-aside" : ""}`}>
              <div className="dash-grid">
                {cfg.widgets.map((w) => (
                  <WidgetCard key={w.id} w={w} defs={defs} rows={rows} filters={filters} editing={editing} selected={selected === w.id}
                    onSelect={() => editing && setSelected(w.id)} onPick={(s) => pick(w.field, s)} />
                ))}
              </div>
              {editing && sel && (
                <WidgetSettings w={sel} defs={defs} index={cfg.widgets.findIndex((w) => w.id === sel.id)} count={cfg.widgets.length}
                  onChange={(p) => patch(sel.id, p)} onMove={(by) => move(sel.id, by)} onRemove={() => remove(sel.id)} onClose={() => setSelected(null)} />
              )}
            </div>}
        </>}
    </div>
  );
}

// ---------- one widget ----------
function WidgetCard({ w, defs, rows, filters, editing, selected, onSelect, onPick }:
  { w: Widget; defs: FieldDef[]; rows: Feature[]; filters: Filters; editing: boolean; selected: boolean; onSelect: () => void; onPick: (s: Slice) => void }) {
  const problem = widgetProblem(w, defs);
  const title = defaultTitle(w, defs);
  const mf = findField(defs, w.metric_field);
  const f = findField(defs, w.field);
  const active = filters.equals.find((e) => e.field === w.field)?.value;

  const data = useMemo<Slice[] | null>(() => {
    if (problem || !f) return null;
    if (w.type === "bar" || w.type === "pie") return groupBy(rows, f, w.metric, mf, w.limit);
    if (w.type === "line") return timeSeries(rows, f, w.bucket, w.metric, mf);
    return null;
  }, [w, rows, defs]); // eslint-disable-line react-hooks/exhaustive-deps

  const mapFeatures = useMemo<MapFeature[]>(() => (w.type === "map" ? rows.slice(0, 5000).map((r) => ({ id: r.id, geometry: r.geometry, state: r.status === "rejected" ? "rejected" as const : r.status === "submitted" ? "review" as const : "clean" as const })) : []), [w.type, rows]);
  const tableCols = useMemo(() => w.columns.map((c) => findField(defs, c)).filter((c): c is FieldDef => !!c), [w.columns, defs]);

  function csv() {
    if (!data) return;
    download(`${slug(title)}.csv`, slicesCsv(data, f?.label ?? "Group", w.metric === "count" ? "Records" : `${METRIC_LABEL[w.metric]} of ${mf?.label ?? ""}`), "text/csv");
  }

  let body;
  if (problem) body = <div className="widget-note is-problem">{problem}</div>;
  else if (w.type === "kpi") {
    const v = kpi(rows, w.metric, mf);
    body = <div className="kpi-value">{v == null ? "–" : fmt(v)}{mf?.unit && v != null && w.metric !== "count" && <span className="kpi-unit">{mf.unit}</span>}</div>;
  } else if (w.type === "table") {
    const t = tableRows(rows, tableCols, w.limit);
    body = !t.length ? <div className="widget-note">No records match the filters.</div> : (
      <div className="dash-table"><table className="data-table"><thead><tr>{tableCols.map((c) => <th key={c.id} scope="col">{c.label}</th>)}</tr></thead>
        <tbody>{t.map((r) => <tr key={r.id}>{r.cells.map((c, i) => <td key={i}>{c}</td>)}</tr>)}</tbody></table></div>
    );
  } else if (w.type === "map") {
    body = !mapFeatures.length ? <div className="widget-note">No records match the filters.</div> : <div className="dash-map"><MapView features={mapFeatures} fitKey={`dash:${w.id}:${mapFeatures.length}`} label={title} /></div>;
  } else if (!data || !data.length) body = <div className="widget-note">No records match the filters.</div>;
  else if (w.type === "bar") body = <BarList data={data} active={active} onPick={onPick} unit={mf && w.metric !== "count" ? mf.unit ?? "" : ""} />;
  else if (w.type === "pie") body = <Donut data={data} active={active} onPick={onPick} />;
  else body = <LineChart data={data} />;

  return (
    <section className={`widget w${w.width}${editing ? " is-editable" : ""}${selected ? " is-selected" : ""}`} aria-label={title}
      onClick={editing ? onSelect : undefined}>
      <div className="widget-head">
        <h3>{title}</h3>
        {!editing && data && data.length > 0 && <Button small variant="ghost" onClick={csv} aria-label={`Download ${title} as CSV`}>CSV</Button>}
      </div>
      {body}
    </section>
  );
}

// ---------- the settings panel ----------
export function WidgetSettings({ w, defs, index, count, onChange, onMove, onRemove, onClose }:
  { w: Widget; defs: FieldDef[]; index: number; count: number; onChange: (p: Partial<Widget>) => void; onMove: (by: -1 | 1) => void; onRemove: () => void; onClose: () => void }) {
  const nums = numberFields(defs);
  const usesMetric = w.type === "kpi" || w.type === "bar" || w.type === "pie" || w.type === "line";
  const setMetric = (metric: Metric) => onChange({ metric, metric_field: metric === "count" ? undefined : w.metric_field ?? nums[0]?.id });
  return (
    <aside className="dash-aside" aria-label="Chart settings">
      <div className="row" style={{ alignItems: "center" }}><h2 style={{ flex: 1 }}>{WIDGET_LABEL[w.type]}</h2><Button small variant="ghost" onClick={onClose} aria-label="Close settings">Close</Button></div>
      <div className="field"><label htmlFor="wt">Title</label><input id="wt" value={w.title} placeholder={defaultTitle({ ...w, title: "" }, defs)} onChange={(e) => onChange({ title: e.target.value })} maxLength={120} /></div>
      <div className="field"><label htmlFor="ww">Width</label>
        <select id="ww" value={w.width} onChange={(e) => onChange({ width: Number(e.target.value) as Widget["width"] })}>
          <option value={1}>One third</option><option value={2}>Two thirds</option><option value={3}>Full width</option>
        </select></div>

      {(w.type === "bar" || w.type === "pie") && (
        <div className="field"><label htmlFor="wf">Group by</label>
          <select id="wf" value={w.field ?? ""} onChange={(e) => onChange({ field: e.target.value })}>
            {groupFields(defs).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select></div>
      )}
      {w.type === "line" && (<>
        <div className="field"><label htmlFor="wf">Date to plot</label>
          <select id="wf" value={w.field ?? ""} onChange={(e) => onChange({ field: e.target.value })}>
            {dateFields(defs).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select></div>
        <div className="field"><label htmlFor="wb">Group by</label>
          <select id="wb" value={w.bucket} onChange={(e) => onChange({ bucket: e.target.value as Widget["bucket"] })}>
            <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
          </select></div>
      </>)}
      {usesMetric && (<>
        <div className="field"><label htmlFor="wm">Show</label>
          <select id="wm" value={w.metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            {(Object.keys(METRIC_LABEL) as Metric[]).map((m) => <option key={m} value={m} disabled={m !== "count" && !nums.length}>{METRIC_LABEL[m]}</option>)}
          </select>
          {!nums.length && <small className="meta">Add a number field to the form to total or average it.</small>}</div>
        {w.metric !== "count" && (
          <div className="field"><label htmlFor="wmf">of the field</label>
            <select id="wmf" value={w.metric_field ?? ""} onChange={(e) => onChange({ metric_field: e.target.value })}>
              {nums.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select></div>
        )}
      </>)}
      {(w.type === "bar" || w.type === "pie") && (
        <div className="field"><label htmlFor="wl">Groups shown</label><input id="wl" type="number" min={2} max={50} value={w.limit} onChange={(e) => onChange({ limit: Math.min(50, Math.max(2, Number(e.target.value) || 8)) })} /></div>
      )}
      {w.type === "table" && (<>
        <div className="field"><span id="wcl" className="label">Columns (up to 12)</span>
          <div className="cols" role="group" aria-labelledby="wcl">
            {defs.map((d) => {
              const on = w.columns.includes(d.id);
              return <label key={d.id}><input type="checkbox" checked={on} disabled={!on && w.columns.length >= 12}
                onChange={() => onChange({ columns: on ? w.columns.filter((c) => c !== d.id) : [...w.columns, d.id] })} />{d.label}</label>;
            })}
            {[["__status", "Review status"], ["__updated", "Date record changed"]].map(([id, label]) => (
              <label key={id}><input type="checkbox" checked={w.columns.includes(id)} onChange={() => onChange({ columns: w.columns.includes(id) ? w.columns.filter((c) => c !== id) : [...w.columns, id] })} />{label}</label>
            ))}
          </div></div>
        <div className="field"><label htmlFor="wl">Rows shown</label><input id="wl" type="number" min={1} max={50} value={w.limit} onChange={(e) => onChange({ limit: Math.min(50, Math.max(1, Number(e.target.value) || 10)) })} /></div>
      </>)}
      {w.type === "map" && <p className="meta">Shows where the records are. Records waiting for review are amber, rejected ones red.</p>}

      <div className="row">
        <Button small onClick={() => onMove(-1)} disabled={index <= 0}>Move earlier</Button>
        <Button small onClick={() => onMove(1)} disabled={index >= count - 1}>Move later</Button>
        <Button small variant="danger" onClick={onRemove}>Remove</Button>
      </div>
    </aside>
  );
}
