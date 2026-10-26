import { useEffect, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { DashboardView } from "./DashboardPage";
import { ErrorState, Loading } from "../components/ui";
import { ApiError } from "../lib/api";
import { useAsync } from "../lib/hooks";

/** A dashboard opened from its public link (/d/:token). No sign-in, read-only, and nothing but what the link allows. */
export default function PublicDashboardPage() {
  const { token = "" } = useParams();
  const q = useAsync((api) => api.getPublicDashboard(token), [token]);
  const loadedAt = useMemo(() => new Date(), [q.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // A shared link is not for search engines to list.
  useEffect(() => {
    const m = document.createElement("meta");
    m.name = "robots"; m.content = "noindex,nofollow";
    document.head.appendChild(m);
    return () => m.remove();
  }, []);

  if (q.error != null) {
    const gone = q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 429);
    return (
      <div className="container public-dash-error">
        {gone && (q.error as ApiError).status === 404
          ? <><h1>This link doesn't work</h1><p>The dashboard link is not valid, or the person who shared it has turned sharing off. Ask them for a new link.</p><Link to="/">Go to Geohub</Link></>
          : <ErrorState error={q.error} onRetry={() => void q.reload()} />}
      </div>
    );
  }
  if (!q.data) return <div className="container"><Loading label="Loading dashboard…" /></div>;
  const d = q.data;
  // Keyed by the saved version, so when the owner changes the layout a refresh shows it.
  return <DashboardView key={`${d.token}:${d.updated_at}`} projectId="" dashboard={{ id: d.token, project_id: "", name: d.name, config: d.config, updated_at: d.updated_at }}
    forms={d.forms} features={d.features} canEdit={false} loadedAt={loadedAt} onRefresh={() => void q.reload()} publicView={{ projectName: d.project_name, truncated: d.truncated }} />;
}
