import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import DashAppBar from "../components/dashboard/DashAppBar";
import { useActiveProject } from "../components/dashboard/useActiveProject";
import { Button, EmptyState, ErrorState, Loading, useConfirm, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { newPage } from "../lib/dashboard";
import { useAsync } from "../lib/hooks";
import type { Dashboard } from "../lib/types";

const elementCount = (d: Dashboard) => d.config.pages.reduce((n, p) => n + p.widgets.length, 0);

/** The gallery of a project's dashboards. Each card opens the dashboard in its own full-screen workspace. */
export function DashboardGallery({ dashboards, canEdit, onDelete }: { dashboards: Dashboard[]; canEdit: boolean; onDelete: (d: Dashboard) => void }) {
  return (
    <div className="dash-gallery" role="list">
      {dashboards.map((d) => {
        const n = elementCount(d), pages = d.config.pages.length;
        return (
          <div key={d.id} className="dash-card" role="listitem">
            <Link className="dash-card-link" to={`/dashboards/${d.id}`}>
              <div className="dash-card-thumb" aria-hidden="true">
                <svg viewBox="0 0 48 48" width={40} height={40}>
                  <rect x="5" y="6" width="16" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
                  <rect x="25" y="6" width="18" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
                  <rect x="5" y="26" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
                  <rect x="27" y="20" width="16" height="22" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
                </svg>
                <span className="dash-card-badge">{n} {n === 1 ? "element" : "elements"}</span>
              </div>
              <div className="dash-card-body">
                <strong>{d.name}{d.shared && <span className="dash-card-public" title="Anyone with the link can view it">Public link</span>}</strong>
                <span>{d.config.description || "No description"}</span>
                <small>{pages} {pages === 1 ? "page" : "pages"} · updated {new Date(d.updated_at).toLocaleDateString()}</small>
              </div>
            </Link>
            {canEdit && <Button small variant="ghost" className="dash-card-delete" onClick={() => onDelete(d)} aria-label={`Delete ${d.name}`}>Delete</Button>}
          </div>
        );
      })}
    </div>
  );
}

export default function DashboardApp() {
  const nav = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { projects, viewable, active, choose } = useActiveProject();
  const list = useAsync((api) => (active ? api.listDashboards(active.id) : Promise.resolve([] as Dashboard[])), [active?.id]);
  const [creating, setCreating] = useState(false);
  const canEdit = active?.role === "owner" || active?.role === "admin";

  async function create() {
    if (!active) return;
    setCreating(true);
    try {
      const api = await loadApi();
      const forms = await api.listForms(active.id);
      // A project with a single form needs no choosing: the first page already reads its records.
      const d = await api.createDashboard(active.id, "Untitled dashboard", { pages: [newPage("Overview", forms.length === 1 ? forms[0].id : undefined)] });
      nav(`/dashboards/${d.id}`);
    } catch (e) { toast(e instanceof Error ? e.message : "Could not create the dashboard.", "error"); setCreating(false); }
  }
  async function remove(d: Dashboard) {
    if (!(await confirm({ title: `Delete “${d.name}”?`, message: "Its elements are removed. The collected data is not touched.", confirmLabel: "Delete dashboard", danger: true }))) return;
    try { await (await loadApi()).deleteDashboard(d.id); void list.reload(); toast("Dashboard deleted.", "success"); }
    catch (e) { toast(e instanceof Error ? e.message : "Could not delete.", "error"); }
  }

  let body;
  if (projects.loading && !projects.data) body = <Loading label="Loading…" />;
  else if (projects.error != null) body = <ErrorState error={projects.error} onRetry={() => void projects.reload()} />;
  else if (!projects.data?.length) body = <EmptyState title="No projects yet" action={<Link className="btn btn-primary" to="/collect">Go to Data collection</Link>}>Create a project and collect some data first. Dashboards show what a project has collected.</EmptyState>;
  else if (!active) body = <EmptyState title="No dashboards for you">Dashboards are for project administrators and viewers. You are a collector on your projects.</EmptyState>;
  else if (list.error != null) body = <ErrorState error={list.error} onRetry={() => void list.reload()} />;
  else if (list.loading && !list.data) body = <Loading label="Loading dashboards…" />;
  else {
    const items = list.data ?? [];
    body = (<>
      <div className="dash-gallery-head"><span className="dash-gallery-filter">All dashboards</span><span className="dash-gallery-count">Count: {items.length}</span></div>
      {items.length === 0
        ? <EmptyState title="No dashboards yet">{canEdit ? <>Use “+ New dashboard” above to start building one.</> : "An administrator has not created any dashboards for this project."}</EmptyState>
        : <DashboardGallery dashboards={items} canEdit={canEdit} onDelete={(d) => void remove(d)} />}
    </>);
  }

  return (
    <div className="dapp">
      <DashAppBar />
      <div className="dapp-toolbar">
        <h1>My Dashboards</h1>
        {viewable.length > 1 && (
          <label className="dapp-project"><span className="sr-only">Project</span>
            <select value={active?.id ?? ""} onChange={(e) => choose(e.target.value)} aria-label="Project">
              {viewable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
        )}
        {viewable.length === 1 && active && <span className="dapp-project-name">{active.name}</span>}
        <span className="grow" />
        {canEdit && <button type="button" className="dapp-new" onClick={() => void create()} disabled={creating}>{creating ? "Creating…" : "+ New dashboard"}</button>}
      </div>
      <div className="container dapp-page">{body}</div>
    </div>
  );
}
