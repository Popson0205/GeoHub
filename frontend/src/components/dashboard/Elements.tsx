import { parseRich, fmt, type WidgetData } from "../../lib/dashboard";
import type { WidgetType } from "../../lib/types";

type Data<K extends WidgetData["kind"]> = Extract<WidgetData, { kind: K }>;

/** A half-circle dial: how far a value has got towards its target. Shows the real percentage even when it passes 100. */
export function Gauge({ d }: { d: Data<"gauge"> }) {
  const pct = d.percent == null ? 0 : Math.max(0, Math.min(100, d.percent));
  const R = 52, C = Math.PI * R;
  return (
    <div className="gauge" role="img" aria-label={d.percent == null ? "Gauge with no value" : `Gauge at ${Math.round(d.percent)} percent`}>
      <svg viewBox="0 0 140 84" aria-hidden="true">
        <path d="M18 74 A52 52 0 0 1 122 74" className="gauge-track" />
        <path d="M18 74 A52 52 0 0 1 122 74" className="gauge-fill" strokeDasharray={`${(pct / 100) * C} ${C}`} />
      </svg>
      <div className="gauge-value">{d.value == null ? "–" : fmt(d.value)}{d.unit && d.value != null && <span className="kpi-unit">{d.unit}</span>}</div>
      <div className="gauge-sub">{d.percent == null ? "no target value" : `${Math.round(d.percent)}% of ${d.max == null ? "" : fmt(d.max)}`}</div>
    </div>
  );
}

/** The author's own words. Only bold, italic and line breaks; nothing in here is ever read as HTML. */
export function RichText({ content }: { content: string }) {
  const lines = parseRich(content);
  if (!content.trim()) return <div className="widget-note">Empty. Select this element and write something.</div>;
  return (
    <div className="rich-text">
      {lines.map((spans, i) => (
        <p key={i}>{spans.length ? spans.map((s, j) => (s.bold ? <strong key={j}>{s.text}</strong> : s.italic ? <em key={j}>{s.text}</em> : <span key={j}>{s.text}</span>)) : <br />}</p>
      ))}
    </div>
  );
}

/** A web page in a frame. Sandboxed, no referrer, and never this app's own address (that would undo the sandbox). */
export function EmbedFrame({ url, title }: { url: string; title: string }) {
  const own = typeof window !== "undefined" && (() => { try { return new URL(url).origin === window.location.origin; } catch { return true; } })();
  if (own) return <div className="widget-note is-problem">Pages from this site cannot be embedded.</div>;
  return (
    <div className="embed">
      <iframe src={url} title={title} loading="lazy" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-forms" />
      <a className="embed-open" href={url} target="_blank" rel="noopener noreferrer">Open in a new tab</a>
    </div>
  );
}

/** What an element says when it has nothing to draw, and the one thing that fixes it. Never a blank box. */
export function EmptyNote({ d, canFix, onFix, onClear }: { d: Data<"empty">; canFix?: boolean; onFix?: () => void; onClear?: () => void }) {
  return (
    <div className="widget-note is-empty" role="status">
      <p>{d.message}</p>
      {d.reason === "no-data" && canFix && onFix && <button type="button" className="note-action" onClick={onFix}>Choose another field</button>}
      {d.reason === "no-data" && !canFix && <small>The person who built this dashboard can pick a different field.</small>}
      {d.reason === "filtered" && onClear && <button type="button" className="note-action" onClick={onClear}>Clear filters</button>}
    </div>
  );
}

export function ItemList({ rows }: { rows: Data<"list">["rows"] }) {
  return (
    <ul className="item-list">
      {rows.map((r) => <li key={r.id}><strong>{r.title}</strong>{r.subtitle && <small>{r.subtitle}</small>}</li>)}
    </ul>
  );
}

export function DetailsList({ items }: { items: Data<"details">["items"] }) {
  return (
    <dl className="details-list">
      {items.map((it, i) => <div key={it.label + i}><dt>{it.label}</dt><dd>{it.value}</dd></div>)}
    </dl>
  );
}

/** Small line icons for the Add element menu, on a 24px grid. */
const PATHS: Record<WidgetType, JSX.Element> = {
  map: <><path d="M9 4L3 6.5v13L9 17l6 3 6-2.5v-13L15 7z" /><path d="M9 4v13M15 7v13" /></>,
  bar: <path d="M5 20V10M12 20V4M19 20v-7" />,
  line: <path d="M3 17l5-6 4 3 8-9M3 21h18" />,
  pie: <><path d="M12 3v9h9" /><path d="M20.5 15A9 9 0 1112 3" /></>,
  kpi: <path d="M9 4L7 20M17 4l-2 16M4 9h17M3 15h17" />,
  gauge: <><path d="M4 17a8 8 0 0116 0" /><path d="M12 17l4-5" /></>,
  list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  table: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M3 15h18M9 4v16" /></>,
  details: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  rich_text: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,
  embedded: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M10 9l-3 3 3 3M14 9l3 3-3 3" /></>,
};
export function ElementIcon({ type, size = 20 }: { type: WidgetType; size?: number }) {
  return <svg className="el-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{PATHS[type]}</svg>;
}

/** The order and names of the Add element menu. */
export const ELEMENT_TYPES: { type: WidgetType; label: string; hint: string }[] = [
  { type: "map", label: "Map", hint: "Where records were collected" },
  { type: "bar", label: "Bar chart", hint: "Records or totals per group" },
  { type: "line", label: "Line chart", hint: "Records or totals over time" },
  { type: "pie", label: "Pie chart", hint: "Share of each group" },
  { type: "kpi", label: "Indicator", hint: "One big number" },
  { type: "gauge", label: "Gauge", hint: "A number against a target" },
  { type: "list", label: "List", hint: "Latest records, one line each" },
  { type: "table", label: "Table", hint: "Latest records in columns" },
  { type: "details", label: "Details", hint: "All fields of the latest record" },
  { type: "rich_text", label: "Rich text", hint: "A note, instructions or a title" },
  { type: "embedded", label: "Embedded content", hint: "A web page in a frame" },
];
