import { Link } from "react-router-dom";
import { ErrorState, Loading, useToast } from "../../components/ui";
import { Button } from "../../components/ui";
import { useAsync } from "../../lib/hooks";
import type { Contributor, WorkMap } from "../../lib/types";
import { ago, csvEscape, download, fmtDate, KIND_LABEL, plural, STATUS_BADGE, timeLeft } from "./shared";

const MEDAL = ["🥇", "🥈", "🥉"];

/** Last 30 days as bars. Plain SVG so there is nothing to load. */
function DailyBars({ daily }: { daily: { day: string; count: number }[] }) {
  const days: { day: string; count: number }[] = [];
  const by = new Map(daily.map((d) => [d.day.slice(0, 10), d.count]));
  for (let i = 29; i >= 0; i--) { const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10); days.push({ day: d, count: by.get(d) ?? 0 }); }
  const max = Math.max(1, ...days.map((d) => d.count));
  const total = days.reduce((t, d) => t + d.count, 0);
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox="0 0 300 70" role="img" aria-label={`Features drawn per day over the last 30 days, ${total} in total`} style={{ width: "100%", height: 90 }}>
        {days.map((d, i) => { const h = (d.count / max) * 56; return <rect key={d.day} x={i * 10 + 1} y={62 - h} width={8} height={Math.max(h, d.count ? 2 : 1)} rx={1.5} fill={d.count ? "var(--green)" : "var(--line)"}><title>{`${d.day}: ${d.count}`}</title></rect>; })}
      </svg>
      <figcaption className="field-hint">Features drawn per day, last 30 days ({total} in total)</figcaption>
    </figure>
  );
}

export default function ContributorsTab({ map }: { map: WorkMap }) {
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(async (api) => ({ report: await api.contributors(map.id), activity: await api.mapActivity(map.id) }), [map.id]);
  if (loading) return <Loading label="Counting contributions…" />;
  if (error != null || !data) return <ErrorState error={error} onRetry={reload} />;
  const { report, activity } = data;
  const rows = report.contributors;
  const top = Math.max(1, ...rows.map((r) => r.added));
  const windowed = !!(report.starts_at || report.ends_at);

  function exportCsv() {
    const head = ["rank", "name", "role", "features_added", "approved", "waiting_for_review", "rejected", "others_features_edited", "first_contribution", "last_contribution"];
    const lines = rows.map((r) => [r.rank, r.name, r.role, r.added, r.approved, r.pending, r.rejected, r.edited, r.first_at ?? "", r.last_at ?? ""].map(csvEscape).join(","));
    download(`${map.name.replace(/[^A-Za-z0-9]+/g, "-")}-contributors.csv`, [head.join(","), ...lines].join("\n"), "text/csv");
    toast("Contributor list downloaded.", "success");
  }

  return (
    <div className="stack" style={{ gap: 24 }}>
      {map.is_campaign && (
        <section className="card" aria-label="Campaign">
          <div className="row" style={{ flexWrap: "wrap" }}>
            <h2 style={{ margin: 0 }}>{map.competition ? "Mapping competition" : "Mapping campaign"}</h2>
            {map.campaign_status && <span className={`badge ${map.campaign_status === "open" ? "badge-ok" : map.campaign_status === "ended" ? "badge-bad" : "badge-warn"}`}>{map.campaign_status === "open" ? "Open" : map.campaign_status === "ended" ? "Ended" : "Not started"}</span>}
            <span className="grow" />
            <strong>{timeLeft(map.starts_at, map.ends_at)}</strong>
          </div>
          {map.goal && <p style={{ margin: 0 }}>{map.goal}</p>}
          <div className="field-hint">{map.starts_at ? `From ${fmtDate(map.starts_at, true)}` : "No start date"}{map.ends_at ? ` to ${fmtDate(map.ends_at, true)}` : ""}.{windowed ? " Only features drawn in this window are counted." : ""}</div>
        </section>
      )}

      <div className="stat-grid">
        {[["Contributors", report.totals.contributors], ["Features added", report.totals.added], ["Approved", report.totals.approved], ["Waiting for review", report.totals.pending], ["Rejected", report.totals.rejected]].map(([label, n]) => (
          <div className="card stat" key={label as string}><strong>{n}</strong><span>{label}</span></div>
        ))}
      </div>

      <section className="card" aria-label="Leaderboard">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <h2 style={{ margin: 0 }}>{map.competition ? "Leaderboard" : "Contributors"}</h2><span className="grow" />
          <Button small onClick={exportCsv} disabled={!rows.length}>Download CSV</Button>
        </div>
        <p className="field-hint" style={{ margin: 0 }}>Ranked by features added. Rejected features do not count.</p>
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead><tr><th scope="col">#</th><th scope="col">Name</th><th scope="col">Added</th><th scope="col">Approved</th><th scope="col">Waiting</th><th scope="col">Rejected</th><th scope="col">Edited</th><th scope="col">Last active</th><th scope="col"><span className="sr-only">Features</span></th></tr></thead>
            <tbody>
              {rows.map((r: Contributor) => (
                <tr key={r.user_id}>
                  <td>{map.competition && r.added > 0 && r.rank <= 3 ? <span aria-label={`Rank ${r.rank}`}>{MEDAL[r.rank - 1]}</span> : r.added > 0 ? r.rank : "–"}</td>
                  <td><strong>{r.name}</strong> <span className="field-hint">{r.role === "owner" ? "owner" : r.role === "reviewer" ? "reviewer" : r.role === "former" ? "left the map" : ""}</span></td>
                  <td style={{ minWidth: 140 }}><div className="row" style={{ gap: 8 }}><strong style={{ minWidth: 24 }}>{r.added}</strong><div className="bar" aria-hidden="true"><span style={{ width: `${(r.added / top) * 100}%` }} /></div></div></td>
                  <td>{r.approved}</td><td>{r.pending}</td><td>{r.rejected}</td><td>{r.edited}</td>
                  <td>{ago(r.last_at)}</td>
                  <td>{(r.added || r.rejected) > 0 && <Link to={`?tab=review&author=${r.user_id}`}>Their features</Link>}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={9} className="field-hint">Nobody has drawn anything yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <div className="two-col">
        <section className="card" aria-label="Activity over time"><h2 style={{ margin: 0 }}>Activity</h2><DailyBars daily={report.daily} /></section>
        <section className="card" aria-label="Recent changes">
          <h2 style={{ margin: 0 }}>Recent changes</h2>
          {activity.length === 0 && <span className="field-hint">Nothing yet.</span>}
          <ul className="plain-list">
            {activity.slice(0, 8).map((a) => (
              <li key={a.feature_id + a.at}><strong>{a.name ?? "Someone"}</strong> {a.action} a {KIND_LABEL[a.geometry_type].toLowerCase()} <span className="field-hint">{ago(a.at)}</span> <span className={`badge ${STATUS_BADGE[a.status]}`}>{a.status === "submitted" ? "waiting" : a.status}</span></li>
            ))}
          </ul>
        </section>
      </div>
      <span className="field-hint">{plural(map.member_count, "person", "people")} on this map.</span>
    </div>
  );
}
