import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../components/icons";
import { Button, EmptyState, ErrorState, Loading, PageHeader, useConfirm, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { EmailCheck, Org, OrgMember, OrgRole } from "../lib/types";

const ROLE: Record<OrgRole, { label: string; help: string }> = {
  owner: { label: "Owner", help: "Everything, including roles and the plan. Owner of every project." },
  admin: { label: "Administrator", help: "Invites people and runs every project in the organization." },
  member: { label: "Member", help: "Works in the projects and maps they are added to." },
};
const USAGE: { key: keyof Org["usage"]; label: string; hint: string }[] = [
  { key: "seats", label: "People", hint: "Members and open invitations" },
  { key: "projects", label: "Projects", hint: "Data collection projects" },
  { key: "records", label: "Records", hint: "Collected records, all projects" },
];
const fmt = (n: number) => n.toLocaleString();
const YOU_ARE: Record<OrgRole, string> = { owner: "You are an owner.", admin: "You are an administrator.", member: "You are a member." };

/** The organization: its name, its people and their roles, and what its plan allows. */
export default function OrgSettingsPage() {
  const { user, refresh } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const nav = useNavigate();
  const [org, setOrg] = useState<Org | null>(null);
  const [members, setMembers] = useState<OrgMember[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState<string | null>(null);
  const [mailCheck, setMailCheck] = useState<EmailCheck | null>(null);

  async function load() {
    setError(null);
    try {
      const api = await loadApi();
      const [o, m] = await Promise.all([api.getOrg(), api.listOrgMembers()]);
      setOrg(o); setMembers(m); setName(o.name);
    } catch (e) { setError(e); }
  }
  useEffect(() => { void load(); }, []);

  if (error != null) return <div className="container"><ErrorState error={error} onRetry={() => void load()} /></div>;
  if (!org || !members) return <div className="container"><Loading label="Loading organization…" /></div>;
  const admin = org.role !== "member", owner = org.role === "owner";
  const active = members.filter((m) => m.status === "active"), invited = members.filter((m) => m.status === "invited");
  const fail = (e: unknown, what: string) => toast(e instanceof Error ? e.message : what, "error");

  async function rename(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || name.trim() === org!.name) return;
    setBusy("name");
    try { setOrg(await (await loadApi()).renameOrg(name.trim())); await refresh(); toast("Organization renamed.", "success"); }
    catch (err) { fail(err, "Could not rename."); } finally { setBusy(null); }
  }
  async function invite(e: FormEvent) {
    e.preventDefault();
    setBusy("invite");
    try {
      const m = await (await loadApi()).inviteOrgMember(email.trim(), role);
      toast(m.status === "active" ? `${m.name ?? m.email} joined the organization.` : `Invitation sent to ${m.email}.`, "success");
      setEmail(""); setRole("member"); await load();
    } catch (err) { fail(err, "Could not invite."); } finally { setBusy(null); }
  }
  async function changeRole(m: OrgMember, r: OrgRole) {
    setBusy(m.id);
    try { await (await loadApi()).setOrgMemberRole(m.user_id!, r); toast(`${m.name ?? m.email} is now ${ROLE[r].label.toLowerCase()}.`, "success"); await load(); if (m.user_id === user?.id) await refresh(); }
    catch (err) { fail(err, "Could not change the role."); await load(); } finally { setBusy(null); }
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
      message: "They lose access to every project and map in the organization. Maps they own pass to you. Their account is kept, and you can invite them again." }))) return;
    setBusy(m.id);
    try { await (await loadApi()).removeOrgMember(m.user_id!); toast(`${who} was removed.`, "success"); await load(); }
    catch (err) { fail(err, "Could not remove."); } finally { setBusy(null); }
  }
  async function checkEmail() {
    setBusy("mail"); setMailCheck(null);
    try { setMailCheck(await (await loadApi()).checkEmail()); }
    catch (err) { fail(err, "Could not run the email check."); } finally { setBusy(null); }
  }
  async function leave() {
    if (!(await confirm({ title: `Leave ${org!.name}?`, danger: true, confirmLabel: "Leave organization",
      message: org!.single_org ? "You will lose access to everything here until someone invites you again." : "You lose access to its projects and maps and get a new, empty organization of your own." }))) return;
    try { await (await loadApi()).leaveOrg(); await refresh(); toast("You left the organization.", "success"); nav("/"); }
    catch (err) { fail(err, "Could not leave."); }
  }

  return (
    <div className="container org">
      <PageHeader title={org.name} lede={`Your organization on Geohub. Projects and maps made here belong to it. ${YOU_ARE[org.role]}`} />

      <div className="org-grid">
        <div className="org-main">
          {admin && (
            <section className="card" aria-labelledby="org-people-invite">
              <h2 id="org-people-invite">Invite people</h2>
              <form className="org-invite" onSubmit={invite}>
                <div className="field grow">
                  <label htmlFor="org-email">Email</label>
                  <input id="org-email" type="email" required autoComplete="off" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="org-role">Role</label>
                  <select id="org-role" value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
                    <option value="member">Member</option>
                    {owner && <option value="admin">Administrator</option>}
                  </select>
                </div>
                <Button type="submit" variant="primary" busy={busy === "invite"}><Icon name="plus" size={18} />Invite</Button>
              </form>
              <p className="field-hint">People with a Geohub account join at once. Others get an email and join when they sign up with that address.</p>
            </section>
          )}

          <section aria-labelledby="org-people">
            <h2 id="org-people" className="org-h2">People <span className="muted">{active.length}</span></h2>
            <div className="table-wrap">
              <table className="data-table org-people">
                <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Joined</th>{admin && <th scope="col"><span className="sr-only">Actions</span></th>}</tr></thead>
                <tbody>
                  {active.map((m) => {
                    const self = m.user_id === user?.id;
                    return (
                      <tr key={m.id}>
                        <td><strong>{m.name}{self && <span className="muted"> (you)</span>}</strong><br /><span className="muted">{m.email}</span></td>
                        <td>
                          {owner && !self ? (
                            <select className="input" aria-label={`Role of ${m.name ?? m.email}`} value={m.role} disabled={busy === m.id} onChange={(e) => void changeRole(m, e.target.value as OrgRole)}>
                              {(["owner", "admin", "member"] as OrgRole[]).map((r) => <option key={r} value={r}>{ROLE[r].label}</option>)}
                            </select>
                          ) : <span className={`badge ${m.role === "member" ? "badge-quiet" : "badge-info"}`}>{ROLE[m.role].label}</span>}
                        </td>
                        <td className="muted tnum">{new Date(m.joined_at).toLocaleDateString()}</td>
                        {admin && <td className="org-actions">{!self && (owner || m.role === "member") && <Button small variant="ghost" onClick={() => void remove(m)} disabled={busy === m.id} aria-label={`Remove ${m.name ?? m.email}`}>Remove</Button>}</td>}
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
        </div>

        <aside className="org-side">
          <section className="card" aria-labelledby="org-plan">
            <h2 id="org-plan">Plan <span className="badge badge-quiet org-plan-name">{org.plan}</span></h2>
            <dl className="org-usage">
              {USAGE.map((u) => {
                const cap = org.limits[u.key], used = org.usage[u.key];
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
            <p className="field-hint">{owner ? "To change your plan, contact Geohub." : "The organization owner manages the plan."}</p>
          </section>

          {admin && (
            <section className="card" aria-labelledby="org-mail-h">
              <h2 id="org-mail-h">Email delivery</h2>
              <p className="field-hint">Invitations are sent by email. Check that they get through: this sends a test to {user?.email} and reports each step.</p>
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
              <h2 id="org-name-h">Name</h2>
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
      {active.length === 1 && admin && <EmptyState icon="users" title="It's just you so far">Invite your team above. Everyone you invite can be added to your projects and maps.</EmptyState>}
    </div>
  );
}
