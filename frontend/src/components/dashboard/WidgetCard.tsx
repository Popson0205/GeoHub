import { useMemo, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { BarList, Donut, LineChart } from "../charts";
import MapView, { type MapFeature } from "../MapView";
import { Button } from "../ui";
import { download } from "../../lib/csv";
import { METRIC_LABEL, defaultTitle, findField, fmt, isStatic, slicesCsv, widgetData, type Filters, type Slice, type Source } from "../../lib/dashboard";
import type { Widget } from "../../lib/types";
import { DetailsList, EmbedFrame, Gauge, ItemList, RichText } from "./Elements";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "chart";

export interface CardProps {
  w: Widget; span: number; height: number; col?: number; row?: number; dragging?: boolean;
  onGrab?: (mode: "move" | "e" | "s" | "se", e: ReactPointerEvent) => void;
  source?: Source; hasForm: boolean; showSource: boolean; filters: Filters; editing: boolean; selected: boolean;
  onSelect: () => void; onPick: (s: Slice) => void;
  /** In the side column: stacked, not on the grid, so it cannot be dragged or resized. */
  side?: boolean;
}

/** One element of a dashboard page: its title bar, what it shows, and (while editing) the handles to move and resize it. */
export function WidgetCard({ w, span, height, col, row, dragging, onGrab, source, hasForm, showSource, filters, editing, selected, onSelect, onPick, side }: CardProps) {
  const defs = useMemo(() => source?.defs ?? [], [source]);
  const title = defaultTitle(w, defs);
  const d = useMemo(() => widgetData(w, source, hasForm), [w, source, hasForm]);
  const f = findField(defs, w.field), mf = findField(defs, w.metric_field);
  const active = filters.equals.find((e) => e.field === w.field)?.value;
  const grab = editing && !side ? onGrab : undefined;

  const mapFeatures = useMemo<MapFeature[]>(
    () => (w.type === "map" && source ? source.rows.slice(0, 5000).map((r) => ({ id: r.id, geometry: r.geometry, state: r.status === "rejected" ? "rejected" as const : r.status === "submitted" ? "review" as const : "clean" as const })) : []),
    [w.type, source]);

  function csv() {
    if (d.kind !== "slices") return;
    download(`${slug(title)}.csv`, slicesCsv(d.slices, f?.label ?? "Group", w.metric === "count" ? "Records" : `${METRIC_LABEL[w.metric]} of ${mf?.label ?? ""}`), "text/csv");
  }

  let body;
  switch (d.kind) {
    case "problem": body = <div className="widget-note is-problem">{d.message}</div>; break;
    case "empty": body = <div className="widget-note">{d.message}</div>; break;
    case "number": body = <div className="kpi-value">{d.value == null ? "–" : fmt(d.value)}{d.unit && d.value != null && <span className="kpi-unit">{d.unit}</span>}</div>; break;
    case "gauge": body = <Gauge d={d} />; break;
    case "slices": body = d.chart === "bar" ? <BarList data={d.slices} active={active} onPick={onPick} unit={d.unit} /> : d.chart === "pie" ? <Donut data={d.slices} active={active} onPick={onPick} /> : <LineChart data={d.slices} />; break;
    case "table": body = (
      <div className="dash-table"><table className="data-table"><thead><tr>{d.columns.map((c) => <th key={c.id} scope="col">{c.label}</th>)}</tr></thead>
        <tbody>{d.rows.map((r) => <tr key={r.id}>{r.cells.map((c, i) => <td key={i}>{c}</td>)}</tr>)}</tbody></table></div>); break;
    case "list": body = <ItemList rows={d.rows} />; break;
    case "details": body = <DetailsList items={d.items} />; break;
    case "text": body = <RichText content={d.content} />; break;
    case "embed": body = <EmbedFrame url={d.url} title={title} />; break;
    case "map": body = <div className="dash-map"><MapView features={mapFeatures} fitKey={`dash:${w.id}:${mapFeatures.length}`} label={title} /></div>; break;
  }

  const placed = col != null && row != null && !side;
  const style = (side ? { "--h": height } : placed ? { "--h": height, "--gc": `${col + 1} / span ${span}`, "--gr": `${row + 1} / span ${height}` } : { gridRow: `span ${height}` }) as CSSProperties;
  return (
    <section className={`widget t-${w.type} s${span}${placed ? " is-placed" : ""}${side ? " is-side" : ""}${editing ? " is-editable" : ""}${selected ? " is-selected" : ""}${dragging ? " is-dragging" : ""}`}
      style={style} aria-label={title} onClick={editing ? onSelect : undefined}>
      <div className={`widget-head${grab ? " is-grab" : ""}`} onPointerDown={grab ? (e) => grab("move", e) : undefined}>
        {grab && <span className="grip" aria-hidden="true">⋮⋮</span>}
        <h3>{title}</h3>
        {showSource && source && !isStatic(w.type) && !title.startsWith(source.form.name) && <small className="meta">{source.form.name}</small>}
        {!editing && d.kind === "slices" && <Button small variant="ghost" onClick={csv} aria-label={`Download ${title} as CSV`}>CSV</Button>}
      </div>
      <div className={`widget-body is-${w.type}`}>{body}</div>
      {grab && <>
        <span className="rh rh-e" aria-hidden="true" onPointerDown={(e) => grab("e", e)} />
        <span className="rh rh-s" aria-hidden="true" onPointerDown={(e) => grab("s", e)} />
        <span className="rh rh-se" aria-hidden="true" onPointerDown={(e) => grab("se", e)} />
      </>}
    </section>
  );
}
