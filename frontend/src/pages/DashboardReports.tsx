import { useMemo, useState } from "react";
import DashAppBar from "../components/dashboard/DashAppBar";
import ReportView from "../components/dashboard/ReportView";
import { useActiveProject } from "../components/dashboard/useActiveProject";
import { Button, EmptyState, ErrorState, Loading, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { buildReport, type Report } from "../lib/dashboardReport";
import { useAsync } from "../lib/hooks";
import type { Dashboard } from "../lib/types";

export default function DashboardReports() {
  const toast = useToast();
  const { projects, viewable, active, choose } = useActiveProject();
  const list = useAsync((api) => (active ? api.listDashboards(active.id) : Promise.resolve([] as Dashboard[])), [active?.id]);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());            // dashboards the person un-ticked
  const [includeRecords, setIncludeRecords] = useState(true);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const dashboards = useMemo(() => list.data ?? [], [list.data]);
  const picked = dashboards.filter((d) => !skipped.has(d.id));

  async function generate() {
    if (!active || !picked.length) return;
    setBusy(true);
    try {
      const api = await loadApi();
      // Read the records now, so the report is a snapshot of the moment it was made.
      const [forms, features] = await Promise.all([api.listForms(active.id), api.listFeatures(active.id)]);
      setReport(buildReport({ projectName: active.name, dashboards: picked, forms, features, options: { includeRecords } }));
    } catch (e) { toast(e instanceof Error ? e.message : "Could not make the report.", "error"); }
    finally { setBusy(false); }
  }

  let body;
  if (projects.loading && !projects.data) body = <Loading label="Loading…" />;
  else if (projects.error != null) body = <ErrorState error={projects.error} onRetry={() => void projects.reload()} />;
  else if (!active) body = <EmptyState title="No projects to report on">Create a project and a dashboard first.</EmptyState>;
  else if (list.error != null) body = <ErrorState error={list.error} onRetry={() => void list.reload()} />;
  else if (list.loading && !list.data) body = <Loading label="Loading dashboards…" />;
  else body = (<>
    <section className="card report-controls" style={{ maxWidth: 720 }}>
      <h2>Make a report</h2>
      <p className="meta">A report is a snapshot of the dashboards you choose, worked out from the records as they are right now. Print it, or save it as a PDF from the print window.</p>
      {dashboards.length === 0
        ? <p className="meta">This project has no dashboards yet. Make one in <strong>Dashboards</strong> first.</p>
        : <>
          <div className="field"><span className="label">Dashboards to include</span>
            <div className="cols" role="group" aria-label="Dashboards to include">
              {dashboards.map((d) => <label key={d.id}><input type="checkbox" checked={!skipped.has(d.id)} onChange={() => setSkipped((s) => { const n = new Set(s); if (n.has(d.id)) n.delete(d.id); else n.add(d.id); return n; })} />{d.name}</label>)}
            </div></div>
          <label className="check-row"><input type="checkbox" checked={includeRecords} onChange={(e) => setIncludeRecords(e.target.checked)} />Include record tables and lists (leave off for a short report of numbers and charts)</label>
          <div className="row"><Button variant="primary" busy={busy} disabled={!picked.length} onClick={() => void generate()}>Make report</Button></div>
        </>}
    </section>
    {report && (<>
      <div className="report-controls report-actions"><Button variant="primary" onClick={() => window.print()}>Print / Save as PDF</Button><Button variant="ghost" onClick={() => setReport(null)}>Close report</Button></div>
      <ReportView report={report} />
    </>)}
  </>);

  return (
    <div className="dapp">
      <DashAppBar />
      <div className="dapp-toolbar"><h1>Reports</h1>
        {viewable.length > 1 && <label className="dapp-project"><span className="sr-only">Project</span>
          <select value={active?.id ?? ""} onChange={(e) => { setReport(null); setSkipped(new Set()); choose(e.target.value); }} aria-label="Project">{viewable.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
        {viewable.length === 1 && active && <span className="dapp-project-name">{active.name}</span>}
      </div>
      <div className="container dapp-page">{body}</div>
    </div>
  );
}
