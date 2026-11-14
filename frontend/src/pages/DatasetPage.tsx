import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import MapView, { type MapFeature } from "../components/MapView";
import { Button, ErrorState, Loading, useToast } from "../components/ui";
import { config } from "../lib/config";
import { ApiError, loadApi } from "../lib/api";
import { useAsync } from "../lib/hooks";
import type { ExportFormat, FeatureCollection, RasterInfo } from "../lib/types";

const FORMATS: { id: ExportFormat; label: string }[] = [
  { id: "geojson", label: "GeoJSON" }, { id: "gpkg", label: "GeoPackage" }, { id: "shp", label: "Shapefile" }, { id: "csv", label: "CSV" },
  { id: "tif", label: "GeoTIFF" },
];
/** The colour ramps a single-band raster may be drawn with, as CSS gradients for its legend (sampled from TiTiler's). */
const RAMPS: Record<string, string[]> = {
  viridis: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"], magma: ["#000004", "#51127c", "#b73779", "#fc8961", "#fcfdbf"],
  plasma: ["#0d0887", "#7e03a8", "#cc4778", "#f89540", "#f0f921"], inferno: ["#000004", "#56106e", "#bb3754", "#f98e09", "#fcffa4"],
  cividis: ["#00224e", "#434e6c", "#7d7c78", "#bcaf6f", "#fee838"], terrain: ["#333399", "#0294fa", "#24d36e", "#fefe98", "#835e58", "#ffffff"],
  gist_earth: ["#000000", "#2b5a8a", "#4e9a59", "#b8ae5b", "#fdfbfb"], greys: ["#ffffff", "#000000"], rdylgn: ["#a50026", "#fdae61", "#ffffbf", "#a6d96a", "#006837"],
  spectral: ["#9e0142", "#fdae61", "#ffffbf", "#abdda4", "#5e4fa2"], ylgn: ["#ffffe5", "#addd8e", "#31a354", "#004529"], blues: ["#f7fbff", "#6baed6", "#08306b"],
  reds: ["#fff5f0", "#fb6a4a", "#67000d"], rdylbu: ["#a50026", "#fdae61", "#ffffbf", "#abd9e9", "#313695"], brbg: ["#543005", "#dfc27d", "#f5f5f5", "#80cdc1", "#003c30"],
  gray: ["#000000", "#ffffff"], greens: ["#f7fcf5", "#74c476", "#00441b"], rdbu: ["#67001f", "#f4a582", "#f7f7f7", "#92c5de", "#053061"],
};
/** A ramp's colours, reversed for a name ending in _r (as TiTiler draws it). */
const rampOf = (name: string) => (name.endsWith("_r") ? [...(RAMPS[name.slice(0, -2)] ?? RAMPS.viridis)].reverse() : RAMPS[name] ?? RAMPS.viridis);
const num = (v: number | null | undefined) => (v == null ? "–" : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : Number(v.toPrecision(4)).toString());
const bytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
/** A cell's size, in metres when the raster is projected, in degrees when it is not. */
const cell = (r: RasterInfo) => (r.crs === "EPSG:4326" ? `${Number(r.resolution.toPrecision(3))}°` : `${Number(r.resolution.toPrecision(4))} m`);

export default function DatasetPage() {
  const { slug = "" } = useParams();
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(async (api) => {
    const dataset = await api.getDataset(slug);
    if (dataset.kind === "raster") return { dataset, fc: { type: "FeatureCollection" as const, features: [] } as FeatureCollection, unpublished: !dataset.raster };
    // A dataset whose first snapshot has not finished (or failed) has no features to show yet. That is not an error page.
    try { return { dataset, fc: await api.datasetFeatures(slug), unpublished: false }; }
    catch (e) {
      if (e instanceof ApiError && e.status === 409) return { dataset, fc: { type: "FeatureCollection" as const, features: [] } as FeatureCollection, unpublished: true };
      throw e;
    }
  }, [slug]);
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
      a.href = job.download_url; a.download = `${slug}.${format === "gpkg" ? "gpkg" : format === "shp" ? "zip" : format}`;      // tif: the GeoTIFF
      document.body.appendChild(a); a.click(); a.remove();
      toast(`${format.toUpperCase()} download started.`, "success");
    } catch (e) { toast(e instanceof Error ? e.message : "Download failed.", "error"); }
    finally { setBusy(null); }
  }

  if (loading) return <Loading label="Loading dataset…" />;
  if (error != null || !data) return <div className="container"><ErrorState error={error} onRetry={reload} /></div>;
  const d = data.dataset;
  const r = d.raster;
  const api = config.useMock ? "(mock mode: no live API)" : r && d.tiles_url ? d.tiles_url : `${config.apiUrl}/datasets/${d.slug}/features`;
  const ramp = r?.render.kind === "single" ? r.render.colors ?? rampOf(r.render.colormap) : null;      // the app's own ramp, when it sent one

  return (
    <div className="container detail" style={{ width: "100%" }}>
      <div>
        <Link to="/hub">Back to datasets</Link>
        <h1 style={{ margin: "8px 0 16px", fontSize: 34 }}>{d.title}</h1>
        {data.unpublished && <div className="state" role="status"><strong>Not published yet</strong><span>This dataset has no finished version. Publishing may still be running, or it failed (for example, no records were approved). Go back to Collected data and publish again.</span></div>}
        {r && d.tiles_url ? (
          <div className="preview"><MapView features={[]} imagery={[{ id: d.slug, url: d.tiles_url, maxzoom: 22 }]} flyTo={d.bbox ? { bounds: d.bbox, key: 1 } : null} label="Raster preview">
            {r.render.kind === "classes" && (
              <ul className="raster-legend raster-classes" aria-label="Classes">
                {r.render.classes.map((c) => <li key={c.value}><span className="raster-swatch" style={{ background: c.color }} aria-hidden="true" />{c.label || c.value}</li>)}
              </ul>
            )}
            {ramp && r.render.kind === "single" && r.render.rescale && (
              <div className="raster-legend" role="img" aria-label={`Colours from ${num(r.render.rescale[0])} to ${num(r.render.rescale[1])}`}>
                <span className="raster-ramp" style={{ background: `linear-gradient(90deg, ${ramp.join(", ")})` }} />
                <span className="raster-ends"><span>{num(r.render.rescale[0])}</span><span>{r.bands[r.render.band - 1]?.name}</span><span>{num(r.render.rescale[1])}</span></span>
              </div>
            )}
          </MapView></div>
        ) : <div className="preview"><MapView features={features} fitKey={d.slug} label="Dataset preview" /></div>}
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
            {d.visibility && d.visibility !== "public" && <><dt>Who can see it</dt><dd>{d.visibility === "organization" ? "Your organization only" : "Members only"}</dd></>}
            {r ? <>
              <dt>Raster</dt><dd>{r.width.toLocaleString()} × {r.height.toLocaleString()} cells of {cell(r)}</dd>
              <dt>{r.render.kind === "classes" ? "Classes" : r.bands.length === 1 ? "Band" : "Bands"}</dt><dd>{r.render.kind === "classes" ? `${r.render.classes.length} (${r.render.classes.slice(0, 3).map((c) => c.label || c.value).join(", ")}${r.render.classes.length > 3 ? "…" : ""})` : r.bands.length === 1 ? `${num(r.bands[0].min)} to ${num(r.bands[0].max)}` : `${r.bands.length} (${r.render.kind === "rgb" ? "a colour image" : r.bands.map((b) => b.name).join(", ")})`}</dd>
              <dt>File</dt><dd>GeoTIFF, {bytes(r.size)}</dd>
            </> : <><dt>Features</dt><dd>{d.feature_count}</dd></>}
            <dt>Version</dt><dd>{d.latest_version}</dd>
            <dt>Updated</dt><dd>{new Date(d.updated_at).toLocaleDateString()}</dd>
            <dt>Coordinates</dt><dd className="mono">{r ? r.crs : "EPSG:4326"}</dd>
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
        {d.source && <section className="card" aria-label="Source"><span className="field-hint">Published from {d.source.name}{d.source.label ? `: ${d.source.label}` : ""}. New versions are published from there.</span></section>}
        {d.map_id && <section className="card" aria-label="Source"><span className="field-hint">Published from a shared map.</span><Link to={`/maps/${d.map_id}/portal?tab=publish`}>Open the map portal</Link></section>}
        <section className="card" aria-label="Use in your app">
          <h2>Use in your app</h2>
          {r && <span className="field-hint">Map tiles (XYZ, PNG) for a raster layer{d.visibility !== "public" ? "; the link works for an hour" : ""}:</span>}
          <div className="mono" style={{ background: "var(--paper)", padding: 10, borderRadius: 6, wordBreak: "break-all" }}>{api}</div>
        </section>
      </aside>
    </div>
  );
}
