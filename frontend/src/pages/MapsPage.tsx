import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Icon } from "../components/icons";
import { Button, CardSkeletons, EmptyState, ErrorState, MoreMenu, PageHeader, thumbStyle, useConfirm, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { useAsync } from "../lib/hooks";

/** Mapping app home: your maps. A map is a workspace to digitise features over imagery. No forms, no projects. */
export default function MapsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, loading, reload } = useAsync((api) => api.listMaps(), []);
  // ?new=1 (from the home page) opens the "New map" panel straight away.
  const [creating, setCreating] = useState(() => new URLSearchParams(window.location.search).get("new") === "1");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [joining, setJoining] = useState(false);
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
    if (!(await confirm({ title: `Delete "${title}"?`, message: "This permanently deletes the map with all its features and imagery. This cannot be undone.", confirmLabel: "Delete map", danger: true }))) return;
    try { await (await loadApi()).deleteMap(id); toast("Map deleted.", "success"); await reload(); }
    catch (err) { toast(err instanceof Error ? err.message : "Could not delete the map.", "error"); }
  }

  const newButton = <Button variant="primary" onClick={() => { setJoining(false); setCreating((v) => !v); }} aria-expanded={creating}><Icon name="plus" size={18} />New map</Button>;
  return (
    <div className="container" style={{ width: "100%" }}>
      <PageHeader
        title="Web mapping"
        lede="Draw points, lines and areas over imagery, alone or with a team. Review contributors' work and publish what you approve to the Data hub."
        actions={<>
          <Button onClick={() => { setCreating(false); setJoining((v) => !v); }} aria-expanded={joining}><Icon name="link" size={18} />Join with a code</Button>
          {newButton}
        </>}
      />

      {creating && (
        <form className="card inline-panel" onSubmit={create} aria-label="New map">
          <h2>New map</h2>
          <div className="field"><label htmlFor="mname">Map name</label><input id="mname" required value={name} onChange={(e) => setName(e.target.value)} placeholder="For example, Oke-Baale buildings" autoFocus /></div>
          <div className="row"><Button type="submit" variant="primary" busy={busy}>Create map</Button><Button onClick={() => setCreating(false)}>Cancel</Button></div>
        </form>
      )}
      {joining && (
        <form className="card inline-panel" onSubmit={openInvite} aria-label="Join a map">
          <h2>Join someone else's map</h2>
          <div className="field">
            <label htmlFor="invite">Invitation link or code</label>
            <input id="invite" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the link you were sent" autoFocus />
            <span className="field-hint">The map's owner can copy this from the map's Team & stats page.</span>
          </div>
          <div className="row"><Button type="submit" variant="primary" disabled={!code.trim()}>Join</Button><Button onClick={() => setJoining(false)}>Cancel</Button></div>
        </form>
      )}

      {loading && <CardSkeletons />}
      {error != null && <ErrorState error={error} onRetry={reload} />}
      {data && data.length === 0 && !creating && (
        <EmptyState icon="navMap" title="No maps yet" action={newButton}>
          A map is a workspace for tracing features over imagery. Create one, or join a team's map with the link they sent you.
        </EmptyState>
      )}
      {data && data.length > 0 && (
        <div className="grid-cards">
          {data.map((m) => (
            <article className="card item-card" key={m.id}>
              <div className="thumb" style={thumbStyle(m.id)} aria-hidden="true" />
              <div className="item-card-body">
                <h2><Link to={`/maps/${m.id}`}>{m.name}</Link></h2>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <span className="badge badge-quiet">{m.role === "owner" ? "Owner" : m.role === "reviewer" ? "Reviewer" : "Contributor"}</span>
                  {m.is_campaign && m.campaign_status && <span className={`badge ${m.campaign_status === "open" ? "badge-ok" : m.campaign_status === "ended" ? "badge-bad" : "badge-warn"}`}>{m.competition ? "Competition" : "Campaign"} · {m.campaign_status === "open" ? "open" : m.campaign_status === "ended" ? "ended" : "not started"}</span>}
                </div>
                <div className="item-stats">
                  <span><Icon name="polygon" size={15} />{m.feature_count} {m.feature_count === 1 ? "feature" : "features"}</span>
                  <span><Icon name="users" size={15} />{m.member_count} {m.member_count === 1 ? "person" : "people"}</span>
                  <span>{m.role !== "owner" ? `By ${m.owner_name}` : `Updated ${new Date(m.updated_at).toLocaleDateString()}`}</span>
                </div>
              </div>
              <div className="item-card-foot">
                <Link className="btn btn-primary" to={`/maps/${m.id}`}>Open map</Link>
                <Link className="btn" to={`/maps/${m.id}/portal`}>{m.role === "contributor" ? "Leaderboard" : "Team & stats"}</Link>
                <span className="grow" />
                {m.role === "owner" && <MoreMenu label={`More for ${m.name}`} items={[{ label: "Delete map", icon: "delete", danger: true, onSelect: () => void remove(m.id, m.name) }]} />}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
