import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import CustomerForm, { blankDraft, type Draft } from "../components/admin/CustomerForm";
import { Icon } from "../components/icons";
import { Button, EmptyState, ErrorState, Loading, PageHeader, useConfirm, useToast } from "../components/ui";
import { ApiError, loadApi } from "../lib/api";
import { useAuth } from "../lib/auth";
import { KINDS, LICENCE, ROLE_HELP, ROLE_NAMES, STATUS_FILTERS, ago, can, describe, longDate, renewal } from "../lib/staffConsole";
import type { AdminOrg, LicenceStatus, OrgRequest, RequestStatus, StaffActivity, StaffMe, StaffMember, StaffRole } from "../lib/types";

export { renewal, yearFrom } from "../lib/staffConsole";

const STATUS: Record<RequestStatus, { label: string; badge: string }> = {
  new: { label: "New", badge: "badge-info" }, contacted: { label: "Contacted", badge: "badge-warn" },
  set_up: { label: "Set up", badge: "badge-ok" }, declined: { label: "Declined", badge: "badge-quiet" },
};
const REQUEST_PLAN: Record<string, string> = { standard: "Standard", advanced: "Advanced", custom: "Custom", unsure: "Not sure", demo: "One-month demo" };
type Tab = "customers" | "requests" | "staff" | "activity";
const TABS: Tab[] = ["customers", "requests", "staff", "activity"];

/** The GeoEstate staff console: customers and their licences, requests from the website, staff, and what staff did. */
export default function AdminPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab") as Tab | null;
  const tab: Tab = raw && TABS.includes(raw) ? raw : "customers";
  const setTab = (t: Tab) => setParams(t === "customers" ? {} : { tab: t }, { replace: true });
  const [me, setMe] = useState<StaffMe | null>(null);
  const [gate, setGate] = useState<unknown>(null);

  useEffect(() => { void loadApi().then((api) => api.adminMe()).then(setMe, setGate); }, []);

  if (gate instanceof ApiError && gate.code === "staff_mfa_required") return (
    <div className="container admin">
      <PageHeader title="Staff console" />
      <section className="card admin-gate" role="alert">
        <h2>Turn on two-step sign-in first</h2>
        <p>The staff console holds every customer's details, so staff must use two-step sign-in. It takes a minute with an authenticator app on your phone.</p>
        <Link className="btn btn-primary" to="/settings/security">Set up two-step sign-in</Link>
      </section>
    </div>
  );
  if (gate != null) return <div className="container"><ErrorState error={gate} /></div>;
  if (!me) return <div className="container"><Loading label="Opening the staff console…" /></div>;

  return (
    <div className="container admin">
      <PageHeader title="Staff console" lede={`GeoEstate staff only. You are ${me.role_name.toLowerCase() === "super admin" ? "a super admin" : `in ${me.role_name}`}.`}>
        <div role="tablist" aria-label="Staff console sections" className="tabs">
          {([["customers", "Customers"], ["requests", "Requests"], ["staff", "Staff"], ["activity", "Activity"]] as [Tab, string][]).map(([t, label]) => (
            <button key={t} type="button" role="tab" id={`tab-${t}`} aria-controls={`panel-${t}`} aria-selected={tab === t} className="tab" onClick={() => setTab(t)}>{label}</button>
          ))}
        </div>
      </PageHeader>
      <section id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} className="admin-panel">
        {tab === "customers" && <Customers me={me} />}
        {tab === "requests" && <Requests me={me} />}
        {tab === "staff" && <Staff me={me} />}
        {tab === "activity" && <Activity />}
      </section>
    </div>
  );
}

// ---------- customers ----------
function Customers({ me }: { me: StaffMe }) {
  const toast = useToast();
  const nav = useNavigate();
  const [orgs, setOrgs] = useState<AdminOrg[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<LicenceStatus | "due" | "">("");
  const [form, setForm] = useState<Draft | null>(null);

  async function load(s = status, query = q) {
    setError(null);
    try { setOrgs(await (await loadApi()).adminListCustomers({ status: s || undefined, q: query.trim() || undefined })); } catch (e) { setError(e); }
  }
  useEffect(() => { void load(); }, []);   // filters reload on change below

  if (error != null) return <ErrorState error={error} onRetry={() => void load()} />;
  return (
    <>
      {form ? (
        <CustomerForm orgId={null} initial={form} title={form.kind === "demo" ? "Start a demo licence" : "Set up a customer"} onCancel={() => setForm(null)}
          onSaved={(o) => { setForm(null); toast(`${o.name} is set up. ${o.owner_name ?? "The owner"} has been emailed.`, "success"); nav(`/admin/customers/${o.id}`); }} />
      ) : can(me.perms, "licences.edit") && (
        <div className="admin-actions">
          <Button variant="primary" onClick={() => setForm(blankDraft("paid"))}><Icon name="plus" size={18} />Set up a customer</Button>
          <Button onClick={() => setForm(blankDraft("demo"))}>Start a demo</Button>
        </div>
      )}
      <div className="admin-toolbar">
        <form className="field admin-search" role="search" onSubmit={(e) => { e.preventDefault(); void load(); }}>
          <label htmlFor="ao-q" className="sr-only">Search customers</label>
          <input id="ao-q" type="search" placeholder="Search by name, owner or domain" value={q}
            onChange={(e) => { setQ(e.target.value); if (!e.target.value) void load(status, ""); }} />
        </form>
        <div className="admin-filters" role="group" aria-label="Licence status">
          {STATUS_FILTERS.map((f) => (
            <button key={f.id} type="button" className={`admin-filter${status === f.id ? " is-on" : ""}`} aria-pressed={status === f.id}
              onClick={() => { setStatus(f.id); void load(f.id); }}>{f.label}</button>
          ))}
        </div>
      </div>
      {!orgs ? <Loading label="Loading customers…" /> : orgs.length === 0 ? (
        <EmptyState title={status || q ? "No customer matches" : "No customers yet"} icon="users">
          {status || q ? "Try another filter or search." : "Set one up once the client has paid, or start a demo. Free Individual accounts are not listed."}
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="data-table admin-orgs">
            <thead><tr><th scope="col">Customer</th><th scope="col">Licence</th><th scope="col">People</th><th scope="col">Renewal</th><th scope="col">Last active</th></tr></thead>
            <tbody>
              {orgs.map((o) => {
                const r = renewal(o.days_left);
                const st = LICENCE[o.status ?? "active"];
                return (
                  <tr key={o.id}>
                    <td><Link className="admin-org-link" to={`/admin/customers/${o.id}`}><strong>{o.name}</strong></Link><br />
                      <span className="muted">{o.owner_name ? `${o.owner_name} · ${o.owner_email}` : "No owner"}</span></td>
                    <td><span className={`badge ${st.badge}`}>{st.label}</span><br /><span className="muted">{o.plan_name}</span></td>
                    <td className="admin-people tnum">
                      {KINDS.map((k) => {
                        const cap = o.caps[k.key], used = o.usage[k.key];
                        return <span key={k.key} className={cap != null && used >= cap ? "is-full" : undefined}>{used}{cap != null ? `/${cap}` : ""} <span className="muted">{k.label.toLowerCase()}</span></span>;
                      })}
                    </td>
                    <td>{o.subscription_ends && <span className="tnum">{longDate(o.subscription_ends)}<br /></span>}<span className={`badge badge-${r.tone}`}>{r.text}</span></td>
                    <td className="muted">{ago(o.last_active)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---------- requests ----------
function Requests({ me }: { me: StaffMe }) {
  const toast = useToast();
  const nav = useNavigate();
  const [requests, setRequests] = useState<OrgRequest[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [setUp, setSetUp] = useState<Draft | null>(null);
  const edit = can(me.perms, "requests.edit");

  async function load() { try { setRequests(await (await loadApi()).adminListRequests()); } catch (e) { setError(e); } }
  useEffect(() => { void load(); }, []);
  async function update(r: OrgRequest, patch: { status?: RequestStatus; note?: string }) {
    setBusy(r.id);
    try {
      const n = await (await loadApi()).adminUpdateRequest(r.id, patch);
      setRequests((all) => all!.map((x) => (x.id === n.id ? n : x)));
      if (patch.note != null) toast("Note saved.", "success");
    } catch (e) { toast(e instanceof Error ? e.message : "Could not update the request.", "error"); } finally { setBusy(null); }
  }
  function startFrom(r: OrgRequest) {
    const d = blankDraft(r.plan === "demo" ? "demo" : "paid");
    setSetUp({ ...d, name: r.organization, owner_name: r.contact_name, owner_email: r.email, request_id: r.id,
      plan: r.plan === "advanced" || r.plan === "demo" ? "advanced" : r.plan === "custom" ? "custom" : "standard" });
  }

  if (error != null) return <ErrorState error={error} onRetry={() => void load()} />;
  if (!requests) return <Loading label="Loading requests…" />;
  if (setUp) return (
    <CustomerForm orgId={null} initial={setUp} title={setUp.kind === "demo" ? "Start a demo licence" : "Set up a customer"} onCancel={() => setSetUp(null)}
      onSaved={(o) => { toast(`${o.name} is set up. ${o.owner_name ?? "The owner"} has been emailed.`, "success"); nav(`/admin/customers/${o.id}`); }} />
  );
  const fresh = requests.filter((r) => r.status === "new").length;
  return requests.length === 0 ? (
    <EmptyState title="No requests yet" icon="inbox">Requests from the "Request an organization" page appear here, and are emailed to super admins and account managers.</EmptyState>
  ) : (
    <>
      {fresh > 0 && <p className="muted" role="status"><strong>{fresh}</strong> new</p>}
      <ul className="admin-requests">
        {requests.map((r) => (
          <li key={r.id} className="card">
            <div className="admin-req-head">
              <h2>{r.organization}</h2>
              {r.plan === "demo" && <span className="badge badge-info">Demo</span>}
              <span className={`badge ${STATUS[r.status].badge}`}>{STATUS[r.status].label}</span>
            </div>
            <p className="muted">{new Date(r.created_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</p>
            <dl className="admin-req-facts">
              <div><dt>Contact</dt><dd>{r.contact_name} · <a href={`mailto:${r.email}`}>{r.email}</a>{r.phone && <> · <a href={`tel:${r.phone.replace(/\s/g, "")}`}>{r.phone}</a></>}</dd></div>
              <div><dt>Asked for</dt><dd>{REQUEST_PLAN[r.plan] ?? r.plan}</dd></div>
              {r.team_size && <div><dt>Team</dt><dd>{r.team_size}</dd></div>}
              {r.message && <div><dt>Message</dt><dd className="admin-req-msg">{r.message}</dd></div>}
            </dl>
            {edit && (
              <>
                <div className="field"><label htmlFor={`note-${r.id}`}>Staff note</label>
                  <textarea id={`note-${r.id}`} rows={2} value={notes[r.id] ?? r.note ?? ""} placeholder="Invoice number, follow-up date…"
                    onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} /></div>
                <div className="admin-req-actions">
                  {(notes[r.id] ?? r.note ?? "") !== (r.note ?? "") && <Button small onClick={() => void update(r, { note: notes[r.id] })} busy={busy === r.id}>Save note</Button>}
                  {r.status !== "set_up" && <Button small variant="primary" onClick={() => startFrom(r)}>{r.plan === "demo" ? "Start this demo" : "Set up this customer"}</Button>}
                  {r.org_id && <Link className="btn btn-sm" to={`/admin/customers/${r.org_id}`}>Open the customer</Link>}
                  <label className="admin-req-status"><span className="sr-only">Status of {r.organization}</span>
                    <select className="input" value={r.status} disabled={busy === r.id} onChange={(e) => void update(r, { status: e.target.value as RequestStatus })}>
                      {(Object.keys(STATUS) as RequestStatus[]).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
                    </select>
                  </label>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------- staff ----------
function Staff({ me }: { me: StaffMe }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const [list, setList] = useState<StaffMember[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<StaffRole>("support");
  const [busy, setBusy] = useState<string | null>(null);
  const manage = can(me.perms, "staff.manage");

  useEffect(() => { void loadApi().then((api) => api.adminListStaff()).then(setList, setError); }, []);
  async function run(key: string, f: () => Promise<StaffMember[]>, done: string) {
    setBusy(key);
    try { setList(await f()); toast(done, "success"); } catch (e) { toast(e instanceof Error ? e.message : "That did not work.", "error"); } finally { setBusy(null); }
  }
  async function add(e: FormEvent) {
    e.preventDefault();
    await run("add", async () => (await loadApi()).adminAddStaff({ email: email.trim(), name: name.trim() || undefined, role }),
      `${email.trim()} was added as ${ROLE_NAMES[role]} and emailed.`);
    setEmail(""); setName("");
  }
  async function remove(m: StaffMember) {
    if (!(await confirm({ title: `Remove ${m.name ?? m.email} from the staff?`, danger: true, confirmLabel: "Remove from staff",
      message: "They keep their Geohub account; only the staff console closes to them." }))) return;
    await run(m.user_id!, async () => (await loadApi()).adminRemoveStaff(m.user_id!), `${m.name ?? m.email} is no longer on the staff.`);
  }

  if (error != null) return <ErrorState error={error} />;
  if (!list) return <Loading label="Loading staff…" />;
  return (
    <>
      {manage && (
        <form className="card admin-staff-add" onSubmit={add} aria-labelledby="staff-add-h">
          <h2 id="staff-add-h">Add a staff member</h2>
          <p className="field-hint">They get an email. Someone new to Geohub chooses a password first. Everyone turns on two-step sign-in before the console opens.</p>
          <div className="admin-staff-row">
            <div className="field"><label htmlFor="st-email">Email</label><input id="st-email" type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div className="field"><label htmlFor="st-name">Name <span className="muted">(if new to Geohub)</span></label><input id="st-name" maxLength={120} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="field"><label htmlFor="st-role">Role</label>
              <select id="st-role" className="input" value={role} onChange={(e) => setRole(e.target.value as StaffRole)}>
                {(Object.keys(ROLE_NAMES) as StaffRole[]).map((r) => <option key={r} value={r}>{ROLE_NAMES[r]}</option>)}
              </select></div>
            <Button type="submit" variant="primary" busy={busy === "add"}>Add</Button>
          </div>
          <p className="field-hint">{ROLE_NAMES[role]}: {ROLE_HELP[role]}.</p>
        </form>
      )}
      <div className="table-wrap">
        <table className="data-table admin-staff">
          <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Two-step</th><th scope="col">Last active</th>{manage && <th scope="col"><span className="sr-only">Actions</span></th>}</tr></thead>
          <tbody>
            {list.map((m) => {
              const self = m.email === user?.email.toLowerCase();
              const editable = manage && !m.from_settings && !self && m.user_id;
              return (
                <tr key={m.email}>
                  <td><strong>{m.name ?? "Not signed up yet"}{self && <span className="muted"> (you)</span>}</strong><br /><span className="muted">{m.email}</span></td>
                  <td>{editable ? (
                    <select className="input" aria-label={`Role of ${m.name ?? m.email}`} value={m.role} disabled={busy === m.user_id}
                      onChange={(e) => { const next = e.target.value as StaffRole;
                        void run(m.user_id!, async () => (await loadApi()).adminSetStaffRole(m.user_id!, next), `${m.name ?? m.email} is now ${ROLE_NAMES[next]}.`); }}>
                      {(Object.keys(ROLE_NAMES) as StaffRole[]).map((r) => <option key={r} value={r}>{ROLE_NAMES[r]}</option>)}
                    </select>
                  ) : <><span className="badge badge-quiet">{ROLE_NAMES[m.role]}</span>{m.from_settings && <><br /><span className="muted">Set on the server</span></>}</>}</td>
                  <td>{m.mfa_enabled ? <span className="badge badge-ok">On</span> : <span className="badge badge-warn">Not yet</span>}</td>
                  <td className="muted">{ago(m.last_active)}</td>
                  {manage && <td className="org-actions">{editable && <Button small variant="ghost" busy={busy === m.user_id} onClick={() => void remove(m)} aria-label={`Remove ${m.name ?? m.email} from the staff`}>Remove</Button>}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------- what staff did ----------
export function ActivityList({ items }: { items: StaffActivity[] }) {
  return (
    <ol className="admin-activity">
      {items.map((a) => (
        <li key={a.id}>
          <span className="admin-activity-when tnum">{new Date(a.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
          <span><strong>{a.actor_name ?? (typeof a.details?.staff === "string" ? `${a.details.staff} (CRM)` : "Someone")}</strong> {describe(a)}
            {a.org_id && a.org_name && <> · <Link to={`/admin/customers/${a.org_id}`}>{a.org_name}</Link></>}</span>
        </li>
      ))}
    </ol>
  );
}

function Activity() {
  const [items, setItems] = useState<StaffActivity[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void loadApi().then((api) => api.adminActivity()).then((a) => { setItems(a); setMore(a.length >= 100); }, setError); }, []);
  async function loadMore() {
    setBusy(true);
    try { const next = await (await loadApi()).adminActivity({ before: items![items!.length - 1].id }); setItems((x) => [...x!, ...next]); setMore(next.length >= 100); }
    finally { setBusy(false); }
  }
  if (error != null) return <ErrorState error={error} />;
  if (!items) return <Loading label="Loading activity…" />;
  if (!items.length) return <EmptyState title="Nothing yet" icon="inbox">Everything staff do here is listed: set-ups, licence changes, support actions, staff changes.</EmptyState>;
  return (
    <>
      <ActivityList items={items} />
      {more && <Button onClick={() => void loadMore()} busy={busy}>Show older</Button>}
    </>
  );
}
