import { useState, type FormEvent } from "react";
import { loadApi } from "../../lib/api";
import { LICENCE, longDate } from "../../lib/staffConsole";
import type { AdminOrgDetail, LicenceKind, ProductId, ProductLicence, ProductPlan } from "../../lib/types";
import { Button, useConfirm, useToast } from "../ui";

export const PRODUCT_NAMES: Record<ProductId, string> = { hub: "Geohub", land: "Land Registry", check: "LandCheck", farm: "FarmScan" };
const OTHERS: ProductId[] = ["land", "check", "farm"];
const HELP: Record<ProductId, string> = {
  hub: "", land: "Parcels, titles, transfers and disputes", check: "Location and due-diligence reports", farm: "Crop monitoring from satellite and drone",
};
const FEATURE: Record<string, string> = {
  parcels: "Parcels", titles: "Titles and owners", transactions: "Transfers", public_lookup: "Public lookup", dxf_import: "DXF import",
  ai_georeference: "AI georeferencing", workflows: "Approval workflows", valuations: "Valuations", disputes: "Disputes", reports: "Reports",
  batch: "Batch checks", ai_briefing: "AI briefing", title_status: "Title status", monitoring: "Monitoring", zones: "Zones",
  suitability: "Suitability", drone: "Drone imagery", plant_count: "Plant counts", prescriptions: "Prescriptions",
  alerts: "Weekly alerts", verification: "Verification reports",
};
const iso = (d: Date) => d.toISOString().slice(0, 10);
const yearFrom = (start: string) => { const d = new Date(`${start}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + 1); d.setUTCDate(d.getUTCDate() - 1); return iso(d); };

interface Draft { product: ProductId; plan: ProductPlan; kind: LicenceKind; starts: string; ends: string; invoice: string; note: string; isNew: boolean }

/** The other GeoEstate products a customer has (Geohub's own licence is the card beside it): add, renew, change, remove. */
export default function ProductsCard({ o, edit, onChange }: { o: AdminOrgDetail; edit: boolean; onChange: (p: ProductLicence[]) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ProductId | null>(null);
  const [why, setWhy] = useState("");
  const have = (o.products ?? []).filter((p) => p.product !== "hub");
  const missing = OTHERS.filter((k) => !have.some((p) => p.product === k));
  const individual = o.plan === "individual";

  function start(p: ProductLicence | null, product: ProductId = missing[0]) {
    const today = iso(new Date());
    if (!p) { setDraft({ product, plan: "standard", kind: "paid", starts: today, ends: yearFrom(today), invoice: "", note: "", isNew: true }); return; }
    const from = p.subscription_ends && p.subscription_ends >= today ? iso(new Date(Date.parse(`${p.subscription_ends}T00:00:00Z`) + 86400000)) : today;
    setDraft({ product: p.product, plan: p.plan as ProductPlan, kind: "paid", starts: from, ends: yearFrom(from), invoice: "", note: "", isNew: false });
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    const d = draft!;
    setBusy("save");
    try {
      const out = await (await loadApi()).adminPutProduct(o.id, d.product, { plan: d.plan, licence_kind: d.kind,
        subscription_starts: d.kind === "demo" ? null : d.starts, subscription_ends: d.kind === "demo" ? null : d.ends,
        invoice_ref: d.invoice || undefined, note: d.note || undefined });
      onChange(out); setDraft(null);
      toast(`${o.name} has ${PRODUCT_NAMES[d.product]}${d.kind === "demo" ? " on a month's demo" : ""}.`, "success");
    } catch (err) { toast(err instanceof Error ? err.message : "That did not work.", "error"); } finally { setBusy(null); }
  }
  async function remove(e: FormEvent, p: ProductLicence) {
    e.preventDefault();
    if (!(await confirm({ title: `Take ${p.name} away?`, confirmLabel: "Take it away", message: `${o.name} loses access to ${p.name} at once. Its data is kept.` }))) return;
    setBusy(p.product);
    try {
      onChange(await (await loadApi()).adminRemoveProduct(o.id, p.product, why.trim()));
      toast(`${p.name} is taken away.`, "success"); setRemoving(null); setWhy("");
    } catch (err) { toast(err instanceof Error ? err.message : "That did not work.", "error"); } finally { setBusy(null); }
  }

  return (
    <section className="card" aria-labelledby="c-products">
      <h2 id="c-products">Other GeoEstate products</h2>
      <p className="field-hint">Each product has its own licence. Suspending the customer suspends them all.</p>
      {have.length === 0 ? <p className="muted">{individual ? "An Individual account cannot have other products." : "None yet."}</p> : (
        <ul className="product-list">
          {have.map((p) => (
            <li key={p.product}>
              <div>
                <strong>{p.name}</strong> <span className={`badge ${LICENCE[p.status].badge}`}>{LICENCE[p.status].label}</span>
                <div className="muted">{p.plan_name}{p.licence_kind === "demo" ? " (demo)" : ""} · {p.subscription_starts ? longDate(p.subscription_starts) : "…"} to {p.subscription_ends ? longDate(p.subscription_ends) : "no end date"}</div>
                {p.features.length > 0 && <div className="product-features">{p.features.map((f) => <span key={f} className="badge badge-quiet">{FEATURE[f] ?? f}</span>)}</div>}
              </div>
              {edit && <div className="row-actions">
                <Button small onClick={() => start(p)}>Renew or change</Button>
                <Button small variant="ghost" onClick={() => setRemoving(removing === p.product ? null : p.product)}>Remove</Button>
              </div>}
              {removing === p.product && (
                <form className="customer-suspend product-remove" onSubmit={(e) => void remove(e, p)}>
                  <div className="field"><label htmlFor={`pr-why-${p.product}`}>Why? <span className="muted">(kept in the history; the data stays)</span></label>
                    <input id={`pr-why-${p.product}`} required maxLength={1000} value={why} onChange={(e) => setWhy(e.target.value)} /></div>
                  <Button type="submit" variant="danger" busy={busy === p.product}>Take {p.name} away</Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {edit && !individual && !draft && missing.length > 0 && <Button onClick={() => start(null)}>Add a product</Button>}
      {draft && (
        <form className="product-form" onSubmit={save} aria-label={draft.isNew ? "Add a product" : `Change ${PRODUCT_NAMES[draft.product]}`}>
          <div className="field"><label htmlFor="pr-product">Product</label>
            <select id="pr-product" value={draft.product} disabled={!draft.isNew} onChange={(e) => setDraft({ ...draft, product: e.target.value as ProductId })}>
              {(draft.isNew ? missing : [draft.product]).map((k) => <option key={k} value={k}>{PRODUCT_NAMES[k]}{HELP[k] ? ` · ${HELP[k]}` : ""}</option>)}
            </select></div>
          <div className="field"><label htmlFor="pr-plan">Plan</label>
            <select id="pr-plan" value={draft.plan} onChange={(e) => setDraft({ ...draft, plan: e.target.value as ProductPlan })}>
              <option value="standard">Standard</option><option value="advanced">Advanced</option><option value="custom">Custom</option>
            </select></div>
          <fieldset className="field"><legend>Licence</legend>
            <label className="check"><input type="radio" name="pr-kind" checked={draft.kind === "paid"} onChange={() => setDraft({ ...draft, kind: "paid" })} /> Paid</label>
            <label className="check"><input type="radio" name="pr-kind" checked={draft.kind === "demo"} onChange={() => setDraft({ ...draft, kind: "demo" })} /> A month's demo, from today</label>
          </fieldset>
          {draft.kind === "paid" && <>
            <div className="field"><label htmlFor="pr-from">From</label><input id="pr-from" type="date" required value={draft.starts} onChange={(e) => setDraft({ ...draft, starts: e.target.value, ends: e.target.value ? yearFrom(e.target.value) : draft.ends })} /></div>
            <div className="field"><label htmlFor="pr-to">To</label><input id="pr-to" type="date" required min={draft.starts} value={draft.ends} onChange={(e) => setDraft({ ...draft, ends: e.target.value })} /></div>
            <div className="field"><label htmlFor="pr-invoice">Invoice number</label><input id="pr-invoice" maxLength={80} placeholder="GE-2026-0001" value={draft.invoice} onChange={(e) => setDraft({ ...draft, invoice: e.target.value })} /></div>
          </>}
          <div className="field"><label htmlFor="pr-note">Note <span className="muted">(optional, kept in the history)</span></label><input id="pr-note" maxLength={1000} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} /></div>
          <div className="row-actions">
            <Button type="submit" variant="primary" busy={busy === "save"}>{draft.isNew ? `Give ${PRODUCT_NAMES[draft.product]}` : "Save"}</Button>
            <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          </div>
        </form>
      )}
    </section>
  );
}
