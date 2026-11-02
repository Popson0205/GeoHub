import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import FootprintThumb from "../components/FootprintThumb";
import { Icon } from "../components/icons";
import { Button, CardSkeletons, EmptyState, ErrorState, MoreMenu, PageHeader, useToast, type MoreMenuItem } from "../components/ui";
import { loadApi } from "../lib/api";
import { useAsync } from "../lib/hooks";
import type { DatasetVisibility, License, Project } from "../lib/types";
import VisibilityField from "../components/VisibilityField";

export default function ProjectsPage() {
  const toast = useToast();
  const nav = useNavigate();
  const { data, error, loading, reload } = useAsync((api) => api.listProjects(), []);
  // ?new=1 (from the home page) opens the "New project" panel straight away.
  const [creating, setCreating] = useState(() => new URLSearchParams(window.location.search).get("new") === "1");
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

  const newButton = <Button variant="primary" onClick={() => setCreating((v) => !v)} aria-expanded={creating}><Icon name="plus" size={18} />New project</Button>;
  return (
    <div className="container" style={{ width: "100%" }}>
      <PageHeader title="Data collection" lede="Build a form, send collectors into the field with it, then review what comes back before you publish it." actions={newButton} />

      {creating && (
        <form className="card inline-panel" onSubmit={create} aria-label="New project">
          <h2>New project</h2>
          <div className="field"><label htmlFor="pname">Project name</label><input id="pname" required value={name} onChange={(e) => setName(e.target.value)} placeholder="For example, Water points survey" autoFocus /></div>
          <div className="row"><Button type="submit" variant="primary" busy={busy}>Create project</Button><Button onClick={() => setCreating(false)}>Cancel</Button></div>
        </form>
      )}

      {publishing && <PublishPanel project={publishing} onClose={() => setPublishing(null)} />}
      {loading && <CardSkeletons />}
      {error != null && <ErrorState error={error} onRetry={reload} />}
      {data && data.length === 0 && !creating && (
        <EmptyState icon="navCollect" title="No projects yet" action={newButton}>
          A project holds your forms, the people collecting with them, and everything they send back.
        </EmptyState>
      )}
      {data && data.length > 0 && (
        <div className="grid-cards">
          {data.map((p) => {
            const manage = p.role === "owner" || p.role === "admin";
            // A collector's job is collecting; everyone else lands on the data the project has gathered.
            const home = p.role === "collector" ? `/collect/${p.id}` : `/collect/${p.id}/data`;
            const more: MoreMenuItem[] = [
              { label: "Open map", icon: "navMap", onSelect: () => nav(`/collect/${p.id}/review`) },
              ...(manage ? [{ label: "Edit forms", icon: "form" as const, onSelect: () => nav(`/collect/${p.id}/forms`) }] : []),
              ...(p.role !== "collector" ? [{ label: "Dashboards", icon: "navDash" as const, onSelect: () => nav(`/dashboards?project=${p.id}`) }] : []),
              ...(manage ? [{ label: "Publish to data hub", icon: "globe" as const, onSelect: () => setPublishing(p) }] : []),
            ];
            return (
              <article className="card item-card" key={p.id}>
                <FootprintThumb kind="project" id={p.id} version={`${p.updated_at}:${p.feature_count}`} />
                <div className="item-card-body">
                  <h2><Link to={home}>{p.name}</Link></h2>
                  <div className="item-stats">
                    <span><Icon name="point" size={15} />{p.feature_count} {p.feature_count === 1 ? "record" : "records"}</span>
                    <span><Icon name="users" size={15} />{p.collector_count} {p.collector_count === 1 ? "collector" : "collectors"}</span>
                    <span>Updated {new Date(p.updated_at).toLocaleDateString()}</span>
                  </div>
                </div>
                <div className="item-card-foot">
                  <Link className="btn btn-primary" to={`/collect/${p.id}`}><Icon name="navCollect" size={18} />Collect</Link>
                  {manage && (p.waiting_count ?? 0) > 0
                    ? <Link className="btn btn-attention" to={`/collect/${p.id}/data?review=1`}>Review {p.waiting_count}<span className="sr-only"> waiting records</span></Link>
                    : p.role !== "collector" && <Link className="btn" to={`/collect/${p.id}/data`}>View data</Link>}
                  <span className="grow" />
                  <MoreMenu label={`More for ${p.name}`} items={more} />
                </div>
              </article>
            );
          })}
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
  const [visibility, setVisibility] = useState<DatasetVisibility>("public");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const { data: forms, loading: formsLoading } = useAsync((api) => api.listForms(project.id), [project.id]);
  const published = (forms ?? []).filter((f) => f.version > 0);
  const [formId, setFormId] = useState("");
  useEffect(() => { if (!formId && published.length) setFormId(published[0].id); }, [published.length]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const api = await loadApi();
      const { dataset, job: first } = await api.publishDataset(project.id, { form_id: formId, title, description, license, visibility });
      // The snapshot is built in the background. Wait for it, so we only say "published" when it really is.
      let job = first;
      for (let i = 0; i < 60 && (job.status === "queued" || job.status === "running"); i++) {
        setStatus(job.status === "queued" ? "Waiting for the publisher to start…" : `Publishing… ${Math.round(job.progress)}%`);
        await new Promise((r) => setTimeout(r, 1500));
        job = await api.getJob(job.id);
      }
      if (job.status === "failed") throw new Error(job.error || "Publishing failed.");
      if (job.status !== "done") throw new Error("Publishing has not started. The background worker may not be running on the server; the dataset stays unpublished until it is.");
      toast(`Published "${dataset.title}" (version ${Math.max(dataset.latest_version, 1)}).`, "success");
      onClose();
    } catch (err) { toast(err instanceof Error ? err.message : "Could not publish.", "error"); }
    finally { setBusy(false); setStatus(""); }
  }
  return (
    <form className="card inline-panel" onSubmit={submit} style={{ maxWidth: 560 }} aria-label="Publish dataset">
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
      <VisibilityField id="pvis-project" value={visibility} onChange={setVisibility} license={license} membersLabel="This project's people only" />
      <div className="row"><Button type="submit" variant="primary" busy={busy} disabled={!formId}>Publish</Button><Button onClick={onClose}>Cancel</Button>{status && <span className="meta" role="status">{status}</span>}</div>
    </form>
  );
}
