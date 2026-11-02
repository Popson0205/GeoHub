import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Icon } from "../components/icons";
import { Button, EmptyState, ErrorState, Loading, PageHeader, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import type { AdminOrg, AdminOrgInput, OrgLimits, OrgRequest, PeopleKind, PlanId, RequestStatus } from "../lib/types";

const PLANS: { id: PlanId; name: string; price: string; people: string }[] = [
  { id: "standard", name: "Organization Standard", price: "$500 a year", people: "10 team seats · 50 field collectors · 50 viewers" },
  { id: "advanced", name: "Organization Advanced", price: "$1,000 a year", people: "30 team seats · 300 field collectors · unlimited viewers" },
  { id: "custom", name: "Custom", price: "Quoted", people: "No caps unless you set them below" },
];
const PLAN_CAPS: Record<string, Record<PeopleKind, number | null>> = {
  individual: { seats: 1, collectors: 5, viewers: 5 }, standard: { seats: 10, collectors: 50, viewers: 50 },
  advanced: { seats: 30, collectors: 300, viewers: null }, custom: { seats: null, collectors: null, viewers: null },
};
const KINDS: { key: PeopleKind; label: string }[] = [
  { key: "seats", label: "Team seats" }, { key: "collectors", label: "Field collectors" }, { key: "viewers", label: "Viewers" },
];
const STATUS: Record<RequestStatus, { label: string; badge: string }> = {
  new: { label: "New", badge: "badge-info" }, contacted: { label: "Contacted", badge: "badge-warn" },
  set_up: { label: "Set up", badge: "badge-ok" }, declined: { label: "Declined", badge: "badge-quiet" },
};
const REQUEST_PLAN: Record<string, string> = { standard: "Standard", advanced: "Advanced", custom: "Custom", unsure: "Not sure" };
const longDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** A year's subscription ends the day before the same date next year. */
export function yearFrom(start: string): string {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 1); d.setUTCDate(d.getUTCDate() - 1);
  return iso(d);
}
/** How the renewal date reads in the list, and how urgent it is. */
export function renewal(days: number | null): { text: string; tone: "ok" | "warn" | "bad" | "quiet" } {
  if (days == null) return { text: "No end date", tone: "quiet" };
  if (days < 0) return { text: `Ended ${-days} day${days === -1 ? "" : "s"} ago`, tone: "bad" };
  if (days === 0) return { text: "Ends today", tone: "bad" };
  if (days <= 60) return { text: `${days} day${days === 1 ? "" : "s"} left`, tone: "warn" };
  return { text: `${days} days left`, tone: "ok" };
}

interface Draft { name: string; plan: PlanId; owner_name: string; owner_email: string; starts: string; ends: string;
  limits: Record<PeopleKind, string>; request_id?: string }
const blank = (): Draft => {
  const starts = iso(new Date());
  return { name: "", plan: "standard", owner_name: "", owner_email: "", starts, ends: yearFrom(starts), limits: { seats: "", collectors: "", viewers: "" } };
};
const fromOrg = (o: AdminOrg): Draft => ({ name: o.name, plan: (o.plan as PlanId), owner_name: o.owner_name ?? "", owner_email: o.owner_email ?? "",
  starts: o.subscription_starts ?? "", ends: o.subscription_ends ?? "",
  limits: { seats: o.limits.seats?.toString() ?? "", collectors: o.limits.collectors?.toString() ?? "", viewers: o.limits.viewers?.toString() ?? "" } });
const limitsOf = (d: Draft): OrgLimits => Object.fromEntries(KINDS.filter((k) => d.limits[k.key].trim() !== "").map((k) => [k.key, Number(d.limits[k.key])]));

/** For GeoEstate staff: set up client organizations, keep their plans and renewal dates, and answer requests. */
export default function AdminPage() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "requests" ? "requests" : "orgs";
  const setTab = (t: "orgs" | "requests") => setParams(t === "orgs" ? {} : { tab: t }, { replace: true });
  const [orgs, setOrgs] = useState<AdminOrg[] | null>(null);
  const [requests, setRequests] = useState<OrgRequest[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  async function load() {
    setError(null);
    try {
      const api = await loadApi();
      const [o, r] = await Promise.all([api.adminListOrgs(), api.adminListRequests()]);
      setOrgs(o); setRequests(r);
    } catch (e) { setError(e); }
  }
  useEffect(() => { void load(); }, []);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (orgs ?? []).filter((o) => !t || `${o.name} ${o.owner_name ?? ""} ${o.owner_email ?? ""}`.toLowerCase().includes(t));
  }, [orgs, q]);

  if (error != null) return <div className="container"><ErrorState error={error} onRetry={() => void load()} /></div>;
  if (!orgs || !requests) return <div className="container"><Loading label="Loading organizations…" /></div>;
  const fresh = requests.filter((r) => r.status === "new").length;
  const dueSoon = orgs.filter((o) => o.days_left != null && o.days_left <= 60).length;
  const fail = (e: unknown, what: string) => (e instanceof Error ? e.message : what);

  function open(id: string | null, draft: Draft) { setEditing({ id, draft }); setFormError(""); setTab("orgs"); }
  function set<K extends keyof Draft>(k: K, v: Draft[K]) {
    setEditing((e) => {
      if (!e) return e;
      const d = { ...e.draft, [k]: v };
      // moving the start of a year's subscription moves its end with it
      if (k === "starts" && typeof v === "string" && v && (!e.draft.ends || e.draft.ends === yearFrom(e.draft.starts || v))) d.ends = yearFrom(v);
      return { ...e, draft: d };
    });
  }

  async function save(ev: FormEvent) {
    ev.preventDefault();
    if (!editing) return;
    const d = editing.draft;
    if (d.starts && d.ends && d.ends < d.starts) { setFormError("The subscription cannot end before it starts."); return; }
    setBusy("save"); setFormError("");
    try {
      const api = await loadApi();
      if (editing.id) {
        const o = await api.adminUpdateOrg(editing.id, { name: d.name.trim(), plan: d.plan, limits: limitsOf(d),
          ...(d.starts || d.ends ? { subscription_starts: d.starts || null, subscription_ends: d.ends || null } : { clear_dates: true }) });
        setOrgs((all) => all!.map((x) => (x.id === o.id ? o : x)));
        toast(`${o.name} saved.`, "success");
      } else {
        const input: AdminOrgInput = { name: d.name.trim(), plan: d.plan, owner_name: d.owner_name.trim(), owner_email: d.owner_email.trim(),
          subscription_starts: d.starts || null, subscription_ends: d.ends || null, limits: limitsOf(d), request_id: d.request_id };
        const o = await api.adminCreateOrg(input);
        setOrgs((all) => [o, ...all!]);
        if (d.request_id) setRequests(await api.adminListRequests());
        toast(`${o.name} is set up. ${o.owner_name ?? "The owner"} has been emailed.`, "success");
      }
      setEditing(null);
    } catch (e) { setFormError(fail(e, "Could not save.")); } finally { setBusy(null); }
  }

  async function updateRequest(r: OrgRequest, patch: { status?: RequestStatus; note?: string }) {
    setBusy(r.id);
    try {
      const n = await (await loadApi()).adminUpdateRequest(r.id, patch);
      setRequests((all) => all!.map((x) => (x.id === n.id ? n : x)));
      if (patch.note != null) toast("Note saved.", "success");
    } catch (e) { toast(fail(e, "Could not update the request."), "error"); } finally { setBusy(null); }
  }

  function setUpFrom(r: OrgRequest) {
    const plan: PlanId = r.plan === "advanced" ? "advanced" : r.plan === "custom" ? "custom" : "standard";
    open(null, { ...blank(), name: r.organization, plan, owner_name: r.contact_name, owner_email: r.email, request_id: r.id });
  }

  const d = editing?.draft;
  return (
    <div className="container admin">
      <PageHeader title="Platform admin" lede="GeoEstate staff only. Set up client organizations, keep their plans and renewal dates, and answer requests."
        actions={<Button variant="primary" onClick={() => open(null, blank())}><Icon name="plus" size={18} />Set up an organization</Button>}>
        <div role="tablist" aria-label="Platform admin sections" className="tabs">
          <button type="button" role="tab" id="tab-orgs" aria-controls="panel-orgs" aria-selected={tab === "orgs"} className="tab" onClick={() => setTab("orgs")}>
            Organizations <span className="muted">{orgs.length}</span>
          </button>
          <button type="button" role="tab" id="tab-requests" aria-controls="panel-requests" aria-selected={tab === "requests"} className="tab" onClick={() => setTab("requests")}>
            Requests {fresh > 0 ? <span className="badge badge-info">{fresh} new</span> : <span className="muted">{requests.length}</span>}
          </button>
        </div>
      </PageHeader>

      {tab === "orgs" && (
        <section id="panel-orgs" role="tabpanel" aria-labelledby="tab-orgs" className="admin-panel">
          {editing && d && (
            <form className="card admin-form" onSubmit={save} aria-labelledby="admin-form-h">
              <h2 id="admin-form-h">{editing.id ? `Edit ${d.name || "organization"}` : "Set up an organization"}</h2>
              {!editing.id && <p className="field-hint">The owner gets an email to choose their password, then adds their own team. Invoice first; set this up once paid.</p>}
              <div className="field"><label htmlFor="ao-name">Organization name</label>
                <input id="ao-name" required maxLength={120} value={d.name} onChange={(e) => set("name", e.target.value)} /></div>
              <fieldset className="admin-plans">
                <legend>Plan</legend>
                {PLANS.map((p) => (
                  <label key={p.id} className={`org-role-opt${d.plan === p.id ? " is-on" : ""}`}>
                    <input type="radio" name="ao-plan" value={p.id} checked={d.plan === p.id} onChange={() => set("plan", p.id)} />
                    <span><strong>{p.name}</strong> <span className="muted">· {p.price}</span><br /><span className="muted">{p.people}</span></span>
                  </label>
                ))}
              </fieldset>
              {!editing.id && (
                <div className="org-add-row">
                  <div className="field"><label htmlFor="ao-owner">Owner's name</label>
                    <input id="ao-owner" required autoComplete="off" value={d.owner_name} onChange={(e) => set("owner_name", e.target.value)} /></div>
                  <div className="field"><label htmlFor="ao-email">Owner's email</label>
                    <input id="ao-email" type="email" required autoComplete="off" value={d.owner_email} onChange={(e) => set("owner_email", e.target.value)} /></div>
                </div>
              )}
              <div className="org-add-row">
                <div className="field"><label htmlFor="ao-start">Subscription starts</label>
                  <input id="ao-start" type="date" value={d.starts} onChange={(e) => set("starts", e.target.value)} /></div>
                <div className="field"><label htmlFor="ao-end">Ends</label>
                  <input id="ao-end" type="date" value={d.ends} min={d.starts || undefined} onChange={(e) => set("ends", e.target.value)} aria-describedby="ao-end-hint" />
                  <span id="ao-end-hint" className="field-hint">Reminders go to the owner and admins 60, 30 and 7 days before, and on the day.</span></div>
              </div>
              <fieldset className="admin-caps">
                <legend>People caps <span className="muted">(leave empty for the plan's numbers)</span></legend>
                {KINDS.map((k) => {
                  const planCap = PLAN_CAPS[d.plan]?.[k.key] ?? null;
                  return (
                    <div className="field" key={k.key}><label htmlFor={`ao-${k.key}`}>{k.label}</label>
                      <input id={`ao-${k.key}`} type="number" min={0} inputMode="numeric" placeholder={planCap == null ? "Unlimited" : String(planCap)}
                        value={d.limits[k.key]} onChange={(e) => set("limits", { ...d.limits, [k.key]: e.target.value })} /></div>
                  );
                })}
              </fieldset>
              {formError && <div className="field-error" role="alert">{formError}</div>}
              <div className="admin-form-actions">
                <Button type="submit" variant="primary" busy={busy === "save"}>{editing.id ? "Save changes" : "Set up and email the owner"}</Button>
                <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              </div>
            </form>
          )}

          <div className="admin-toolbar">
            <div className="field admin-search"><label htmlFor="ao-q" className="sr-only">Search organizations</label>
              <input id="ao-q" type="search" placeholder="Search by name or owner" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            {dueSoon > 0 && <p className="muted" role="status"><strong>{dueSoon}</strong> to renew within 60 days</p>}
          </div>

          {shown.length === 0 ? (
            <EmptyState title={orgs.length ? "No organization matches" : "No client organizations yet"} icon="users">
              {orgs.length ? "Try another name or email." : "Set one up once the client has paid. Free Individual accounts are not listed."}
            </EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="data-table admin-orgs">
                <thead><tr><th scope="col">Organization</th><th scope="col">Plan</th><th scope="col">People</th><th scope="col">Renewal</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {shown.map((o) => {
                    const r = renewal(o.days_left);
                    return (
                      <tr key={o.id}>
                        <td><strong>{o.name}</strong><br /><span className="muted">{o.owner_name ? `${o.owner_name} · ${o.owner_email}` : "No owner"}</span></td>
                        <td><span className="badge badge-quiet">{o.plan_name}</span></td>
                        <td className="admin-people tnum">
                          {KINDS.map((k) => {
                            const cap = o.caps[k.key], used = o.usage[k.key];
                            return <span key={k.key} className={cap != null && used >= cap ? "is-full" : undefined}>{used}{cap != null ? `/${cap}` : ""} <span className="muted">{k.label.toLowerCase()}</span></span>;
                          })}
                        </td>
                        <td>
                          {o.subscription_ends && <span className="tnum">{longDate(o.subscription_ends)}<br /></span>}
                          <span className={`badge badge-${r.tone}`}>{r.text}</span>
                        </td>
                        <td className="org-actions"><Button small variant="ghost" onClick={() => open(o.id, fromOrg(o))} aria-label={`Edit ${o.name}`}>Edit</Button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {tab === "requests" && (
        <section id="panel-requests" role="tabpanel" aria-labelledby="tab-requests" className="admin-panel">
          {requests.length === 0 ? (
            <EmptyState title="No requests yet" icon="inbox">Requests from the "Request an organization" page appear here, and are emailed to every platform admin.</EmptyState>
          ) : (
            <ul className="admin-requests">
              {requests.map((r) => (
                <li key={r.id} className="card">
                  <div className="admin-req-head">
                    <h2>{r.organization}</h2>
                    <span className={`badge ${STATUS[r.status].badge}`}>{STATUS[r.status].label}</span>
                  </div>
                  <p className="muted">{new Date(r.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</p>
                  <dl className="admin-req-facts">
                    <div><dt>Contact</dt><dd>{r.contact_name} · <a href={`mailto:${r.email}`}>{r.email}</a>{r.phone && <> · <a href={`tel:${r.phone.replace(/\s/g, "")}`}>{r.phone}</a></>}</dd></div>
                    <div><dt>Plan</dt><dd>{REQUEST_PLAN[r.plan]}</dd></div>
                    {r.team_size && <div><dt>Team</dt><dd>{r.team_size}</dd></div>}
                    {r.message && <div><dt>Message</dt><dd className="admin-req-msg">{r.message}</dd></div>}
                  </dl>
                  <div className="field"><label htmlFor={`note-${r.id}`}>Staff note</label>
                    <textarea id={`note-${r.id}`} rows={2} value={notes[r.id] ?? r.note ?? ""} placeholder="Invoice number, follow-up date…"
                      onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} /></div>
                  <div className="admin-req-actions">
                    {(notes[r.id] ?? r.note ?? "") !== (r.note ?? "") && <Button small onClick={() => void updateRequest(r, { note: notes[r.id] })} busy={busy === r.id}>Save note</Button>}
                    {r.status !== "set_up" && <Button small variant="primary" onClick={() => setUpFrom(r)}>Set up this organization</Button>}
                    <label className="admin-req-status"><span className="sr-only">Status of {r.organization}</span>
                      <select className="input" value={r.status} disabled={busy === r.id} onChange={(e) => void updateRequest(r, { status: e.target.value as RequestStatus })}>
                        {(Object.keys(STATUS) as RequestStatus[]).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
                      </select>
                    </label>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
