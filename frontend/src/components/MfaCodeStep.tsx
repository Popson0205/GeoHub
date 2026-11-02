import { useState, type FormEvent } from "react";
import { Button } from "./ui";
import { loadApi } from "../lib/api";
import { config } from "../lib/config";
import type { Session } from "../lib/types";

/** The second step of signing in: the code from the person's authenticator app, or one of their recovery codes. */
export default function MfaCodeStep({ token, onSession, onCancel }: { token: string; onSession: (s: Session) => void; onCancel?: () => void }) {
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try { onSession(await (await loadApi()).verifyMfa(token, code.trim())); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not check the code."); setCode(""); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="mfa-step">
      <h1>Two-step sign-in</h1>
      <p className="field-hint">{recovery
        ? "Enter one of the recovery codes you saved when you set up two-step sign-in. Each works once."
        : "Open your authenticator app and enter the 6-digit code it shows for Geohub."}</p>
      {config.useMock && !recovery && <div className="state"><span>Mock mode: the code is 123456.</span></div>}
      <div className="field">
        <label htmlFor="mfa-code">{recovery ? "Recovery code" : "Code"}</label>
        <input id="mfa-code" className={recovery ? undefined : "mfa-input"} required autoFocus autoComplete="one-time-code"
          inputMode={recovery ? "text" : "numeric"} pattern={recovery ? undefined : "[0-9 ]{6,7}"} maxLength={recovery ? 20 : 7}
          placeholder={recovery ? "xxxxx-xxxxx" : "123 456"} value={code} onChange={(e) => setCode(e.target.value)} />
      </div>
      {error && <div className="field-error" role="alert">{error}</div>}
      <Button type="submit" variant="primary" busy={busy}>Continue</Button>
      <p className="meta" style={{ marginTop: 12 }}>
        <a href="#" onClick={(e) => { e.preventDefault(); setRecovery(!recovery); setCode(""); setError(""); }}>
          {recovery ? "Use the code from the app instead" : "Lost your phone? Use a recovery code"}
        </a>
        {onCancel && <> · <a href="#" onClick={(e) => { e.preventDefault(); onCancel(); }}>Start again</a></>}
      </p>
      {recovery && <p className="field-hint">No recovery codes either? Your organization's administrator can turn two-step sign-in off for you.</p>}
    </form>
  );
}
