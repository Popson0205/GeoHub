import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import FootprintThumb from "../components/FootprintThumb";
import { Icon } from "../components/icons";
import { Button, EmptyState, ErrorState, Loading } from "../components/ui";
import { useAsync } from "../lib/hooks";

const FORMAT_LABEL = { geojson: "GeoJSON", gpkg: "GeoPackage", shp: "Shapefile", csv: "CSV", tif: "GeoTIFF" } as const;

export default function HubPage() {
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const { data, error, loading, reload } = useAsync((api) => api.listDatasets(applied), [applied]);
  const submit = (e: FormEvent) => { e.preventDefault(); setApplied(q.trim()); };

  return (
    <>
      <section className="hero">
        <h1>Open map data you can preview, download and reuse</h1>
        <p>Surveyed features and imagery from field teams, published with clear licences.</p>
        <form className="search" onSubmit={submit} role="search">
          <label className="sr-only" htmlFor="q">Search datasets</label>
          <span className="search-field"><Icon name="search" size={18} /><input id="q" type="search" className="input" placeholder="Search datasets, places or tags" value={q} onChange={(e) => setQ(e.target.value)} /></span>
          <Button type="submit" variant="accent">Search</Button>
        </form>
      </section>
      <section className="container" style={{ paddingTop: 12, width: "100%" }} aria-live="polite">
        {loading && <Loading label="Loading datasets…" />}
        {error != null && <ErrorState error={error} onRetry={reload} />}
        {data && data.length === 0 && <EmptyState icon={applied ? "search" : "navHub"} title={applied ? "No datasets found" : "Nothing published yet"} action={applied ? <Button onClick={() => { setQ(""); setApplied(""); }}>Show all datasets</Button> : undefined}>{applied ? `Nothing matches "${applied}". Try a place or a topic.` : "Datasets appear here once a team publishes reviewed data."}</EmptyState>}
        <div className="stack">
          {data?.map((d) => (
            <article className="dataset" key={d.slug}>
              <FootprintThumb kind="dataset" id={d.slug} version={String(d.latest_version)} />
              <div>
                <h2><Link to={`/hub/${d.slug}`}>{d.title}</Link></h2>
                <p>{d.description || "No description yet."} {d.kind === "raster" ? "Raster" : `${d.feature_count} features`}, updated {new Date(d.updated_at).toLocaleDateString()}.</p>
                <div className="chips">
                  {d.formats.map((f) => <span className="chip" key={f}>{FORMAT_LABEL[f]}</span>)}
                  <span className="chip chip-plain">{d.license}</span>
                  {d.visibility === "organization" && <span className="badge badge-info">Your organization only</span>}
                  {d.visibility === "private" && <span className="badge badge-quiet">Members only</span>}
                </div>
              </div>
              <Link className="btn btn-primary" to={`/hub/${d.slug}`}>View and download</Link>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
