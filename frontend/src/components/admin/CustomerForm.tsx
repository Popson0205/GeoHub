import { useState, type FormEvent } from "react";
import { Button } from "../ui";
import { loadApi } from "../../lib/api";
import { DEMO_DAYS, KINDS, PLAN_CAPS, PLANS, dayAfter, demoEnd, today, yearFrom } from "../../lib/staffConsole";
import type { AdminOrg, LicenceKind, OrgLimits, PeopleKind, PlanId } from "../../lib/types";

export interface Draft { name: string; kind: LicenceKind; plan: PlanId; owner_name: string; owner_email: string; starts: string; ends: string;
  limits: Record<PeopleKind, string>; invoice_ref: string; note: string; request_id?: string }

export const blankDraft = (kind: LicenceKind = "paid"): Draft => {
  const starts = today();
  return { name: "", kind, plan: kind === "demo" ? "advanced" : "standard", owner_name: "", owner_email: "", starts,
    ends: kind === "demo" ? demoEnd(starts) : yearFrom(starts), limits: { seats: "", collectors: "", viewers: "" }, invoice_ref: "", note: "" };
};
export const draftFrom = (o: AdminOrg): Draft => ({ name: o.name, kind: o.licence_kind ?? "paid", plan: o.plan as PlanId, owner_name: o.owner_name ?? "",
  owner_email: o.owner_email ?? "", starts: o.subscription_starts ?? "", ends: o.subscription_ends ?? "", invoice_ref: "", note: "",
  limits: { seats: o.limits.seats?.toString() ?? "", collectors: o.limits.collectors?.toString() ?? "", viewers: o.limits.viewers?.toString() ?? "" } });
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
      const o = isNew
        ? await api.adminCreateOrg({ name: d.name.trim(), plan: d.plan, licence_kind: d.kind, owner_name: d.owner_name.trim(), owner_email: d.owner_email.trim(),
            subscription_starts: d.starts || null, subscription_ends: d.ends || null, limits: limitsOf(d), request_id: d.request_id, ...extra })
        : await api.adminUpdateOrg(orgId, { name: d.name.trim(), plan: d.plan, licence_kind: d.kind, limits: limitsOf(d), ...extra,
            ...(d.starts || d.ends ? { subscription_starts: d.starts || null, subscription_ends: d.ends || null } : { clear_dates: true }) });
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
      {error && <div className="field-error" role="alert">{error}</div>}
      <div className="admin-form-actions">
        <Button type="submit" variant="primary" busy={busy}>{isNew ? (d.kind === "demo" ? "Start the demo and email the owner" : "Set up and email the owner") : "Save changes"}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
