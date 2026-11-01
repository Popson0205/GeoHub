import { lazy, Suspense, useMemo } from "react";
import { Link } from "react-router-dom";
import FootprintThumb from "../components/FootprintThumb";
import { Icon, type IconName } from "../components/icons";
import { CardSkeletons, ErrorState } from "../components/ui";
import { useAuth } from "../lib/auth";
import { useAsync } from "../lib/hooks";
import type { Project, WorkMap } from "../lib/types";

const DeviceQueue = lazy(() => import("../components/DeviceQueue"));

type Recent = { kind: "map" | "project"; id: string; name: string; updated: string; to: string; stats: { icon: IconName; text: string }[] };

const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
};

/**
 * Home for someone signed in: what needs them now, and the maps and projects they were last working on.
 * People come back to continue something, so the page leads with that rather than with what Geohub is.
 */
export default function HomePage() {
  const { user } = useAuth();
  const projects = useAsync((api) => api.listProjects(), []);
  const maps = useAsync((api) => api.listMaps(), []);
  const loading = (projects.loading && !projects.data) || (maps.loading && !maps.data);

  const review = useMemo(() => (projects.data ?? []).filter((p) => (p.role === "owner" || p.role === "admin") && (p.waiting_count ?? 0) > 0), [projects.data]);
  const recent = useMemo<Recent[]>(() => [
    ...(maps.data ?? []).map((m: WorkMap): Recent => ({ kind: "map", id: m.id, name: m.name, updated: m.updated_at, to: `/maps/${m.id}`,
      stats: [{ icon: "polygon", text: plural(m.feature_count, "feature", "features") }, { icon: "users", text: plural(m.member_count, "person", "people") }] })),
    ...(projects.data ?? []).map((p: Project): Recent => ({ kind: "project", id: p.id, name: p.name, updated: p.updated_at,
      to: p.role === "collector" ? `/collect/${p.id}` : `/collect/${p.id}/data`,
      stats: [{ icon: "point", text: plural(p.feature_count, "record", "records") }, { icon: "users", text: plural(p.collector_count, "collector", "collectors") }] })),
  ].sort((a, b) => (a.updated < b.updated ? 1 : -1)).slice(0, 6), [maps.data, projects.data]);

  const first = (user?.name ?? "").split(/\s+/)[0];
  const err = projects.error ?? maps.error;
  const empty = !loading && !err && !recent.length;

  return (
    <div className="container home" style={{ width: "100%" }}>
      <header className="home-head">
        <div>
          <p className="home-greeting">{greeting()}{first ? `, ${first}` : ""}</p>
          <h1>{empty ? "Let's get you started" : "Pick up where you left off"}</h1>
        </div>
        <div className="page-header-actions">
          <Link className="btn" to="/maps?new=1"><Icon name="navMap" size={18} />New map</Link>
          <Link className="btn btn-primary" to="/collect?new=1"><Icon name="plus" size={18} />New project</Link>
        </div>
      </header>

      {err != null && <ErrorState error={err} onRetry={() => { void projects.reload(); void maps.reload(); }} />}

      {!loading && !err && (
        <section className="home-section" aria-labelledby="attention-title">
          <h2 id="attention-title">Needs your attention</h2>
          <ul className="attention">
            {review.map((p) => (
              <li key={p.id} className="attention-row">
                <span className="attention-icon" aria-hidden="true"><Icon name="check" size={18} /></span>
                <div className="grow">
                  <strong>{plural(p.waiting_count ?? 0, "record", "records")} waiting for review</strong>
                  <small>{p.name}</small>
                </div>
                <Link className="btn btn-sm btn-primary" to={`/collect/${p.id}/data?review=1`}>Review</Link>
              </li>
            ))}
            <Suspense fallback={null}><DeviceQueue projects={projects.data ?? []} /></Suspense>
            <li className="attention-clear"><Icon name="check" size={16} />{review.length ? "Nothing else is waiting." : "You're all caught up. Nothing is waiting for review."}</li>
          </ul>
        </section>
      )}

      <section className="home-section" aria-labelledby="recent-title">
        <div className="home-section-head">
          <h2 id="recent-title">Recent</h2>
          {!empty && <span className="home-links"><Link to="/maps">All maps</Link><Link to="/collect">All projects</Link></span>}
        </div>
        {loading && <CardSkeletons count={3} />}
        {empty && (
          <div className="state">
            <span className="state-icon" aria-hidden="true"><Icon name="navMap" size={24} /></span>
            <strong>Nothing here yet</strong>
            <span className="state-text">Start a map to trace features over imagery, or a project to collect data in the field with a form.</span>
            <div className="state-action"><Link className="btn" to="/maps?new=1">Start a map</Link><Link className="btn btn-primary" to="/collect?new=1">Start a project</Link></div>
          </div>
        )}
        {recent.length > 0 && (
          <ul className="recent-grid">
            {recent.map((r) => (
              <li key={`${r.kind}-${r.id}`} className="card recent-card">
                <FootprintThumb kind={r.kind} id={r.id} version={r.updated} />
                <div className="recent-body">
                  <span className="recent-kind"><Icon name={r.kind === "map" ? "navMap" : "navCollect"} size={14} />{r.kind === "map" ? "Map" : "Data collection"}</span>
                  <Link className="recent-title" to={r.to}>{r.name}</Link>
                  <span className="item-stats">{r.stats.map((s) => <span key={s.text}><Icon name={s.icon} size={14} />{s.text}</span>)}<span>{ago(r.updated)}</span></span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="home-section home-more" aria-label="More">
        <Link className="home-tile" to="/dashboards"><Icon name="navDash" size={20} /><span><strong>Dashboards</strong><small>Charts and maps of what your projects collected</small></span></Link>
        <Link className="home-tile" to="/hub"><Icon name="navHub" size={20} /><span><strong>Data hub</strong><small>Published datasets anyone can download</small></span></Link>
        <Link className="home-tile" to="/about"><Icon name="globe" size={20} /><span><strong>About Geohub</strong><small>How mapping, collection and the hub fit together</small></span></Link>
      </section>
    </div>
  );
}
