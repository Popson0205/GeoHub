import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { BuilderSidebar, AddElementPanel, DataSourcesPanel, EmptyCanvas, ThemePanel, TimePanel, ViewPanel, type PanelKey, type ViewTab } from "../components/dashboard/Panels";
import { WidgetCard } from "../components/dashboard/WidgetCard";
import { WidgetSettings } from "../components/dashboard/WidgetSettings";
import { Button, ErrorState, Loading, useConfirm, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import {
  STATUS_LABEL, MAX_PAGES, MAX_WIDGETS_PER_PAGE, GRID_COLUMNS, arrangeRects, buildSources, dashboardFields, filtersFromParams, filtersToParams, findField, inSidebar, isFiltered, isManualLayout, isStatic,
  layoutRects, newPage, newWidget, noFilters, pageFormIds, placeAll, resetRects, setRegion, setWidgetRect, settle, starterWidgets, timeLabel, timeRange, withRects, withTimeRange,
  type Filters, type Rect, type Slice,
} from "../lib/dashboard";
import { DEFAULT_THEME_PRESET, resolveThemeColors, themeToCssVars } from "../lib/dashboardThemes";
import { TEMPLATES, templateWidgets, type TemplateId } from "../lib/dashboardTemplates";
import { useAsync } from "../lib/hooks";
import type { Dashboard, DashboardConfig, DashPage, DashTheme, FeatureStatus, Form, Feature, TimeFilter, Widget, WidgetType } from "../lib/types";

export { WidgetSettings };

/** A saved dashboard, open in its own full-screen workspace. Anyone who may see the data views it; owners and admins also build it. */
export default function DashboardPage() {
  const { dashboardId = "" } = useParams();
  const base = useAsync(async (api) => {
    const d = await api.getDashboard(dashboardId);
    const [project, forms] = await Promise.all([api.getProject(d.project_id), api.listForms(d.project_id)]);
    return { d, project, forms };
  }, [dashboardId]);
  const projectId = base.data?.d.project_id ?? "";
  const feats = useAsync((api) => (projectId ? api.listFeatures(projectId) : Promise.resolve([] as Feature[])), [projectId]);
  const loadedAt = useMemo(() => new Date(), [feats.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const err = base.error ?? feats.error;
  if (err != null) return <div className="container"><ErrorState error={err} onRetry={() => { void base.reload(); void feats.reload(); }} /></div>;
  if (!base.data || (projectId && feats.data == null)) return <div className="container"><Loading label="Loading dashboard…" /></div>;
  const { d, project, forms } = base.data;
  const canEdit = project.role === "owner" || project.role === "admin";
  return <DashboardView key={d.id} projectId={projectId} dashboard={d} forms={forms} features={feats.data ?? []} canEdit={canEdit} loadedAt={loadedAt} onRefresh={() => void feats.reload()} />;
}

export function DashboardView({ projectId, dashboard, forms, features, canEdit, onRefresh, loadedAt, publicView }:
  { projectId: string; dashboard: Dashboard; forms: Form[]; features: Feature[]; canEdit: boolean; onRefresh: () => void; loadedAt?: Date;
    /** Seen through a public link: no toolbar, no way back into the project, read-only. */
    publicView?: { projectName: string; truncated: boolean } }) {
  const toast = useToast();
  const confirm = useConfirm();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [name, setName] = useState(dashboard.name);
  const [cfg, setCfg] = useState<DashboardConfig>(dashboard.config);
  const [snapshot, setSnapshot] = useState(JSON.stringify({ name: dashboard.name, cfg: dashboard.config }));
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [panel, setPanel] = useState<PanelKey | null>(null);
  const [viewTab, setViewTab] = useState<ViewTab>("body");
  const [collapsed, setCollapsed] = useState(false);
  const [drag, setDrag] = useState<{ id: string; rects: Map<string, Rect> } | null>(null);   // the layout while a chart is being dragged
  const gridRef = useRef<HTMLDivElement>(null);
  // "Fit to screen": on a desktop-width window the whole page is scaled down to fit under the header, so it never scrolls.
  const stageRef = useRef<HTMLDivElement>(null), innerRef = useRef<HTMLDivElement>(null), fitRef = useRef(1);
  const [fit, setFit] = useState(1);
  const editing = canEdit && !publicView;
  const dirty = JSON.stringify({ name, cfg }) !== snapshot;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // The current page and the filters live in the address (?page=…&status=…), so a view can be sent as a link,
  // survives a refresh, and the filters stay put as you move from page to page.
  const page: DashPage = cfg.pages.find((p) => p.id === params.get("page")) ?? cfg.pages[0];
  useLayoutEffect(() => {
    const stage = stageRef.current, inner = innerRef.current;
    if (!stage || !inner || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const wide = window.matchMedia("(min-width: 1101px)").matches;
      const next = wide && inner.offsetHeight > 0 && stage.clientHeight > 0 ? Math.min(1, Math.max(0.3, stage.clientHeight / inner.offsetHeight)) : 1;
      const r = Math.floor(next * 1000) / 1000;
      if (Math.abs(r - fitRef.current) > 0.002) { fitRef.current = r; setFit(r); }
    };
    measure();
    const ro = new ResizeObserver(measure); ro.observe(stage); ro.observe(inner);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, [page.id, page.widgets.length === 0]);   // eslint-disable-line react-hooks/exhaustive-deps
  const filters = useMemo(() => filtersFromParams(params), [params]);
  const setFilters = (n: Filters | ((f: Filters) => Filters)) => setParams(filtersToParams(typeof n === "function" ? n(filters) : n, params), { replace: true });
  const pageSearch = (id: string) => { const q = new URLSearchParams(params); q.set("page", id); return `?${q.toString()}`; };
  const goPage = (id: string) => { const q = new URLSearchParams(params); q.set("page", id); setParams(q); };
  useEffect(() => { setSelected(null); }, [page.id]);

  // The dashboard's own date range narrows what viewers' filters let through; it is part of the design and previews live.
  const range = useMemo(() => timeRange(cfg.time_filter, loadedAt ?? new Date()), [cfg.time_filter, loadedAt]);
  const effective = useMemo(() => withTimeRange(filters, range), [filters, range]);
  const formIds = useMemo(() => pageFormIds(page), [page]);
  const sources = useMemo(() => buildSources(formIds, forms, features, effective), [formIds, forms, features, effective]);
  const used = [...sources.values()];
  const total = used.reduce((n, s) => n + s.base.length, 0), shown = used.reduce((n, s) => n + s.rows.length, 0);
  const statusCounts = useMemo(() => { const c: Partial<Record<FeatureStatus, number>> = {}; for (const s of sources.values()) for (const f of s.base) c[f.status] = (c[f.status] ?? 0) + 1; return c; }, [sources]);
  const manual = isManualLayout(page.widgets);
  const placed = useMemo(() => placeAll(page.widgets, drag?.rects), [page.widgets, drag]);
  const sideWidgets = useMemo(() => page.widgets.filter(inSidebar), [page.widgets]);
  const rectOfSel = useMemo(() => (selected ? layoutRects(page.widgets).get(selected) : undefined), [page.widgets, selected]);
  const sel = page.widgets.find((w) => w.id === selected) ?? null;
  const sourceOf = (w: Widget) => sources.get(w.form_id ?? page.form_id ?? "");
  const pageForm = forms.find((f) => f.id === page.form_id);

  // ---- editing ----
  const patchPage = (fn: (p: DashPage) => DashPage) => setCfg((c) => ({ ...c, pages: c.pages.map((p) => (p.id === page.id ? fn(p) : p)) }));
  const patch = (id: string, p: Partial<Widget>) => patchPage((pg) => ({ ...pg, widgets: pg.widgets.map((w) => (w.id === id ? { ...w, ...p } : w)) }));
  function add(type: WidgetType) {
    if (page.widgets.length >= MAX_WIDGETS_PER_PAGE) { toast(`A page can have up to ${MAX_WIDGETS_PER_PAGE} elements.`, "error"); return; }
    const own = isStatic(type) || page.form_id ? undefined : forms[0];                    // a page with no form: the element picks its own
    const defsFor = isStatic(type) ? [] : dashboardFields(own ?? pageForm);
    const w: Widget = { ...newWidget(type, defsFor), form_id: own?.id };
    patchPage((pg) => ({ ...pg, widgets: [...pg.widgets, w] })); setSelected(w.id);
  }
  function move(id: string, by: -1 | 1) {
    patchPage((pg) => { const i = pg.widgets.findIndex((w) => w.id === id), j = i + by; if (i < 0 || j < 0 || j >= pg.widgets.length) return pg; const a = [...pg.widgets]; [a[i], a[j]] = [a[j], a[i]]; return { ...pg, widgets: a }; });
  }
  function remove(id: string) { patchPage((pg) => ({ ...pg, widgets: settle(pg.widgets.filter((w) => w.id !== id)) })); if (selected === id) setSelected(null); }
  const setRect = (id: string, r: Partial<Rect>) => patchPage((pg) => ({ ...pg, widgets: setWidgetRect(pg.widgets, id, r) }));
  const moveRegion = (id: string, r: "body" | "sidebar") => patchPage((pg) => ({ ...pg, widgets: setRegion(pg.widgets, id, r) }));
  const canDrag = () => typeof window !== "undefined" && window.matchMedia("(min-width: 1101px)").matches;   // below this the grid has fewer columns

  /** Drag a chart by its title bar (move) or by an edge or corner (resize). The others make way live; the result is kept on release. */
  function grab(w: Widget, mode: "move" | "e" | "s" | "se", e: ReactPointerEvent) {
    if (!editing || e.button !== 0 || !gridRef.current) return;
    e.preventDefault(); e.stopPropagation(); setSelected(w.id);
    if (!canDrag()) { toast("Dragging needs a wider screen. Use the Left / Top / Wide / Tall boxes in the element settings instead.", "info"); return; }
    const grid = gridRef.current, cs = getComputedStyle(grid);
    const gapX = parseFloat(cs.columnGap) || 12, gapY = parseFloat(cs.rowGap) || 12, rowH = parseFloat(cs.gridAutoRows) || 64;
    const stepX = (grid.clientWidth - gapX * (GRID_COLUMNS - 1)) / GRID_COLUMNS + gapX, stepY = rowH + gapY;
    const rects = layoutRects(page.widgets), start = rects.get(w.id);
    if (!start) return;
    const x0 = e.clientX, y0 = e.clientY;
    let latest: Map<string, Rect> | null = null;
    const onMove = (ev: PointerEvent) => {
      const dc = Math.round((ev.clientX - x0) / fitRef.current / stepX), dr = Math.round((ev.clientY - y0) / fitRef.current / stepY);
      const want: Rect = mode === "move" ? { ...start, col: start.col + dc, row: start.row + dr }
        : { ...start, cols: mode === "s" ? start.cols : start.cols + dc, rows: mode === "e" ? start.rows : start.rows + dr };
      latest = arrangeRects(rects, w.id, want);
      setDrag({ id: w.id, rects: latest });
    };
    const done = (keep: boolean) => {
      window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); window.removeEventListener("pointercancel", onCancel);
      const final = latest; setDrag(null);
      if (keep && final) patchPage((pg) => ({ ...pg, widgets: withRects(pg.widgets, final) }));
    };
    const onUp = () => done(true), onCancel = () => done(false);
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp); window.addEventListener("pointercancel", onCancel);
  }
  function setWidgetForm(w: Widget, formId: string) {
    const f = forms.find((x) => x.id === (formId || page.form_id));
    const fresh = newWidget(w.type, dashboardFields(f), () => w.id);                  // the old field choices belong to the old form
    patch(w.id, { ...fresh, title: w.title, wide: w.wide, region: w.region, form_id: formId || undefined });
  }
  async function choosePageForm(id: string) {
    const next = forms.find((f) => f.id === id);
    if (!next || next.id === page.form_id) return;
    if (page.widgets.length && !(await confirm({ title: "Switch form?", message: "The charts use fields from the current form. They are replaced with a starter set for the new one.", confirmLabel: "Switch form" }))) return;
    patchPage((pg) => ({ ...pg, form_id: next.id, widgets: starterWidgets(next) }));
    setFilters(noFilters()); setSelected(null);
  }
  async function applyTemplate(id: TemplateId) {
    const form = forms.find((f) => f.id === page.form_id);
    if (!form) return;
    const label = TEMPLATES.find((t) => t.id === id)?.name ?? "template";
    if (page.widgets.length && !(await confirm({ title: `Apply “${label}”?`, message: "The elements on this page are replaced. Other pages are not touched. Nothing is saved until you press Save, and Discard brings everything back.", confirmLabel: "Replace elements" }))) return;
    patchPage((pg) => ({ ...pg, widgets: templateWidgets(id, form) })); setSelected(null);
  }
  function addPage() {
    if (cfg.pages.length >= MAX_PAGES) { toast(`A dashboard can have up to ${MAX_PAGES} pages.`, "error"); return; }
    const p = newPage("New page", forms.length === 1 ? forms[0].id : undefined);
    setCfg((c) => ({ ...c, pages: [...c.pages, p] })); goPage(p.id);
  }
  function movePage(by: -1 | 1) {
    setCfg((c) => { const i = c.pages.findIndex((p) => p.id === page.id), j = i + by; if (i < 0 || j < 0 || j >= c.pages.length) return c; const a = [...c.pages]; [a[i], a[j]] = [a[j], a[i]]; return { ...c, pages: a }; });
  }
  async function removePage() {
    if (cfg.pages.length <= 1) return;
    if (!(await confirm({ title: `Delete the page “${page.title || "Untitled"}”?`, message: "Its elements are removed when you save. The collected data is not touched.", confirmLabel: "Delete page", danger: true }))) return;
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
      setSaved(true); window.setTimeout(() => setSaved(false), 1800); toast("Dashboard saved.", "success");
    } catch (e) { toast(e instanceof Error ? e.message : "Could not save.", "error"); }
    finally { setSaving(false); }
  }
  async function discard() {
    if (dirty && !(await confirm({ title: "Discard your changes?", message: "The dashboard goes back to how it was last saved.", confirmLabel: "Discard", danger: true }))) return;
    const s = JSON.parse(snapshot) as { name: string; cfg: DashboardConfig };
    setName(s.name); setCfg(s.cfg); setSelected(null);
  }
  async function leave(e: React.MouseEvent) {
    if (!dirty) return;
    e.preventDefault();
    if (await confirm({ title: "Leave without saving?", message: "Your changes to this dashboard have not been saved.", confirmLabel: "Leave", danger: true })) nav(`/dashboards?project=${projectId}`);
  }
  const togglePanel = (k: PanelKey) => { setPanel((cur) => (cur === k ? null : k)); };
  const openPanel = (k: PanelKey, tab?: ViewTab) => { if (tab) setViewTab(tab); setPanel(k); };
  const setTheme = (theme: DashTheme) => setCfg((c) => ({ ...c, theme: theme.preset === DEFAULT_THEME_PRESET && !Object.keys(theme.overrides ?? {}).length ? undefined : theme }));
  const setTime = (time_filter: TimeFilter | undefined) => setCfg((c) => ({ ...c, time_filter }));

  const hasSource = !!(page.form_id || forms.length);
  const time = loadedAt?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const themeVars = useMemo(() => themeToCssVars(resolveThemeColors(cfg.theme)), [cfg.theme]);
  const tl = timeLabel(cfg.time_filter);
  const card = (w: Widget, extra: { span: number; rows: number; col?: number; row?: number }, side = false) => (
    <WidgetCard key={w.id} w={w} span={extra.span} height={extra.rows} col={extra.col} row={extra.row} side={side} dragging={drag?.id === w.id} onGrab={(m, e) => grab(w, m, e)}
      source={sourceOf(w)} hasForm={!!(w.form_id ?? page.form_id)} showSource={!!w.form_id && w.form_id !== page.form_id}
      filters={filters} editing={editing} selected={selected === w.id} onSelect={() => editing && setSelected(w.id)} onPick={(s) => pick(w, s)} />
  );

  return (
    <div className={`dashboard-builder${publicView ? " is-public" : ""}`}>
      {!publicView && <>
      <BuilderSidebar active={panel} onToggle={togglePanel} canEdit={canEdit} dirty={dirty} saving={saving} saved={saved} onSave={() => void save()} onDiscard={() => void discard()} collapsed={collapsed} onCollapse={() => setCollapsed((v) => !v)} />

      {panel === "add" && <AddElementPanel onPick={add} onClose={() => setPanel(null)} full={page.widgets.length >= MAX_WIDGETS_PER_PAGE} hasSource={hasSource} />}
      {panel === "view" && (
        <ViewPanel key={viewTab} initialTab={viewTab} canEdit={canEdit} onClose={() => setPanel(null)} name={name} description={cfg.description ?? ""} onName={setName} onDescription={(v) => setCfg((c) => ({ ...c, description: v || undefined }))}
          pages={cfg.pages} page={page} forms={forms} selectedId={selected} onSelect={setSelected} onRemove={remove} onRegion={moveRegion}
          onPageTitle={(v) => patchPage((p) => ({ ...p, title: v }))} onPageForm={(id) => void choosePageForm(id)} onApplyTemplate={(id) => void applyTemplate(id)}
          onMovePage={movePage} onRemovePage={() => void removePage()} onAddPage={addPage} dashboardId={dashboard.id} dirty={dirty} />)}
      {panel === "data" && <DataSourcesPanel forms={forms} features={features} pages={cfg.pages} pageFormId={page.form_id} canEdit={canEdit} onUse={(id) => void choosePageForm(id)} onClose={() => setPanel(null)} />}
      {panel === "theme" && <ThemePanel theme={cfg.theme} canEdit={canEdit} onChange={setTheme} onClose={() => setPanel(null)} />}
      {panel === "time" && <TimePanel value={cfg.time_filter} canEdit={canEdit} onChange={setTime} onClose={() => setPanel(null)} />}
      </>}

      <div className="dashboard-canvas-outer dash-app" style={themeVars}>
        <header className="dashboard-canvas-header">
          {!publicView && <Link className="dashboard-header-back" to={`/dashboards?project=${projectId}`} onClick={(e) => void leave(e)} title="Back to dashboards" aria-label="Back to dashboards">←</Link>}
          <div className="dash-title"><h1>{name}</h1>{cfg.description && <p className="meta">{cfg.description}</p>}{publicView && <p className="meta">Shared from {publicView.projectName || "Geohub"}</p>}</div>
          <div className="dash-actions">
            {time && <span className="meta">Data as of {time}</span>}
            {canEdit && !publicView && <button type="button" className="dashboard-header-btn" onClick={() => openPanel("view", "sharing")}>Share{dashboard.shared ? " ·  Public" : ""}</button>}
            <button type="button" className="dashboard-header-btn" onClick={onRefresh}>Refresh data</button>
            <button type="button" className="dashboard-header-btn" onClick={() => window.print()}>Print / PDF</button>
          </div>
        </header>

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
            {tl && <span className="chip-x is-static" title="Set in Time and region">{tl}</span>}
            <span className="count">{shown === total ? `${total} records` : `${shown} of ${total} records`}</span>
          </div>
        </div>
        {editing && page.widgets.length > 0 && (
          <div className="dash-hintbar">
            <small className="meta dash-hint">Drag an element by its title bar to move it, and by its edge or corner to resize it. Press Save in the toolbar to keep your changes.</small>
            {manual && <Button small onClick={() => patchPage((pg) => ({ ...pg, widgets: resetRects(pg.widgets) }))}>Reset layout</Button>}
          </div>)}

        {publicView?.truncated && <p className="hint" role="status">This dashboard has more records than a shared link can carry. The most recently changed are shown.</p>}
        <h2 className="print-only">{page.title}</h2>
        {page.widgets.length === 0
          ? <EmptyCanvas canEdit={canEdit} onPick={add} onPanel={openPanel} />
          : <div className={`dash-layout${editing && sel ? " has-aside" : ""}`}>
            <div className="dash-stage" ref={stageRef}>
            <div className="dash-stage-inner" ref={innerRef} style={{ "--fit": fit } as CSSProperties}>
            <div className={`dash-body${sideWidgets.length ? " has-side" : ""}`}>
              <div className={`dash-grid${drag ? " is-dragging" : ""}`} ref={gridRef}>
                {placed.map(({ w, span, rows, col, row }) => card(w, { span, rows, col, row }))}
              </div>
              {sideWidgets.length > 0 && <div className="dash-side-col" aria-label="Side column">{sideWidgets.map((w) => card(w, { span: 12, rows: 4 }, true))}</div>}
            </div>
            </div>
            </div>
            {editing && sel && (
              <WidgetSettings w={sel} rect={rectOfSel} manual={manual} onRect={(r) => setRect(sel.id, r)} defs={(sourceOf(sel)?.defs) ?? []} index={page.widgets.findIndex((w) => w.id === sel.id)} count={page.widgets.length}
                forms={forms} pageFormId={page.form_id} onForm={(id) => setWidgetForm(sel, id)} onRegion={(r) => moveRegion(sel.id, r)}
                onChange={(p) => patch(sel.id, p)} onMove={(by) => move(sel.id, by)} onRemove={() => remove(sel.id)} onClose={() => setSelected(null)} />
            )}
          </div>}
      </div>
    </div>
  );
}
