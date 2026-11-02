import { useEffect, useState, type FormEvent } from "react";
import { Button, useConfirm, useToast } from "./ui";
import { loadApi } from "../lib/api";
import type { Org, OrgMember, Project, Team, TeamProjectRole } from "../lib/types";

const ROLE_WORD = { admin: "admins", collector: "collectors", viewer: "viewers" } as const;

/** Teams (departments): administrators make them and choose leads; leads add and remove the team's people. A team
 *  given a project gives everyone in it a role there. */
export default function OrgTeams({ org, people, projects = [], onChanged }: { org: Org; people: OrgMember[]; projects?: Project[]; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<Record<string, string>>({});
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [giving, setGiving] = useState<Record<string, { project: string; role: TeamProjectRole }>>({});
  const admin = org.role === "owner" || org.role === "admin";
  const cap = org.caps.teams ?? null, used = teams?.length ?? org.usage.teams ?? 0;
  const full = cap != null && used >= cap;

  async function load() {
    try { setTeams(await (await loadApi()).listTeams()); } catch { setTeams([]); }
  }
  useEffect(() => { void load(); }, []);
  const fail = (e: unknown, what: string) => toast(e instanceof Error ? e.message : what, "error");
  const replace = (t: Team) => setTeams((all) => (all ?? []).map((x) => (x.id === t.id ? t : x)));

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy("create");
    try { const t = await (await loadApi()).createTeam({ name: name.trim(), description: desc.trim() }); setTeams((all) => [...(all ?? []), t].sort((a, b) => a.name.localeCompare(b.name))); setName(""); setDesc(""); toast(`Team “${t.name}” made. Add its people below.`, "success"); onChanged(); }
    catch (err) { fail(err, "Could not make the team."); } finally { setBusy(null); }
  }
  async function addPerson(t: Team) {
    const uid = adding[t.id];
    if (!uid) return;
    setBusy(`add-${t.id}`);
    try { replace(await (await loadApi()).putTeamMember(t.id, uid)); setAdding((a) => ({ ...a, [t.id]: "" })); }
    catch (err) { fail(err, "Could not add them."); } finally { setBusy(null); }
  }
  async function setLead(t: Team, uid: string, lead: boolean) {
    setBusy(`${t.id}-${uid}`);
    try { replace(await (await loadApi()).putTeamMember(t.id, uid, lead)); }
    catch (err) { fail(err, "Could not change the lead."); } finally { setBusy(null); }
  }
  async function removePerson(t: Team, uid: string, who: string) {
    setBusy(`${t.id}-${uid}`);
    try { replace(await (await loadApi()).removeTeamMember(t.id, uid)); toast(`${who} is no longer in ${t.name}.`, "success"); }
    catch (err) { fail(err, "Could not take them out."); } finally { setBusy(null); }
  }
  async function giveProject(t: Team) {
    const g = giving[t.id];
    if (!g?.project) return;
    setBusy(`give-${t.id}`);
    try {
      const api = await loadApi();
      await api.putProjectTeam(g.project, t.id, g.role);
      await load();
      setGiving((x) => ({ ...x, [t.id]: { project: "", role: g.role } }));
      toast(`${t.name} now has ${projects.find((p) => p.id === g.project)?.name ?? "the project"}.`, "success");
    } catch (err) { fail(err, "Could not give the project."); } finally { setBusy(null); }
  }
  async function takeProject(t: Team, projectId: string, name: string) {
    setBusy(`give-${t.id}`);
    try { await (await loadApi()).removeProjectTeam(projectId, t.id); await load(); toast(`${t.name} no longer has ${name}.`, "success"); }
    catch (err) { fail(err, "Could not take the project off."); } finally { setBusy(null); }
  }
  async function rename(e: FormEvent) {
    e.preventDefault();
    if (!renaming) return;
    setBusy(`rename-${renaming.id}`);
    try { replace(await (await loadApi()).updateTeam(renaming.id, { name: renaming.name.trim() })); setRenaming(null); }
    catch (err) { fail(err, "Could not rename."); } finally { setBusy(null); }
  }
  async function remove(t: Team) {
    if (!(await confirm({ title: `Delete ${t.name}?`, danger: true, confirmLabel: "Delete team",
      message: "Its people stay in the organization. They lose the project roles the team gave them, but keep any given to them directly." }))) return;
    setBusy(`del-${t.id}`);
    try { await (await loadApi()).deleteTeam(t.id); setTeams((all) => (all ?? []).filter((x) => x.id !== t.id)); toast(`${t.name} deleted.`, "success"); onChanged(); }
    catch (err) { fail(err, "Could not delete."); } finally { setBusy(null); }
  }

  if (!teams) return null;
  if (!admin && teams.length === 0) return null;
  const active = people.filter((p) => p.status === "active" && p.user_id);

  return (
    <section className="card org-teams" aria-labelledby="org-teams-h">
      <h2 id="org-teams-h">Teams <span className="muted">{cap == null ? used : `${used} of ${cap}`}</span></h2>
      <p className="field-hint">Group people by department or area. Give a team a project, and everyone in it gets that role there (field
        collectors at most collect, viewers only view). A team lead adds and removes the team's people and runs its projects.</p>
      {teams.length === 0 && <p className="muted">No teams yet.</p>}
      <ul className="team-list">
        {teams.map((t) => {
          const inTeam = new Set(t.members.map((m) => m.user_id));
          const others = active.filter((p) => !inTeam.has(p.user_id!));
          return (
            <li key={t.id} className="team">
              <div className="team-head">
                {renaming?.id === t.id ? (
                  <form className="team-rename" onSubmit={rename}>
                    <label htmlFor={`rn-${t.id}`} className="sr-only">Team name</label>
                    <input id={`rn-${t.id}`} className="input" required maxLength={80} value={renaming.name} onChange={(e) => setRenaming({ id: t.id, name: e.target.value })} />
                    <Button small type="submit" busy={busy === `rename-${t.id}`}>Save</Button>
                    <Button small type="button" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
                  </form>
                ) : (
                  <h3>{t.name}{t.you_lead && <span className="badge badge-info">You lead</span>}</h3>
                )}
                {t.can_edit && renaming?.id !== t.id && (
                  <span className="row-actions">
                    <Button small variant="ghost" onClick={() => setRenaming({ id: t.id, name: t.name })} aria-label={`Rename ${t.name}`}>Rename</Button>
                    <Button small variant="ghost" busy={busy === `del-${t.id}`} onClick={() => void remove(t)} aria-label={`Delete ${t.name}`}>Delete</Button>
                  </span>
                )}
              </div>
              {t.description && <p className="field-hint">{t.description}</p>}
              <ul className="team-people" aria-label={`People in ${t.name}`}>
                {t.members.length === 0 && <li className="muted">Nobody yet.</li>}
                {t.members.map((m) => (
                  <li key={m.user_id}>
                    <span>{m.name}{m.lead && <span className="badge badge-ok">Lead</span>}</span>
                    {(t.can_edit || (t.can_manage_people && !m.lead)) && (
                      <span className="row-actions">
                        {t.can_edit && (m.role === "owner" || m.role === "admin" || m.role === "member") && (
                          <Button small variant="ghost" disabled={busy === `${t.id}-${m.user_id}`} onClick={() => void setLead(t, m.user_id, !m.lead)}>{m.lead ? "Not lead" : "Make lead"}</Button>
                        )}
                        <Button small variant="ghost" disabled={busy === `${t.id}-${m.user_id}`} onClick={() => void removePerson(t, m.user_id, m.name)} aria-label={`Take ${m.name} out of ${t.name}`}>Remove</Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {t.can_manage_people && others.length > 0 && (
                <div className="team-add">
                  <label htmlFor={`ta-${t.id}`} className="sr-only">Add someone to {t.name}</label>
                  <select id={`ta-${t.id}`} className="input" value={adding[t.id] ?? ""} onChange={(e) => setAdding((a) => ({ ...a, [t.id]: e.target.value }))}>
                    <option value="">Add someone…</option>
                    {others.map((p) => <option key={p.user_id} value={p.user_id!}>{p.name ?? p.email}</option>)}
                  </select>
                  <Button small disabled={!adding[t.id]} busy={busy === `add-${t.id}`} onClick={() => void addPerson(t)}>Add</Button>
                </div>
              )}
              {t.projects.length > 0 && (
                <ul className="team-projects" aria-label={`Projects of ${t.name}`}>
                  {t.projects.map((p) => (
                    <li key={p.project_id}><span>{p.name} <span className="muted">· as {ROLE_WORD[p.role]}</span></span>
                      {t.can_edit && <Button small variant="ghost" disabled={busy === `give-${t.id}`} onClick={() => void takeProject(t, p.project_id, p.name)} aria-label={`Take ${p.name} off ${t.name}`}>Remove</Button>}</li>
                  ))}
                </ul>
              )}
              {t.can_edit && projects.some((p) => !t.projects.some((x) => x.project_id === p.id)) && (
                <div className="team-add">
                  <label htmlFor={`tp-${t.id}`} className="sr-only">Give {t.name} a project</label>
                  <select id={`tp-${t.id}`} className="input" value={giving[t.id]?.project ?? ""} onChange={(e) => setGiving((x) => ({ ...x, [t.id]: { project: e.target.value, role: x[t.id]?.role ?? "collector" } }))}>
                    <option value="">Give a project…</option>
                    {projects.filter((p) => !t.projects.some((x) => x.project_id === p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <label htmlFor={`tr-${t.id}`} className="sr-only">As</label>
                  <select id={`tr-${t.id}`} className="input team-role" value={giving[t.id]?.role ?? "collector"} onChange={(e) => setGiving((x) => ({ ...x, [t.id]: { project: x[t.id]?.project ?? "", role: e.target.value as TeamProjectRole } }))}>
                    <option value="collector">as collectors</option><option value="viewer">as viewers</option><option value="admin">as admins</option>
                  </select>
                  <Button small disabled={!giving[t.id]?.project} busy={busy === `give-${t.id}`} onClick={() => void giveProject(t)}>Give</Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {admin && (full ? (
        <p className="field-hint">{cap === 0 ? "Teams come with Organization plans." : `Your plan includes ${cap} teams. Delete one, or contact GeoEstate for more.`}</p>
      ) : (
        <form className="team-new" onSubmit={create}>
          <div className="field"><label htmlFor="team-name">New team</label><input id="team-name" required maxLength={80} placeholder="e.g. North district" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field grow"><label htmlFor="team-desc">Description <span className="muted">(optional)</span></label><input id="team-desc" maxLength={300} value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
          <Button type="submit" busy={busy === "create"}>Make team</Button>
        </form>
      ))}
    </section>
  );
}
