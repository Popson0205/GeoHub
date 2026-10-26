import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { fmt, type Slice } from "../lib/dashboard";

const color = (i: number) => `var(--chart-${(i % 8) + 1})`;
const pct = (v: number, total: number) => (total > 0 ? Math.round((v / total) * 100) : 0);
/** The keys currently filtered on: one value or several. */
const isOn = (active: string | string[] | undefined, key: string) => (Array.isArray(active) ? active.includes(key) : active != null && active === key);

/** Rows of bars, biggest first. Each row is a button when the chart can filter the dashboard. */
export function BarList({ data, active, onPick, unit = "" }: { data: Slice[]; active?: string | string[]; onPick?: (s: Slice) => void; unit?: string }) {
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  return (
    <div className="bars" role="list">
      {data.map((d, i) => {
        const inner = (
          <>
            <span className="bar-label" title={d.label}>{d.label}</span>
            <span className="bar-track"><span className="bar-fill" style={{ width: `${Math.max(2, (d.value / max) * 100)}%`, background: color(0) }} /></span>
            <span className="bar-value">{fmt(d.value)}{unit}</span>
          </>
        );
        const on = isOn(active, d.key);
        return onPick && d.key !== "__other"
          ? <button key={d.key + i} type="button" role="listitem" className={`bar-row is-pick${on ? " is-active" : ""}`} aria-pressed={on} onClick={() => onPick(d)}>{inner}</button>
          : <div key={d.key + i} role="listitem" className="bar-row">{inner}</div>;
      })}
    </div>
  );
}

/** A ring split into slices, with a legend that doubles as the filter buttons. */
export function Donut({ data, active, onPick }: { data: Slice[]; active?: string | string[]; onPick?: (s: Slice) => void }) {
  const total = data.reduce((s, d) => s + Math.max(0, d.value), 0);
  const R = 46, C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="donut">
      <svg viewBox="0 0 120 120" role="img" aria-label={`Pie chart, ${data.length} groups, total ${fmt(total)}`}>
        <g transform="rotate(-90 60 60)">
          {total > 0 && data.map((d, i) => {
            const len = (Math.max(0, d.value) / total) * C;
            const seg = (
              <circle key={d.key + i} cx="60" cy="60" r={R} fill="none" stroke={color(i)} strokeWidth={isOn(active, d.key) ? 20 : 16}
                strokeDasharray={`${Math.max(0, len - 0.6)} ${C - Math.max(0, len - 0.6)}`} strokeDashoffset={-offset}
                style={{ cursor: onPick && d.key !== "__other" ? "pointer" : undefined }}
                onClick={() => onPick && d.key !== "__other" && onPick(d)}><title>{`${d.label}: ${fmt(d.value)} (${pct(d.value, total)}%)`}</title></circle>
            );
            offset += len;
            return seg;
          })}
        </g>
        <text x="60" y="58" textAnchor="middle" className="donut-total">{fmt(total)}</text>
        <text x="60" y="73" textAnchor="middle" className="donut-sub">total</text>
      </svg>
      <ul className="legend">
        {data.map((d, i) => {
          const body = (<><span className="dot" style={{ background: color(i) }} /><span className="legend-label" title={d.label}>{d.label}</span><span className="legend-value">{fmt(d.value)} · {pct(d.value, total)}%</span></>);
          const on = isOn(active, d.key);
          return <li key={d.key + i}>{onPick && d.key !== "__other"
            ? <button type="button" className={`legend-row is-pick${on ? " is-active" : ""}`} aria-pressed={on} onClick={() => onPick(d)}>{body}</button>
            : <span className="legend-row">{body}</span>}</li>;
        })}
      </ul>
    </div>
  );
}

const niceMax = (v: number) => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };

/** A line over time with a soft area under it. Hover a point for its value. */
export function LineChart({ data, active, onPick, bucket }: { data: Slice[]; active?: string[]; onPick?: (s: Slice) => void; bucket?: string }) {
  // Draw at the size the tile really has, so the chart fills it with text at its normal size (600 x 220 until measured).
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ W: 600, H: 220 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => { const { width, height } = e.contentRect; if (width > 120 && height > 80) setSize((o) => (Math.abs(o.W - width) < 1 && Math.abs(o.H - height) < 1 ? o : { W: Math.round(width), H: Math.round(height) })); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { W, H } = size, L = 44, R = 12, T = 12, B = 26;
  const top = niceMax(Math.max(...data.map((d) => d.value), 0));
  const x = (i: number) => (data.length === 1 ? (L + W - R) / 2 : L + (i / (data.length - 1)) * (W - L - R));
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const pts = data.map((d, i) => `${x(i)},${y(d.value)}`);
  const ticks = [0, top / 2, top];
  const every = Math.max(1, Math.ceil(data.length / 6));
  return (
    <svg ref={ref} className="line-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Line chart over time, ${data.length} points`}>
      {ticks.map((t) => (
        <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="grid" /><text x={L - 6} y={y(t) + 4} textAnchor="end" className="axis">{fmt(t)}</text></g>
      ))}
      {data.length > 1 && <path d={`M${x(0)},${y(0)} L${pts.join(" L")} L${x(data.length - 1)},${y(0)} Z`} className="area" />}
      {data.length > 1 && <polyline points={pts.join(" ")} className="line" />}
      {data.map((d, i) => (
        <g key={d.key}>
          {onPick && <circle cx={x(i)} cy={y(d.value)} r={9} className="point-hit" onClick={() => onPick(d)} />}
          <circle cx={x(i)} cy={y(d.value)} r={isOn(active, d.key) ? 5.5 : data.length > 40 ? 2 : 3.5} className={`point${onPick ? " is-pick" : ""}${isOn(active, d.key) ? " is-active" : ""}`}
            {...(onPick ? { onClick: () => onPick(d), role: "button", "aria-pressed": isOn(active, d.key), "aria-label": `Filter to ${d.label}`,
              // A long series stays mouse-only so the keyboard is not asked to stop on a hundred points.
              tabIndex: data.length <= 24 ? 0 : undefined, onKeyDown: (e: ReactKeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(d); } } } : {})}>
            <title>{`${d.label}: ${fmt(d.value)}${onPick ? ` (click to filter to this ${bucket ?? "point"})` : ""}`}</title></circle>
          {i % every === 0 && <text x={x(i)} y={H - 8} textAnchor="middle" className="axis">{d.label}</text>}
        </g>
      ))}
    </svg>
  );
}
