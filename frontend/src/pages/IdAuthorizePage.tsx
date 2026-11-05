import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import AuthFrame from "../components/AuthFrame";
import { Button, Loading } from "../components/ui";
import { ApiError, loadApi } from "../lib/api";
import { useAuth } from "../lib/auth";

type Problem = { title: string; detail: string; noProduct?: boolean };
/** Leaving for the app (tests replace it). */
export const leave = { to: (url: string) => window.location.assign(url) };

/**
 * GeoEstate ID: another GeoEstate app (Land Registry, LandCheck, FarmScan) sent the person here to sign in. Signed in to
 * Geohub already (RequireAuth sees to that), they go straight back to the app with a one-time code. Only an app
 * registered in ID_CLIENTS, returning to one of its own addresses, gets one; and only when the organization has it.
 */
export default function IdAuthorizePage() {
  const { user, logout } = useAuth();
  const [app, setApp] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const p = new URLSearchParams(window.location.search);
    const req = { client_id: p.get("client_id") ?? "", redirect_uri: p.get("redirect_uri") ?? "", state: p.get("state") ?? undefined,
      code_challenge: p.get("code_challenge") ?? undefined, code_challenge_method: p.get("code_challenge_method") ?? "S256" };
    (async () => {
      const api = await loadApi();
      try {
        const c = await api.idClient(req.client_id, req.redirect_uri);
        setApp(c.name);
        const { redirect_to } = await api.idAuthorize(req);
        leave.to(redirect_to);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Something went wrong.";
        if (e instanceof ApiError && e.code === "no_product") setProblem({ title: "Not part of your organization's plan", detail: msg, noProduct: true });
        else if (e instanceof ApiError && e.status === 400) setProblem({ title: "This sign-in link is not right", detail: `${msg} Go back to the app and try again.` });
        else setProblem({ title: "Sign-in did not finish", detail: msg });
      }
    })();
  }, []);

  return (
    <AuthFrame>
      {problem ? (
        <div className="auth-msg">
          <h1>{problem.title}</h1>
          <p role="alert">{problem.detail}</p>
          <p className="muted">Signed in as <strong>{user?.email}</strong>.</p>
          <div className="row-actions">
            <Link className="btn btn-primary" to="/">Go to Geohub</Link>
            <Button variant="ghost" onClick={() => void logout().then(() => window.location.reload())}>Use another account</Button>
          </div>
        </div>
      ) : <Loading label={app ? `Signing you in to ${app}…` : "Signing you in…"} />}
    </AuthFrame>
  );
}
