import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { BuilderSidebar, AddElementPanel, DataSourcesPanel, EmptyCanvas, ThemePanel, TimePanel, ViewPanel, type PanelKey, type ViewTab } from "../components/dashboard/Panels";
import { ActiveFilters, HeaderControls } from "../components/dashboard/ControlBar";
import { HeaderMenu } from "../components/dashboard/HeaderMenu";
import { clearExternalValues } from "../components/dashboard/externalValues";
import { FiltersPanel } from "../components/dashboard/FiltersPanel";
import { WidgetCard } from "../components/dashboard/WidgetCard";
import { WidgetSettings } from "../components/dashboard/WidgetSettings";
import { Button, ErrorState, Loading, useConfirm, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import {
  actionsOf, clickKind, display, isFilterable, recordsOfSlice, toggleRecord,
  MAX_PAGES, MAX_WIDGETS_PER_PAGE, GRID_COLUMNS, arrangeRects, buildSources, controlLabel, controlProblem, dashboardFields, defaultTitle, filterFeatures, filtersFromParams, filtersToParams, findField, inSidebar, isFiltered, isManualLayout, isPicker, isScoped, isStatic,
  layoutRects, newPage, newWidget, noFilters, pageFormIds, placeAll, resetRects, scopeFilters, setRegion, setWidgetRect, settle, starterWidgets, timeLabel, timeRange, toggleEquals, toggleRange, bucketRange, withRects, withTimeRange, withoutField,
  type Filters, type Rect, type Slice, type Source,
} from "../lib/dashboard";
import { DEFAULT_THEME_PRESET, hasStyle, resolveThemeColors, styleToProps, themeToCssVars } from "../lib/dashboardThemes";
import { TEMPLATES, templateControls, templateWidgets, type TemplateId } from "../lib/dashboardTemplates";
import { useAsync } from "../lib/hooks";
import type { Dashboard, DashboardConfig, DashControl, DashPage, DashTheme, Form, Feature, TimeFilter, Widget, WidgetType } from "../lib/types";

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
  const [selected, setSelected] = useState<string | null>(null);         // the element that is highlighted (clicked or dragged)
  const [settingsId, setSettingsId] = useState<string | null>(null);      // the element whose settings are open: only the gear button, "Add element" or the View list opens them
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [panel, setPanel] = useState<PanelKey | null>(null);
  const [viewTab, setViewTab] = useState<ViewTab>("body");
  const [collapsed, setCollapsed] = useState(true);   // a slim icon rail by default, so the dashboard gets the room
  const [drag, setDrag] = useState<{ id: string; rects: Map<string, Rect> } | null>(null);   // the layout while a chart is being dragged
  const gridRef = useRef<HTMLDivElement>(null);
  const justDragged = useRef(false);   // a drag that ends over empty canvas must not count as a click on it
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
  useEffect(() => { setSelected(null); setSettingsId(null); }, [page.id]);
  /** Click or drag an element: highlight it. If the settings panel is already open it follows to this element; otherwise it stays shut. */
  const select = (id: string) => { setSelected(id); setSettingsId((cur) => (cur ? id : null)); };
  /** The gear button: highlight the element and open its settings. */
  const openSettings = (id: string) => { setSelected(id); setSettingsId(id); };
  const closeSettings = () => setSettingsId(null);

  // The dashboard's own date range narrows what viewers' filters let through; it is part of the design and previews live.
  const now = useMemo(() => loadedAt ?? new Date(), [loadedAt]);
  const range = useMemo(() => timeRange(cfg.time_filter, now), [cfg.time_filter, now]);
  const effective = useMemo(() => withTimeRange(filters, range), [filters, range]);
  const formIds = useMemo(() => pageFormIds(page), [page]);
  const sources = useMemo(() => buildSources(formIds, forms, features, effective, now), [formIds, forms, features, effective, now]);
  const used = [...sources.values()];
  const total = used.reduce((n, s) => n + s.base.length, 0), shown = used.reduce((n, s) => n + s.rows.length, 0);
  const manual = isManualLayout(page.widgets);
  const placed = useMemo(() => placeAll(page.widgets, drag?.rects), [page.widgets, drag]);
  const sideWidgets = useMemo(() => page.widgets.filter(inSidebar), [page.widgets]);
  const rectOfSel = useMemo(() => (settingsId ? layoutRects(page.widgets).get(settingsId) : undefined), [page.widgets, settingsId]);
  const sel = page.widgets.find((w) => w.id === settingsId) ?? null;   // the element shown in the settings panel
  // What each element draws. Filters reach every element unless the author left it out (page.exclude), so an element can have rows
  // of its own. A bar, pie or line that is itself filtering keeps all its groups on screen (the picked ones highlighted), so you can
  // pick another without clearing first; every other element is filtered by it as usual.
  const exclude = page.exclude;
  const viewSources = useMemo(() => {
    const m = new Map<string, Source | undefined>();
    for (const w of page.widgets) {
      const s = sources.get(w.form_id ?? page.form_id ?? "");
      if (!s || isStatic(w.type)) { m.set(w.id, s); continue; }
      let mine = isScoped(effective, w.id, exclude) ? scopeFilters(effective, w.id, exclude) : effective;
      // A list, table or map you clicked in keeps showing every record (the picked one highlighted), so you can click another.
      if (mine.record?.src === w.id) mine = { ...mine, record: undefined };
      const own = isPicker(w) && (mine.equals.some((e) => e.field === w.field) || (mine.ranges ?? []).some((r) => r.field === w.field));
      m.set(w.id, mine === effective && !own ? s : { ...s, rows: filterFeatures(s.base, own ? withoutField(mine, w.field) : mine, s.defs, now) });
    }
    return m;
  }, [page.widgets, page.form_id, sources, effective, exclude, now]);
  const sourceOf = (w: Widget) => viewSources.get(w.id);
  const pageForm = forms.find((f) => f.id === page.form_id);
  // The filters the author put in the bar. One that is not set up yet (or whose field has left the form) is hidden from viewers and
  // flagged to the author, never shown broken.
  const pageSource = sources.get(page.form_id ?? "");
  const pageDefs = useMemo(() => pageSource?.defs ?? dashboardFields(pageForm), [pageSource, pageForm]);
  const controlState = useMemo(() => (page.controls ?? []).map((c) => ({ c, problem: controlProblem(c, pageDefs, forms) })), [page.controls, pageDefs, forms]);
  const workingControls = useMemo(() => controlState.filter((x) => !x.problem).map((x) => x.c), [controlState]);
  const unfinishedControls = useMemo(() => controlState.filter((x) => x.problem).map((x) => ({ id: x.c.id, label: controlLabel(x.c, pageDefs), message: x.problem! })), [controlState, pageDefs]);
  const titleOf = (w: Widget) => defaultTitle(w, sources.get(w.form_id ?? page.form_id ?? "")?.defs ?? []);

  // ---- editing ----
  const patchPage = (fn: (p: DashPage) => DashPage) => setCfg((c) => ({ ...c, pages: c.pages.map((p) => (p.id === page.id ? fn(p) : p)) }));
  const patch = (id: string, p: Partial<Widget>) => patchPage((pg) => ({ ...pg, widgets: pg.widgets.map((w) => (w.id === id ? { ...w, ...p } : w)) }));
  function add(type: WidgetType) {
    if (page.widgets.length >= MAX_WIDGETS_PER_PAGE) { toast(`A page can have up to ${MAX_WIDGETS_PER_PAGE} elements.`, "error"); return; }
    const own = isStatic(type) || page.form_id ? undefined : forms[0];                    // a page with no form: the element picks its own
    const defsFor = isStatic(type) ? [] : dashboardFields(own ?? pageForm);
    const w: Widget = { ...newWidget(type, defsFor), form_id: own?.id };
    patchPage((pg) => ({ ...pg, widgets: [...pg.widgets, w] })); openSettings(w.id);   // a new element needs setting up, so its settings open
  }
  function move(id: string, by: -1 | 1) {
    patchPage((pg) => { const i = pg.widgets.findIndex((w) => w.id === id), j = i + by; if (i < 0 || j < 0 || j >= pg.widgets.length) return pg; const a = [...pg.widgets]; [a[i], a[j]] = [a[j], a[i]]; return { ...pg, widgets: a }; });
  }
  function remove(id: string) {
    patchPage((pg) => {
      // Whatever a removed element filtered, or was kept out of, goes with it.
      const ex = Object.fromEntries(Object.entries(pg.exclude ?? {}).filter(([src]) => src !== id).map(([src, ids]) => [src, ids.filter((x) => x !== id)] as const).filter(([, ids]) => ids.length));
      return { ...pg, widgets: settle(pg.widgets.filter((w) => w.id !== id)).map((w) => (w.actions?.zoom?.includes(id) ? { ...w, actions: { ...w.actions, zoom: w.actions.zoom.filter((z) => z !== id) } } : w)), exclude: Object.keys(ex).length ? ex : undefined };
    });
    if (selected === id) setSelected(null); if (settingsId === id) setSettingsId(null);
  }
  const setRect = (id: string, r: Partial<Rect>) => patchPage((pg) => ({ ...pg, widgets: setWidgetRect(pg.widgets, id, r) }));
  const moveRegion = (id: string, r: "body" | "sidebar") => patchPage((pg) => ({ ...pg, widgets: setRegion(pg.widgets, id, r) }));
  const canDrag = () => typeof window !== "undefined" && window.matchMedia("(min-width: 1101px)").matches;   // below this the grid has fewer columns

  /** Drag a chart by its title bar (move) or by an edge or corner (resize). The others make way live; the result is kept on release. */
  function grab(w: Widget, mode: "move" | "e" | "s" | "se", e: ReactPointerEvent) {
    if (!editing || e.button !== 0 || !gridRef.current) return;
    e.preventDefault(); e.stopPropagation(); select(w.id);
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
      const final = latest; setDrag(null); justDragged.current = true; window.setTimeout(() => { justDragged.current = false; }, 0);
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
    patchPage((pg) => ({ ...pg, form_id: next.id, widgets: starterWidgets(next), controls: undefined, exclude: undefined, filters: undefined }));
    setFilters(noFilters()); setSelected(null); setSettingsId(null);
  }
  async function applyTemplate(id: TemplateId) {
    const form = forms.find((f) => f.id === page.form_id);
    if (!form) return;
    const label = TEMPLATES.find((t) => t.id === id)?.name ?? "template";
    if (page.widgets.length && !(await confirm({ title: `Apply “${label}”?`, message: "The elements on this page are replaced. Other pages are not touched. Nothing is saved until you press Save, and Discard brings everything back.", confirmLabel: "Replace elements" }))) return;
    const controls = templateControls(id, form);   // a template that has its own filters sets them up too; the others leave the page's filters as they are
    patchPage((pg) => ({ ...pg, widgets: templateWidgets(id, form), exclude: undefined, ...(controls.length ? { controls } : {}) })); setSelected(null); setSettingsId(null);
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
  /** Click a bar, slice or point: filter every other element to it (click again to undo; click another to add it). */
  // ---- click actions ----
  const [focus, setFocus] = useState<{ ids: string[]; key: number; popup: boolean; maps: string[] } | null>(null);
  const [activeRec, setActiveRec] = useState<string | null>(null);
  const mapsOf = (w: Widget) => actionsOf(w).zoom.filter((id) => page.widgets.some((m) => m.id === id && m.type === "map"));
  const recordTitle = (w: Widget, id: string) => {
    const s = sourceOf(w), r = s?.base.find((x) => x.id === id);
    const d = s && (findField(s.defs, w.title_field) ?? s.defs.find((x) => x.type === "text" || x.type === "choice") ?? s.defs[0]);
    return (r && d && display(r, d)) || "Record";
  };
  /** A click on a record (or on a number / gauge: "all"). Does what the element's Actions say: filter the others, zoom a map. */
  function act(w: Widget, ids: string[] | "all", label?: string) {
    const a = actionsOf(w), s = sourceOf(w);
    const hit = ids === "all" ? (s?.rows.map((r) => r.id) ?? []) : ids;
    if (!hit.length) return;
    if (ids !== "all") setActiveRec(hit.length === 1 ? hit[0] : null);
    if (a.filter && ids !== "all" && clickKind(w) === "record") setFilters((f) => toggleRecord(f, { ids: hit, label: `${label || recordTitle(w, hit[0])}`, src: w.id }));
    const maps = mapsOf(w);
    if (maps.length) setFocus({ ids: hit, key: Date.now(), popup: ids !== "all" && hit.length === 1, maps });
  }
  const clickable = (w: Widget) => { const a = actionsOf(w); return (a.filter && clickKind(w) === "record") || mapsOf(w).length > 0; };
  function pick(w: Widget, s: Slice) {
    const field = w.field;
    if (!field) return;
    const a = actionsOf(w);
    if (mapsOf(w).length && w.type !== "line") {
      const ids = recordsOfSlice(sourceOf(w)?.rows ?? [], findField(sourceOf(w)?.defs ?? [], field), s.key);
      if (ids.length) setFocus({ ids, key: Date.now(), popup: false, maps: mapsOf(w) });
    }
    if (!a.filter) return;
    const label = findField(sourceOf(w)?.defs ?? [], field)?.label ?? field;
    // A line is over time: a point filters to exactly the day, week or month it stands for.
    if (w.type === "line") {
      const r = bucketRange(s.key, w.bucket);
      setFilters((f) => toggleRange(f, { field, from: r.from, to: r.to, label: `${label}: ${r.label}`, src: w.id }));
      return;
    }
    setFilters((f) => toggleEquals(f, { field, value: s.key, label: `${label}: ${s.label}`, src: w.id }));
  }
  async function save() {
    // A filter that is not set up (no field, no address) cannot be stored, so say which one instead of failing at the server.
    for (const p of cfg.pages) {
      const defs = dashboardFields(forms.find((f) => f.id === p.form_id));
      for (const c of p.controls ?? []) {
        const problem = controlProblem(c, defs, forms);
        if (problem) { toast(`Finish the filter “${controlLabel(c, defs)}” on ${p.title || "Untitled page"} before saving. ${problem}`, "error"); setPanel("filters"); goPage(p.id); return; }
      }
    }
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
    setName(s.name); setCfg(s.cfg); setSelected(null); setSettingsId(null);
  }
  async function leave(e: React.MouseEvent) {
    if (!dirty) return;
    e.preventDefault();
    if (await confirm({ title: "Leave without saving?", message: "Your changes to this dashboard have not been saved.", confirmLabel: "Leave", danger: true })) nav(`/dashboards?project=${projectId}`);
  }
  const togglePanel = (k: PanelKey) => { setPanel((cur) => (cur === k ? null : k)); };
  const openPanel = (k: PanelKey, tab?: ViewTab) => { if (tab) setViewTab(tab); setPanel(k); };
  const setTheme = (theme: DashTheme) => setCfg((c) => ({ ...c, theme: theme.preset === DEFAULT_THEME_PRESET && !Object.keys(theme.overrides ?? {}).length && !hasStyle(theme) ? undefined : theme }));
  const setTime = (time_filter: TimeFilter | undefined) => setCfg((c) => ({ ...c, time_filter }));

  const hasSource = !!(page.form_id || forms.length);
  const time = loadedAt?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const themeVars = useMemo(() => themeToCssVars(resolveThemeColors(cfg.theme)), [cfg.theme]);
  const styleProps = useMemo(() => styleToProps(cfg.theme?.style), [cfg.theme?.style]);
  const tl = timeLabel(cfg.time_filter);
  const card = (w: Widget, extra: { span: number; rows: number; col?: number; row?: number }, side = false) => (
    <WidgetCard key={w.id} w={w} span={extra.span} height={extra.rows} col={extra.col} row={extra.row} side={side} dragging={drag?.id === w.id} onGrab={(m, e) => grab(w, m, e)}
      source={sourceOf(w)} hasForm={!!(w.form_id ?? page.form_id)} showSource={!!w.form_id && w.form_id !== page.form_id}
      filters={filters} editing={editing} selected={selected === w.id} onSelect={() => editing && select(w.id)} onSettings={editing ? () => openSettings(w.id) : undefined} settingsOpen={settingsId === w.id} onPick={(s) => pick(w, s)}
      onItem={clickable(w) ? (ids, label) => act(w, ids, label) : undefined}
      activeId={activeRec ?? (filters.record?.ids.length === 1 ? filters.record.ids[0] : null)} mapFocus={focus && w.type === "map" && focus.maps.includes(w.id) ? focus : null}
      onClear={isFiltered(filters) ? () => setFilters(noFilters()) : undefined} />
  );

  return (
    <div className={`dashboard-builder${publicView ? " is-public" : ""}`}>
      {!publicView && <>
      <BuilderSidebar active={panel} onToggle={togglePanel} canEdit={canEdit} dirty={dirty} saving={saving} saved={saved} onSave={() => void save()} onDiscard={() => void discard()} collapsed={collapsed} onCollapse={() => setCollapsed((v) => !v)} />

      {panel === "add" && <AddElementPanel onPick={add} onClose={() => setPanel(null)} full={page.widgets.length >= MAX_WIDGETS_PER_PAGE} hasSource={hasSource} />}
      {panel === "view" && (
        <ViewPanel key={viewTab} initialTab={viewTab} canEdit={canEdit} onClose={() => setPanel(null)} name={name} description={cfg.description ?? ""} onName={setName} onDescription={(v) => setCfg((c) => ({ ...c, description: v || undefined }))}
          pages={cfg.pages} page={page} forms={forms} selectedId={selected} onSelect={openSettings} onRemove={remove} onRegion={moveRegion}
          onPageTitle={(v) => patchPage((p) => ({ ...p, title: v }))} onPageForm={(id) => void choosePageForm(id)} onApplyTemplate={(id) => void applyTemplate(id)}
          onMovePage={movePage} onRemovePage={() => void removePage()} onAddPage={addPage} dashboardId={dashboard.id} dirty={dirty} />)}
      {panel === "filters" && (
        <FiltersPanel page={page} defs={pageDefs} forms={forms} canEdit={canEdit} titleOf={titleOf} onClose={() => setPanel(null)}
          onControls={(c: DashControl[]) => patchPage((p) => ({ ...p, controls: c.length ? c : undefined }))}
          onExclude={(e) => patchPage((p) => ({ ...p, exclude: e }))} />)}
      {panel === "data" && <DataSourcesPanel forms={forms} features={features} pages={cfg.pages} pageFormId={page.form_id} canEdit={canEdit} onUse={(id) => void choosePageForm(id)} onClose={() => setPanel(null)} />}
      {panel === "theme" && <ThemePanel theme={cfg.theme} canEdit={canEdit} onChange={setTheme} onClose={() => setPanel(null)} />}
      {panel === "time" && <TimePanel value={cfg.time_filter} canEdit={canEdit} onChange={setTime} onClose={() => setPanel(null)} />}
      </>}

      <div className="dashboard-canvas-outer dash-app" style={{ ...themeVars, ...styleProps.vars }} {...styleProps.attrs}>
        <header className="dashboard-canvas-header">
          {!publicView && <Link className="dashboard-header-back" to={`/dashboards?project=${projectId}`} onClick={(e) => void leave(e)} title="Back to dashboards" aria-label="Back to dashboards">←</Link>}
          <div className="dash-title"><h1>{name}</h1>{cfg.description && <p className="meta">{cfg.description}</p>}{publicView && <p className="meta">Shared from {publicView.projectName || "Geohub"}</p>}</div>
          <HeaderControls controls={workingControls} source={pageSource} forms={forms} features={features} filters={filters} effective={effective} now={now} setFilters={setFilters}
            unfinished={unfinishedControls} editing={editing} onEdit={() => setPanel("filters")} />
          <div className="dash-actions">
            {(time || tl) && <span className="meta dash-asof" title={tl ? `Dashboard range: ${tl}` : undefined}>{[time && `Data as of ${time}`, tl].filter(Boolean).join(" · ")}</span>}
            {canEdit && !publicView && <button type="button" className="dashboard-header-btn" onClick={() => openPanel("view", "sharing")}>Share{dashboard.shared ? " ·  Public" : ""}</button>}
            <HeaderMenu
              help={editing && page.widgets.length > 0 ? "Drag an element by its title bar to move it, and by its edge or corner to resize it. Click the gear on an element for its settings. Press Save in the toolbar to keep your changes." : undefined}
              items={[
                { label: "Refresh data", onClick: () => { clearExternalValues(); onRefresh(); } },
                { label: "Print / PDF", onClick: () => window.print() },
                { label: "Add page", onClick: addPage, hidden: !editing, disabled: cfg.pages.length >= MAX_PAGES },
                { label: "Reset layout", onClick: () => patchPage((pg) => ({ ...pg, widgets: resetRects(pg.widgets) })), hidden: !(editing && manual && page.widgets.length > 0) },
              ]} />
          </div>
        </header>
        <ActiveFilters filters={filters} setFilters={setFilters} shown={shown} total={total} />

        {cfg.pages.length > 1 && (
          <div className="dash-bar">
            <nav className="dash-tabs" aria-label="Dashboard pages">
              {cfg.pages.map((p) => (
                <Link key={p.id} to={{ search: pageSearch(p.id) }} className={`dash-tab${p.id === page.id ? " is-active" : ""}`} aria-current={p.id === page.id ? "page" : undefined}>{p.title || "Untitled page"}</Link>
              ))}
              {editing && <Button small onClick={addPage} disabled={cfg.pages.length >= MAX_PAGES}>+ Add page</Button>}
            </nav>
          </div>)}

        {publicView?.truncated && <p className="hint" role="status">This dashboard has more records than a shared link can carry. The most recently changed are shown.</p>}
        <h2 className="print-only">{page.title}</h2>
        {page.widgets.length === 0
          ? <EmptyCanvas canEdit={canEdit} onPick={add} onPanel={openPanel} />
          : <div className={`dash-layout${editing && sel ? " has-aside" : ""}`}>
            <div className="dash-stage" ref={stageRef} onClick={editing ? (e) => { if (!justDragged.current && !(e.target as HTMLElement).closest(".widget")) { setSelected(null); setSettingsId(null); } } : undefined}>
            <div className="dash-stage-inner" ref={innerRef} style={{ "--fit": fit } as CSSProperties}>
            <div className={`dash-body${sideWidgets.length ? " has-side" : ""}`}>
              <div className={`dash-grid${drag ? " is-dragging" : ""}`} ref={gridRef}>
                {placed.map(({ w, span, rows, col, row }) => card(w, { span, rows, col, row }))}
              </div>
              {sideWidgets.length > 0 && <div className="dash-side-col" aria-label="Side column">{sideWidgets.map((w) => card(w, { span: 12, rows: w.rows ?? 4 }, true))}</div>}
            </div>
            </div>
            </div>
            {editing && sel && (
              <WidgetSettings w={sel} source={sourceOf(sel)} projectId={projectId} rect={rectOfSel} manual={manual} onRect={(r) => setRect(sel.id, r)} defs={(sourceOf(sel)?.defs) ?? []} index={page.widgets.findIndex((w) => w.id === sel.id)} count={page.widgets.length}
                forms={forms} pageFormId={page.form_id} onForm={(id) => setWidgetForm(sel, id)} onRegion={(r) => moveRegion(sel.id, r)}
                targets={page.widgets.filter((x) => x.id !== sel.id && isFilterable(x)).map((x) => ({ id: x.id, title: titleOf(x) }))} maps={page.widgets.filter((x) => x.type === "map" && x.id !== sel.id).map((x) => ({ id: x.id, title: titleOf(x) }))}
                excluded={page.exclude?.[sel.id] ?? []} onExcluded={(ids) => patchPage((pg) => { const ex = { ...(pg.exclude ?? {}) }; if (ids.length) ex[sel.id] = ids; else delete ex[sel.id]; return { ...pg, exclude: Object.keys(ex).length ? ex : undefined }; })}
                onChange={(p) => patch(sel.id, p)} onMove={(by) => move(sel.id, by)} onRemove={() => remove(sel.id)} onClose={closeSettings} />
            )}
          </div>}
      </div>
    </div>
  );
}
