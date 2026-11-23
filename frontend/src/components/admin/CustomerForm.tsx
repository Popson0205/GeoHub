import { useState, type FormEvent } from "react";
import { Button } from "../ui";
import { loadApi } from "../../lib/api";
import { DEMO_DAYS, KINDS, PLAN_CAPS, PLANS, dayAfter, demoEnd, today, yearFrom } from "../../lib/staffConsole";
import type { AdminOrg, LicenceKind, OrgLimits, PeopleKind, PlanId } from "../../lib/types";

export interface Draft { name: string; kind: LicenceKind; plan: PlanId; owner_name: string; owner_email: string; starts: string; ends: string;
  limits: Record<PeopleKind, string>; invoice_ref: string; note: string; request_id?: string;
  brand_name: string; brand_color: string;
  // The logo (top bar) and seal (sign-in) are uploaded images: *_current is the served URL already on the org (for
  // preview), *_file a newly chosen file to upload on save, *_remove a request to clear the existing one.
  logo_current: string; logo_file: File | null; logo_remove: boolean;
  seal_current: string; seal_file: File | null; seal_remove: boolean;
  home_current: string; home_file: File | null; home_remove: boolean }

export const blankDraft = (kind: LicenceKind = "paid"): Draft => {
  const starts = today();
  return { name: "", kind, plan: kind === "demo" ? "advanced" : "standard", owner_name: "", owner_email: "", starts,
    ends: kind === "demo" ? demoEnd(starts) : yearFrom(starts), limits: { seats: "", collectors: "", viewers: "" }, invoice_ref: "", note: "",
    brand_name: "", brand_color: "", logo_current: "", logo_file: null, logo_remove: false, seal_current: "", seal_file: null, seal_remove: false,
    home_current: "", home_file: null, home_remove: false };
};
export const draftFrom = (o: AdminOrg): Draft => ({ name: o.name, kind: o.licence_kind ?? "paid", plan: o.plan as PlanId, owner_name: o.owner_name ?? "",
  owner_email: o.owner_email ?? "", starts: o.subscription_starts ?? "", ends: o.subscription_ends ?? "", invoice_ref: "", note: "",
  limits: { seats: o.limits.seats?.toString() ?? "", collectors: o.limits.collectors?.toString() ?? "", viewers: o.limits.viewers?.toString() ?? "" },
  brand_name: o.brand_name ?? "", brand_color: o.brand_color ?? "",
  logo_current: o.logo_url ?? "", logo_file: null, logo_remove: false, seal_current: o.brand_seal_url ?? "", seal_file: null, seal_remove: false,
  home_current: o.home_image_url ?? "", home_file: null, home_remove: false });
/** The next year after the current end date, as a renewal. */
export const renewalDraft = (o: AdminOrg): Draft => {
  const d = draftFrom(o);
  const starts = o.subscription_ends && o.subscription_ends >= today() ? dayAfter(o.subscription_ends) : today();
  return { ...d, kind: "paid", plan: d.plan === "individual" ? "standard" : d.plan, starts, ends: yearFrom(starts) };
};
const limitsOf = (d: Draft): OrgLimits => Object.fromEntries(KINDS.filter((k) => d.limits[k.key].trim() !== "").map((k) => [k.key, Number(d.limits[k.key])]));

/** Set up a customer, or change or renew its licence. Every change is kept in the licence history with its invoice. */
export default function CustomerForm({ orgId, initial, title, onSaved, onCancel }: {
  orgId: string | null; initial: Draft; title: string; onSaved: (o: AdminOrg) => void; onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isNew = !orgId;

  function set<K extends keyof Draft>(k: K, v: Draft[K]) {
    setD((p) => {
      const n = { ...p, [k]: v };
      // moving the start moves a year's (or a demo month's) end with it
      if (k === "starts" && typeof v === "string" && v) {
        const auto = p.kind === "demo" ? demoEnd(p.starts || v) : yearFrom(p.starts || v);
        if (!p.ends || p.ends === auto) n.ends = p.kind === "demo" ? demoEnd(v) : yearFrom(v);
      }
      if (k === "kind" && isNew) {
        n.plan = v === "demo" ? "advanced" : p.plan;
        n.ends = v === "demo" ? demoEnd(p.starts || today()) : yearFrom(p.starts || today());
      }
      return n;
    });
  }

  async function save(ev: FormEvent) {
    ev.preventDefault();
    if (d.starts && d.ends && d.ends < d.starts) { setError("The subscription cannot end before it starts."); return; }
    setBusy(true); setError("");
    try {
      const api = await loadApi();
      const extra = { invoice_ref: d.invoice_ref.trim() || undefined, note: d.note.trim() || undefined };
      // White-label identity: on setup, empty fields are ignored; on edit, an empty field clears it (back to the Geohub look).
      const brand = { brand_name: d.brand_name.trim(), brand_color: d.brand_color.trim() };
      const o = isNew
        ? await api.adminCreateOrg({ name: d.name.trim(), plan: d.plan, licence_kind: d.kind, owner_name: d.owner_name.trim(), owner_email: d.owner_email.trim(),
            subscription_starts: d.starts || null, subscription_ends: d.ends || null, limits: limitsOf(d), request_id: d.request_id, ...extra, ...brand })
        : await api.adminUpdateOrg(orgId, { name: d.name.trim(), plan: d.plan, licence_kind: d.kind, limits: limitsOf(d), ...extra, ...brand,
            ...(d.starts || d.ends ? { subscription_starts: d.starts || null, subscription_ends: d.ends || null } : { clear_dates: true }) });
      // The logo and seal are images, uploaded (or cleared) after the org exists.
      if (d.logo_file) await api.adminUploadLogo(o.id, d.logo_file);
      else if (!isNew && d.logo_remove && d.logo_current) await api.adminRemoveLogo(o.id);
      if (d.seal_file) await api.adminUploadSeal(o.id, d.seal_file);
      else if (!isNew && d.seal_remove && d.seal_current) await api.adminRemoveSeal(o.id);
      if (d.home_file) await api.adminUploadHomeImage(o.id, d.home_file);
      else if (!isNew && d.home_remove && d.home_current) await api.adminRemoveHomeImage(o.id);
      onSaved(o);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save."); } finally { setBusy(false); }
  }

  return (
    <form className="card admin-form" onSubmit={save} aria-labelledby="admin-form-h">
      <h2 id="admin-form-h">{title}</h2>
      {isNew && <p className="field-hint">The owner gets an email to choose their password, then adds their own team. A paid licence is set up once the invoice is paid.</p>}
      <div className="field"><label htmlFor="ao-name">Organization name</label>
        <input id="ao-name" required maxLength={120} value={d.name} onChange={(e) => set("name", e.target.value)} /></div>
      <fieldset className="admin-plans admin-kind">
        <legend>Licence</legend>
        <label className={`org-role-opt${d.kind === "paid" ? " is-on" : ""}`}>
          <input type="radio" name="ao-kind" checked={d.kind === "paid"} onChange={() => set("kind", "paid")} />
          <span><strong>Paid</strong><br /><span className="muted">After the invoice is paid.</span></span>
        </label>
        <label className={`org-role-opt${d.kind === "demo" ? " is-on" : ""}`}>
          <input type="radio" name="ao-kind" checked={d.kind === "demo"} onChange={() => set("kind", "demo")} />
          <span><strong>Demo</strong><br /><span className="muted">Free for {DEMO_DAYS} days, with everything in Organization Advanced.</span></span>
        </label>
      </fieldset>
      <fieldset className="admin-plans">
        <legend>Plan</legend>
        {PLANS.map((p) => (
          <label key={p.id} className={`org-role-opt${d.plan === p.id ? " is-on" : ""}${d.kind === "demo" && isNew && p.id !== "advanced" ? " is-full" : ""}`}>
            <input type="radio" name="ao-plan" value={p.id} checked={d.plan === p.id} disabled={d.kind === "demo" && isNew && p.id !== "advanced"} onChange={() => set("plan", p.id)} />
            <span><strong>{p.name}</strong> <span className="muted">· {d.kind === "demo" ? "free during the demo" : p.price}</span><br /><span className="muted">{p.people}</span></span>
          </label>
        ))}
      </fieldset>
      {isNew && (
        <div className="org-add-row">
          <div className="field"><label htmlFor="ao-owner">Owner's name</label>
            <input id="ao-owner" required autoComplete="off" value={d.owner_name} onChange={(e) => set("owner_name", e.target.value)} /></div>
          <div className="field"><label htmlFor="ao-email">Owner's email</label>
            <input id="ao-email" type="email" required autoComplete="off" value={d.owner_email} onChange={(e) => set("owner_email", e.target.value)} /></div>
        </div>
      )}
      <div className="org-add-row">
        <div className="field"><label htmlFor="ao-start">Subscription starts</label>
          <input id="ao-start" type="date" value={d.starts} onChange={(e) => set("starts", e.target.value)} /></div>
        <div className="field"><label htmlFor="ao-end">Ends</label>
          <input id="ao-end" type="date" value={d.ends} min={d.starts || undefined} onChange={(e) => set("ends", e.target.value)} aria-describedby="ao-end-hint" />
          <span id="ao-end-hint" className="field-hint">Reminders go out 60, 30 and 7 days before and on the day. After it, 14 days of grace, then read-only.</span></div>
      </div>
      <fieldset className="admin-caps">
        <legend>People caps <span className="muted">(leave empty for the plan's numbers)</span></legend>
        {KINDS.map((k) => {
          const planCap = PLAN_CAPS[d.plan]?.[k.key] ?? null;
          return (
            <div className="field" key={k.key}><label htmlFor={`ao-${k.key}`}>{k.label}</label>
              <input id={`ao-${k.key}`} type="number" min={0} inputMode="numeric" placeholder={planCap == null ? "Unlimited" : String(planCap)}
                value={d.limits[k.key]} onChange={(e) => set("limits", { ...d.limits, [k.key]: e.target.value })} /></div>
          );
        })}
      </fieldset>
      <div className="org-add-row">
        <div className="field"><label htmlFor="ao-invoice">Invoice number <span className="muted">(optional)</span></label>
          <input id="ao-invoice" maxLength={80} placeholder="GE-2026-0001" value={d.invoice_ref} onChange={(e) => set("invoice_ref", e.target.value)} /></div>
        <div className="field"><label htmlFor="ao-note">Note <span className="muted">(optional)</span></label>
          <input id="ao-note" maxLength={1000} placeholder="Why, for the licence history" value={d.note} onChange={(e) => set("note", e.target.value)} /></div>
      </div>
      <fieldset className="admin-brand">
        <legend>Branding <span className="muted">(optional · white-label; applied across Geohub, PolyGIS and Land Registry)</span></legend>
        <div className="field"><label htmlFor="ao-brand-name">Display name</label>
          <input id="ao-brand-name" maxLength={120} placeholder="e.g. Osun State Land Information System" value={d.brand_name}
            onChange={(e) => set("brand_name", e.target.value)} aria-describedby="ao-brand-name-hint" />
          <span id="ao-brand-name-hint" className="field-hint">Shown in place of "Geohub". Leave empty to keep the GeoEstate look.</span></div>
        <div className="org-add-row">
          <div className="field"><label htmlFor="ao-brand-color">Brand colour</label>
            <div className="brand-colour-row">
              <input id="ao-brand-color" type="color" value={/^#[0-9a-fA-F]{6}$/.test(d.brand_color) ? d.brand_color : "#088b4e"}
                onChange={(e) => set("brand_color", e.target.value)} aria-label="Pick the brand colour" />
              <input type="text" maxLength={7} placeholder="#088B4E" value={d.brand_color}
                onChange={(e) => set("brand_color", e.target.value)} aria-label="Brand colour hex" />
            </div>
            <span className="field-hint">The accent across the apps (greens, violet, navy) is derived from this and contrast-checked.</span></div>
          <div className="field"><label htmlFor="ao-brand-logo">Logo (top bar)</label>
            <div className="brand-seal-row">
              {d.logo_file
                ? <span className="brand-seal-chosen" title={d.logo_file.name}>{d.logo_file.name}</span>
                : d.logo_current && !d.logo_remove
                  ? <img className="brand-seal-preview" src={d.logo_current} alt="Current logo" />
                  : <span className="brand-seal-none muted">No logo</span>}
              <input id="ao-brand-logo" type="file" accept="image/png,image/jpeg,image/webp"
                onChange={(e) => { const f = e.target.files?.[0] ?? null; setD((p) => ({ ...p, logo_file: f, logo_remove: false })); }} />
              {(d.logo_file || (d.logo_current && !d.logo_remove)) &&
                <Button type="button" small variant="ghost" onClick={() => setD((p) => ({ ...p, logo_file: null, logo_remove: true }))}>Remove</Button>}
            </div>
            <span className="field-hint">Shown in the top bar in place of "Geohub". PNG, JPEG or WebP up to 1 MB.</span></div>
          <div className="field"><label htmlFor="ao-brand-seal">Seal / crest</label>
            <div className="brand-seal-row">
              {d.seal_file
                ? <span className="brand-seal-chosen" title={d.seal_file.name}>{d.seal_file.name}</span>
                : d.seal_current && !d.seal_remove
                  ? <img className="brand-seal-preview" src={d.seal_current} alt="Current seal" />
                  : <span className="brand-seal-none muted">No seal</span>}
              <input id="ao-brand-seal" type="file" accept="image/png,image/jpeg,image/webp"
                onChange={(e) => { const f = e.target.files?.[0] ?? null; setD((p) => ({ ...p, seal_file: f, seal_remove: false })); }} />
              {(d.seal_file || (d.seal_current && !d.seal_remove)) &&
                <Button type="button" small variant="ghost" onClick={() => setD((p) => ({ ...p, seal_file: null, seal_remove: true }))}>Remove</Button>}
            </div>
            <span className="field-hint">A square PNG, JPEG or WebP up to 1 MB, shown on the sign-in screen.</span></div>
        </div>
        <div className="field"><label htmlFor="ao-brand-home">Welcome background</label>
          <div className="brand-seal-row">
            {d.home_file
              ? <span className="brand-seal-chosen" title={d.home_file.name}>{d.home_file.name}</span>
              : d.home_current && !d.home_remove
                ? <img className="brand-home-preview" src={d.home_current} alt="Current welcome background" />
                : <span className="brand-seal-none muted">No background</span>}
            <input id="ao-brand-home" type="file" accept="image/png,image/jpeg,image/webp"
              onChange={(e) => { const f = e.target.files?.[0] ?? null; setD((p) => ({ ...p, home_file: f, home_remove: false })); }} />
            {(d.home_file || (d.home_current && !d.home_remove)) &&
              <Button type="button" small variant="ghost" onClick={() => setD((p) => ({ ...p, home_file: null, home_remove: true }))}>Remove</Button>}
          </div>
          <span className="field-hint">A wide landscape image behind the welcome header (ArcGIS-style). PNG, JPEG or WebP up to 6 MB.</span></div>
      </fieldset>
      {error && <div className="field-error" role="alert">{error}</div>}
      <div className="admin-form-actions">
        <Button type="submit" variant="primary" busy={busy}>{isNew ? (d.kind === "demo" ? "Start the demo and email the owner" : "Set up and email the owner") : "Save changes"}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
