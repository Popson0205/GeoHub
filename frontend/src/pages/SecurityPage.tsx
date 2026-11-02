import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { qrPath } from "../components/ShareOptions";
import { Button, ErrorState, Loading, PageHeader, useConfirm, useToast } from "../components/ui";
import { loadApi } from "../lib/api";
import { useAuth } from "../lib/auth";
import { config } from "../lib/config";
import { download } from "../lib/csv";
import type { ApiKey, ApiKeyCreated, MfaSetup, MfaStatus } from "../lib/types";

const when = (d: string | null) => (d ? new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

/** Your account's security: two-step sign-in, your password, and API keys for scripts. */
export default function SecurityPage() {
  const { user, refresh } = useAuth();
  const nav = useNavigate();
  const forced = !!user?.mfa_setup_required;
  const [wasForced] = useState(forced);
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  async function load() {
    setError(null);
    try { setStatus(await (await loadApi()).mfaStatus()); } catch (e) { setError(e); }
  }
  useEffect(() => { void load(); }, []);

  if (error != null) return <div className="container"><ErrorState error={error} onRetry={() => void load()} /></div>;
  if (!status || !user) return <div className="container"><Loading label="Loading…" /></div>;
  const paid = !!user.org && user.org.plan !== "individual";

  return (
    <div className="container security">
      <PageHeader title="Account security" lede={`Signed in as ${user.email}.`} />
      {forced && !codes && (
        <div className="security-required" role="alert">
          <strong>{user.org?.name ?? "Your organization"} requires two-step sign-in.</strong> Set it up below to carry on. It takes
          a minute and needs a phone with an authenticator app.
        </div>
      )}
      <div className="security-grid">
        <TwoStep status={status} codes={codes}
          onEnabled={async (c) => { setCodes(c); await load(); await refresh(); }}
          onChanged={async () => { setCodes(null); await load(); await refresh(); }}
          onCodes={setCodes} />
        {codes && wasForced && !forced && (
          <p className="security-continue"><Button variant="primary" onClick={() => nav("/")}>Continue to Geohub</Button></p>
        )}
        {!forced && (
          <section className="card" aria-labelledby="sec-pw">
            <h2 id="sec-pw">Password</h2>
            <p className="field-hint">Signed in with Google or Microsoft and never set one? Use “Forgot your password?” on the sign-in page to choose one.</p>
            <p className="security-link"><Link className="btn" to="/change-password">Change password</Link></p>
          </section>
        )}
        {!forced && paid && <ApiKeys admin={user.org!.role === "owner" || user.org!.role === "admin"} viewer={user.org!.role === "viewer"} />}
      </div>
    </div>
  );
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  const toast = useToast();
  const text = `Geohub recovery codes\nEach works once, instead of the code from your app.\n\n${codes.join("\n")}\n`;
  return (
    <div className="recovery" role="status">
      <p><strong>Save these recovery codes</strong> somewhere safe, away from your phone: a password manager, or printed. Each gets you
        in once if you lose your phone. They will not be shown again.</p>
      <ol className="recovery-codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ol>
      <div className="row-actions">
        <Button small onClick={() => download("geohub-recovery-codes.txt", text, "text/plain")}>Download</Button>
        <Button small onClick={async () => { try { await navigator.clipboard.writeText(codes.join("\n")); toast("Copied.", "success"); } catch { toast("Select the codes and copy them.", "info"); } }}>Copy</Button>
      </div>
    </div>
  );
}

function TwoStep({ status, codes, onEnabled, onChanged, onCodes }: {
  status: MfaStatus; codes: string[] | null;
  onEnabled: (codes: string[]) => Promise<void>; onChanged: () => Promise<void>; onCodes: (c: string[]) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [action, setAction] = useState<"off" | "codes" | null>(null);
  const qr = useMemo(() => (setup ? qrPath(setup.otpauth_url) : null), [setup]);

  async function start() {
    setBusy("start"); setErr("");
    try { setSetup(await (await loadApi()).startMfaSetup()); setCode(""); }
    catch (e) { setErr(e instanceof Error ? e.message : "Could not start."); } finally { setBusy(null); }
  }
  async function enable(e: FormEvent) {
    e.preventDefault();
    setBusy("enable"); setErr("");
    try { const c = await (await loadApi()).enableMfa(code.trim()); setSetup(null); setCode(""); await onEnabled(c); toast("Two-step sign-in is on.", "success"); }
    catch (e2) { setErr(e2 instanceof Error ? e2.message : "Could not turn it on."); } finally { setBusy(null); }
  }
  async function act(e: FormEvent) {
    e.preventDefault();
    if (action === "off" && !(await confirm({ title: "Turn off two-step sign-in?", danger: true, confirmLabel: "Turn off",
      message: "Your password alone will sign you in again." }))) return;
    setBusy("act"); setErr("");
    try {
      const api = await loadApi();
      if (action === "off") { await api.disableMfa(code.trim()); await onChanged(); toast("Two-step sign-in is off.", "success"); }
      else { onCodes(await api.newRecoveryCodes(code.trim())); toast("New recovery codes made. The old ones no longer work.", "success"); }
      setAction(null); setCode("");
    } catch (e2) { setErr(e2 instanceof Error ? e2.message : "That did not work."); } finally { setBusy(null); }
  }

  return (
    <section className="card" aria-labelledby="sec-mfa">
      <h2 id="sec-mfa">Two-step sign-in {status.enabled ? <span className="badge badge-ok">On</span> : <span className="badge badge-quiet">Off</span>}</h2>
      <p className="field-hint">After your password (or Google / Microsoft), Geohub also asks for a code from an app on your phone, such as
        Google Authenticator, Microsoft Authenticator or 1Password. Someone who learns your password still cannot get in.</p>
      {codes && <RecoveryCodes codes={codes} />}
      {!status.enabled && !setup && <Button variant="primary" busy={busy === "start"} onClick={() => void start()}>Set up two-step sign-in</Button>}
      {setup && qr && (
        <form className="mfa-setup" onSubmit={enable}>
          <ol className="mfa-steps">
            <li>In your authenticator app, add an account and scan this code.
              <svg className="mfa-qr" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label="QR code for your authenticator app" shapeRendering="crispEdges">
                <rect width="100%" height="100%" fill="#fff" /><path d={qr.d} fill="#000" />
              </svg>
              <span className="field-hint">Cannot scan? Type this key instead: <code className="mfa-secret">{setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code></span>
            </li>
            <li>
              <label htmlFor="mfa-confirm">Enter the 6-digit code the app shows</label>
              <input id="mfa-confirm" className="input mfa-input" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7}
                placeholder="123 456" value={code} onChange={(e) => setCode(e.target.value)} />
              {config.useMock && <span className="field-hint mfa-hint">Mock mode: the code is 123456.</span>}
            </li>
          </ol>
          {err && <div className="field-error" role="alert">{err}</div>}
          <div className="row-actions">
            <Button type="submit" variant="primary" busy={busy === "enable"}>Turn on</Button>
            <Button type="button" variant="ghost" onClick={() => { setSetup(null); setErr(""); }}>Cancel</Button>
          </div>
        </form>
      )}
      {status.enabled && (
        <>
          <p>On since {when(status.enabled_at)}. <span className="muted">{status.recovery_codes_left} recovery code{status.recovery_codes_left === 1 ? "" : "s"} left.</span></p>
          {status.required_by_org && <p className="field-hint">Your organization requires it, so it stays on. For a new phone, ask an administrator to reset it.</p>}
          {!action ? (
            <div className="row-actions">
              <Button small onClick={() => { setAction("codes"); setErr(""); }}>New recovery codes</Button>
              {!status.required_by_org && <Button small variant="ghost" onClick={() => { setAction("off"); setErr(""); }}>Turn off</Button>}
            </div>
          ) : (
            <form className="mfa-act" onSubmit={act}>
              <div className="field">
                <label htmlFor="mfa-act">{action === "off" ? "To turn it off, enter a code from your app" : "To make new recovery codes, enter a code from your app"}</label>
                <input id="mfa-act" className="mfa-input" required autoComplete="one-time-code" maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} />
              </div>
              {err && <div className="field-error" role="alert">{err}</div>}
              <div className="row-actions">
                <Button type="submit" variant={action === "off" ? "danger" : "primary"} busy={busy === "act"}>{action === "off" ? "Turn off" : "Make new codes"}</Button>
                <Button type="button" variant="ghost" onClick={() => { setAction(null); setCode(""); setErr(""); }}>Cancel</Button>
              </div>
            </form>
          )}
        </>
      )}
      {err && !setup && !action && <div className="field-error" role="alert">{err}</div>}
    </section>
  );
}

const EXPIRY = [{ v: "", label: "Never" }, { v: "30", label: "In 30 days" }, { v: "90", label: "In 90 days" }, { v: "365", label: "In a year" }];

function ApiKeys({ admin, viewer }: { admin: boolean; viewer: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [all, setAll] = useState(false);
  const [name, setName] = useState("");
  const [access, setAccess] = useState<"read" | "write">("read");
  const [expiry, setExpiry] = useState("");
  const [made, setMade] = useState<ApiKeyCreated | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  async function load(everyone = all) {
    try { setKeys(await (await loadApi()).listApiKeys(everyone)); } catch (e) { setErr(e instanceof Error ? e.message : "Could not load keys."); }
  }
  useEffect(() => { void load(); }, []);   // first load only; the toggle reloads itself

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy("create"); setErr("");
    try {
      setMade(await (await loadApi()).createApiKey({ name: name.trim(), access, expires_in_days: expiry ? Number(expiry) : null }));
      setName(""); await load();
    } catch (e2) { setErr(e2 instanceof Error ? e2.message : "Could not make the key."); } finally { setBusy(null); }
  }
  async function revoke(k: ApiKey) {
    if (!(await confirm({ title: `Revoke “${k.name}”?`, danger: true, confirmLabel: "Revoke key",
      message: "Anything using this key stops working at once. This cannot be undone." }))) return;
    setBusy(k.id);
    try { await (await loadApi()).revokeApiKey(k.id); toast("Key revoked.", "success"); await load(); }
    catch (e) { toast(e instanceof Error ? e.message : "Could not revoke.", "error"); } finally { setBusy(null); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); toast("Copied.", "success"); } catch { toast("Select the key and copy it.", "info"); }
  }

  return (
    <section className="card api-keys" aria-labelledby="sec-keys">
      <h2 id="sec-keys">API keys</h2>
      <p className="field-hint">For scripts and other systems that use the Geohub API. A key acts as you, with your permissions. Send it as
        <code> Authorization: Bearer ghk_…</code>. Keep it secret like a password.</p>
      <form className="api-key-new" onSubmit={create}>
        <div className="field"><label htmlFor="key-name">Name</label><input id="key-name" required maxLength={80} placeholder="e.g. Nightly export to Power BI" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field">
          <label htmlFor="key-access">Access</label>
          <select id="key-access" className="input" value={access} onChange={(e) => setAccess(e.target.value as "read" | "write")}>
            <option value="read">Read only</option>
            {!viewer && <option value="write">Read and write</option>}
          </select>
        </div>
        <div className="field">
          <label htmlFor="key-exp">Expires</label>
          <select id="key-exp" className="input" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            {EXPIRY.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}
          </select>
        </div>
        <Button type="submit" busy={busy === "create"}>Make key</Button>
      </form>
      {err && <div className="field-error" role="alert">{err}</div>}
      {made && (
        <div className="org-temp" role="status">
          <p><strong>{made.name}</strong>: copy the key now. It will not be shown again.</p>
          <div className="org-temp-row"><code className="org-temp-pw api-key-value">{made.key}</code><Button small onClick={() => void copy(made.key)}>Copy</Button></div>
        </div>
      )}
      {admin && (
        <label className="api-key-all"><input type="checkbox" checked={all} onChange={(e) => { setAll(e.target.checked); void load(e.target.checked); }} />Show everyone's keys in the organization</label>
      )}
      {keys && keys.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th scope="col">Key</th>{all && <th scope="col">Person</th>}<th scope="col">Access</th><th scope="col">Last used</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {keys.map((k) => {
                const expired = !!k.expires_at && new Date(k.expires_at) < new Date();
                return (
                  <tr key={k.id} className={k.revoked_at || expired ? "is-off" : undefined}>
                    <td><strong>{k.name}</strong><br /><code className="muted">{k.prefix}…</code>
                      <span className="muted"> · made {when(k.created_at)}{k.expires_at ? ` · ${expired ? "expired" : "expires"} ${when(k.expires_at)}` : ""}</span></td>
                    {all && <td>{k.user_name}<br /><span className="muted">{k.user_email}</span></td>}
                    <td>{k.access === "write" ? "Read and write" : "Read only"}</td>
                    <td className="muted">{k.revoked_at ? `Revoked ${when(k.revoked_at)}` : k.last_used_at ? when(k.last_used_at) : "Never"}</td>
                    <td>{!k.revoked_at && <Button small variant="ghost" busy={busy === k.id} onClick={() => void revoke(k)} aria-label={`Revoke ${k.name}`}>Revoke</Button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {keys && keys.length === 0 && <p className="muted">No keys yet.</p>}
    </section>
  );
}
