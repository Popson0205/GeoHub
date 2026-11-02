import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import AuthFrame from "../components/AuthFrame";
import { Button, Loading } from "../components/ui";
import { loadApi } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { PasswordLink } from "../lib/types";

function NewPassword({ id, value, onChange, label = "New password" }: { id: string; value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="password" autoComplete="new-password" required minLength={8} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={`${id}-hint`} />
      <span id={`${id}-hint`} className="field-hint">At least 8 characters. A short sentence is easy to remember and hard to guess.</span>
    </div>
  );
}

/** From a welcome or reset email: choose a password, then go straight in. */
export function SetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { adopt } = useAuth();
  const nav = useNavigate();
  const [info, setInfo] = useState<PasswordLink | null>(null);
  const [linkError, setLinkError] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) { setLinkError("This page needs the link from your email."); return; }
    loadApi().then((api) => api.passwordLink(token)).then(setInfo, (e) => setLinkError(e instanceof Error ? e.message : "This link is not valid."));
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pw !== pw2) { setError("The two passwords are not the same."); return; }
    setBusy(true); setError("");
    try { adopt(await (await loadApi()).setPassword(token, pw)); nav("/", { replace: true }); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not set the password."); }
    finally { setBusy(false); }
  }

  return (
    <AuthFrame>
      {linkError ? (
        <div className="auth-msg">
          <h1>This link cannot be used</h1>
          <p role="alert">{linkError}</p>
          <p><Link to="/forgot-password">Get a new link</Link> or <Link to="/login">sign in</Link>.</p>
        </div>
      ) : !info ? <Loading label="Checking your link…" /> : (
        <form onSubmit={submit}>
          <h1>{info.purpose === "set" ? `Welcome, ${info.name.split(" ")[0]}` : "Choose a new password"}</h1>
          <p className="field-hint">{info.purpose === "set" && info.org_name ? `Your account in ${info.org_name} is ready. ` : ""}You will sign in as <strong>{info.email}</strong>.</p>
          <NewPassword id="pw" value={pw} onChange={setPw} />
          <div className="field"><label htmlFor="pw2">Type it again</label><input id="pw2" type="password" autoComplete="new-password" required minLength={8} value={pw2} onChange={(e) => setPw2(e.target.value)} /></div>
          {error && <div className="field-error" role="alert">{error}</div>}
          <Button type="submit" variant="primary" busy={busy}>{info.purpose === "set" ? "Set password and continue" : "Save and sign in"}</Button>
        </form>
      )}
    </AuthFrame>
  );
}

/** Ask for a reset link. Always says the same, so it never reveals which emails have accounts. */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try { await (await loadApi()).forgotPassword(email.trim()); setSent(true); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not send the link."); }
    finally { setBusy(false); }
  }
  return (
    <AuthFrame>
      {sent ? (
        <div className="auth-msg" role="status">
          <h1>Check your email</h1>
          <p>If <strong>{email}</strong> has a Geohub account, a link to choose a new password is on its way. It works once, within 2 hours.</p>
          <p className="field-hint">Nothing after a few minutes? Look in Spam and Promotions, or ask your organization's administrator to send you a sign-in link.</p>
          <p><Link to="/login">Back to sign in</Link></p>
        </div>
      ) : (
        <form onSubmit={submit}>
          <h1>Forgot your password?</h1>
          <p className="field-hint">Enter your email and we will send you a link to choose a new one.</p>
          <div className="field"><label htmlFor="email">Email</label><input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          {error && <div className="field-error" role="alert">{error}</div>}
          <Button type="submit" variant="primary" busy={busy}>Send the link</Button>
          <p className="meta" style={{ marginTop: 12 }}><Link to="/login">Back to sign in</Link></p>
        </form>
      )}
    </AuthFrame>
  );
}

/** After signing in with a temporary password (and from the account menu): choose your own. */
export function ChangePasswordPage() {
  const { user, refresh } = useAuth();
  const nav = useNavigate();
  const forced = !!user?.must_change_password;
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try { await (await loadApi()).changePassword(cur, pw); await refresh(); nav("/", { replace: true }); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not change the password."); }
    finally { setBusy(false); }
  }
  return (
    <AuthFrame>
      <form onSubmit={submit}>
        <h1>{forced ? "Choose your own password" : "Change your password"}</h1>
        {forced && <p className="field-hint">You signed in with a temporary password. Choose one only you know before you continue.</p>}
        <div className="field"><label htmlFor="cur">{forced ? "Temporary password" : "Current password"}</label><input id="cur" type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} /></div>
        <NewPassword id="new" value={pw} onChange={setPw} />
        {error && <div className="field-error" role="alert">{error}</div>}
        <Button type="submit" variant="primary" busy={busy}>Save password</Button>
        {!forced && <p className="meta" style={{ marginTop: 12 }}><Link to="/">Cancel</Link></p>}
      </form>
    </AuthFrame>
  );
}
