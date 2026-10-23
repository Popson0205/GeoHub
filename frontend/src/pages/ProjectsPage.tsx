import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Button, EmptyState, ErrorState, Loading, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { useAsync } from "../lib/hooks";
import type { License, Project } from "../lib/types";

export default function ProjectsPage() {
  const toast = useToast();
  const { data, error, loading, reload } = useAsync((api) => api.listProjects(), []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState<Project | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await (await loadApi()).createProject(name.trim());
      setName(""); setCreating(false);
      toast("Project created.", "success");
      await reload();
    } catch (err) { toast(err instanceof Error ? err.message : "Could not create the project.", "error"); }
    finally { setBusy(false); }
  }

  return (
    <div className="container" style={{ width: "100%" }}>
      <div className="page-head">
        <h1>Data collection</h1><span className="grow" />
        <Button variant="accent" onClick={() => setCreating((v) => !v)}>New project</Button>
      </div>

      {creating && (
        <form className="card" onSubmit={create} style={{ marginBottom: 20, maxWidth: 480 }}>
          <div className="field"><label htmlFor="pname">Project name</label><input id="pname" required value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
          <div className="row"><Button type="submit" variant="primary" busy={busy}>Create project</Button><Button onClick={() => setCreating(false)}>Cancel</Button></div>
        </form>
      )}

      {publishing && <PublishPanel project={publishing} onClose={() => setPublishing(null)} />}
      {loading && <Loading label="Loading projects…" />}
      {error != null && <ErrorState error={error} onRetry={reload} />}
      {data && data.length === 0 && <EmptyState title="No projects yet">Create a project to build a form, invite collectors and start collecting.</EmptyState>}
      {data && data.length > 0 && (
        <div className="grid-cards">
          {data.map((p) => (
            <article className="card" key={p.id}>
              <div className="thumb" aria-hidden="true" />
              <h2>{p.name}</h2>
              <div className="meta">{p.collector_count} collectors · {p.feature_count} features · updated {new Date(p.updated_at).toLocaleDateString()}</div>
              <div className="actions">
                <Link className="btn btn-primary" to={`/collect/${p.id}`}>Collect</Link>
                {(p.role === "owner" || p.role === "admin") && <Link className="btn" to={`/collect/${p.id}/forms`}>Forms</Link>}
                <Link className="btn" to={`/collect/${p.id}/data`}>Collected data</Link>
                <Link className="btn" to={`/collect/${p.id}/review`}>Map review</Link>
                {(p.role === "owner" || p.role === "admin") && <Button onClick={() => setPublishing(p)}>Publish</Button>}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export function PublishPanel({ project, onClose }: { project: Project; onClose: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(project.name);
  const [description, setDescription] = useState("");
  const [license, setLicense] = useState<License>("ODbL");
  const [busy, setBusy] = useState(false);
  const { data: forms, loading: formsLoading } = useAsync((api) => api.listForms(project.id), [project.id]);
  const published = (forms ?? []).filter((f) => f.version > 0);
  const [formId, setFormId] = useState("");
  useEffect(() => { if (!formId && published.length) setFormId(published[0].id); }, [published.length]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const d = await (await loadApi()).publishDataset(project.id, { form_id: formId, title, description, license });
      toast(`Published "${d.title}" (version ${d.latest_version}).`, "success");
      onClose();
    } catch (err) { toast(err instanceof Error ? err.message : "Could not publish.", "error"); }
    finally { setBusy(false); }
  }
  return (
    <form className="card" onSubmit={submit} style={{ marginBottom: 20, maxWidth: 560 }} aria-label="Publish dataset">
      <h2>Publish to the data hub</h2>
      <p className="meta" style={{ margin: 0 }}>This takes a snapshot of the project's features. Later changes need a new version.</p>
      {!formsLoading && !published.length && <div className="state"><span>This project has no published form yet. Publish a form first; a dataset is built from one form.</span></div>}
      {published.length > 0 && (
        <div className="field"><label htmlFor="pf">Form to publish</label>
          <select id="pf" value={formId} onChange={(e) => setFormId(e.target.value)}>
            {published.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
      )}
      <div className="field"><label htmlFor="pt">Dataset title</label><input id="pt" required value={title} onChange={(e) => setTitle(e.target.value)} /></div>
      <div className="field"><label htmlFor="pd">Description</label><textarea id="pd" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      <div className="field"><label htmlFor="pl">Licence</label>
        <select id="pl" value={license} onChange={(e) => setLicense(e.target.value as License)}>
          {(["ODbL", "CC BY 4.0", "CC0", "Private"] as License[]).map((l) => <option key={l}>{l}</option>)}
        </select>
      </div>
      <div className="row"><Button type="submit" variant="primary" busy={busy} disabled={!formId}>Publish</Button><Button onClick={onClose}>Cancel</Button></div>
    </form>
  );
}
