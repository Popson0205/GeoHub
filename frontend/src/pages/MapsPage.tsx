import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button, EmptyState, ErrorState, Loading, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { useAsync } from "../lib/hooks";

/** Web mapping home: your maps. Maps are free-form workspaces; they do not need a collection project or a form. */
export default function MapsPage() {
  const toast = useToast();
  const nav = useNavigate();
  const { data, error, loading, reload } = useAsync((api) => api.listMaps(), []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const m = await (await loadApi()).createMap(name.trim());
      nav(`/maps/${m.id}`);          // straight into the editor, ready to draw
    } catch (err) { toast(err instanceof Error ? err.message : "Could not create the map.", "error"); }
    finally { setBusy(false); }
  }

  async function remove(id: string, title: string) {
    if (!window.confirm(`Delete "${title}" with all its layers and features? This cannot be undone.`)) return;
    try { await (await loadApi()).deleteMap(id); toast("Map deleted.", "success"); await reload(); }
    catch (err) { toast(err instanceof Error ? err.message : "Could not delete the map.", "error"); }
  }

  return (
    <div className="container" style={{ width: "100%" }}>
      <div className="page-head">
        <h1>Your maps</h1><span className="grow" />
        <Button variant="accent" onClick={() => setCreating((v) => !v)}>New map</Button>
      </div>
      <p style={{ color: "var(--muted)", marginTop: 0, maxWidth: 640 }}>
        Create a map and start digitizing points, lines and areas over imagery. No forms or setup needed.
      </p>

      {creating && (
        <form className="card" onSubmit={create} style={{ marginBottom: 20, maxWidth: 480 }}>
          <div className="field"><label htmlFor="mname">Map name</label><input id="mname" required value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
          <div className="row"><Button type="submit" variant="primary" busy={busy}>Create map</Button><Button onClick={() => setCreating(false)}>Cancel</Button></div>
        </form>
      )}

      {loading && <Loading label="Loading maps…" />}
      {error != null && <ErrorState error={error} onRetry={reload} />}
      {data && data.length === 0 && <EmptyState title="No maps yet">Create one to start digitizing from imagery.</EmptyState>}
      {data && data.length > 0 && (
        <div className="grid-cards">
          {data.map((m) => (
            <article className="card" key={m.id}>
              <div className="thumb" aria-hidden="true" />
              <h2>{m.name}</h2>
              <div className="meta">{m.layer_count} layers · {m.feature_count} features · updated {new Date(m.updated_at).toLocaleDateString()}</div>
              <div className="actions">
                <Link className="btn btn-primary" to={`/maps/${m.id}`}>Open map</Link>
                {m.role === "owner" && <Button variant="danger" onClick={() => remove(m.id, m.name)}>Delete</Button>}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
