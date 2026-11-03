import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import CustomerForm, { draftFrom, renewalDraft, type Draft } from "../components/admin/CustomerForm";
import ProductsCard, { PRODUCT_NAMES } from "../components/admin/ProductsCard";
import { Icon } from "../components/icons";
import { Button, ErrorState, Loading, useConfirm, useToast } from "../components/ui";
import { ApiError, loadApi } from "../lib/api";
import { useAuth } from "../lib/auth";
import { KINDS, LICENCE, ago, can, licenceAction, longDate, renewal } from "../lib/staffConsole";
import type { AdminOrgDetail, AdminPerson, OrgRole, StaffMe } from "../lib/types";
import { ActivityList } from "./AdminPage";

const ROLE: Record<OrgRole, string> = { owner: "Owner", admin: "Administrator", member: "Member", collector: "Field collector", viewer: "Viewer" };

/** One customer, for GeoEstate staff: its licence and history, its people, notes, domains and what happened. */
export default function AdminCustomerPage() {
  const { orgId = "" } = useParams();
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const [me, setMe] = useState<StaffMe | null>(null);
  const [o, setO] = useState<AdminOrgDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [form, setForm] = useState<{ draft: Draft; title: string } | null>(null);
  const [suspending, setSuspending] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [domain, setDomain] = useState("");
  const [visitReason, setVisitReason] = useState("");
  const [visitHours, setVisitHours] = useState(2);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const api = await loadApi();
      const [m, d] = await Promise.all([api.adminMe(), api.adminGetOrg(orgId)]);
      setMe(m); setO(d);
    } catch (e) { setError(e); }
  }
  useEffect(() => { void load(); }, [orgId]);

  if (error instanceof ApiError && error.code === "staff_mfa_required") return (
    <div className="container"><section className="card admin-gate" role="alert"><h2>Turn on two-step sign-in first</h2>
      <p>Staff must use two-step sign-in to open customers.</p><Link className="btn btn-primary" to="/settings/security">Set up two-step sign-in</Link></section></div>
  );
  if (error != null) return <div className="container"><ErrorState error={error} onRetry={() => void load()} /></div>;
  if (!o || !me) return <div className="container"><Loading label="Loading customer…" /></div>;
  const editLicence = can(me.perms, "licences.edit"), support = can(me.perms, "customers.support");
  const st = LICENCE[o.status ?? "active"];
  const r = renewal(o.days_left);

  async function act(key: string, f: () => Promise<unknown>, done: string, reload = true) {
    setBusy(key);
    try { await f(); toast(done, "success"); if (reload) await load(); }
    catch (e) { toast(e instanceof Error ? e.message : "That did not work.", "error"); } finally { setBusy(null); }
  }
  async function suspend(e: FormEvent) {
    e.preventDefault();
    await act("suspend", async () => (await loadApi()).adminSuspend(o!.id, reason.trim()), `${o!.name} is suspended.`);
    setSuspending(false); setReason("");
  }
  async function makeOwner(p: AdminPerson) {
    if (!(await confirm({ title: `Make ${p.name} the owner?`, confirmLabel: "Make owner",
      message: `${p.name} takes over ${o!.name}. Its current owners become administrators.` }))) return;
    setBusy(p.user_id);
    try { setO(await (await loadApi()).adminMakeOwner(o!.id, p.user_id)); toast(`${p.name} is now the owner.`, "success"); }
    catch (e) { toast(e instanceof Error ? e.message : "Could not change the owner.", "error"); } finally { setBusy(null); }
  }
  async function resetMfa(p: AdminPerson) {
    if (!(await confirm({ title: `Turn off two-step sign-in for ${p.name}?`, confirmLabel: "Turn it off",
      message: "Only when they asked, for example after losing their phone. They are emailed, and sign in with their password alone next time." }))) return;
    await act(p.user_id, async () => (await loadApi()).adminResetMfa(o!.id, p.user_id), `Two-step sign-in is off for ${p.name}.`);
  }
  async function addNote(e: FormEvent) {
    e.preventDefault();
    await act("note", async () => (await loadApi()).adminAddNote(o!.id, note.trim()), "Note added.");
    setNote("");
  }
  async function startVisit(e: FormEvent) {
    e.preventDefault();
    await act("visit", async () => (await loadApi()).adminStartVisit(o!.id, visitReason.trim(), visitHours),
      `You can open ${o!.name}'s projects for ${visitHours} hour${visitHours > 1 ? "s" : ""}. Its owners and admins were told.`);
    setVisitReason("");
  }
  async function addDomain(e: FormEvent) {
    e.preventDefault();
    await act("domain", async () => (await loadApi()).adminAddDomain(o!.id, domain.trim()), `${domain.trim()} is verified for ${o!.name}.`);
    setDomain("");
  }

  return (
    <div className="container admin customer">
      <Link className="page-back" to="/admin"><Icon name="arrowLeft" size={16} />All customers</Link>
      <header className="customer-head">
        <h1>{o.name}</h1>
        <span className={`badge ${st.badge}`}>{st.label}</span>
        <span className="badge badge-quiet">{o.plan_name}</span>
      </header>
      <p className="muted">Customer since {longDate(o.created_at)} · Last active {ago(o.last_active).toLowerCase()}</p>

      {form ? (
        <CustomerForm orgId={o.id} initial={form.draft} title={form.title} onCancel={() => setForm(null)}
          onSaved={async (x) => { setForm(null); toast(`${x.name}'s licence is saved.`, "success"); await load(); }} />
      ) : (
        <div className="customer-grid">
          <section className="card" aria-labelledby="c-licence">
            <h2 id="c-licence">Licence</h2>
            <p className="field-hint">{st.help}</p>
            {o.status === "suspended" && o.suspended_reason && <p className="customer-alert" role="status"><strong>Suspended:</strong> {o.suspended_reason}</p>}
            <dl className="kv">
              <dt>Plan</dt><dd>{o.plan_name}{o.licence_kind === "demo" && " (demo)"}</dd>
              <dt>Runs</dt><dd>{o.subscription_starts ? longDate(o.subscription_starts) : "No start date"} to {o.subscription_ends ? longDate(o.subscription_ends) : "no end date"} <span className={`badge badge-${r.tone}`}>{r.text}</span></dd>
              {o.status === "grace" && o.grace_ends && <><dt>Read-only from</dt><dd>{longDate(o.grace_ends)}</dd></>}
              {KINDS.map((k) => <div key={k.key} className="kv-row"><dt>{k.label}</dt><dd className="tnum">{o.usage[k.key]}{o.caps[k.key] != null ? ` of ${o.caps[k.key]}` : " · unlimited"}</dd></div>)}
              <dt>Teams</dt><dd className="tnum">{o.teams}{o.caps.teams != null ? ` of ${o.caps.teams}` : ""}</dd>
              <dt>Projects</dt><dd className="tnum">{o.usage.projects} · {o.usage.records.toLocaleString()} records</dd>
              <dt>API keys</dt><dd className="tnum">{o.api_keys}</dd>
            </dl>
            {editLicence && (
              <div className="row-actions">
                <Button variant="primary" onClick={() => setForm({ draft: renewalDraft(o), title: `Renew ${o.name}` })}>Renew for a year</Button>
                <Button onClick={() => setForm({ draft: draftFrom(o), title: `Change ${o.name}'s licence` })}>Change licence</Button>
                {o.status === "suspended"
                  ? <Button busy={busy === "reactivate"} onClick={() => void act("reactivate", async () => (await loadApi()).adminReactivate(o.id), `${o.name} is active again.`)}>Lift suspension</Button>
                  : <Button variant="ghost" onClick={() => setSuspending((v) => !v)}>Suspend</Button>}
              </div>
            )}
            {suspending && (
              <form className="customer-suspend" onSubmit={suspend}>
                <div className="field"><label htmlFor="c-reason">Why? <span className="muted">(kept in the history)</span></label>
                  <input id="c-reason" required maxLength={500} placeholder="e.g. Invoice GE-2026-0004 unpaid" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
                <Button type="submit" variant="danger" busy={busy === "suspend"}>Suspend {o.name}</Button>
              </form>
            )}
          </section>

          <ProductsCard o={o} edit={editLicence} onChange={() => void load()} />

          <section className="card" aria-labelledby="c-notes">
            <h2 id="c-notes">Staff notes</h2>
            {support && (
              <form className="customer-note" onSubmit={addNote}>
                <div className="field"><label htmlFor="c-note" className="sr-only">New note</label>
                  <textarea id="c-note" rows={2} required maxLength={4000} placeholder="Calls, promises, anything the next person should know" value={note} onChange={(e) => setNote(e.target.value)} /></div>
                <Button type="submit" small busy={busy === "note"}>Add note</Button>
              </form>
            )}
            {o.notes.length === 0 ? <p className="muted">No notes yet.</p> : (
              <ul className="customer-notes">
                {o.notes.map((n) => (
                  <li key={n.id}>
                    <p>{n.body}</p>
                    <span className="muted">{n.author_name ?? "Former staff"} · {new Date(n.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
                    {(n.author_id === user?.id || me.role === "super_admin") && support && (
                      <Button small variant="ghost" busy={busy === n.id} onClick={() => void act(n.id, async () => (await loadApi()).adminDeleteNote(n.id), "Note deleted.")} aria-label="Delete this note">Delete</Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      <section className="card customer-support" aria-labelledby="c-support">
        <h2 id="c-support">Support visit</h2>
        {(() => {
          const open = (o.support_visits ?? []).find((v) => v.active && v.staff_id === user?.id);
          if (open) return (
            <>
              <p className="customer-visit-on" role="status"><strong>Open until {new Date(open.ends_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.</strong> You see
                {" "}{o.name}'s projects as a viewer and change nothing. Reason: {open.reason}</p>
              {(o.projects ?? []).length === 0 ? <p className="muted">They have no projects yet.</p> : (
                <ul className="customer-projects">
                  {o.projects!.map((p) => <li key={p.id}><Link to={`/collect/${p.id}/data`}>{p.name}</Link> <span className="muted">· {p.records.toLocaleString()} records</span></li>)}
                </ul>
              )}
              <Button busy={busy === open.id} onClick={() => void act(open.id, async () => (await loadApi()).adminEndVisit(open.id), "Support visit ended.")}>End the visit</Button>
            </>
          );
          return support ? (
            <form className="customer-visit" onSubmit={startVisit}>
              <p className="field-hint">To help a customer, open their projects read-only for a few hours. Their owners and administrators are emailed, and see every visit with its reason.</p>
              <div className="field"><label htmlFor="c-visit">Reason <span className="muted">(the customer reads this)</span></label>
                <input id="c-visit" required minLength={3} maxLength={500} placeholder="e.g. Ada asked why the Ikeja map is empty" value={visitReason} onChange={(e) => setVisitReason(e.target.value)} /></div>
              <div className="field"><label htmlFor="c-hours">For</label>
                <select id="c-hours" className="input" value={visitHours} onChange={(e) => setVisitHours(Number(e.target.value))}>
                  {[1, 2, 4, 8].map((h) => <option key={h} value={h}>{h} hour{h > 1 ? "s" : ""}</option>)}
                </select></div>
              <Button type="submit" busy={busy === "visit"}>Open their projects</Button>
            </form>
          ) : <p className="muted">Your role cannot open customers' projects.</p>;
        })()}
        {(o.support_visits ?? []).length > 0 && (
          <ul className="customer-visits" aria-label="Support visits">
            {o.support_visits!.slice(0, 5).map((v) => (
              <li key={v.id}><span className="tnum">{new Date(v.started_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
                {" "}<strong>{v.staff_name ?? "Former staff"}</strong>: {v.reason} {v.active && <span className="badge badge-info">Open</span>}</li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="c-people">
        <h2 id="c-people" className="org-h2">People <span className="muted">{o.people.length}{o.invited ? ` · ${o.invited} invited` : ""}</span></h2>
        <div className="table-wrap">
          <table className="data-table customer-people">
            <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Two-step</th><th scope="col">Last active</th>{support && <th scope="col"><span className="sr-only">Support</span></th>}</tr></thead>
            <tbody>
              {o.people.map((p) => (
                <tr key={p.user_id}>
                  <td><strong>{p.name}</strong><br /><span className="muted">{p.email}</span></td>
                  <td>{ROLE[p.role]}</td>
                  <td>{p.mfa_enabled ? <span className="badge badge-ok">On</span> : <span className="muted">Off</span>}</td>
                  <td className="muted">{ago(p.last_active)}</td>
                  {support && (
                    <td className="org-actions">
                      <Button small variant="ghost" disabled={busy === p.user_id} onClick={() => void act(p.user_id, async () => (await loadApi()).adminSendLink(o.id, p.user_id), `A set-password link was emailed to ${p.email}.`, false)}
                        aria-label={`Send ${p.name} a set-password link`}>Send link</Button>
                      {p.mfa_enabled && <Button small variant="ghost" disabled={busy === p.user_id} onClick={() => void resetMfa(p)} aria-label={`Turn off two-step sign-in for ${p.name}`}>Reset 2-step</Button>}
                      {editLicence && p.role !== "owner" && <Button small variant="ghost" disabled={busy === p.user_id} onClick={() => void makeOwner(p)} aria-label={`Make ${p.name} the owner`}>Make owner</Button>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="customer-grid">
        <section className="card" aria-labelledby="c-history">
          <h2 id="c-history">Licence history</h2>
          <div className="table-wrap">
            <table className="data-table customer-history">
              <thead><tr><th scope="col">When</th><th scope="col">What</th><th scope="col">Licence</th><th scope="col">Invoice and note</th></tr></thead>
              <tbody>
                {o.licences.map((h) => (
                  <tr key={h.id}>
                    <td className="tnum">{longDate(h.at)}<br /><span className="muted">{h.actor_name ?? (h.note?.includes("GeoEstate CRM") ? "GeoEstate CRM" : "Geohub")}</span></td>
                    <td>{licenceAction(h.action)}{h.product && h.product !== "hub" && <><br /><span className="muted">{PRODUCT_NAMES[h.product]}</span></>}</td>
                    <td>{h.plan[0].toUpperCase() + h.plan.slice(1)}{h.kind === "demo" ? " demo" : ""}<br /><span className="muted tnum">{h.starts ? longDate(h.starts) : "…"} to {h.ends ? longDate(h.ends) : "…"}</span></td>
                    <td>{h.invoice_ref && <><strong>{h.invoice_ref}</strong><br /></>}<span className="muted">{h.note ?? ""}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card" aria-labelledby="c-domains">
          <h2 id="c-domains">Company email domains</h2>
          {(o.domains ?? []).length ? <ul className="customer-domains">{o.domains!.map((x) => <li key={x}>{x}</li>)}</ul>
            : <p className="muted">None. The customer's admins can add one and prove it with a DNS record.</p>}
          {editLicence && (
            <form className="org-rename" onSubmit={addDomain}>
              <div className="field"><label htmlFor="c-domain" className="sr-only">Domain to add as verified</label>
                <input id="c-domain" required placeholder="theircompany.com" autoComplete="off" spellCheck={false} value={domain} onChange={(e) => setDomain(e.target.value)} /></div>
              <Button type="submit" busy={busy === "domain"}>Add as verified</Button>
            </form>
          )}
          {editLicence && <p className="field-hint">Only once you have checked the customer owns it.</p>}
        </section>
      </div>

      <section aria-labelledby="c-activity">
        <h2 id="c-activity" className="org-h2">Recent activity</h2>
        {o.activity.length === 0 ? <p className="muted">Nothing yet.</p> : <ActivityList items={o.activity} />}
      </section>
    </div>
  );
}
