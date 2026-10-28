import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button, EmptyState, ErrorState, Loading, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { GEOMETRY_LABEL, type GeometryType } from "../lib/types";

export default function FormsPage() {
  const { projectId = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload } = useAsync((api) => api.listForms(projectId), [projectId]);
  const [name, setName] = useState("");
  const [geom, setGeom] = useState<GeometryType>("Point");
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const f = await (await loadApi()).createForm(projectId, name.trim(), geom);
      nav(`/collect/${projectId}/forms/${f.id}`);
    } catch (err) { toast(err instanceof Error ? err.message : "Could not create the form.", "error"); setBusy(false); }
  }

  return (
    <div className="container" style={{ width: "100%" }}>
      <div className="page-head"><h1>Forms</h1><span className="grow" /><Link className="btn" to="/collect">Back to projects</Link></div>
      <form className="card" onSubmit={create} style={{ maxWidth: 560, marginBottom: 24 }}>
        <h2>New form</h2>
        <div className="field"><label htmlFor="fn">Name</label><input id="fn" required value={name} onChange={(e) => setName(e.target.value)} placeholder="For example, Water point" /></div>
        <div className="field"><label htmlFor="fg">What do collectors capture?</label>
          <select id="fg" value={geom} onChange={(e) => setGeom(e.target.value as GeometryType)}>
            {(Object.keys(GEOMETRY_LABEL) as GeometryType[]).map((g) => <option key={g} value={g}>A {GEOMETRY_LABEL[g]}</option>)}
          </select>
        </div>
        <Button type="submit" variant="primary" busy={busy}>Create and open builder</Button>
      </form>
      {loading && <Loading />}
      {error != null && <ErrorState error={error} onRetry={reload} />}
      {data && data.length === 0 && <EmptyState title="No forms yet">Create the first form above.</EmptyState>}
      <div className="stack">
        {data?.map((f) => (
          <div className="list-item" key={f.id}>
            <div className="grow"><strong>{f.name}</strong><small>{GEOMETRY_LABEL[f.geometry_type]} · {f.fields.length} fields · version {f.version}</small></div>
            <span className={`badge ${f.status === "published" ? "badge-ok" : "badge-warn"}`}>{f.status === "published" ? "Published" : "Draft"}</span>
            {f.status === "published" && <Link className="btn btn-sm" to={`/collect/${projectId}/forms/${f.id}/share`}>Share</Link>}
            <Link className="btn btn-sm" to={`/collect/${projectId}/forms/${f.id}`}>Edit</Link>
          </div>
        ))}
      </div>
    </div>
  );
}
