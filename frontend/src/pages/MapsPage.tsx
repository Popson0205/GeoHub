import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
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
        <Button variant="accent" onClick={() => setCreating((v) => !v)}>New map</Button>
      </div>
      <p style={{ color: "var(--muted)", marginTop: -8, maxWidth: 640 }}>
        Draw points, lines and areas over satellite imagery. Add imagery from a tile URL or by uploading a GeoTIFF, then export what you mapped.
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
              <div className="meta">{m.feature_count} features · {m.sources.length} imagery {m.sources.length === 1 ? "source" : "sources"} · updated {new Date(m.updated_at).toLocaleDateString()}</div>
              <div className="actions">
                <Link className="btn btn-primary" to={`/maps/${m.id}`}>Open map</Link>
                <Button variant="danger" onClick={() => remove(m.id, m.name)}>Delete</Button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
