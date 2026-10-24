import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { BarList, Donut, LineChart } from "../components/charts";
import MapView, { type MapFeature } from "../components/MapView";
import { Button, EmptyState, ErrorState, Loading, useConfirm, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { download } from "../lib/csv";
import {
  STATUS_LABEL, METRIC_LABEL, WIDGET_LABEL, MAX_PAGES, MAX_WIDGETS_PER_PAGE, autoLayout, dashboardFields, dateFields, defaultTitle, filterFeatures,
  filtersFromParams, filtersToParams, findField, fmt, groupBy, groupFields, isFiltered, kpi, newPage, newWidget, noFilters, numberFields,
  pageFormIds, slicesCsv, starterWidgets, tableRows, timeSeries, widgetProblem,
  type FieldDef, type Filters, type Slice,
} from "../lib/dashboard";
import { useAsync } from "../lib/hooks";
import type { Dashboard, DashboardConfig, DashPage, Feature, FeatureStatus, Form, Metric, Widget, WidgetType } from "../lib/types";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "chart";

/** A saved dashboard: pages of charts over the collected records. Anyone who may see the data views it; admins also edit it. */
export default function DashboardPage() {
  const { projectId = "", dashboardId = "" } = useParams();
  const project = useAsync((api) => api.getProject(projectId), [projectId]);
  const dash = useAsync((api) => api.getDashboard(dashboardId), [dashboardId]);
  const forms = useAsync((api) => api.listForms(projectId), [projectId]);
  const feats = useAsync((api) => api.listFeatures(projectId), [projectId]);
  const loadedAt = useMemo(() => new Date(), [feats.data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (project.loading || dash.loading || forms.loading || feats.loading) return <div className="container"><Loading label="Loading dashboard…" /></div>;
  const err = project.error ?? dash.error ?? forms.error ?? feats.error;
  if (err != null || !dash.data || !project.data) {
    return <div className="container"><ErrorState error={err ?? new Error("Dashboard not found.")} onRetry={() => { void project.reload(); void dash.reload(); void forms.reload(); void feats.reload(); }} /></div>;
  }
  const canEdit = project.data.role === "owner" || project.data.role === "admin";
  return <DashboardView key={dash.data.id} projectId={projectId} dashboard={dash.data} forms={forms.data ?? []} features={feats.data ?? []} canEdit={canEdit}
    loadedAt={loadedAt} onRefresh={() => void feats.reload()} />;
}

/** The records one chart draws: a form, its fields, and the records that pass the filters. */
interface Source { form: Form; defs: FieldDef[]; base: Feature[]; rows: Feature[] }

export function DashboardView({ projectId, dashboard, forms, features, canEdit, onRefresh, loadedAt }:
  { projectId: string; dashboard: Dashboard; forms: Form[]; features: Feature[]; canEdit: boolean; onRefresh: () => void; loadedAt?: Date }) {
  const toast = useToast();
  const confirm = useConfirm();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState(canEdit && (location.state as { edit?: boolean } | null)?.edit === true);
  const [name, setName] = useState(dashboard.name);
  const [cfg, setCfg] = useState<DashboardConfig>(dashboard.config);
  const [snapshot, setSnapshot] = useState(JSON.stringify({ name: dashboard.name, cfg: dashboard.config }));
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = JSON.stringify({ name, cfg }) !== snapshot;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // The current page and the filters both live in the address (?page=…&status=…), so a view can be sent as a link,
  // survives a refresh, and the filters stay put as you move from page to page.
  const page: DashPage = cfg.pages.find((p) => p.id === params.get("page")) ?? cfg.pages[0];
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const setFilters = (n: Filters | ((f: Filters) => Filters)) => setParams(filtersToParams(typeof n === "function" ? n(filters) : n, params), { replace: true });
  const pageSearch = (id: string) => { const q = new URLSearchParams(params); q.set("page", id); return `?${q.toString()}`; };
  const goPage = (id: string) => { const q = new URLSearchParams(params); q.set("page", id); setParams(q); };
  useEffect(() => { setSelected(null); }, [page.id]);

  const formIds = useMemo(() => pageFormIds(page), [page]);
  const sources = useMemo(() => {
    const m = new Map<string, Source>();
    for (const id of formIds) {
      const form = forms.find((f) => f.id === id);
      if (!form) continue;
      const defs = dashboardFields(form);
      const base = features.filter((f) => f.form_id === id && !f.deleted);
      m.set(id, { form, defs, base, rows: filterFeatures(base, filters, defs) });
    }
    return m;
  }, [formIds, forms, features, filters]);
  const used = [...sources.values()];
  const total = used.reduce((n, s) => n + s.base.length, 0), shown = used.reduce((n, s) => n + s.rows.length, 0);
  const statusCounts = useMemo(() => { const c: Partial<Record<FeatureStatus, number>> = {}; for (const s of sources.values()) for (const f of s.base) c[f.status] = (c[f.status] ?? 0) + 1; return c; }, [sources]);
  const placed = useMemo(() => autoLayout(page.widgets), [page.widgets]);
  const sel = page.widgets.find((w) => w.id === selected) ?? null;
  const sourceOf = (w: Widget) => sources.get(w.form_id ?? page.form_id ?? "");

  // ---- editing ----
  const patchPage = (fn: (p: DashPage) => DashPage) => setCfg((c) => ({ ...c, pages: c.pages.map((p) => (p.id === page.id ? fn(p) : p)) }));
  const patch = (id: string, p: Partial<Widget>) => patchPage((pg) => ({ ...pg, widgets: pg.widgets.map((w) => (w.id === id ? { ...w, ...p } : w)) }));
  function add(type: WidgetType) {
    if (page.widgets.length >= MAX_WIDGETS_PER_PAGE) { toast(`A page can have up to ${MAX_WIDGETS_PER_PAGE} charts.`, "error"); return; }
    const own = page.form_id ? undefined : forms[0];                                   // a page with no form: the chart picks its own
    const w: Widget = { ...newWidget(type, dashboardFields(own ?? forms.find((f) => f.id === page.form_id))), form_id: own?.id };
    patchPage((pg) => ({ ...pg, widgets: [...pg.widgets, w] })); setSelected(w.id);
  }
  function move(id: string, by: -1 | 1) {
    patchPage((pg) => { const i = pg.widgets.findIndex((w) => w.id === id), j = i + by; if (i < 0 || j < 0 || j >= pg.widgets.length) return pg; const a = [...pg.widgets]; [a[i], a[j]] = [a[j], a[i]]; return { ...pg, widgets: a }; });
  }
  function remove(id: string) { patchPage((pg) => ({ ...pg, widgets: pg.widgets.filter((w) => w.id !== id) })); setSelected(null); }
  function setWidgetForm(w: Widget, formId: string) {
    const f = forms.find((x) => x.id === (formId || page.form_id));
    const fresh = newWidget(w.type, dashboardFields(f), () => w.id);                  // the old field choices belong to the old form
    patch(w.id, { ...fresh, title: w.title, wide: w.wide, form_id: formId || undefined });
  }
  async function choosePageForm(id: string) {
    const next = forms.find((f) => f.id === id);
    if (!next || next.id === page.form_id) return;
    if (page.widgets.length && !(await confirm({ title: "Switch form?", message: "The charts use fields from the current form. They are replaced with a starter set for the new one.", confirmLabel: "Switch form" }))) return;
    patchPage((pg) => ({ ...pg, form_id: next.id, widgets: starterWidgets(next) }));
    setFilters(noFilters()); setSelected(null);
  }
  function addPage() {
    if (cfg.pages.length >= MAX_PAGES) { toast(`A dashboard can have up to ${MAX_PAGES} pages.`, "error"); return; }
    const p = newPage("New page");
    setCfg((c) => ({ ...c, pages: [...c.pages, p] })); goPage(p.id);
  }
  function movePage(by: -1 | 1) {
    setCfg((c) => { const i = c.pages.findIndex((p) => p.id === page.id), j = i + by; if (i < 0 || j < 0 || j >= c.pages.length) return c; const a = [...c.pages]; [a[i], a[j]] = [a[j], a[i]]; return { ...c, pages: a }; });
  }
  async function removePage() {
    if (cfg.pages.length <= 1) return;
    if (!(await confirm({ title: `Delete the page “${page.title || "Untitled"}”?`, message: "Its charts are removed when you save. The collected data is not touched.", confirmLabel: "Delete page", danger: true }))) return;
    const i = cfg.pages.findIndex((p) => p.id === page.id), left = cfg.pages.filter((p) => p.id !== page.id);
    setCfg((c) => ({ ...c, pages: left })); goPage(left[Math.min(i, left.length - 1)].id);
  }
  function pick(w: Widget, s: Slice) {
    const field = w.field;
    if (!field) return;
    setFilters((f) => {
      const has = f.equals.some((e) => e.field === field && e.value === s.key);
      const rest = f.equals.filter((e) => e.field !== field);
      const label = findField(sourceOf(w)?.defs ?? [], field)?.label ?? field;
      return { ...f, equals: has ? rest : [...rest, { field, value: s.key, label: `${label}: ${s.label}` }] };
    });
  }
  async function save() {
    setSaving(true);
    try {
      const pages = cfg.pages.map((p) => ({ ...p, title: p.title.trim() || "Untitled page" }));
      const d = await (await loadApi()).saveDashboard({ id: dashboard.id, name: name.trim() || dashboard.name, config: { ...cfg, pages } });
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

  const pageIndex = cfg.pages.findIndex((p) => p.id === page.id);
  const pageForm = forms.find((f) => f.id === page.form_id);
  const selSource = sel ? sourceOf(sel) : undefined;
  const canAdd = !!(page.form_id || forms.length);
  const time = loadedAt?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="container" style={{ width: "100%" }}>
      <div className="page-head">
        {editing
          ? <input type="text" aria-label="Dashboard name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} style={{ fontSize: "var(--fs-2xl)", fontWeight: 600 }} />
          : <h1>{name}</h1>}
        <span className="grow" />
        <Link className="btn" to={`/collect/${projectId}/dashboards`}>All dashboards</Link>
      </div>
      {editing
        ? <div className="field"><label htmlFor="ddesc">Description</label><input id="ddesc" value={cfg.description ?? ""} maxLength={300} placeholder="What this dashboard reports, and for whom" onChange={(e) => setCfg({ ...cfg, description: e.target.value || undefined })} /></div>
        : cfg.description && <p className="meta">{cfg.description}</p>}

      <div className="dash-toolbar">
        {!editing && time && <span className="meta">Data as of {time}</span>}
        <span className="grow" />
        {!editing && <Button onClick={onRefresh}>Refresh data</Button>}
        {!editing && <Button onClick={() => window.print()}>Print / PDF</Button>}
        {canEdit && !editing && <Button variant="primary" onClick={() => setEditing(true)}>Edit dashboard</Button>}
        {editing && <>
          <Button onClick={() => void cancel()}>Cancel</Button>
          <Button variant="primary" busy={saving} disabled={!dirty} onClick={() => void save()}>Save dashboard</Button>
        </>}
      </div>

      <div className="dash-bar">
        {(cfg.pages.length > 1 || editing) && (
          <nav className="dash-tabs" aria-label="Dashboard pages">
            {cfg.pages.map((p) => (
              <Link key={p.id} to={{ search: pageSearch(p.id) }} className={`dash-tab${p.id === page.id ? " is-active" : ""}`} aria-current={p.id === page.id ? "page" : undefined}>{p.title || "Untitled page"}</Link>
            ))}
            {editing && <Button small onClick={addPage} disabled={cfg.pages.length >= MAX_PAGES}>+ Add page</Button>}
          </nav>
        )}
        <div className="dash-filters" aria-label="Filters">
          <div><label htmlFor="fstatus">Review status</label>
            <select id="fstatus" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as Filters["status"] })}>
              <option value="all">All ({total})</option>
              {(Object.keys(STATUS_LABEL) as FeatureStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]} ({statusCounts[s] ?? 0})</option>)}
            </select></div>
          <div><label htmlFor="ffrom">Changed from</label><input id="ffrom" type="date" value={filters.from ?? ""} onChange={(e) => setFilters({ ...filters, from: e.target.value || undefined })} /></div>
          <div><label htmlFor="fto">to</label><input id="fto" type="date" value={filters.to ?? ""} onChange={(e) => setFilters({ ...filters, to: e.target.value || undefined })} /></div>
          {filters.equals.length > 0 && <div className="chips">{filters.equals.map((e) => (
            <span key={e.field + e.value} className="chip-x">{e.label}<button type="button" aria-label={`Remove filter ${e.label}`} onClick={() => setFilters({ ...filters, equals: filters.equals.filter((x) => x !== e) })}>×</button></span>
          ))}</div>}
          {isFiltered(filters) && <Button small variant="ghost" onClick={() => setFilters(noFilters())}>Clear filters</Button>}
          <span className="count">{shown === total ? `${total} records` : `${shown} of ${total} records`}</span>
        </div>
      </div>

      {editing && (
        <div className="dash-pagebar" aria-label="This page">
          <div className="field"><label htmlFor="ptitle">Page name</label><input id="ptitle" value={page.title} maxLength={60} placeholder="For example, Army" onChange={(e) => patchPage((p) => ({ ...p, title: e.target.value }))} /></div>
          <div className="field"><label htmlFor="pform">Records from</label>
            <select id="pform" value={page.form_id ?? ""} onChange={(e) => void choosePageForm(e.target.value)}>
              <option value="" disabled>{page.form_id ? "" : "Choose a form…"}</option>
              {forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select></div>
          <div className="row">
            <Button small onClick={() => movePage(-1)} disabled={pageIndex <= 0}>Move page left</Button>
            <Button small onClick={() => movePage(1)} disabled={pageIndex >= cfg.pages.length - 1}>Move page right</Button>
            <Button small variant="danger" onClick={() => void removePage()} disabled={cfg.pages.length <= 1}>Delete page</Button>
          </div>
          <div className="row">
            {(["kpi", "bar", "pie", "line", "table", "map"] as WidgetType[]).map((t) => <Button key={t} small disabled={!canAdd} onClick={() => add(t)}>+ {WIDGET_LABEL[t]}</Button>)}
          </div>
        </div>
      )}

      <h2 className="print-only">{page.title}</h2>
      {page.widgets.length === 0
        ? <EmptyState title={pageForm || !editing ? "No charts yet" : "Choose a form to start"}>
          {editing ? (pageForm ? "Use the + buttons above to add a number, chart, table or map." : "Pick which form's records this page shows, or add charts that each pick their own form.") : "Nothing has been added to this page."}</EmptyState>
        : <div className={`dash-layout${editing && sel ? " has-aside" : ""}`}>
          <div className="dash-grid">
            {placed.map(({ w, span, rows }) => (
              <WidgetCard key={w.id} w={w} span={span} height={rows} source={sourceOf(w)} hasForm={!!(w.form_id ?? page.form_id)} showSource={!!w.form_id && w.form_id !== page.form_id}
                filters={filters} editing={editing} selected={selected === w.id} onSelect={() => editing && setSelected(w.id)} onPick={(s) => pick(w, s)} />
            ))}
          </div>
          {editing && sel && (
            <WidgetSettings w={sel} defs={selSource?.defs ?? []} index={page.widgets.findIndex((w) => w.id === sel.id)} count={page.widgets.length}
              forms={forms} pageFormId={page.form_id} onForm={(id) => setWidgetForm(sel, id)}
              onChange={(p) => patch(sel.id, p)} onMove={(by) => move(sel.id, by)} onRemove={() => remove(sel.id)} onClose={() => setSelected(null)} />
          )}
        </div>}
    </div>
  );
}

// ---------- one widget ----------
function WidgetCard({ w, span, height, source, hasForm, showSource, filters, editing, selected, onSelect, onPick }:
  { w: Widget; span: number; height: number; source?: Source; hasForm: boolean; showSource: boolean; filters: Filters; editing: boolean; selected: boolean; onSelect: () => void; onPick: (s: Slice) => void }) {
  const defs = useMemo(() => source?.defs ?? [], [source]);
  const records = useMemo(() => source?.rows ?? [], [source]);
  const problem = source ? widgetProblem(w, defs) : null;
  const title = defaultTitle(w, defs);
  const mf = findField(defs, w.metric_field);
  const f = findField(defs, w.field);
  const active = filters.equals.find((e) => e.field === w.field)?.value;

  const data = useMemo<Slice[] | null>(() => {
    if (problem || !f) return null;
    if (w.type === "bar" || w.type === "pie") return groupBy(records, f, w.metric, mf, w.limit);
    if (w.type === "line") return timeSeries(records, f, w.bucket, w.metric, mf);
    return null;
  }, [w, records, defs]); // eslint-disable-line react-hooks/exhaustive-deps

  const mapFeatures = useMemo<MapFeature[]>(() => (w.type === "map" ? records.slice(0, 5000).map((r) => ({ id: r.id, geometry: r.geometry, state: r.status === "rejected" ? "rejected" as const : r.status === "submitted" ? "review" as const : "clean" as const })) : []), [w.type, records]);
  const tableCols = useMemo(() => w.columns.map((c) => findField(defs, c)).filter((c): c is FieldDef => !!c), [w.columns, defs]);

  function csv() {
    if (!data) return;
    download(`${slug(title)}.csv`, slicesCsv(data, f?.label ?? "Group", w.metric === "count" ? "Records" : `${METRIC_LABEL[w.metric]} of ${mf?.label ?? ""}`), "text/csv");
  }

  let body;
  if (!source) body = <div className="widget-note is-problem">{hasForm ? "The form this uses is no longer available." : "Choose the form this uses."}</div>;
  else if (problem) body = <div className="widget-note is-problem">{problem}</div>;
  else if (w.type === "kpi") {
    const v = kpi(records, w.metric, mf);
    body = <div className="kpi-value">{v == null ? "–" : fmt(v)}{mf?.unit && v != null && w.metric !== "count" && <span className="kpi-unit">{mf.unit}</span>}</div>;
  } else if (w.type === "table") {
    const t = tableRows(records, tableCols, w.limit);
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
    <section className={`widget s${span}${editing ? " is-editable" : ""}${selected ? " is-selected" : ""}`} style={{ gridRow: `span ${height}` }} aria-label={title}
      onClick={editing ? onSelect : undefined}>
      <div className="widget-head">
        <h3>{title}</h3>
        {showSource && source && <small className="meta">{source.form.name}</small>}
        {!editing && data && data.length > 0 && <Button small variant="ghost" onClick={csv} aria-label={`Download ${title} as CSV`}>CSV</Button>}
      </div>
      <div className={`widget-body is-${w.type}`}>{body}</div>
    </section>
  );
}

// ---------- the settings panel ----------
export function WidgetSettings({ w, defs, index, count, forms = [], pageFormId, onForm, onChange, onMove, onRemove, onClose }:
  { w: Widget; defs: FieldDef[]; index: number; count: number; forms?: Form[]; pageFormId?: string; onForm?: (formId: string) => void;
    onChange: (p: Partial<Widget>) => void; onMove: (by: -1 | 1) => void; onRemove: () => void; onClose: () => void }) {
  const nums = numberFields(defs);
  const usesMetric = w.type === "kpi" || w.type === "bar" || w.type === "pie" || w.type === "line";
  const setMetric = (metric: Metric) => onChange({ metric, metric_field: metric === "count" ? undefined : w.metric_field ?? nums[0]?.id });
  return (
    <aside className="dash-aside" aria-label="Chart settings">
      <div className="row" style={{ alignItems: "center" }}><h2 style={{ flex: 1 }}>{WIDGET_LABEL[w.type]}</h2><Button small variant="ghost" onClick={onClose} aria-label="Close settings">Close</Button></div>
      <div className="field"><label htmlFor="wt">Title</label><input id="wt" value={w.title} placeholder={defaultTitle({ ...w, title: "" }, defs)} onChange={(e) => onChange({ title: e.target.value })} maxLength={120} /></div>
      {onForm && forms.length > 1 && (
        <div className="field"><label htmlFor="wsrc">Records from</label>
          <select id="wsrc" value={w.form_id ?? ""} onChange={(e) => onForm(e.target.value)}>
            {pageFormId && <option value="">This page's form</option>}
            {forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select></div>
      )}
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={w.wide === true} onChange={(e) => onChange({ wide: e.target.checked || undefined })} />Full row</label>
      <small className="meta">Size and position are set automatically. Use Move earlier / later to change the order.</small>

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
