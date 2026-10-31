import { useMemo, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { BarList, Donut, LineChart } from "../charts";
import MapViewer, { type ViewerLayer } from "../MapViewer";
import { Button } from "../ui";
import { download } from "../../lib/csv";
import { METRIC_LABEL, activeBuckets, defaultTitle, findField, fmt, isStatic, slicesCsv, widgetData, type Filters, type Slice, type Source } from "../../lib/dashboard";
import { widgetStyleToProps } from "../../lib/dashboardThemes";
import { cleanViewerStyle, emptyViewerStyle, statusLayer, type ViewerStyle } from "../../lib/symbology";
import type { Widget } from "../../lib/types";
import { SymbolIcon } from "../SymbolIcon";
import { DataTable, DetailsList, EmbedFrame, EmptyNote, Gauge, ItemList, RichText } from "./Elements";

/** The cog on an element's top corner. */
export function GearIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.7 1.7 0 00-1.87-.34 1.7 1.7 0 00-1.03 1.56V21a2 2 0 11-4 0v-.09A1.7 1.7 0 009 19.4a1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.7 1.7 0 004.6 15a1.7 1.7 0 00-1.56-1.03H3a2 2 0 110-4h.09A1.7 1.7 0 004.6 9a1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06A1.7 1.7 0 009 4.6a1.7 1.7 0 001.03-1.56V3a2 2 0 114 0v.09A1.7 1.7 0 0015 4.6a1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06A1.7 1.7 0 0019.4 9c.2.62.8 1.03 1.56 1.03H21a2 2 0 110 4h-.09c-.76 0-1.36.41-1.51 1z" />
    </svg>
  );
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "chart";

export interface CardProps {
  w: Widget; span: number; height: number; col?: number; row?: number; dragging?: boolean;
  onGrab?: (mode: "move" | "e" | "s" | "se", e: ReactPointerEvent) => void;
  source?: Source; hasForm: boolean; showSource: boolean; filters: Filters; editing: boolean; selected: boolean;
  /** A click on the element: it is only highlighted. Its settings never open by themselves. */
  onSelect: () => void;
  /** The gear button (and the "fix it" shortcuts inside an empty element): open this element's settings. */
  onSettings?: () => void; settingsOpen?: boolean;
  onPick: (s: Slice) => void;
  /**
   * A record was clicked (list row, table row, map point, the details card), or a number or gauge ("all" = every record it counts).
   * Missing = this element has no click action set, so nothing in it is a button.
   */
  onItem?: (ids: string[] | "all", label?: string) => void;
  /** The record last clicked in any element, shown as selected here. */
  activeId?: string | null;
  /** A map element: where another element sent it (see MapViewer's `focus`). */
  mapFocus?: { ids: string[]; key: number; popup: boolean } | null;
  onClear?: () => void;
  /** In the side column: stacked, not on the grid, so it cannot be dragged or resized. */
  side?: boolean;
}

/** One element of a dashboard page: its title bar, what it shows, and (while editing) the handles to move and resize it. */
export function WidgetCard({ w, span, height, col, row, dragging, onGrab, source, hasForm, showSource, filters, editing, selected, onSelect, onSettings, settingsOpen, onPick, onItem, activeId, mapFocus, onClear, side }: CardProps) {
  const defs = useMemo(() => source?.defs ?? [], [source]);
  const title = defaultTitle(w, defs);
  const d = useMemo(() => widgetData(w, source, hasForm), [w, source, hasForm]);
  const f = findField(defs, w.field), mf = findField(defs, w.metric_field);
  // Bars and slices that are filtered on show as picked; so do the points of a line whose day, week or month is.
  const active = w.type === "line" ? (d.kind === "slices" ? activeBuckets(filters, w.field, w.bucket, d.slices.map((s) => s.key)) : [])
    : filters.equals.filter((e) => e.field === w.field).map((e) => e.value);
  const grab = editing && !side ? onGrab : undefined;

  // A map element is the same map viewer as the project's map, small: its layer is the records this element draws on (filters applied).
  const mapLayers = useMemo<ViewerLayer[]>(
    () => (w.type === "map" && source ? [{ id: source.form.id, name: source.form.name, form: source.form, features: source.rows.slice(0, 5000) }] : []),
    [w.type, source]);
  const mapStyle = useMemo<ViewerStyle>(() => {
    const s = w.map_style ? cleanViewerStyle(w.map_style) : emptyViewerStyle();
    return source && !s.layers[source.form.id] ? { ...s, layers: { ...s.layers, [source.form.id]: statusLayer() } } : s;
  }, [w.map_style, source]);

  function csv() {
    if (d.kind !== "slices") return;
    download(`${slug(title)}.csv`, slicesCsv(d.slices, f?.label ?? "Group", w.metric === "count" ? "Records" : `${METRIC_LABEL[w.metric]} of ${mf?.label ?? ""}`), "text/csv");
  }

  let body;
  switch (d.kind) {
    case "problem": body = <div className="widget-note is-problem" role="status"><p>{d.message}</p>{editing && <button type="button" className="note-action" onClick={onSettings}>Open settings to fix</button>}</div>; break;
    case "empty": body = <EmptyNote d={d} canFix={editing} onFix={onSettings} onClear={onClear} />; break;
    case "number": {
      const num = (
        <div className={`kpi-value${onItem ? " is-clickable" : ""}`} {...(onItem ? { role: "button", tabIndex: 0, onClick: () => onItem("all"), onKeyDown: (e: { key: string }) => { if (e.key === "Enter" || e.key === " ") onItem("all"); } } : {})}>
          {d.value == null ? "–" : fmt(d.value)}{d.unit && d.value != null && <span className="kpi-unit">{d.unit}</span>}</div>);
      // A symbol sits beside the number, like the icon on an Esri indicator.
      body = w.symbol ? <div className="kpi-row"><SymbolIcon spec={w.symbol} size={52} />{num}</div> : num; break;
    }
    case "gauge": {
      const g = onItem ? <div className="is-clickable" role="button" tabIndex={0} onClick={() => onItem("all")} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onItem("all"); }}><Gauge d={d} /></div> : <Gauge d={d} />;
      body = w.symbol ? <div className="kpi-row is-gauge"><SymbolIcon spec={w.symbol} size={44} />{g}</div> : g; break;
    }
    case "slices": body = d.chart === "bar" ? <BarList data={d.slices} active={active} onPick={onPick} unit={d.unit} /> : d.chart === "pie" ? <Donut data={d.slices} active={active} onPick={onPick} /> : <LineChart data={d.slices} active={active} bucket={w.bucket} onPick={w.field ? onPick : undefined} />; break;
    case "table": body = <DataTable columns={d.columns} rows={d.rows} activeId={activeId} onPick={onItem && ((id, label) => onItem([id], label))} />; break;
    case "list": body = <ItemList rows={d.rows} symbol={w.symbol} labels={w.show_labels} activeId={activeId} onPick={onItem && ((id, label) => onItem([id], label))} />; break;
    case "details": body = <DetailsList items={d.items} onPick={onItem && (() => onItem([d.id]))} />; break;
    case "text": body = <RichText content={d.content} />; break;
    case "embed": body = <EmbedFrame url={d.url} title={title} />; break;
    case "map": body = <div className="dash-map"><MapViewer compact layers={mapLayers} style={mapStyle} fitKey={`dash:${w.id}:${mapLayers[0]?.features.length ?? 0}`} label={title} focus={mapFocus} onPickFeature={onItem && ((id) => { if (id) onItem([id]); })} /></div>; break;
  }

  const placed = col != null && row != null && !side;
  const own = useMemo(() => widgetStyleToProps(w.style), [w.style]);   // this element's own font and style; wins over the dashboard's
  const style = { ...(side ? { "--h": height } : placed ? { "--h": height, "--gc": `${col + 1} / span ${span}`, "--gr": `${row + 1} / span ${height}` } : { gridRow: `span ${height}` }), ...own.vars } as CSSProperties;
  return (
    <section className={`widget t-${w.type} s${span}${placed ? " is-placed" : ""}${side ? " is-side" : ""}${editing ? " is-editable" : ""}${selected ? " is-selected" : ""}${dragging ? " is-dragging" : ""}`}
      style={style} {...own.attrs} aria-label={title} onClick={editing ? onSelect : undefined}>
      <div className={`widget-head${grab ? " is-grab" : ""}`} onPointerDown={grab ? (e) => grab("move", e) : undefined}>
        {grab && <span className="grip" aria-hidden="true">⋮⋮</span>}
        {w.symbol && w.type !== "kpi" && w.type !== "gauge" && w.type !== "list" && <SymbolIcon spec={w.symbol} size={20} className="head-sym" />}
        <h3>{title}</h3>
        {showSource && source && !isStatic(w.type) && !title.startsWith(source.form.name) && <small className="meta">{source.form.name}</small>}
        {!editing && d.kind === "slices" && <Button small variant="ghost" onClick={csv} aria-label={`Download ${title} as CSV`}>CSV</Button>}
      </div>
      <div className={`widget-body is-${w.type}`}>{body}</div>
      {editing && onSettings && (
        <button type="button" className={`widget-gear${settingsOpen ? " is-open" : ""}`} aria-label={`Settings for ${title}`} aria-haspopup="dialog" aria-expanded={settingsOpen ? true : false} title="Element settings"
          onPointerDown={(e) => e.stopPropagation()} onClick={onSettings}>
          <GearIcon />
        </button>)}
      {grab && <>
        <span className="rh rh-e" aria-hidden="true" onPointerDown={(e) => grab("e", e)} />
        <span className="rh rh-s" aria-hidden="true" onPointerDown={(e) => grab("s", e)} />
        <span className="rh rh-se" aria-hidden="true" onPointerDown={(e) => grab("se", e)} />
      </>}
    </section>
  );
}
