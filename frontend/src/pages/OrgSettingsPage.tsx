import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Icon } from "../components/icons";
import OrgDomains from "../components/OrgDomains";
import OrgBranding from "../components/OrgBranding";
import OrgTeams from "../components/OrgTeams";
import ImportPeople from "../components/ImportPeople";
import { Button, ErrorState, Loading, PageHeader, useConfirm, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { AccountResult, AddableRole, EmailCheck, Org, OrgMember, OrgRole, PeopleKind, Project } from "../lib/types";

export const ROLE: Record<OrgRole, { label: string; help: string }> = {
  owner: { label: "Owner", help: "Everything, including roles. Owner of every project." },
  admin: { label: "Administrator", help: "Adds people and runs every project and map." },
  member: { label: "Member", help: "Builds forms and maps, reviews and publishes in their projects." },
  collector: { label: "Field collector", help: "Collects in assigned projects from the phone. Sees only their own records." },
  viewer: { label: "Viewer", help: "Opens the dashboards and maps shared with them. Changes nothing." },
};
const KIND: Record<OrgRole, PeopleKind> = { owner: "seats", admin: "seats", member: "seats", collector: "collectors", viewer: "viewers" };
const PEOPLE: { key: PeopleKind; label: string; hint: string }[] = [
  { key: "seats", label: "Team seats", hint: "Owners, administrators, members" },
  { key: "collectors", label: "Field collectors", hint: "Collect only" },
  { key: "viewers", label: "Viewers", hint: "Read only" },
];
const fmt = (n: number) => n.toLocaleString();
const day = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
const YOU_ARE: Record<OrgRole, string> = { owner: "You are an owner.", admin: "You are an administrator.", member: "You are a member.", collector: "You are a field collector.", viewer: "You are a viewer." };

/** The organization: its people by kind, how they sign in, and what its plan includes. */
export default function OrgSettingsPage() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const nav = useNavigate();
  const [org, setOrg] = useState<Org | null>(null);
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [mailCheck, setMailCheck] = useState<EmailCheck | null>(null);
  // the Add person form
  const [pName, setPName] = useState("");
  const [pEmail, setPEmail] = useState("");
  const [pRole, setPRole] = useState<AddableRole>("collector");
  const [delivery, setDelivery] = useState<"email" | "temporary">("email");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [made, setMade] = useState<AccountResult | null>(null);

  async function load() {
    setError(null);
    try {
      const api = await loadApi();
      const [o, m] = await Promise.all([api.getOrg(), api.listOrgMembers()]);
      setOrg(o); setMembers(m); setName(o.name);
      if (o.role === "owner" || o.role === "admin") setProjects(await api.listProjects().catch(() => []));
    } catch (e) { setError(e); }
  }
  useEffect(() => { void load(); }, []);

  if (error != null) return <div className="container"><ErrorState error={error} onRetry={() => void load()} /></div>;
  if (!org || !members) return <div className="container"><Loading label="Loading organization…" /></div>;
  const owner = org.role === "owner", admin = owner || org.role === "admin";
  const active = members.filter((m) => m.status === "active"), invited = members.filter((m) => m.status === "invited");
  const fail = (e: unknown, what: string) => toast(e instanceof Error ? e.message : what, "error");
  const left = (k: PeopleKind) => (org.caps[k] == null ? null : Math.max(0, org.caps[k]! - org.usage[k]));
  const roleChoices = (["collector", "viewer", "member", ...(owner ? ["admin"] : [])] as AddableRole[]);
  const isIndividual = org.plan === "individual";

  async function rename(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || name.trim() === org!.name) return;
    setBusy("name");
    try { setOrg(await (await loadApi()).renameOrg(name.trim())); await refresh(); toast("Organization renamed.", "success"); }
    catch (err) { fail(err, "Could not rename."); } finally { setBusy(null); }
  }
  async function addPerson(e: FormEvent) {
    e.preventDefault();
    setBusy("add"); setMade(null);
    try {
      const r = await (await loadApi()).createAccount({ name: pName.trim(), email: pEmail.trim(), role: pRole, delivery,
        projects: [...picked].map((project_id) => ({ project_id })) });
      setMade(r);
      toast(r.temporary_password ? `Account made for ${r.member.name}. Give them the temporary password below.`
        : r.email_sent ? `Account made. ${r.member.email} has been emailed a link to set their password.`
        : `Account made for ${r.member.name}, but the email did not go out. Use Send sign-in link to try again.`, r.email_sent || r.temporary_password ? "success" : "info");
      setPName(""); setPEmail(""); setPicked(new Set()); await load();
    } catch (err) { fail(err, "Could not add this person."); } finally { setBusy(null); }
  }
  async function changeRole(m: OrgMember, r: OrgRole) {
    setBusy(m.id);
    try { await (await loadApi()).setOrgMemberRole(m.user_id!, r); toast(`${m.name ?? m.email} is now ${ROLE[r].label.toLowerCase()}.`, "success"); await load(); if (m.user_id === user?.id) await refresh(); }
    catch (err) { fail(err, "Could not change the role."); await load(); } finally { setBusy(null); }
  }
  async function sendLink(m: OrgMember) {
    setBusy(m.id);
    try { await (await loadApi()).sendSignInLink(m.user_id!); toast(`A new sign-in link was emailed to ${m.email}. Older links stop working.`, "success"); }
    catch (err) { fail(err, "Could not send the link."); } finally { setBusy(null); }
  }
  async function remove(m: OrgMember) {
    const who = m.name ?? m.email;
    if (m.status === "invited") {
      setBusy(m.id);
      try { await (await loadApi()).cancelOrgInvite(m.id); toast(`Invitation to ${m.email} cancelled.`, "success"); await load(); }
      catch (err) { fail(err, "Could not cancel."); } finally { setBusy(null); }
      return;
    }
    if (!(await confirm({ title: `Remove ${who}?`, danger: true, confirmLabel: "Remove from organization",
      message: "They lose access to every project and map in the organization, and their place is freed. Maps they own pass to you. Their account is kept." }))) return;
    setBusy(m.id);
    try { await (await loadApi()).removeOrgMember(m.user_id!); toast(`${who} was removed.`, "success"); await load(); }
    catch (err) { fail(err, "Could not remove."); } finally { setBusy(null); }
  }
  async function resetMfa(m: OrgMember) {
    const who = m.name ?? m.email;
    if (!(await confirm({ title: `Turn off two-step sign-in for ${who}?`, confirmLabel: "Turn it off",
      message: `For a lost or new phone. ${who} signs in with their password alone next time${org!.require_mfa ? ", then sets it up again" : ""}. They get an email saying so.` }))) return;
    setBusy(m.id);
    try { await (await loadApi()).resetMemberMfa(m.user_id!); toast(`Two-step sign-in is off for ${who}.`, "success"); await load(); }
    catch (err) { fail(err, "Could not turn it off."); } finally { setBusy(null); }
  }
  async function requireMfa(on: boolean) {
    if (on && !(await confirm({ title: "Require two-step sign-in?", confirmLabel: "Require it",
      message: "Everyone without it is asked to set it up the next time they use Geohub, and can do nothing else until they have. They need a phone with an authenticator app." }))) return;
    setBusy("mfa");
    try { setOrg(await (await loadApi()).setRequireMfa(on)); toast(on ? "Two-step sign-in is now required." : "Two-step sign-in is no longer required.", "success"); }
    catch (err) { fail(err, "Could not change it."); } finally { setBusy(null); }
  }
  async function checkEmail() {
    setBusy("mail"); setMailCheck(null);
    try { setMailCheck(await (await loadApi()).checkEmail()); }
    catch (err) { fail(err, "Could not run the email check."); } finally { setBusy(null); }
  }
  async function leave() {
    if (!(await confirm({ title: `Leave ${org!.name}?`, danger: true, confirmLabel: "Leave organization",
      message: org!.single_org ? "You will lose access to everything here until an administrator adds you again." : "You lose access to its projects and maps and get a free Individual account of your own." }))) return;
    try { await (await loadApi()).leaveOrg(); await refresh(); toast("You left the organization.", "success"); nav("/"); }
    catch (err) { fail(err, "Could not leave."); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); toast("Copied.", "success"); } catch { toast("Select the password and copy it.", "info"); }
  }

  return (
    <div className="container org">
      <PageHeader title={org.name} lede={`${isIndividual ? "Your Geohub account." : "Your organization on Geohub. Projects and maps made here belong to it."} ${YOU_ARE[org.role]}`} />

      <div className="org-grid">
        <div className="org-main">
          {admin && (
            <section className="card" aria-labelledby="org-add">
              <h2 id="org-add">Add a person</h2>
              <p className="field-hint">You create their account; they never fill in a sign-up form.</p>
              <form className="org-add" onSubmit={addPerson}>
                <div className="org-add-row">
                  <div className="field"><label htmlFor="add-name">Name</label><input id="add-name" required maxLength={120} autoComplete="off" value={pName} onChange={(e) => setPName(e.target.value)} /></div>
                  <div className="field"><label htmlFor="add-email">Email</label><input id="add-email" type="email" required autoComplete="off" placeholder="name@company.com" value={pEmail} onChange={(e) => setPEmail(e.target.value)} /></div>
                </div>
                <fieldset className="org-roles">
                  <legend>Role</legend>
                  {roleChoices.map((r) => {
                    const l = left(KIND[r]);
                    const full = l === 0;
                    return (
                      <label key={r} className={`org-role-opt${pRole === r ? " is-on" : ""}${full ? " is-full" : ""}`}>
                        <input type="radio" name="add-role" value={r} checked={pRole === r} disabled={full} onChange={() => setPRole(r)} />
                        <span><strong>{ROLE[r].label}</strong> <span className="muted">{l == null ? "" : full ? "· none left" : `· ${l} left`}</span><br /><span className="muted">{ROLE[r].help}</span></span>
                      </label>
                    );
                  })}
                </fieldset>
                {projects.length > 0 && (
                  <fieldset className="org-projects">
                    <legend>Add to projects <span className="muted">(optional)</span></legend>
                    {projects.map((p) => (
                      <label key={p.id}><input type="checkbox" checked={picked.has(p.id)} onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} />{p.name}</label>
                    ))}
                  </fieldset>
                )}
                <fieldset className="org-delivery">
                  <legend>How they sign in</legend>
                  <label><input type="radio" name="delivery" checked={delivery === "email"} onChange={() => setDelivery("email")} /><span><strong>Email them a link</strong><br /><span className="muted">They choose their own password. The link works once, for 72 hours.</span></span></label>
                  <label><input type="radio" name="delivery" checked={delivery === "temporary"} onChange={() => setDelivery("temporary")} /><span><strong>Give them a temporary password</strong><br /><span className="muted">Shown once here, to read out or print. They change it at first sign-in.</span></span></label>
                </fieldset>
                <Button type="submit" variant="primary" busy={busy === "add"}><Icon name="plus" size={18} />Add person</Button>
              </form>
              {made?.temporary_password && (
                <div className="org-temp" role="status">
                  <p><strong>{made.member.name}</strong> signs in with <strong>{made.member.email}</strong> and this temporary password. It will not be shown again.</p>
                  <div className="org-temp-row"><code className="org-temp-pw">{made.temporary_password}</code><Button small onClick={() => void copy(made.temporary_password!)}>Copy</Button></div>
                </div>
              )}
            </section>
          )}

          {admin && <ImportPeople org={org} onDone={() => void load()} />}

          <section aria-labelledby="org-people">
            <h2 id="org-people" className="org-h2">People <span className="muted">{active.length}</span></h2>
            <div className="table-wrap">
              <table className="data-table org-people">
                <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Joined</th>{admin && <th scope="col"><span className="sr-only">Actions</span></th>}</tr></thead>
                <tbody>
                  {active.map((m) => {
                    const self = m.user_id === user?.id;
                    const canManage = admin && !self && (owner || !["owner", "admin"].includes(m.role));
                    return (
                      <tr key={m.id}>
                        <td><strong>{m.name}{self && <span className="muted"> (you)</span>}</strong>{m.mfa_enabled && <span className="badge badge-quiet org-mfa" title="Two-step sign-in is on">2-step</span>}<br /><span className="muted">{m.email}</span></td>
                        <td>
                          {owner && !self ? (
                            <select className="input" aria-label={`Role of ${m.name ?? m.email}`} value={m.role} disabled={busy === m.id} onChange={(e) => void changeRole(m, e.target.value as OrgRole)}>
                              {(["owner", "admin", "member", "collector", "viewer"] as OrgRole[]).map((r) => <option key={r} value={r}>{ROLE[r].label}</option>)}
                            </select>
                          ) : <span className={`badge ${KIND[m.role] === "seats" && m.role !== "member" ? "badge-info" : "badge-quiet"}`}>{ROLE[m.role].label}</span>}
                        </td>
                        <td className="muted tnum">{new Date(m.joined_at).toLocaleDateString()}</td>
                        {admin && (
                          <td className="org-actions">
                            {canManage && <Button small variant="ghost" onClick={() => void sendLink(m)} disabled={busy === m.id} aria-label={`Send a sign-in link to ${m.name ?? m.email}`}>Send link</Button>}
                            {canManage && m.mfa_enabled && <Button small variant="ghost" onClick={() => void resetMfa(m)} disabled={busy === m.id} aria-label={`Turn off two-step sign-in for ${m.name ?? m.email}`}>Reset 2-step</Button>}
                            {canManage && <Button small variant="ghost" onClick={() => void remove(m)} disabled={busy === m.id} aria-label={`Remove ${m.name ?? m.email}`}>Remove</Button>}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {invited.length > 0 && (
            <section aria-labelledby="org-invited">
              <h2 id="org-invited" className="org-h2">Invited <span className="muted">{invited.length}</span></h2>
              <ul className="org-invites">
                {invited.map((m) => (
                  <li key={m.id}>
                    <span><strong>{m.email}</strong> <span className="muted">· {ROLE[m.role].label} · invited {new Date(m.joined_at).toLocaleDateString()}</span></span>
                    {admin && <Button small variant="ghost" onClick={() => void remove(m)} disabled={busy === m.id} aria-label={`Cancel invitation to ${m.email}`}>Cancel</Button>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!isIndividual && <OrgTeams org={org} people={members} projects={projects} onChanged={() => void load()} />}
          {admin && !isIndividual && <OrgBranding org={org} onSaved={(o) => { setOrg(o); void refresh(); }} />}
          {admin && !isIndividual && <OrgDomains />}
        </div>

        <aside className="org-side">
          <section className="card" aria-labelledby="org-plan">
            <h2 id="org-plan">{org.plan_name}</h2>
            {org.subscription_ends && <p className="org-renew">Subscription runs until <strong>{day(org.subscription_ends)}</strong></p>}
            {isIndividual && <p className="field-hint">Free. Projects, forms, maps and dashboards are unlimited.</p>}
            <dl className="org-usage">
              {PEOPLE.map((u) => {
                const cap = org.caps[u.key], used = org.usage[u.key];
                const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
                return (
                  <div key={u.key}>
                    <dt>{u.label}<span className="muted"> · {u.hint}</span></dt>
                    <dd>
                      <span className="tnum"><strong>{fmt(used)}</strong>{cap != null ? ` of ${fmt(cap)}` : <span className="muted"> · Unlimited</span>}</span>
                      {cap != null && <span className={`meter${pct >= 90 ? " is-full" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={used} aria-label={`${u.label} used`}><span style={{ width: `${pct}%` }} /></span>}
                    </dd>
                  </div>
                );
              })}
            </dl>
            {org.caps.teams !== 0 && <p className="org-teams-count">Teams <span className="tnum"><strong>{org.usage.teams ?? 0}</strong>{org.caps.teams != null ? ` of ${org.caps.teams}` : ""}</span></p>}
            <p className="field-hint">{isIndividual ? "For a team, ask GeoEstate for an organization." : owner ? "For more people or another plan, contact GeoEstate." : "The organization owner manages the plan."}</p>
          </section>

          {admin && !isIndividual && (
            <section className="card" aria-labelledby="org-sec-h">
              <h2 id="org-sec-h">Two-step sign-in</h2>
              <p className="field-hint">{active.filter((m) => m.mfa_enabled).length} of {active.length} people have it on.</p>
              {org.require_mfa ? (
                <>
                  <p><span className="badge badge-ok">Required</span> Everyone must use it.</p>
                  <Button small variant="ghost" busy={busy === "mfa"} onClick={() => void requireMfa(false)}>Stop requiring it</Button>
                </>
              ) : user?.mfa_enabled ? (
                <Button busy={busy === "mfa"} onClick={() => void requireMfa(true)}>Require it for everyone</Button>
              ) : (
                <p className="field-hint">To require it for everyone, first <Link to="/settings/security">turn it on for yourself</Link>.</p>
              )}
            </section>
          )}

          {admin && (
            <section className="card" aria-labelledby="org-mail-h">
              <h2 id="org-mail-h">Email delivery</h2>
              <p className="field-hint">Sign-in links are sent by email. Check that they get through: this sends a test to {user?.email} and reports each step.</p>
              <Button onClick={() => void checkEmail()} busy={busy === "mail"}>{busy === "mail" ? "Checking… (up to 30 s)" : "Send me a test email"}</Button>
              {mailCheck && (
                <div className="mail-check" role="status">
                  <p className={mailCheck.ok ? "mail-ok" : "mail-bad"}><strong>{mailCheck.ok ? "Email works." : "Email is not working yet."}</strong></p>
                  <ol>
                    {mailCheck.steps.map((s, i) => (
                      <li key={i} className={`is-${s.status}`}>
                        <span className="mail-step">{s.status === "ok" ? "✓" : s.status === "fail" ? "✕" : s.status === "warn" ? "!" : "i"}<span className="sr-only"> {s.status === "ok" ? "passed" : s.status === "fail" ? "failed" : s.status === "warn" ? "warning" : "note"}:</span></span>
                        <span><strong>{s.name}</strong> {s.detail}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </section>
          )}

          {admin && (
            <section className="card" aria-labelledby="org-name-h">
              <h2 id="org-name-h">Rename organization</h2>
              <form onSubmit={rename} className="org-rename">
                <div className="field"><label htmlFor="org-name" className="sr-only">Organization name</label><input id="org-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></div>
                <Button type="submit" busy={busy === "name"} disabled={!name.trim() || name.trim() === org.name}>Save</Button>
              </form>
            </section>
          )}

          {!(owner && active.filter((m) => m.role === "owner").length === 1) && (
            <section className="card" aria-labelledby="org-leave">
              <h2 id="org-leave">Leave</h2>
              <p className="field-hint">You will lose access to this organization's projects and maps.</p>
              <Button variant="danger" onClick={() => void leave()}>Leave {org.name}</Button>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
