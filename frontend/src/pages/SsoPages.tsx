import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import AuthFrame from "../components/AuthFrame";
import { Button, Loading } from "../components/ui";
import { loadApi } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { PasswordLink } from "../lib/types";

const safeNext = (n: string | null) => (n && n.startsWith("/") && !n.startsWith("//") ? n : "/");

/** Back from Google or Microsoft: trade the one-time code for a session and carry on where the person was going. */
export function SsoReturnPage() {
  const [params] = useSearchParams();
  const { adopt } = useAuth();
  const nav = useNavigate();
  const [error, setError] = useState("");
  const once = useRef(false);            // the code works once; React's development double effects must not spend it twice

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const code = params.get("code");
    if (!code) { setError("This page needs the answer from Google or Microsoft. Sign in again."); return; }
    loadApi().then((api) => api.ssoExchange(code)).then((s) => {
      adopt(s);
      nav(s.user.must_change_password ? "/change-password" : safeNext(params.get("next")), { replace: true });
    }, (e) => setError(e instanceof Error ? e.message : "Could not sign in."));
  }, [params, adopt, nav]);

  return (
    <AuthFrame>
      {error ? (
        <div className="auth-msg">
          <h1>Sign-in did not finish</h1>
          <p role="alert">{error}</p>
          <p><Link to="/login">Back to sign in</Link></p>
        </div>
      ) : <Loading label="Signing you in…" />}
    </AuthFrame>
  );
}

/** From the "Join … on Geohub" email: someone who signed up with a company email confirms it and joins. */
export function JoinOrgPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { adopt } = useAuth();
  const nav = useNavigate();
  const [info, setInfo] = useState<PasswordLink | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) { setError("This page needs the link from your email."); return; }
    loadApi().then((api) => api.passwordLink(token)).then((l) => {
      if (l.purpose !== "join") setError("This link is not for joining an organization.");
      else setInfo(l);
    }, (e) => setError(e instanceof Error ? e.message : "This link is not valid."));
  }, [token]);

  async function join() {
    setBusy(true); setError("");
    try { adopt(await (await loadApi()).joinOrganization(token)); nav("/", { replace: true }); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not join."); setBusy(false); }
  }

  return (
    <AuthFrame>
      {error && !info ? (
        <div className="auth-msg">
          <h1>This link cannot be used</h1>
          <p role="alert">{error}</p>
          <p><Link to="/login">Sign in</Link></p>
        </div>
      ) : !info ? <Loading label="Checking your link…" /> : (
        <div className="auth-msg">
          <h1>Join {info.org_name}</h1>
          <p>You are confirming that <strong>{info.email}</strong> is your email. You will join <strong>{info.org_name}</strong> and see the work its administrators share with you.</p>
          <p className="field-hint">This works while your own free account is still empty. If you have already made projects or maps in it, ask the organization's administrator to add you instead.</p>
          {error && <div className="field-error" role="alert">{error}</div>}
          <Button variant="primary" busy={busy} onClick={() => void join()}>Join {info.org_name}</Button>
        </div>
      )}
    </AuthFrame>
  );
}
