import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import MapView, { type MapFeature } from "../components/MapView";
import { Button, ErrorState, Loading, useToast } from "../components/ui";
import { config } from "../lib/config";
import { loadApi } from "../lib/api";
import { useAsync } from "../lib/hooks";
import type { ExportFormat } from "../lib/types";

const FORMATS: { id: ExportFormat; label: string }[] = [
  { id: "geojson", label: "GeoJSON" }, { id: "gpkg", label: "GeoPackage" }, { id: "shp", label: "Shapefile" }, { id: "csv", label: "CSV" },
];

export default function DatasetPage() {
  const { slug = "" } = useParams();
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(async (api) => ({ dataset: await api.getDataset(slug), fc: await api.datasetFeatures(slug) }), [slug]);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [progress, setProgress] = useState(0);

  const features: MapFeature[] = useMemo(() => (data?.fc.features ?? []).map((f) => ({ id: f.id, geometry: f.geometry, properties: f.properties })), [data]);

  async function download(format: ExportFormat) {
    setBusy(format); setProgress(0);
    try {
      const api = await loadApi();
      let job = await api.createExport(slug, format);
      for (let i = 0; i < 90 && job.status !== "done" && job.status !== "failed"; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        job = await api.getJob(job.id);
        setProgress(job.progress);
      }
      if (job.status === "failed") throw new Error(job.error || "The export failed.");
      if (job.status !== "done" || !job.download_url) throw new Error("The export is taking too long. Try again in a minute.");
      const a = document.createElement("a");
      a.href = job.download_url; a.download = `${slug}.${format === "gpkg" ? "gpkg" : format === "shp" ? "zip" : format}`;
      document.body.appendChild(a); a.click(); a.remove();
      toast(`${format.toUpperCase()} download started.`, "success");
    } catch (e) { toast(e instanceof Error ? e.message : "Download failed.", "error"); }
    finally { setBusy(null); }
  }

  if (loading) return <Loading label="Loading dataset…" />;
  if (error != null || !data) return <div className="container"><ErrorState error={error} onRetry={reload} /></div>;
  const d = data.dataset;
  const api = config.useMock ? "(mock mode: no live API)" : `${config.apiUrl}/datasets/${d.slug}/features`;

  return (
    <div className="container detail" style={{ width: "100%" }}>
      <div>
        <Link to="/hub">Back to datasets</Link>
        <h1 style={{ margin: "8px 0 16px", fontSize: 34 }}>{d.title}</h1>
        <div className="preview"><MapView features={features} fitKey={d.slug} label="Dataset preview" /></div>
        <p style={{ marginTop: 20, maxWidth: 640, lineHeight: 1.6 }}>{d.description || "No description yet."}</p>
      </div>
      <aside className="stack">
        <section className="card" aria-label="Download">
          <h2>Download</h2>
          {FORMATS.filter((f) => d.formats.includes(f.id)).map((f, i) => (
            <Button key={f.id} variant={i === 0 ? "primary" : "default"} busy={busy === f.id} disabled={!!busy} onClick={() => download(f.id)}>
              {busy === f.id ? `Preparing… ${progress}%` : f.label}
            </Button>
          ))}
        </section>
        <section className="card" aria-label="Details">
          <h2>About this data</h2>
          <dl className="kv">
            <dt>Licence</dt><dd>{d.license}</dd>
            <dt>Features</dt><dd>{d.feature_count}</dd>
            <dt>Version</dt><dd>{d.latest_version}</dd>
            <dt>Updated</dt><dd>{new Date(d.updated_at).toLocaleDateString()}</dd>
            <dt>Coordinates</dt><dd className="mono">EPSG:4326</dd>
          </dl>
        </section>
        {d.contributors && d.contributors.length > 0 && (
          <section className="card" aria-label="Contributors">
            <h2>Mapped by</h2>
            <ul className="plain-list">
              {d.contributors.map((c) => <li key={c.name} className="row"><span className="grow">{c.name}</span><span className="field-hint">{c.features} {c.features === 1 ? "feature" : "features"}</span></li>)}
            </ul>
          </section>
        )}
        {d.map_id && <section className="card" aria-label="Source"><span className="field-hint">Published from a shared map.</span><Link to={`/maps/${d.map_id}/portal?tab=publish`}>Open the map portal</Link></section>}
        <section className="card" aria-label="Use in your app">
          <h2>Use in your app</h2>
          <div className="mono" style={{ background: "var(--paper)", padding: 10, borderRadius: 6, wordBreak: "break-all" }}>{api}</div>
        </section>
      </aside>
    </div>
  );
}
