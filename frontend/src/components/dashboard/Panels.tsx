import { useState, type ReactNode } from "react";
import { Button } from "../ui";
import TemplatePicker from "../TemplatePicker";
import { DASHBOARD_THEMES, DASH_FONTS, DEFAULT_THEME_PRESET, FONT_KEYS, STYLE_LIMITS, THEME_COLOR_FIELDS, cleanStyle, resolveThemeColors } from "../../lib/dashboardThemes";
import { TIME_PRESETS, WIDGET_LABEL, timeLabel } from "../../lib/dashboard";
import type { TemplateId } from "../../lib/dashboardTemplates";
import type { DashPage, DashStyle, DashTheme, Feature, Form, ThemeColorKey, TimeFilter, TimePreset, Widget, WidgetType } from "../../lib/types";
import { ELEMENT_TYPES, ElementIcon } from "./Elements";
import SharingTab from "./SharingPanel";

export type PanelKey = "add" | "view" | "filters" | "data" | "theme" | "time";

export function PanelShell({ title, onClose, onBack, children }: { title: string; onClose: () => void; onBack?: () => void; children: ReactNode }) {
  return (
    <section className="dashboard-side-panel" aria-label={title}>
      <div className="dashboard-side-panel-head">
        {onBack && <button type="button" className="dashboard-panel-back" onClick={onBack} aria-label="Back">←</button>}
        <h3>{title}</h3>
        <button type="button" className="dashboard-panel-close" onClick={onClose} aria-label={`Close ${title}`}>×</button>
      </div>
      <div className="dashboard-side-panel-body">{children}</div>
    </section>
  );
}

// ---------- the left sidebar ----------
const SIDE_ICONS: Record<PanelKey | "save" | "discard", JSX.Element> = {
  add: <path d="M12 5v14M5 12h14" />,
  view: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 9v11" /></>,
  filters: <path d="M4 5h16l-6 8v5l-4 2v-7z" />,
  data: <><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>,
  theme: <><circle cx="12" cy="12" r="9" /><path d="M12 3v18" /><path d="M12 3a9 9 0 010 18z" fill="currentColor" /></>,
  time: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  save: <><path d="M5 3h11l4 4v13a1 1 0 01-1 1H5a1 1 0 01-1-1V4a1 1 0 011-1z" /><path d="M8 3v5h7V3M8 21v-7h8v7" /></>,
  discard: <><path d="M9 4L4 9l5 5" /><path d="M4 9h9.5a6 6 0 010 12H10" /></>,
};
const SideIcon = ({ k }: { k: keyof typeof SIDE_ICONS }) => <svg className="dashboard-sidebar-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{SIDE_ICONS[k]}</svg>;

const ITEMS: { key: PanelKey; label: string }[] = [
  { key: "add", label: "Add element" }, { key: "view", label: "View" }, { key: "filters", label: "Filters" }, { key: "data", label: "Data sources" },
  { key: "theme", label: "Theme" }, { key: "time", label: "Time and region" },
];

export function BuilderSidebar({ active, onToggle, canEdit, dirty, saving, saved, onSave, onDiscard, collapsed, onCollapse }:
  { active: PanelKey | null; onToggle: (k: PanelKey) => void; canEdit: boolean; dirty: boolean; saving: boolean; saved: boolean; onSave: () => void; onDiscard: () => void; collapsed: boolean; onCollapse: () => void }) {
  return (
    <aside className={`dashboard-sidebar${collapsed ? " is-collapsed" : ""}`} aria-label="Dashboard tools">
      <div className="dashboard-sidebar-items">
        {ITEMS.map((it) => {
          const off = !canEdit && it.key !== "data";
          return (
            <button key={it.key} type="button" className={`dashboard-sidebar-item${active === it.key ? " is-active" : ""}${off ? " is-disabled" : ""}`} disabled={off} aria-pressed={active === it.key} title={it.label} onClick={() => onToggle(it.key)}>
              <SideIcon k={it.key} />{!collapsed && it.label}
            </button>
          );
        })}
        {canEdit && (
          <button type="button" className={`dashboard-sidebar-item${dirty ? " has-unsaved-changes" : ""}`} disabled={saving || !dirty} onClick={onSave} title={dirty ? "Save the dashboard" : "Nothing to save"}>
            <SideIcon k="save" />{!collapsed && (saving ? "Saving…" : saved && !dirty ? "Saved" : dirty ? "Save*" : "Save")}
          </button>
        )}
        {canEdit && dirty && (
          <button type="button" className="dashboard-sidebar-item" disabled={saving} onClick={onDiscard} title="Discard unsaved changes">
            <SideIcon k="discard" />{!collapsed && "Discard"}
          </button>
        )}
      </div>
      <button type="button" className="dashboard-sidebar-collapse" onClick={onCollapse} aria-label={collapsed ? "Expand the toolbar" : "Collapse the toolbar"}>{collapsed ? "»" : "« Collapse"}</button>
    </aside>
  );
}

// ---------- Add element ----------
export function ElementMenu({ onPick, disabled }: { onPick: (t: WidgetType) => void; disabled?: boolean }) {
  return (
    <div className="add-element-menu" role="menu">
      {ELEMENT_TYPES.map((t) => (
        <button key={t.type} type="button" role="menuitem" className="add-element-menu-item" disabled={disabled} onClick={() => onPick(t.type)}>
          <span className="add-element-menu-icon"><ElementIcon type={t.type} /></span>
          <span><strong>{t.label}</strong><small>{t.hint}</small></span>
        </button>
      ))}
    </div>
  );
}
export function AddElementPanel({ onPick, onClose, full, hasSource }: { onPick: (t: WidgetType) => void; onClose: () => void; full: boolean; hasSource: boolean }) {
  return (
    <PanelShell title="Add element" onClose={onClose}>
      {full && <p className="hint">This page already has the most elements it can hold.</p>}
      {!hasSource && <p className="builder-hint">This dashboard has no form to draw on yet. Charts and tables will ask you to choose one; notes and embedded pages do not need one.</p>}
      <ElementMenu onPick={onPick} disabled={full} />
    </PanelShell>
  );
}

// ---------- View ----------
export type ViewTab = "body" | "header" | "sidebar" | "pages" | "sharing";
export interface ViewPanelProps {
  canEdit: boolean; initialTab?: ViewTab; onClose: () => void;
  name: string; description: string; onName: (v: string) => void; onDescription: (v: string) => void;
  pages: DashPage[]; page: DashPage; forms: Form[]; selectedId: string | null;
  onSelect: (id: string) => void; onRemove: (id: string) => void; onRegion: (id: string, r: "body" | "sidebar") => void;
  onPageTitle: (v: string) => void; onPageForm: (formId: string) => void; onApplyTemplate: (id: TemplateId) => void;
  onMovePage: (by: -1 | 1) => void; onRemovePage: () => void; onAddPage: () => void;
  /** Given for a saved dashboard that an administrator is looking at: adds the Sharing tab. */
  dashboardId?: string; dirty?: boolean;
}
const elementName = (w: Widget) => w.title.trim() || WIDGET_LABEL[w.type];

export function ViewPanel(p: ViewPanelProps) {
  const [tab, setTab] = useState<ViewTab>(p.initialTab ?? "body");
  const [tpl, setTpl] = useState<TemplateId>("monitor");
  const idx = p.pages.findIndex((x) => x.id === p.page.id);
  const widgets = p.page.widgets;
  return (
    <PanelShell title="View" onClose={p.onClose}>
      <div className="dashboard-view-tabs" role="tablist">
        {(["body", "header", "sidebar", "pages", ...(p.canEdit && p.dashboardId ? ["sharing"] : [])] as ViewTab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`dashboard-view-tab${tab === t ? " is-active" : ""}`} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
        ))}
      </div>

      {tab === "body" && (widgets.length === 0
        ? <div className="empty-state"><p>This page is empty.</p><span>Add an element to get started.</span></div>
        : <ul className="entity-list">{widgets.map((w) => (
          <li key={w.id} className="record-row">
            <button type="button" className={`link-btn${p.selectedId === w.id ? " is-active" : ""}`} onClick={() => p.onSelect(w.id)} style={{ flex: 1, textAlign: "left" }}>
              <strong>{elementName(w)}</strong><div className="meta">{WIDGET_LABEL[w.type]}{w.region === "sidebar" ? " · side column" : ""}</div>
            </button>
            {p.canEdit && <Button small variant="ghost" onClick={() => p.onRemove(w.id)}>Remove</Button>}
          </li>))}</ul>)}

      {tab === "header" && (p.canEdit ? (
        <div className="stacked-form">
          <div className="field"><label htmlFor="vhn">Dashboard title</label><input id="vhn" value={p.name} maxLength={120} onChange={(e) => p.onName(e.target.value)} /></div>
          <div className="field"><label htmlFor="vhd">Description</label><input id="vhd" value={p.description} maxLength={300} placeholder="What it reports, and for whom" onChange={(e) => p.onDescription(e.target.value)} /></div>
          <p className="builder-hint">Filters have their own tool now: use Filters in the toolbar to add category selectors and a date filter.</p>
          <small className="meta">Changes are kept when you press Save.</small>
        </div>) : <p className="meta">Read-only for your role.</p>)}

      {tab === "sidebar" && (<>
        <p className="builder-hint">Move any element into a side column beside the main grid. Useful for a number or a note you want to stay in view.</p>
        {widgets.length === 0 ? <div className="empty-state"><p>No elements yet.</p></div>
          : <ul className="entity-list">{widgets.map((w) => {
            const side = w.region === "sidebar";
            return (
              <li key={w.id} className="record-row">
                <div style={{ flex: 1 }}><strong>{elementName(w)}</strong><div className="meta">{side ? "In the side column" : "On the main grid"}</div></div>
                {p.canEdit && <Button small variant="ghost" onClick={() => p.onRegion(w.id, side ? "body" : "sidebar")}>{side ? "Move to grid" : "Move to side"}</Button>}
              </li>);
          })}</ul>}
      </>)}

      {tab === "sharing" && p.dashboardId && <SharingTab dashboardId={p.dashboardId} dirty={!!p.dirty} />}

      {tab === "pages" && (p.canEdit ? (
        <div className="stacked-form">
          <div className="field"><label htmlFor="vpn">Page name</label><input id="vpn" value={p.page.title} maxLength={60} placeholder="For example, Army" onChange={(e) => p.onPageTitle(e.target.value)} /></div>
          <div className="field"><label htmlFor="vpf">Records from</label>
            <select id="vpf" value={p.page.form_id ?? ""} onChange={(e) => p.onPageForm(e.target.value)}>
              <option value="" disabled>{p.page.form_id ? "" : "Choose a form…"}</option>
              {p.forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select></div>
          <div className="row">
            <Button small onClick={() => p.onMovePage(-1)} disabled={idx <= 0}>Move left</Button>
            <Button small onClick={() => p.onMovePage(1)} disabled={idx >= p.pages.length - 1}>Move right</Button>
            <Button small variant="danger" onClick={p.onRemovePage} disabled={p.pages.length <= 1}>Delete page</Button>
          </div>
          <Button small onClick={p.onAddPage}>+ Add page</Button>
          <div className="field"><span className="label">Start this page from a template</span>
            <TemplatePicker value={tpl} onChange={setTpl} />
            <Button disabled={!p.page.form_id} onClick={() => p.onApplyTemplate(tpl)}>Apply to this page</Button>
            {!p.page.form_id && <small className="meta">Choose the form this page shows first.</small>}</div>
        </div>) : <p className="meta">Read-only for your role.</p>)}
    </PanelShell>
  );
}

// ---------- Data sources ----------
export function DataSourcesPanel({ forms, features, pages, pageFormId, canEdit, onUse, onClose }:
  { forms: Form[]; features: Feature[]; pages: DashPage[]; pageFormId?: string; canEdit: boolean; onUse: (formId: string) => void; onClose: () => void }) {
  const count = (id: string) => features.filter((f) => f.form_id === id && !f.deleted).length;
  const usedOn = (id: string) => pages.filter((pg) => pg.form_id === id || pg.widgets.some((w) => w.form_id === id)).length;
  return (
    <PanelShell title="Data sources" onClose={onClose}>
      <p className="builder-hint">Every form in this project can feed an element. Elements read the records collected with the form, so they change as new records arrive.</p>
      {forms.length === 0
        ? <div className="empty-state"><p>No forms yet.</p><span>Create a form and collect some records first.</span></div>
        : <ul className="entity-list">{forms.map((f) => (
          <li key={f.id} className="record-row">
            <div style={{ flex: 1 }}><strong>{f.name}</strong><div className="meta">{count(f.id)} records · used on {usedOn(f.id)} {usedOn(f.id) === 1 ? "page" : "pages"}</div></div>
            {canEdit && (f.id === pageFormId ? <span className="chip-x">This page</span> : <Button small variant="ghost" onClick={() => onUse(f.id)}>Use for this page</Button>)}
          </li>))}</ul>}
    </PanelShell>
  );
}

// ---------- Theme ----------
export function ThemePanel({ theme, canEdit, onChange, onClose }: { theme?: DashTheme; canEdit: boolean; onChange: (t: DashTheme) => void; onClose: () => void }) {
  const [step, setStep] = useState<"presets" | "custom" | "style">("presets");
  const preset = theme?.preset && DASHBOARD_THEMES[theme.preset] ? theme.preset : DEFAULT_THEME_PRESET;
  const colors = resolveThemeColors(theme);
  const style: DashStyle = cleanStyle(theme?.style) ?? {};
  const keepStyle = (t: DashTheme): DashTheme => (cleanStyle(theme?.style) ? { ...t, style: cleanStyle(theme?.style) } : t);
  const setColor = (key: ThemeColorKey, value: string) => onChange(keepStyle({ preset, overrides: { ...theme?.overrides, [key]: value } }));
  /** Change one style choice (undefined puts it back to the normal look). */
  const setStyle = <K extends keyof DashStyle>(key: K, value: DashStyle[K] | undefined) => {
    const next = { ...style }; if (value === undefined) delete next[key]; else next[key] = value;
    const clean = cleanStyle(next);
    onChange({ preset, ...(theme?.overrides && Object.keys(theme.overrides).length ? { overrides: theme.overrides } : {}), ...(clean ? { style: clean } : {}) });
  };
  const title = step === "custom" ? "Colours" : step === "style" ? "Fonts and styling" : "Theme";
  const slider = (label: string, key: "textSize" | "titleSize" | "headingSize" | "numberSize" | "radius" | "gap", unit: string, normal: number) => {
    const [lo, hi] = STYLE_LIMITS[key], v = style[key] ?? normal;
    return (<label className="style-row"><span className="style-row-head">{label}<output>{style[key] === undefined ? "Normal" : `${v}${unit}`}</output></span>
      <input type="range" min={lo} max={hi} value={v} onChange={(e) => setStyle(key, Number(e.target.value))} /></label>);
  };
  const choice = <K extends "headingWeight" | "border" | "shadow" | "titleAlign">(label: string, key: K, options: { value: NonNullable<DashStyle[K]> | ""; label: string }[]) => (
    <div className="style-row"><span className="style-row-head">{label}</span>
      <div className="style-seg" role="group" aria-label={label}>{options.map((o) => {
        const active = (style[key] ?? "") === o.value;
        return <button key={String(o.value)} type="button" className={active ? "is-active" : ""} aria-pressed={active} onClick={() => setStyle(key, (o.value === "" ? undefined : o.value) as DashStyle[K] | undefined)}>{o.label}</button>;
      })}</div></div>);
  const colour = (label: string, key: "numberColor" | "borderColor", fallback: string) => (
    <label className="theme-color-row">{label}<span className="style-colour"><input type="color" value={style[key] ?? fallback} onChange={(e) => setStyle(key, e.target.value)} />{style[key] && <button type="button" className="link-btn" onClick={() => setStyle(key, undefined)}>Reset</button>}</span></label>);
  return (
    <PanelShell title={title} onClose={onClose} onBack={step !== "presets" ? () => setStep("presets") : undefined}>
      {!canEdit ? <p className="meta">Read-only for your role.</p> : step === "presets" ? (<>
        <p className="builder-hint">Pick a look for this dashboard, then change any colour, font or shape you like.</p>
        <div className="theme-preset-list">
          {Object.entries(DASHBOARD_THEMES).map(([key, t]) => (
            <button key={key} type="button" className={`theme-preset-row${preset === key && !Object.keys(theme?.overrides ?? {}).length ? " is-active" : ""}`} aria-pressed={preset === key} onClick={() => onChange(keepStyle({ preset: key }))}>
              <span className="theme-preset-swatch" style={{ background: t.colors.background }}><span style={{ background: t.colors.accent }} /><span style={{ background: t.colors.cardBackground }} /><span style={{ background: t.colors.headerBackground }} /></span>
              {t.label}
            </button>))}
        </div>
        <Button variant="primary" onClick={() => setStep("custom")} style={{ marginTop: 12 }}>Customize colours</Button>
        <Button onClick={() => setStep("style")}>Fonts and styling</Button>
      </>) : step === "custom" ? (<>
        {THEME_COLOR_FIELDS.map((g) => (
          <div key={g.group} className="theme-color-group"><p className="palette-group-label">{g.group}</p>
            {g.fields.map((f) => <label key={f.key} className="theme-color-row">{f.label}<input type="color" value={colors[f.key]} onChange={(e) => setColor(f.key, e.target.value)} /></label>)}
          </div>))}
        <Button small variant="ghost" onClick={() => onChange(keepStyle({ preset }))}>Reset to “{DASHBOARD_THEMES[preset].label}”</Button>
      </>) : (<>
        <div className="theme-color-group"><p className="palette-group-label">Text</p>
          <label className="style-row"><span className="style-row-head">Font</span>
            <select value={style.font ?? ""} onChange={(e) => setStyle("font", (e.target.value || undefined) as DashStyle["font"])} style={style.font ? { fontFamily: DASH_FONTS[style.font].stack } : undefined}>
              <option value="">Normal</option>
              {FONT_KEYS.map((k) => <option key={k} value={k} style={{ fontFamily: DASH_FONTS[k].stack }}>{DASH_FONTS[k].label}</option>)}
            </select></label>
          {slider("Text size", "textSize", "%", 100)}
          {slider("Dashboard title size", "titleSize", "px", 22)}
          {slider("Element title size", "headingSize", "px", 14)}
          {choice("Element title weight", "headingWeight", [{ value: "", label: "Normal" }, { value: 500, label: "Medium" }, { value: 600, label: "Semi" }, { value: 700, label: "Bold" }, { value: 800, label: "Black" }])}
          <label className="check-row"><input type="checkbox" checked={!!style.headingCaps} onChange={(e) => setStyle("headingCaps", e.target.checked ? true : undefined)} />Element titles in capitals</label>
          {choice("Dashboard title", "titleAlign", [{ value: "", label: "Left" }, { value: "center", label: "Centre" }])}
        </div>
        <div className="theme-color-group"><p className="palette-group-label">Numbers</p>
          {slider("Big number size", "numberSize", "%", 100)}
          {colour("Big number colour", "numberColor", colors.accent)}
        </div>
        <div className="theme-color-group"><p className="palette-group-label">Elements</p>
          {slider("Corner roundness", "radius", "px", 10)}
          {choice("Border", "border", [{ value: "", label: "Normal" }, { value: "none", label: "None" }, { value: "thin", label: "Thin" }, { value: "thick", label: "Thick" }])}
          {colour("Border colour", "borderColor", colors.cardForeground)}
          {choice("Shadow", "shadow", [{ value: "", label: "Normal" }, { value: "none", label: "None" }, { value: "soft", label: "Soft" }, { value: "strong", label: "Strong" }])}
          {slider("Space between elements", "gap", "px", 12)}
        </div>
        <Button small variant="ghost" onClick={() => onChange({ preset, ...(theme?.overrides && Object.keys(theme.overrides).length ? { overrides: theme.overrides } : {}) })}>Reset fonts and styling</Button>
      </>)}
    </PanelShell>
  );
}

// ---------- Time and region ----------
export function TimePanel({ value, canEdit, onChange, onClose }: { value?: TimeFilter; canEdit: boolean; onChange: (t: TimeFilter | undefined) => void; onClose: () => void }) {
  const [preset, setPreset] = useState<TimePreset>(value?.preset ?? "all_time");
  const [start, setStart] = useState(value?.start ?? "");
  const [end, setEnd] = useState(value?.end ?? "");
  const pick = (p: TimePreset) => { setPreset(p); if (p === "all_time") onChange(undefined); else if (p !== "custom") onChange({ preset: p }); };
  const bad = !!start && !!end && start > end;
  return (
    <PanelShell title="Time and region" onClose={onClose}>
      <p className="builder-hint">Limits every element on this dashboard to records that changed within a date range. It works on top of the filters viewers choose, not instead of them.</p>
      {!canEdit ? <p className="meta">{value ? `This dashboard shows: ${timeLabel(value)}.` : "This dashboard shows all time."}</p> : (<>
        <div className="theme-preset-list">
          {TIME_PRESETS.map((t) => <button key={t.value} type="button" className={`theme-preset-row${preset === t.value ? " is-active" : ""}`} aria-pressed={preset === t.value} onClick={() => pick(t.value)}>{t.label}</button>)}
        </div>
        {preset === "custom" && (
          <div className="stacked-form" style={{ marginTop: 12 }}>
            <div className="field"><label htmlFor="tps">From</label><input id="tps" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="field"><label htmlFor="tpe">To</label><input id="tpe" type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
            {bad && <p className="hint">The start date is after the end date.</p>}
            <Button variant="primary" disabled={!start || !end || bad} onClick={() => onChange({ preset: "custom", start, end })}>Apply range</Button>
          </div>)}
      </>)}
      <p className="meta" style={{ marginTop: 16 }}>There is no separate region filter yet: forms do not share a common region field to filter by.</p>
    </PanelShell>
  );
}

// ---------- an empty page ----------
function Illustration() {
  return (
    <svg viewBox="0 0 200 140" width={180} height={126} aria-hidden="true" className="dashboard-empty-art">
      <rect x="30" y="30" width="90" height="70" rx="4" fill="none" stroke="var(--line)" strokeWidth="2" />
      <circle cx="55" cy="80" r="14" fill="none" stroke="var(--dash-accent, var(--green-600))" strokeWidth="4" strokeDasharray="60 30" />
      <rect x="85" y="70" width="8" height="20" fill="var(--dash-accent, var(--green-600))" /><rect x="97" y="60" width="8" height="30" fill="var(--dash-accent, var(--green-600))" />
      <path d="M40 45 L60 45 L60 35 L80 55" fill="none" stroke="var(--dash-accent, var(--green-600))" strokeWidth="2" /><circle cx="40" cy="45" r="3" fill="var(--dash-accent, var(--green-600))" /><circle cx="80" cy="55" r="3" fill="var(--n-500)" />
      <circle cx="140" cy="40" r="16" fill="none" stroke="var(--dash-accent, var(--green-600))" strokeWidth="3" /><path d="M140 40 L140 28 M140 40 L150 40" stroke="var(--dash-accent, var(--green-600))" strokeWidth="3" strokeLinecap="round" />
      <circle cx="115" cy="70" r="8" fill="none" stroke="var(--line)" strokeWidth="2" /><path d="M111 70 L119 70 M115 66 L115 74" stroke="var(--line)" strokeWidth="2" />
    </svg>
  );
}
export function EmptyCanvas({ canEdit, onPick, onPanel }: { canEdit: boolean; onPick: (t: WidgetType) => void; onPanel: (k: PanelKey, tab?: ViewTab) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="dashboard-empty">
      <Illustration />
      <h2>Visualize, monitor, and share information</h2>
      {canEdit
        ? <p>Press the button below to start building your dashboard.<br />Want a head start? Try a template or browse your data.</p>
        : <p>This page doesn't have any elements yet.</p>}
      {canEdit && (
        <div style={{ position: "relative" }}>
          <button type="button" className="dashboard-add-fab" aria-label="Add your first element" aria-expanded={open} onClick={() => setOpen((v) => !v)}>+</button>
          {open && <div className="dashboard-empty-menu"><ElementMenu onPick={(t) => { setOpen(false); onPick(t); }} /></div>}
        </div>
      )}
      {canEdit && (
        <div className="dashboard-empty-links">
          <button type="button" className="dashboard-empty-link" onClick={() => onPanel("view", "pages")}>Start from a template</button>
          <button type="button" className="dashboard-empty-link" onClick={() => onPanel("data")}>Browse data sources</button>
          <button type="button" className="dashboard-empty-link" onClick={() => onPanel("theme")}>Choose a theme</button>
        </div>
      )}
    </div>
  );
}
