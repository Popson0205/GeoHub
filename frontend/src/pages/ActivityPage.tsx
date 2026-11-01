import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import ProjectNav, { ProjectNavSkeleton } from "../components/ProjectNav";
import { Icon, type IconName } from "../components/icons";
import { Button, EmptyState, ErrorState, Loading } from "../components/ui";
import { loadApi } from "../lib/api";
import { useAsync } from "../lib/hooks";
import type { AuditEvent, AuditKind } from "../lib/types";

const KINDS: { id: AuditKind | "all"; label: string }[] = [
  { id: "all", label: "Everything" }, { id: "records", label: "Records" }, { id: "forms", label: "Forms" },
  { id: "people", label: "People" }, { id: "publishing", label: "Publishing" }, { id: "dashboards", label: "Dashboards" },
];
const ROLE: Record<string, string> = { owner: "an owner", admin: "an administrator", viewer: "a viewer", collector: "a collector" };

/** A run of the same thing done by the same person close together ("added 12 records"), shown as one line. */
export interface Entry { first: AuditEvent; events: AuditEvent[] }
const GROUPABLE = new Set(["feature.create", "feature.edit", "feature.delete", "feature.review", "feature.restore"]);
const SPAN_MS = 30 * 60000;

export function group(events: AuditEvent[]): Entry[] {
  const out: Entry[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    const same = last && GROUPABLE.has(e.action) && last.first.action === e.action && last.first.actor_id === e.actor_id
      && last.first.target_name === e.target_name && (e.details.decision ?? null) === (last.first.details.decision ?? null)
      && Math.abs(Date.parse(last.events[last.events.length - 1]!.at) - Date.parse(e.at)) <= SPAN_MS
      && dayKey(last.first.at) === dayKey(e.at);
    if (same) last.events.push(e); else out.push({ first: e, events: [e] });
  }
  return out;
}

const dayKey = (iso: string) => new Date(iso).toDateString();
function dayLabel(iso: string): string {
  const d = new Date(iso), today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}
const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** What happened, as a sentence after the person's name, with the names of things in bold. */
export function describe(e: AuditEvent, n = 1, projectId = ""): { icon: IconName; text: ReactNode } {
  const name = e.target_name ? <strong>{e.target_name}</strong> : null;
  const rec = (verb: string) => <>{verb} {n === 1 ? "a" : n} {e.target_name ? <strong>{e.target_name}</strong> : null} {n === 1 ? "record" : "records"}</>;
  const role = typeof e.details.role === "string" ? ROLE[e.details.role] ?? e.details.role : null;
  const formLink = (label: ReactNode) => (e.target_id && projectId ? <Link to={`/collect/${projectId}/forms/${e.target_id}`}>{label}</Link> : label);
  switch (e.action) {
    case "feature.create": return { icon: "plus", text: rec("added") };
    case "feature.edit": return { icon: "reshape", text: rec("edited") };
    case "feature.delete": return { icon: "delete", text: rec("deleted") };
    case "feature.restore": return { icon: "undo", text: rec("restored") };
    case "feature.review": return e.details.decision === "rejected"
      ? { icon: "undo", text: <>returned {n === 1 ? "a" : n} {name} {n === 1 ? "record" : "records"} for changes</> }
      : { icon: "check", text: rec("approved") };
    case "features.import": return { icon: "upload", text: <>imported records into {name ? formLink(name) : "a form"}{typeof e.details.file === "string" && <> from <span className="mono">{e.details.file}</span></>}</> };
    case "form.publish": return { icon: "form", text: <>published {name ? formLink(name) : "a form"}{typeof e.details.version === "number" && e.details.version > 1 && <> (version {e.details.version})</>}</> };
    case "form.sharing": return { icon: "link", text: <>changed who can open {name ? formLink(name) : "a form"}</> };
    case "member.add": return { icon: "users", text: <>added {name ?? "someone"}{role && <> as {role}</>}</> };
    case "member.invite": return { icon: "users", text: <>invited {name ?? <strong>{String(e.details.email ?? "someone")}</strong>}{role && <> as {role}</>}</> };
    case "member.join": return { icon: "users", text: <>joined the project</> };
    case "member.role_change": return { icon: "users", text: <>made {name ?? "someone"} {role ?? "a member"}</> };
    case "member.remove": return { icon: "users", text: <>removed {name ?? "someone"} from the project</> };
    case "dataset.publish": return { icon: "globe", text: <>published {name ?? "a dataset"} to the data hub</> };
    case "dataset.version": return { icon: "globe", text: <>published a new version of {name ?? "a dataset"}</> };
    case "dataset.visibility": return { icon: "globe", text: <>changed who can see {name ?? "a dataset"}</> };
    case "export.request": return { icon: "download", text: <>downloaded {name ?? "data"}{typeof e.details.format === "string" && <> as {e.details.format.toUpperCase()}</>}</> };
    case "dashboard.create": return { icon: "navDash", text: <>made the dashboard {name ?? ""}</> };
    case "dashboard.delete": return { icon: "delete", text: <>deleted a dashboard</> };
    case "dashboard.sharing": return { icon: "link", text: <>changed who can see the dashboard {name ?? ""}</> };
    case "project.create": return { icon: "navCollect", text: <>created the project</> };
    case "imagery.delete": return { icon: "layers", text: <>removed an imagery layer</> };
    default: return { icon: "inbox", text: <>{e.action.replace(/[._]/g, " ")}</> };
  }
}
const who = (e: AuditEvent) => e.actor_name ?? (e.details.public ? "Someone using the public link" : e.actor_id ? "A former member" : "Geohub");

/** A project's history: who added, reviewed, published or changed what, newest first. Owners and administrators only. */
export default function ActivityPage() {
  const { projectId = "" } = useParams();
  const project = useAsync((api) => api.getProject(projectId), [projectId]);
  const manage = project.data?.role === "owner" || project.data?.role === "admin";
  const members = useAsync((api) => (manage ? api.listProjectMembers(projectId) : Promise.resolve([])), [projectId, manage]);
  const [kind, setKind] = useState<AuditKind | "all">("all");
  const [actor, setActor] = useState("");
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [tick, setTick] = useState(0);

  async function fetchPage(from: string | null) {
    const api = await loadApi();
    return api.listActivity(projectId, { kind: kind === "all" ? undefined : kind, actor: actor || undefined, cursor: from });
  }
  useEffect(() => {
    if (!manage) return;
    let live = true;
    setEvents(null); setError(null); setOpen(new Set());
    fetchPage(null).then((r) => { if (live) { setEvents(r.items); setCursor(r.next_cursor); } }, (e) => { if (live) setError(e); });
    return () => { live = false; };
  }, [projectId, manage, kind, actor, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  async function loadMore() {
    setMore(true);
    try { const r = await fetchPage(cursor); setEvents((l) => [...(l ?? []), ...r.items]); setCursor(r.next_cursor); }
    catch (e) { setError(e); } finally { setMore(false); }
  }

  const days = useMemo(() => {
    const out: { label: string; entries: Entry[] }[] = [];
    for (const g of group(events ?? [])) {
      const label = dayLabel(g.first.at);
      if (out[out.length - 1]?.label === label) out[out.length - 1]!.entries.push(g); else out.push({ label, entries: [g] });
    }
    return out;
  }, [events]);
  const people = useMemo(() => (members.data ?? []).filter((m) => m.user_id).map((m) => ({ id: m.user_id!, name: m.name || m.email })), [members.data]);

  if (project.loading) return <><ProjectNavSkeleton /><div className="container"><Loading label="Loading activity…" /></div></>;
  if (project.error != null) return <><ProjectNav projectId={projectId} /><div className="container"><ErrorState error={project.error} onRetry={project.reload} /></div></>;

  return (
    <>
      <ProjectNav projectId={projectId} project={project.data} />
      <div className="container activity">
        <div className="page-head">
          <div className="grow">
            <h2>Activity</h2>
            <p className="muted">Who added, reviewed, published or changed what in this project, newest first.</p>
          </div>
        </div>
        {!manage ? (
          <EmptyState icon="users" title="Only owners and administrators can see the project's history">Ask an owner if you need to know who changed something.</EmptyState>
        ) : (
          <>
            <div className="toolbar-bar">
              <div className="status-filter" role="group" aria-label="Show">
                {KINDS.map((k) => <button key={k.id} type="button" className="filter-chip" aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>{k.label}</button>)}
              </div>
              {people.length > 1 && (
                <div className="field activity-person">
                  <label htmlFor="act-who">Person</label>
                  <select id="act-who" value={actor} onChange={(e) => setActor(e.target.value)}>
                    <option value="">Anyone</option>
                    {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
              )}
            </div>
            {error != null ? <ErrorState error={error} onRetry={() => setTick((t) => t + 1)} />
              : events === null ? <Loading label="Loading activity…" />
              : events.length === 0 ? <EmptyState icon="inbox" title={kind === "all" && !actor ? "Nothing has happened here yet" : "Nothing matches"}>{kind === "all" && !actor ? "Records, reviews and changes to forms and people will show here." : "Try “Everything” or “Anyone”."}</EmptyState>
              : (
                <>
                  {days.map((d) => (
                    <section key={d.label} className="activity-day" aria-labelledby={`day-${d.label}`}>
                      <h3 id={`day-${d.label}`}>{d.label}</h3>
                      <ol className="activity-list">
                        {d.entries.map((g) => {
                          const { icon, text } = describe(g.first, g.events.length, projectId);
                          const last = g.events[g.events.length - 1]!;
                          const isOpen = open.has(g.first.id);
                          const span = g.events.length > 1 && time(last.at) !== time(g.first.at) ? `${time(last.at)}–${time(g.first.at)}` : time(g.first.at);
                          return (
                            <li key={g.first.id} className={`activity-item kind-${g.first.action.split(".")[0]}`}>
                              <span className="activity-icon" aria-hidden="true"><Icon name={icon} size={16} /></span>
                              <div className="activity-body">
                                <p><strong>{who(g.first)}</strong> {text}</p>
                                {typeof g.first.details.note === "string" && g.first.details.note && <p className="activity-note">“{g.first.details.note}”</p>}
                                {g.events.length > 1 && (
                                  <button type="button" className="link-btn" aria-expanded={isOpen} onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(g.first.id)) n.delete(g.first.id); else n.add(g.first.id); return n; })}>
                                    {isOpen ? "Hide the times" : `Show each of the ${g.events.length}`}
                                  </button>
                                )}
                                {isOpen && <ul className="activity-each">{g.events.map((e) => <li key={e.id}><time dateTime={e.at}>{time(e.at)}</time> <span className="mono">{e.target_id?.slice(0, 8)}</span></li>)}</ul>}
                              </div>
                              <time className="activity-time" dateTime={g.first.at} title={new Date(g.first.at).toLocaleString()}>{span}</time>
                            </li>
                          );
                        })}
                      </ol>
                    </section>
                  ))}
                  {cursor && <div className="activity-more"><Button onClick={() => void loadMore()} disabled={more}>{more ? "Loading…" : "Show older activity"}</Button></div>}
                </>
              )}
          </>
        )}
      </div>
    </>
  );
}
