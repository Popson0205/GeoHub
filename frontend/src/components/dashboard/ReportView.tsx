import { fmt } from "../../lib/dashboard";
import type { Report, ReportElement } from "../../lib/dashboardReport";
import { parseRich } from "../../lib/dashboard";

const SHOWN = 12;   // rows of a chart printed; the rest are summed up so the report stays short

function Element({ el }: { el: ReportElement }) {
  const d = el.data;
  let body;
  switch (d.kind) {
    case "problem": case "empty": body = <p className="report-note">{d.message}</p>; break;
    case "number": body = <p className="report-number">{d.value == null ? "–" : fmt(d.value)}{d.unit && d.value != null ? ` ${d.unit}` : ""}</p>; break;
    case "gauge": body = <p className="report-number">{d.value == null ? "–" : fmt(d.value)}{d.max != null && <span> of {fmt(d.max)}{d.percent != null ? ` (${Math.round(d.percent)}%)` : ""}</span>}</p>; break;
    case "slices": {
      const rows = d.chart === "line" ? d.slices.slice(-SHOWN) : d.slices.slice(0, SHOWN), more = d.slices.length - rows.length;
      body = (<table className="data-table"><thead><tr><th scope="col">{d.chart === "line" ? "Period" : "Group"}</th><th scope="col">Value</th></tr></thead>
        <tbody>{rows.map((s, i) => <tr key={s.key + i}><td>{s.label}</td><td>{fmt(s.value)}{d.unit}</td></tr>)}{more > 0 && <tr><td colSpan={2} className="report-note">and {more} more</td></tr>}</tbody></table>);
      break;
    }
    case "table": body = (<table className="data-table"><thead><tr>{d.columns.map((c) => <th key={c.id} scope="col">{c.label}</th>)}</tr></thead><tbody>{d.rows.map((r) => <tr key={r.id}>{r.cells.map((c, i) => <td key={i}>{c}</td>)}</tr>)}</tbody></table>); break;
    case "list": body = <ul>{d.rows.map((r) => <li key={r.id}><strong>{r.title}</strong>{r.subtitle && ` · ${r.subtitle}`}</li>)}</ul>; break;
    case "details": body = <dl className="report-details">{d.items.map((it, i) => <div key={it.label + i}><dt>{it.label}</dt><dd>{it.value}</dd></div>)}</dl>; break;
    case "text": body = <>{parseRich(d.content).map((spans, i) => <p key={i}>{spans.map((s, j) => (s.bold ? <strong key={j}>{s.text}</strong> : s.italic ? <em key={j}>{s.text}</em> : <span key={j}>{s.text}</span>))}</p>)}</>; break;
    case "embed": body = <p className="report-note">Embedded page: {d.url}</p>; break;
    case "map": body = <p className="report-note">A map of {fmt(d.count)} {d.count === 1 ? "record" : "records"}. Open the dashboard to see it.</p>; break;
  }
  return <section className="report-el"><h4>{el.title}</h4>{body}</section>;
}

/** The printable report. Plain, black on white, and it breaks cleanly across pages. */
export default function ReportView({ report }: { report: Report }) {
  const t = report.totals;
  return (
    <article className="report-doc" aria-label="Report">
      <header>
        <h2>{report.projectName}: dashboard report</h2>
        <p className="meta">Created {new Date(report.generatedAt).toLocaleString()} · {t.dashboards} {t.dashboards === 1 ? "dashboard" : "dashboards"} · {t.pages} {t.pages === 1 ? "page" : "pages"} · {t.elements} elements · {fmt(t.records)} records</p>
      </header>
      {report.dashboards.map((d) => (
        <section key={d.id} className="report-dash">
          <h3>{d.name}</h3>
          {(d.description || d.range) && <p className="meta">{[d.description, d.range && `Showing: ${d.range}`].filter(Boolean).join(" · ")}</p>}
          {d.pages.map((p) => (
            <div key={p.id} className="report-page">
              <h4 className="report-page-title">{p.title}{p.formName && <small> · {p.formName} · {fmt(p.records)} {p.records === 1 ? "record" : "records"}</small>}</h4>
              {p.elements.length === 0 ? <p className="report-note">This page has no elements.</p> : p.elements.map((el) => <Element key={el.id} el={el} />)}
            </div>
          ))}
        </section>
      ))}
    </article>
  );
}
