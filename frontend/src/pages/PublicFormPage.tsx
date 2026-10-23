import { useEffect, useState, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { BrandMark } from "../components/Shell";
import { ErrorState, Loading } from "../components/ui";
import { ApiError, loadApi } from "../lib/api";
import { tokenFromParam } from "../lib/share";
import type { PublicForm } from "../lib/types";
import CollectPage from "./CollectPage";

const frame = (children: ReactNode) => (
  <div style={{ maxWidth: 640, margin: "0 auto", padding: "16px 16px 48px" }}>
    <header style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}><BrandMark /><strong>Geohub</strong></header>
    {children}
  </div>
);

/**
 * A form opened from its share link (/f/:token). Anyone can use a public link; collaborator links need sign-in.
 * Once the link checks out, people get the same field-map collector as signed-in collectors.
 */
export default function PublicFormPage() {
  const { token: param = "" } = useParams();
  const token = tokenFromParam(param);
  const nav = useNavigate();
  const [pf, setPf] = useState<PublicForm | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const f = await (await loadApi()).getPublicForm(token);
        if (live) setPf(f);
      } catch (e) {
        if (!live) return;
        if (e instanceof ApiError && e.status === 401) nav("/login", { replace: true, state: { from: `/f/${param}` } });
        else setError(e);
      }
    })();
    return () => { live = false; };
  }, [token, nav]);

  // The tab and the share sheet of the phone show the form's name, not the app's.
  useEffect(() => {
    if (!pf) return;
    const before = document.title;
    document.title = pf.form.name;
    return () => { document.title = before; };
  }, [pf]);

  if (error != null) {
    const status = error instanceof ApiError ? error.status : 0;
    return frame(
      <div className="card">
        <h1 style={{ marginTop: 0 }}>{status === 403 ? "You do not have access yet" : status === 404 ? "This link does not work" : "Could not open the form"}</h1>
        <p>{error instanceof Error ? error.message : "Something went wrong."}</p>
        {status === 403 && <p className="meta">Ask the form's owner to add your email as a collaborator, or sign in with a different account.</p>}
        {status === 403 && <Link className="btn" to="/login" state={{ from: `/f/${param}` }}>Use a different account</Link>}
        {status === 0 && <ErrorState error={error} onRetry={() => window.location.reload()} />}
      </div>,
    );
  }
  if (!pf) return frame(<Loading label="Opening the form…" />);
  // Collaborators use the project's own collector, with sync and everyone's data.
  if (pf.access === "member") return <Navigate to={`/collect/${pf.form.project_id}`} replace />;
  return <CollectPage pub={pf} />;
}
