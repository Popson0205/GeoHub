import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import ProjectNav from "../components/ProjectNav";
import MapViewer, { type ViewerImagery, type ViewerLayer } from "../components/MapViewer";
import { ErrorState, Loading } from "../components/ui";
import { loadApi } from "../lib/api";
import type { FeatureStatus } from "../lib/types";
import { useAsync } from "../lib/hooks";
import { loadViewerStyle, saveViewerStyle, type ViewerStyle } from "../lib/symbology";

/**
 * The map of a project's collected data. It is a viewer, not a form: it shows what has been collected, one layer per form,
 * and lets you change how each layer is drawn. Adding and correcting records happens in the forms and in Collected data.
 */
export default function EditorPage() {
  const { projectId = "" } = useParams();
  const { data, error, loading, reload } = useAsync(async (api) => {
    const [project, forms, features, imagery] = await Promise.all([api.getProject(projectId), api.listForms(projectId), api.listFeatures(projectId), api.listImagery(projectId)]);
    return { project, forms: forms.filter((f) => f.status === "published" || f.version > 0), features, imagery };
  }, [projectId]);

  // How the layers are drawn is remembered per project, and the dashboard map starts from it.
  const [style, setStyle] = useState<ViewerStyle>(() => loadViewerStyle(projectId));
  useEffect(() => { setStyle(loadViewerStyle(projectId)); }, [projectId]);
  const change = (next: ViewerStyle) => { setStyle(next); saveViewerStyle(projectId, next); };

  // Filters: review status and when the record last changed.
  const [status, setStatus] = useState<"all" | FeatureStatus>("all");
  const [days, setDays] = useState<number | null>(null);
  const shown = useMemo(() => {
    const since = days == null ? "" : new Date(Date.now() - days * 86400000).toISOString();
    return (data?.features ?? []).filter((f) => !f.deleted && (status === "all" || f.status === status) && (!since || f.updated_at >= since));
  }, [data, status, days]);
  const total = useMemo(() => (data?.features ?? []).filter((f) => !f.deleted).length, [data]);
  const layers = useMemo<ViewerLayer[]>(() => (data?.forms ?? []).map((f) => ({ id: f.id, name: f.name, form: f, features: shown.filter((x) => x.form_id === f.id) })), [data, shown]);

  // Imagery tiles come with signed addresses, so they are asked for once the list is known.
  const [tiles, setTiles] = useState<ViewerImagery[]>([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const api = await loadApi();
      const next: ViewerImagery[] = [];
      for (const i of data?.imagery ?? []) { const url = i.status === "ready" ? api.imageryTileUrl(i.id) : null; if (url) next.push({ id: i.id, name: i.name, url }); }
      if (alive) setTiles(next);
    })().catch(() => { if (alive) setTiles([]); });
    return () => { alive = false; };
  }, [data?.imagery]);

  if (loading) return <Loading label="Loading project…" />;
  if (error != null || !data) return <div className="container"><ErrorState error={error} onRetry={reload} /></div>;

  return (
    <div className="viewer-page" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <ProjectNav projectId={projectId} project={data.project} compact />
      <MapViewer layers={layers} imagery={tiles} style={style} onStyleChange={change} label="Collected data map" fitKey={projectId} cluster
        toolbar={
          <div className="map-filters" role="group" aria-label="Show on the map">
            <label><span className="sr-only">Review status</span>
              <select className="input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Review status">
                <option value="all">All records</option><option value="submitted">Waiting for review</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="draft">Drafts</option>
              </select>
            </label>
            <label><span className="sr-only">Changed</span>
              <select className="input" value={days ?? ""} onChange={(e) => setDays(e.target.value ? Number(e.target.value) : null)} aria-label="Changed">
                <option value="">Any time</option><option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option>
              </select>
            </label>
            <span className="map-filters-count" aria-live="polite">{shown.length === total ? `${total} records` : `${shown.length} of ${total} records`}</span>
            {(status !== "all" || days != null) && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setStatus("all"); setDays(null); }}>Clear</button>}
          </div>
        } />
    </div>
  );
}
