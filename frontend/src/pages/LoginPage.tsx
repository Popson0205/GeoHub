import { useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import AuthFrame from "../components/AuthFrame";
import { Button } from "../components/ui";
import MfaCodeStep from "../components/MfaCodeStep";
import { loadApi, MfaRequired } from "../lib/api";
import { useAuth } from "../lib/auth";
import { config } from "../lib/config";
import type { SsoProvider } from "../lib/types";

const PROVIDER_NAME: Record<SsoProvider, string> = { google: "Google", microsoft: "Microsoft" };

export default function LoginPage() {
  const { login, register, adopt } = useAuth();
  const nav = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? "/";
  // An older invitation email links here with ?signup=1&email=…, so the invited address is filled in.
  const [params] = useSearchParams();
  const invited = params.get("email") ?? "";
  const [email, setEmail] = useState(config.useMock ? "demo@geohub.test" : invited);
  const [password, setPassword] = useState(config.useMock ? "demo" : "");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"signin" | "register">(params.get("signup") === "1" && !config.useMock ? "register" : "signin");
  const [error, setError] = useState(params.get("sso_error") ?? "");
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<SsoProvider[]>([]);
  const [going, setGoing] = useState<SsoProvider | null>(null);
  const [mfa, setMfa] = useState<string | null>(null);
  useEffect(() => { void loadApi().then((api) => api.listProviders()).then(setProviders, () => setProviders([])); }, []);

  async function withProvider(p: SsoProvider) {
    setGoing(p);
    const url = (await loadApi()).ssoStartUrl(p, from);
    if (url.startsWith("/")) nav(url); else window.location.assign(url);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "register") await register(name, email, password);
      else await login(email, password);
      nav(from, { replace: true });
    } catch (err) {
      if (err instanceof MfaRequired) { setMfa(err.token); return; }
      setError(err instanceof Error ? err.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  if (mfa) return (
    <AuthFrame>
      <MfaCodeStep token={mfa} onSession={(s) => { adopt(s); nav(from, { replace: true }); }} onCancel={() => { setMfa(null); setPassword(""); }} />
    </AuthFrame>
  );

  return (
    <AuthFrame>
      <form onSubmit={submit}>
        <h1>{mode === "register" ? "Create a free account" : "Sign in to Geohub"}</h1>
        {config.useMock && <div className="state"><span>Mock mode: no server needed. Use the filled-in demo account.</span></div>}
        {mode === "register" && <p className="field-hint">A free Individual account, for students and anyone working on their own. If your organization uses Geohub, your administrator creates your account instead.</p>}
        {providers.length > 0 && (
          <div className="auth-sso">
            {providers.map((p) => (
              <Button key={p} type="button" busy={going === p} onClick={() => void withProvider(p)}>Continue with {PROVIDER_NAME[p]}</Button>
            ))}
            <p className="auth-or"><span>or with email</span></p>
          </div>
        )}
        {mode === "register" && <div className="field"><label htmlFor="name">Your name</label><input id="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} /></div>}
        <div className="field"><label htmlFor="email">Email</label><input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="field">
          <label htmlFor="pw">Password</label>
          <input id="pw" type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} required minLength={mode === "register" ? 8 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} />
          {mode === "signin" && !config.useMock && <Link className="auth-forgot" to="/forgot-password">Forgot your password?</Link>}
        </div>
        {error && <div className="field-error" role="alert">{error}</div>}
        <Button type="submit" variant="primary" busy={busy}>{mode === "register" ? "Create free account" : "Sign in"}</Button>
        {!config.useMock && (
          <p className="meta" style={{ marginTop: 12 }}>
            {mode === "register" ? "Already have an account? " : "New here? "}
            <a href="#" onClick={(e) => { e.preventDefault(); setError(""); setMode(mode === "register" ? "signin" : "register"); }}>
              {mode === "register" ? "Sign in" : "Create a free account"}
            </a>
          </p>
        )}
        {(
          <p className="meta auth-company">
            Setting up Geohub for a company or agency?{" "}
            <Link to="/request-organization">Request an organization</Link>
          </p>
        )}
      </form>
    </AuthFrame>
  );
}
