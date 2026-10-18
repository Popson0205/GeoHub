import { useNavigate } from "react-router-dom";
import { Button, ErrorState, Loading, useToast } from "../../components/ui";
import { loadApi } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useAsync } from "../../lib/hooks";
import type { MapRole, WorkMap } from "../../lib/types";
import { fmtDate } from "./shared";

export default function TeamTab({ map, onChanged }: { map: WorkMap; onChanged: () => Promise<void> | void }) {
  const toast = useToast();
  const nav = useNavigate();
  const { user } = useAuth();
  const isOwner = map.role === "owner";
  const { data, error, loading, reload } = useAsync((api) => api.listMembers(map.id), [map.id, map.member_count]);
  const link = map.join_code ? `${window.location.origin}/join/${map.join_code}` : "";

  async function run(fn: () => Promise<unknown>, ok: string) {
    try { await fn(); toast(ok, "success"); await reload(); await onChanged(); }
    catch (e) { toast(e instanceof Error ? e.message : "That did not work.", "error"); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(link); toast("Invitation link copied.", "success"); }
    catch { toast("Could not copy. Select the link and copy it by hand.", "error"); }
  }
  async function leave() {
    if (!window.confirm("Leave this map? What you drew stays on the map.")) return;
    try { await (await loadApi()).removeMember(map.id, user!.id); toast("You left the map.", "success"); nav("/maps"); }
    catch (e) { toast(e instanceof Error ? e.message : "Could not leave.", "error"); }
  }

  return (
    <div className="stack" style={{ gap: 24 }}>
      {isOwner && (
        <section className="card" aria-label="Invite people">
          <h2 style={{ margin: 0 }}>Invite people</h2>
          <p className="field-hint" style={{ margin: 0 }}>Anyone with the link who has an account can join as a contributor. You can promote people to reviewer below.</p>
          <label className="check"><input type="checkbox" checked={!!map.join_code} onChange={(e) => { const open = e.target.checked; void run(async () => { await (await loadApi()).updateMap(map.id, { join_open: open }); }, open ? "Joining by link is on." : "Joining by link is off."); }} />Let people join with a link</label>
          {link && (
            <div className="row" style={{ flexWrap: "wrap" }}>
              <input className="input grow" readOnly aria-label="Invitation link" value={link} onFocus={(e) => e.target.select()} style={{ minWidth: 220 }} />
              <Button variant="primary" onClick={copy}>Copy link</Button>
              <Button onClick={() => run(async () => { const api = await loadApi(); await api.updateMap(map.id, { join_open: false }); await api.updateMap(map.id, { join_open: true }); }, "New link created. The old one no longer works.")}>New link</Button>
            </div>
          )}
        </section>
      )}

      <section className="card" aria-label="Team">
        <h2 style={{ margin: 0 }}>Team</h2>
        {loading && <Loading label="Loading team…" />}
        {error != null && <ErrorState error={error} onRetry={reload} />}
        {data && (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Joined</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {data.map((m) => (
                  <tr key={m.user_id}>
                    <td><strong>{m.name}</strong>{m.user_id === user?.id ? " (you)" : ""}{m.email && <div className="field-hint">{m.email}</div>}</td>
                    <td>
                      {isOwner && m.role !== "owner"
                        ? <select aria-label={`Role of ${m.name}`} className="input" style={{ minHeight: 36, width: "auto" }} value={m.role} onChange={(e) => { const role = e.target.value as Exclude<MapRole, "owner">; void run(async () => (await loadApi()).setMemberRole(map.id, m.user_id, role), `${m.name} is now a ${role}.`); }}><option value="contributor">Contributor</option><option value="reviewer">Reviewer</option></select>
                        : <span className="badge badge-ok">{m.role}</span>}
                    </td>
                    <td>{m.joined_at ? fmtDate(m.joined_at) : "—"}</td>
                    <td>
                      {isOwner && m.role !== "owner" && <Button small variant="danger" onClick={() => window.confirm(`Remove ${m.name} from this map? What they drew stays.`) && run(async () => (await loadApi()).removeMember(map.id, m.user_id), `${m.name} was removed.`)}>Remove</Button>}
                      {!isOwner && m.user_id === user?.id && <Button small variant="danger" onClick={leave}>Leave</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="field-hint" style={{ margin: 0 }}><strong>Owner</strong> runs the map and publishes. <strong>Reviewers</strong> approve work and can edit anything. <strong>Contributors</strong> draw, and can change their own features until they are approved.</p>
      </section>
    </div>
  );
}
