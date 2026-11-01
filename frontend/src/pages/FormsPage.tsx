import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Icon } from "../components/icons";
import ProjectNav from "../components/ProjectNav";
import { Button, ErrorState, Loading, useToast } from "../components/ui";
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
  const [creating, setCreating] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const f = await (await loadApi()).createForm(projectId, name.trim(), geom);
      nav(`/collect/${projectId}/forms/${f.id}`);
    } catch (err) { toast(err instanceof Error ? err.message : "Could not create the form.", "error"); setBusy(false); }
  }

  const empty = data != null && data.length === 0;
  const showCreate = creating || empty;
  return (
    <>
      <ProjectNav projectId={projectId} actions={!empty && <Button variant="primary" onClick={() => setCreating((v) => !v)} aria-expanded={creating}><Icon name="plus" size={18} />New form</Button>} />
      <div className="container" style={{ width: "100%" }}>
        {empty && !loading && (
          <p className="page-header-lede" style={{ marginBottom: "var(--s-5)" }}>A form sets what collectors record at each place. Create the first one to start collecting.</p>
        )}
        {showCreate && (
          <form className="card inline-panel" onSubmit={create} aria-label="New form">
            <h2>New form</h2>
            <div className="field"><label htmlFor="fn">Name</label><input id="fn" required value={name} onChange={(e) => setName(e.target.value)} placeholder="For example, Water point" autoFocus={creating} /></div>
            <div className="field"><label htmlFor="fg">What do collectors capture?</label>
              <select id="fg" value={geom} onChange={(e) => setGeom(e.target.value as GeometryType)}>
                {(Object.keys(GEOMETRY_LABEL) as GeometryType[]).map((g) => <option key={g} value={g}>A {GEOMETRY_LABEL[g]}</option>)}
              </select>
              <span className="field-hint">This is the shape drawn on the map for each record. It cannot be changed later.</span>
            </div>
            <div className="row"><Button type="submit" variant="primary" busy={busy}>Create and open builder</Button>{creating && <Button onClick={() => setCreating(false)}>Cancel</Button>}</div>
          </form>
        )}
        {loading && <Loading label="Loading forms…" />}
        {error != null && <ErrorState error={error} onRetry={reload} />}
        {data && data.length > 0 && (
          <ul className="form-list" aria-label="Forms">
            {data.map((f) => (
              <li className="list-item form-row" key={f.id}>
                <span className="form-row-icon" aria-hidden="true"><Icon name={f.geometry_type === "Point" ? "point" : f.geometry_type.includes("Line") ? "line" : "polygon"} size={20} /></span>
                <div className="grow">
                  <Link className="form-row-title" to={`/collect/${projectId}/forms/${f.id}`}>{f.name}</Link>
                  <small>{GEOMETRY_LABEL[f.geometry_type]} · {f.fields.length} {f.fields.length === 1 ? "question" : "questions"} · version {f.version}</small>
                </div>
                <span className={`badge ${f.status === "published" ? "badge-ok" : "badge-warn"}`}>{f.status === "published" ? "Published" : "Draft"}</span>
                <div className="form-row-actions">
                  {f.status === "published" && <Link className="btn btn-sm" to={`/collect/${projectId}/forms/${f.id}/share`}><Icon name="share" size={16} />Share</Link>}
                  <Link className="btn btn-sm" to={`/collect/${projectId}/forms/${f.id}`}><Icon name="reshape" size={16} />Edit</Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
