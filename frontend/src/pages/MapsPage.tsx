import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, EmptyState, ErrorState, Loading, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { useAsync } from "../lib/hooks";

/** Mapping app home: your maps. A map is a workspace to digitise features over imagery. No forms, no projects. */
export default function MapsPage() {
  const toast = useToast();
  const { data, error, loading, reload } = useAsync((api) => api.listMaps(), []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const nav = useNavigate();

  /** Accepts a pasted invitation link or just the code at the end of it. */
  function openInvite(e: FormEvent) {
    e.preventDefault();
    const c = code.trim().replace(/\/+$/, "").split("/").pop();
    if (c) nav(`/join/${encodeURIComponent(c)}`);
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await (await loadApi()).createMap(name.trim());
      setName(""); setCreating(false);
      toast("Map created.", "success");
      await reload();
    } catch (err) { toast(err instanceof Error ? err.message : "Could not create the map.", "error"); }
    finally { setBusy(false); }
  }
  async function remove(id: string, title: string) {
    if (!window.confirm(`Delete "${title}" with all its features and imagery? This cannot be undone.`)) return;
    try { await (await loadApi()).deleteMap(id); toast("Map deleted.", "success"); await reload(); }
    catch (err) { toast(err instanceof Error ? err.message : "Could not delete the map.", "error"); }
  }

  return (
    <div className="container" style={{ width: "100%" }}>
      <div className="page-head">
        <h1>Web mapping</h1><span className="grow" />
        <form className="row" onSubmit={openInvite} aria-label="Join a map">
          <input className="input" style={{ width: 220, minHeight: 44 }} aria-label="Invitation link or code" placeholder="Invitation link or code" value={code} onChange={(e) => setCode(e.target.value)} />
          <Button type="submit" disabled={!code.trim()}>Join</Button>
        </form>
        <Button variant="accent" onClick={() => setCreating((v) => !v)}>New map</Button>
      </div>
      <p style={{ color: "var(--muted)", marginTop: -8, maxWidth: 640 }}>
        Draw points, lines and polygons over satellite imagery, alone or with a team. Invite contributors, review their work, run a mapping competition, and publish the approved features to the Data hub.
      </p>

      {creating && (
        <form className="card" onSubmit={create} style={{ marginBottom: 20, maxWidth: 480 }}>
          <div className="field"><label htmlFor="mname">Map name</label><input id="mname" required value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
          <div className="row"><Button type="submit" variant="primary" busy={busy}>Create map</Button><Button onClick={() => setCreating(false)}>Cancel</Button></div>
        </form>
      )}

      {loading && <Loading label="Loading maps…" />}
      {error != null && <ErrorState error={error} onRetry={reload} />}
      {data && data.length === 0 && <EmptyState title="No maps yet">Create a map to start digitising.</EmptyState>}
      {data && data.length > 0 && (
        <div className="grid-cards">
          {data.map((m) => (
            <article className="card" key={m.id}>
              <div className="thumb" aria-hidden="true" />
              <h2>{m.name}</h2>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                <span className="badge badge-ok">{m.role === "owner" ? "Owner" : m.role === "reviewer" ? "Reviewer" : "Contributor"}</span>
                {m.is_campaign && m.campaign_status && <span className={`badge ${m.campaign_status === "open" ? "badge-ok" : m.campaign_status === "ended" ? "badge-bad" : "badge-warn"}`}>{m.competition ? "Competition" : "Campaign"} · {m.campaign_status === "open" ? "open" : m.campaign_status === "ended" ? "ended" : "not started"}</span>}
              </div>
              <div className="meta">{m.feature_count} features · {m.member_count} {m.member_count === 1 ? "person" : "people"}{m.role !== "owner" ? ` · by ${m.owner_name}` : ""} · updated {new Date(m.updated_at).toLocaleDateString()}</div>
              <div className="actions">
                <Link className="btn btn-primary" to={`/maps/${m.id}`}>Open map</Link>
                <Link className="btn" to={`/maps/${m.id}/portal`}>{m.role === "contributor" ? "Leaderboard" : "Team & stats"}</Link>
                {m.role === "owner" && <Button variant="danger" onClick={() => remove(m.id, m.name)}>Delete</Button>}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
