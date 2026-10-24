import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button, EmptyState, ErrorState, Loading, useConfirm, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { starterWidgets } from "../lib/dashboard";
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
  const [formId, setFormId] = useState("");
  const [starter, setStarter] = useState(true);
  const [busy, setBusy] = useState(false);

  if (project.loading || forms.loading || list.loading) return <div className="container"><Loading /></div>;
  const err = project.error ?? forms.error ?? list.error;
  if (err != null) return <div className="container"><ErrorState error={err} onRetry={() => { void project.reload(); void forms.reload(); void list.reload(); }} /></div>;

  const canEdit = project.data?.role === "owner" || project.data?.role === "admin";
  const allForms = forms.data ?? [];
  const formName = (id?: string) => allForms.find((f) => f.id === id)?.name;
  const chosen = allForms.find((f) => f.id === (formId || allForms[0]?.id));

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!chosen || !name.trim()) return;
    setBusy(true);
    try {
      const d = await (await loadApi()).createDashboard(projectId, name.trim(), { form_id: chosen.id, widgets: starter ? starterWidgets(chosen) : [] });
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
        : <form className="card" onSubmit={(e) => void create(e)} style={{ maxWidth: 560, marginBottom: "var(--s-5)" }}>
          <h2>New dashboard</h2>
          <div className="field"><label htmlFor="dn">Name</label><input id="dn" required value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="For example, Water points overview" /></div>
          <div className="field"><label htmlFor="df">Show records from</label>
            <select id="df" value={chosen?.id ?? ""} onChange={(e) => setFormId(e.target.value)}>{allForms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></div>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}><input type="checkbox" checked={starter} onChange={(e) => setStarter(e.target.checked)} />Start with suggested charts</label>
          <div><Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>Create dashboard</Button></div>
        </form>)}

      {(list.data ?? []).length === 0
        ? <EmptyState title="No dashboards yet">{canEdit ? "Create one above to see your data as charts." : "An administrator has not created any dashboards for this project."}</EmptyState>
        : <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
          {(list.data ?? []).map((d) => (
            <div key={d.id} className="list-item">
              <div className="grow"><strong>{d.name}</strong>
                <small>{formName(d.config.form_id) ?? "No form chosen"} · {d.config.widgets.length} {d.config.widgets.length === 1 ? "chart" : "charts"}</small></div>
              <Link className="btn btn-primary btn-sm" to={`/collect/${projectId}/dashboards/${d.id}`}>Open</Link>
              {canEdit && <Button small variant="danger" onClick={() => void remove(d.id, d.name)}>Delete</Button>}
            </div>
          ))}
        </div>}
    </div>
  );
}
