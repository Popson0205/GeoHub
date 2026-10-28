import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BrandMark } from "../components/Shell";
import { Button, ErrorState, Loading } from "../components/ui";
import { loadApi } from "../lib/api";
import { useAuth } from "../lib/auth";
import { db } from "../lib/db";
import { useOnline } from "../lib/hooks";
import type { Project } from "../lib/types";

/**
 * The installed collector app's home screen: pick a project, then collect. Nothing else lives here;
 * building forms, reviewing, mapping and publishing are done by administrators on the website.
 */
export default function CollectHomePage() {
  const { user, logout } = useAuth();
  const online = useOnline();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [fromCache, setFromCache] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await (await loadApi()).listProjects();
      setProjects(list); setFromCache(false);
      void db.meta.put({ key: "collector:projects", value: JSON.stringify(list) }).catch(() => undefined);
    } catch (e) {
      const saved = await db.meta.get("collector:projects").catch(() => undefined);
      if (saved) { try { setProjects(JSON.parse(saved.value) as Project[]); setFromCache(true); return; } catch { /* unreadable */ } }
      setError(e);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div style={{ maxWidth: 560, margin: "0 auto", padding: "calc(16px + env(safe-area-inset-top, 0px)) 16px calc(32px + env(safe-area-inset-bottom, 0px))" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <BrandMark /><strong style={{ flex: 1 }}>Geohub Collector</strong>
        <span className={`badge ${online ? "badge-ok" : "badge-warn"}`}>{online ? "Online" : "Offline"}</span>
      </header>
      <h1 style={{ marginTop: 0 }}>Choose a project</h1>
      {user && <p className="meta">Signed in as {user.name || user.email}</p>}
      {fromCache && <span className="badge badge-warn">Showing projects saved on this device</span>}
      {projects === null && error == null && <Loading label="Loading your projects…" />}
      {error != null && <ErrorState error={error} onRetry={load} />}
      {projects && projects.length === 0 && <div className="state"><strong>No projects yet</strong>Ask a project administrator to add you as a collector.</div>}
      {projects?.map((p) => (
        <Link key={p.id} className="list-item" to={`/collect/${p.id}`} style={{ textDecoration: "none", color: "inherit" }}>
          <div className="grow"><strong>{p.name}</strong>{p.description && <small>{p.description}</small>}</div>
          <span aria-hidden="true">→</span>
        </Link>
      ))}
      <div style={{ marginTop: 24 }}><Button variant="ghost" onClick={() => void logout()}>Sign out</Button></div>
    </div>
  );
}
