import { useEffect, useState, type FormEvent } from "react";
import { loadApi } from "../../lib/api";
import { longDate } from "../../lib/staffConsole";
import type { AdminOrgDetail, IssuedLicenceKey } from "../../lib/types";
import { Button, useToast } from "../ui";

/** Keys for a customer's own installation: issue one carrying its licences, copy or download one issued before. */
export default function LicenceKeysCard({ o, edit, onChange }: { o: AdminOrgDetail; edit: boolean; onChange: () => void }) {
  const toast = useToast();
  const [settings, setSettings] = useState<{ can_issue: boolean; public_key: string | null } | null>(null);
  const [form, setForm] = useState<{ installation: string; ends: string; note: string } | null>(null);
  const [made, setMade] = useState<IssuedLicenceKey | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { void loadApi().then((a) => a.adminLicenceKeySettings()).then(setSettings, () => setSettings(null)); }, []);
  const keys = o.licence_keys ?? [];

  async function issue(e: FormEvent) {
    e.preventDefault();
    setBusy("issue");
    try {
      const k = await (await loadApi()).adminIssueLicenceKey(o.id, { installation: form!.installation.trim(), ends: form!.ends || undefined, note: form!.note || undefined });
      setMade(k); setForm(null); onChange();
      toast(`A licence key for ${k.installation} is ready.`, "success");
    } catch (err) { toast(err instanceof Error ? err.message : "That did not work.", "error"); } finally { setBusy(null); }
  }
  async function open(id: string) {
    setBusy(id);
    try { setMade(await (await loadApi()).adminGetLicenceKey(id)); } catch (err) { toast(err instanceof Error ? err.message : "That did not work.", "error"); } finally { setBusy(null); }
  }
  function download(k: IssuedLicenceKey) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([k.key + "\n"], { type: "text/plain" }));
    a.download = `geoestate-licence-${o.slug ?? "customer"}-${k.id.slice(0, 8)}.txt`;
    a.click(); URL.revokeObjectURL(a.href);
  }

  return (
    <section className="card" aria-labelledby="c-keys">
      <h2 id="c-keys">Licence keys</h2>
      <p className="field-hint">For a customer who runs GeoEstate software on its own servers or in its own cloud. The key carries its licences as they stand now; renewing = a new key.</p>
      {settings && !settings.can_issue && <p className="customer-alert" role="status">This Geohub cannot issue keys yet: set <code>LICENCE_SIGNING_SECRET</code> in its variables.</p>}
      {made && (
        <div className="licence-key" aria-label="Licence key">
          <p><strong>Key for {made.installation}</strong>{made.products.map((p) => ` · ${p.plan_name}${p.ends ? ` to ${longDate(p.ends)}` : ""}`).join("")}</p>
          <textarea readOnly rows={5} value={made.key} aria-label="The licence key" onFocus={(e) => e.currentTarget.select()} />
          <div className="row-actions">
            <Button small onClick={() => void navigator.clipboard?.writeText(made.key).then(() => toast("Copied.", "success"))}>Copy</Button>
            <Button small onClick={() => download(made)}>Download</Button>
            <Button small variant="ghost" onClick={() => setMade(null)}>Close</Button>
          </div>
          <p className="field-hint">The customer's administrator pastes it under Organization settings → Licence key.</p>
        </div>
      )}
      {keys.length > 0 && (
        <ul className="product-list">
          {keys.map((k) => (
            <li key={k.id}>
              <div><strong>{k.installation}</strong>
                <div className="muted">{longDate(k.issued_at)}{k.issued_by ? ` by ${k.issued_by}` : ""} · {k.products.map((p) => p.plan_name).join(", ")}{k.note ? ` · ${k.note}` : ""}</div></div>
              <Button small busy={busy === k.id} onClick={() => void open(k.id)} aria-label={`Show the key of ${longDate(k.issued_at)}`}>Show key</Button>
            </li>
          ))}
        </ul>
      )}
      {edit && settings?.can_issue && !form && <Button onClick={() => setForm({ installation: "", ends: "", note: "" })}>Make a licence key</Button>}
      {form && (
        <form className="product-form" onSubmit={issue} aria-label="Make a licence key">
          <div className="field"><label htmlFor="lk-site">Installation's web address</label>
            <input id="lk-site" type="url" required placeholder="https://geohub.client.gov.ng" value={form.installation} onChange={(e) => setForm({ ...form, installation: e.target.value })} /></div>
          <div className="field"><label htmlFor="lk-ends">End every licence on <span className="muted">(optional)</span></label>
            <input id="lk-ends" type="date" value={form.ends} onChange={(e) => setForm({ ...form, ends: e.target.value })} /></div>
          <div className="field"><label htmlFor="lk-note">Note <span className="muted">(optional)</span></label>
            <input id="lk-note" maxLength={500} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
          <div className="row-actions"><Button type="submit" variant="primary" busy={busy === "issue"}>Make the key</Button><Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button></div>
        </form>
      )}
      {settings?.public_key && <details className="licence-public"><summary>Public key, for installations</summary>
        <p className="field-hint">Set as <code>LICENCE_PUBLIC_KEY</code> on each customer installation, with <code>LICENCE_REQUIRED=true</code>.</p>
        <code className="licence-public-key">{settings.public_key}</code></details>}
    </section>
  );
}
