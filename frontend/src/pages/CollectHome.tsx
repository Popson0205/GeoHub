import { Link } from "react-router-dom";
import { EmptyState, ErrorState, Loading } from "../components/ui";
import { useAsync } from "../lib/hooks";

/** Data collection entry point: pick a project to collect in. */
export default function CollectHome() {
  const { data, error, loading, reload } = useAsync((api) => api.listProjects(), []);
  return (
    <div className="container" style={{ width: "100%" }}>
      <div className="page-head"><h1>Data collection</h1><span className="grow" /><Link className="btn" to="/projects">Manage projects and forms</Link></div>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>Choose a project to start collecting in the field.</p>
      {loading && <Loading label="Loading projects…" />}
      {error != null && <ErrorState error={error} onRetry={reload} />}
      {data && data.length === 0 && (
        <EmptyState title="No projects yet">Ask a project owner to invite you, or <Link to="/projects">create one and build its forms</Link>.</EmptyState>
      )}
      {data && data.length > 0 && (
        <div className="grid-cards">
          {data.map((p) => (
            <article className="card" key={p.id}>
              <h2>{p.name}</h2>
              <div className="meta">{p.feature_count} features collected</div>
              <div className="actions"><Link className="btn btn-primary" to={`/collect/${p.id}`}>Collect</Link></div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
