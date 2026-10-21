import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button } from "../components/ui";
import { useAuth } from "../lib/auth";
import { config } from "../lib/config";
import { BrandMark } from "../components/Shell";

export default function LoginPage() {
  const { login, register } = useAuth();
  const nav = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? "/";
  const [email, setEmail] = useState(config.useMock ? "demo@geohub.test" : "");
  const [password, setPassword] = useState(config.useMock ? "demo" : "");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "register") await register(name, email, password);
      else await login(email, password);
      nav(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <aside className="auth-side">
        <div className="brand-line"><BrandMark size={32} />Geohub</div>
        <div>
          <h2>Map it, collect it, share it.</h2>
          <p>Digitise over imagery, run field surveys offline, and publish reviewed data for everyone to use.</p>
        </div>
      </aside>
      <main className="auth-main">
      <form onSubmit={submit}>
        <h1>{mode === "register" ? "Create your Geohub account" : "Sign in to Geohub"}</h1>
        {config.useMock && <div className="state"><span>Mock mode: no server needed. Use the filled-in demo account.</span></div>}
        {mode === "register" && <div className="field"><label htmlFor="name">Your name</label><input id="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} /></div>}
        <div className="field"><label htmlFor="email">Email</label><input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="field"><label htmlFor="pw">Password</label><input id="pw" type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} required minLength={mode === "register" ? 8 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        {error && <div className="field-error" role="alert">{error}</div>}
        <Button type="submit" variant="primary" busy={busy}>{mode === "register" ? "Create account" : "Sign in"}</Button>
        {!config.useMock && (
          <p className="meta" style={{ marginTop: 12 }}>
            {mode === "register" ? "Already have an account? " : "New here? "}
            <a href="#" onClick={(e) => { e.preventDefault(); setError(""); setMode(mode === "register" ? "signin" : "register"); }}>
              {mode === "register" ? "Sign in" : "Create an account"}
            </a>
          </p>
        )}
      </form>
      </main>
    </div>
  );
}
