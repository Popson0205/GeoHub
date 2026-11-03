import { useEffect, useState } from "react";
import { Button, useToast } from "./ui";
import { loadApi } from "../lib/api";
import type { ProjectTeam, Team, TeamProjectRole } from "../lib/types";

const ROLE_LABEL: Record<TeamProjectRole, string> = { collector: "Collectors", viewer: "Viewers", admin: "Admins" };

/** The teams given a project: everyone in the team gets the role (field collectors at most collect, viewers only
 *  view, and the team's leads run the project). Shown to the project's admins. */
export default function ProjectTeams({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const toast = useToast();
  const [list, setList] = useState<ProjectTeam[] | null>(null);
  const [teams, setTeams] = useState<Team[]>([]);
  const [pick, setPick] = useState("");
  const [role, setRole] = useState<TeamProjectRole>("collector");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const api = await loadApi();
      try { setList(await api.listProjectTeams(projectId)); } catch { setList([]); }
      if (canManage) try { setTeams(await api.listTeams()); } catch { setTeams([]); }
    })();
  }, [projectId, canManage]);

  async function run(key: string, f: () => Promise<ProjectTeam[]>, done?: string) {
    setBusy(key);
    try { setList(await f()); if (done) toast(done, "success"); }
    catch (e) { toast(e instanceof Error ? e.message : "That did not work.", "error"); } finally { setBusy(null); }
  }

  if (!list || (!canManage && list.length === 0)) return null;
  const given = new Set(list.map((t) => t.team_id));
  const free = teams.filter((t) => !given.has(t.id));
  if (canManage && list.length === 0 && teams.length === 0) return null;      // no teams in the organization

  return (
    <section className="card project-teams" style={{ maxWidth: 640, marginTop: 20 }} aria-labelledby="pt-h">
      <h2 id="pt-h">Teams</h2>
      <p className="meta" style={{ marginTop: 0 }}>Everyone in a team gets its role here, and the team's leads run the project. Field collectors
        can at most collect, and viewers only view.</p>
      {list.map((t) => (
        <div key={t.team_id} className="project-team-row">
          <span className="grow"><strong>{t.name}</strong> <span className="meta">· {t.member_count} {t.member_count === 1 ? "person" : "people"}</span></span>
          {canManage ? (
            <>
              <select aria-label={`Role of ${t.name}`} value={t.role} disabled={busy === t.team_id}
                onChange={(e) => { const role = e.target.value as TeamProjectRole; void run(t.team_id, async () => (await loadApi()).putProjectTeam(projectId, t.team_id, role)); }}>
                {(["collector", "viewer", "admin"] as TeamProjectRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
              <Button small variant="ghost" disabled={busy === t.team_id} aria-label={`Take ${t.name} off this project`}
                onClick={() => void run(t.team_id, async () => (await loadApi()).removeProjectTeam(projectId, t.team_id), `${t.name} taken off the project.`)}>Remove</Button>
            </>
          ) : <span className="badge badge-quiet">{ROLE_LABEL[t.role]}</span>}
        </div>
      ))}
      {canManage && free.length > 0 && (
        <div className="project-team-add">
          <select aria-label="Team to add" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Add a team…</option>
            {free.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <select aria-label="Their role" value={role} onChange={(e) => setRole(e.target.value as TeamProjectRole)}>
            {(["collector", "viewer", "admin"] as TeamProjectRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
          <Button variant="primary" disabled={!pick} busy={busy === "add"}
            onClick={() => void run("add", async () => (await loadApi()).putProjectTeam(projectId, pick, role), `${free.find((t) => t.id === pick)?.name} added.`).then(() => setPick(""))}>Add team</Button>
        </div>
      )}
    </section>
  );
}
