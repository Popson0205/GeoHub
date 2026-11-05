import { useEffect, useState, type FormEvent } from "react";
import { loadApi } from "../lib/api";
import type { InstallationLicence } from "../lib/types";
import { Button, useToast } from "./ui";

const day = (d: string | null) => (d ? new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "no end date");

/** On a customer's own installation: the licence key in force, and pasting the next one from GeoEstate. */
export default function LicenceKeyCard({ canInstall, onInstalled }: { canInstall: boolean; onInstalled: () => void }) {
  const toast = useToast();
  const [state, setState] = useState<InstallationLicence | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void loadApi().then((a) => a.orgLicenceKey()).then(setState, () => setState(null)); }, []);
  if (!state?.required) return null;
  const k = state.installed;

  async function install(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const s = await (await loadApi()).installLicenceKey(key.trim());
      setState(s); setKey(""); onInstalled();
      toast("The licence key is installed.", "success");
    } catch (err) { toast(err instanceof Error ? err.message : "That key could not be installed.", "error"); } finally { setBusy(false); }
  }

  return (
    <section className="card" aria-labelledby="org-key-h">
      <h2 id="org-key-h">Licence key</h2>
      {k ? (
        <>
          <p>Issued to <strong>{k.customer}</strong> by GeoEstate NIG Limited, installed {day(k.installed_at)}.</p>
          <ul className="org-key-products">{k.products.map((p) => <li key={p.product}><strong>{p.plan_name}</strong> until {day(p.ends)}</li>)}</ul>
        </>
      ) : <p className="customer-alert" role="status">No licence key is installed. Everyone has full use for 14 days from the first start; after that this Geohub is read-only until a key is installed.</p>}
      {canInstall ? (
        <form onSubmit={install} className="org-key-form">
          <div className="field"><label htmlFor="org-key">{k ? "Install a new key (a renewal)" : "Paste the key from GeoEstate"}</label>
            <textarea id="org-key" rows={4} required placeholder="GEOESTATE-LICENCE-1…" value={key} onChange={(e) => setKey(e.target.value)} /></div>
          <Button type="submit" variant="primary" busy={busy}>Install the key</Button>
        </form>
      ) : <p className="field-hint">The organization's owners and administrators install licence keys.</p>}
      <p className="field-hint">For {state.installation}. A key is made for this address only; ask GeoEstate if the address changes.</p>
    </section>
  );
}
