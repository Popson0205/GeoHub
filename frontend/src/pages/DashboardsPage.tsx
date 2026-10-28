import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button, EmptyState, ErrorState, Loading, useConfirm, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import TemplatePicker from "../components/TemplatePicker";
import { MAX_PAGES } from "../lib/dashboard";
import { templatePages, type TemplateId } from "../lib/dashboardTemplates";
import { useAsync } from "../lib/hooks";

/** The project's dashboards: charts over the collected data. Administrators build them; viewers read them. */
export default function DashboardsPage() {
  const { projectId = "" } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const project = useAsync((api) => api.getProject(projectId), [projectId]);
  const forms = useAsync((api) => api.listForms(projectId), [projectId]);
  const list = useAsync((api) => api.listDashboards(projectId), [projectId]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<string[] | null>(null);          // forms that become pages; null = all of them
  const [overview, setOverview] = useState(true);
  const [template, setTemplate] = useState<TemplateId>("standard");
  const [busy, setBusy] = useState(false);

  if (project.loading || forms.loading || list.loading) return <div className="container"><Loading /></div>;
  const err = project.error ?? forms.error ?? list.error;
  if (err != null) return <div className="container"><ErrorState error={err} onRetry={() => { void project.reload(); void forms.reload(); void list.reload(); }} /></div>;

  const canEdit = project.data?.role === "owner" || project.data?.role === "admin";
  const allForms = forms.data ?? [];
  const chosen = allForms.filter((f) => (picked ?? allForms.map((x) => x.id)).includes(f.id)).slice(0, MAX_PAGES - 1);
  const toggle = (id: string) => setPicked((cur) => { const base = cur ?? allForms.map((x) => x.id); return base.includes(id) ? base.filter((x) => x !== id) : [...base, id]; });

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!chosen.length || !name.trim()) return;
    setBusy(true);
    try {
      // One page per chosen form (say Army, Air Force, Navy), plus a joint overview when there are several.
      const pages = templatePages(template, chosen, overview);
      const d = await (await loadApi()).createDashboard(projectId, name.trim(), { description: description.trim() || undefined, pages });
      nav(`/collect/${projectId}/dashboards/${d.id}`, { state: { edit: true } });
    } catch (e2) { toast(e2 instanceof Error ? e2.message : "Could not create the dashboard.", "error"); setBusy(false); }
  }
  async function remove(id: string, title: string) {
    if (!(await confirm({ title: `Delete “${title}”?`, message: "The charts are removed. The collected data is not touched.", confirmLabel: "Delete dashboard", danger: true }))) return;
    try { await (await loadApi()).deleteDashboard(id); void list.reload(); toast("Dashboard deleted.", "success"); }
    catch (e) { toast(e instanceof Error ? e.message : "Could not delete.", "error"); }
  }

  return (
    <div className="container" style={{ width: "100%" }}>
      <div className="page-head"><h1>Dashboards</h1><span className="grow" />
        <Link className="btn" to={`/collect/${projectId}/data`}>Collected data</Link>
        <Link className="btn" to="/collect">Back to projects</Link></div>
      <p className="meta">{project.data?.name}. Charts, numbers, tables and maps that update from the data you have collected.</p>

      {canEdit && (allForms.length === 0
        ? <div className="state"><span>Create a form and collect some data first.</span><Link to={`/collect/${projectId}/forms`}>Go to forms</Link></div>
        : <form className="card" onSubmit={(e) => void create(e)} style={{ maxWidth: 940, marginBottom: "var(--s-5)" }}>
          <h2>New dashboard</h2>
          <p className="meta">Make one dashboard for each department or team. Each form you pick becomes a page of that dashboard.</p>
          <div className="field"><label htmlFor="dn">Name</label><input id="dn" required value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="For example, Ministry of Defence" /></div>
          <div className="field"><label htmlFor="dd">Description (optional)</label><input id="dd" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} placeholder="What it reports, and for whom" /></div>
          <div className="field"><span id="dpl" className="label">Pages: one for each form</span>
            <div className="cols" role="group" aria-labelledby="dpl" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {allForms.map((f) => <label key={f.id} style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={chosen.some((c) => c.id === f.id)} onChange={() => toggle(f.id)} />{f.name}</label>)}
            </div>
            <small className="meta">You can rename, reorder, add and remove pages later.</small></div>
          {chosen.length > 1 && <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={overview} disabled={template === "blank"} onChange={(e) => setOverview(e.target.checked)} />Add an overview page that compares them</label>}
          <div className="field"><span id="dtl" className="label">Start from a template</span>
            <TemplatePicker value={template} onChange={setTemplate} />
            <small className="meta">Every template can be changed afterwards: move and resize charts, add and remove them, or apply a different template to a page.</small></div>
          <div><Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || !chosen.length}>Create dashboard</Button></div>
        </form>)}

      {(list.data ?? []).length === 0
        ? <EmptyState title="No dashboards yet">{canEdit ? "Create one above to see your data as charts." : "An administrator has not created any dashboards for this project."}</EmptyState>
        : <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
          {(list.data ?? []).map((d) => (
            <div key={d.id} className="list-item">
              <div className="grow"><strong>{d.name}</strong>
                {d.config.description && <small>{d.config.description}</small>}
                <small>{d.config.pages.length} {d.config.pages.length === 1 ? "page" : "pages"} · {d.config.pages.reduce((n, p) => n + p.widgets.length, 0)} charts</small>
                {d.config.pages.length > 1 && <div className="chips" style={{ marginTop: 4 }}>{d.config.pages.map((p) => (
                  <Link key={p.id} className="chip-x" to={`/collect/${projectId}/dashboards/${d.id}?page=${p.id}`}>{p.title}</Link>))}</div>}</div>
              <Link className="btn btn-primary btn-sm" to={`/collect/${projectId}/dashboards/${d.id}`}>Open</Link>
              {canEdit && <Button small variant="danger" onClick={() => void remove(d.id, d.name)}>Delete</Button>}
            </div>
          ))}
        </div>}
    </div>
  );
}
