import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import AuthFrame from "../components/AuthFrame";
import { Button } from "../components/ui";
import { loadApi } from "../lib/api";
import type { OrgRequestInput, RequestPlan } from "../lib/types";

const PLANS: { id: RequestPlan; name: string; detail: string }[] = [
  { id: "demo", name: "One-month demo", detail: "Free for 30 days, with everything in Organization Advanced" },
  { id: "standard", name: "Organization Standard", detail: "$500 a year · 10 team seats, 50 field collectors, 50 viewers" },
  { id: "advanced", name: "Organization Advanced", detail: "$1,000 a year · 30 team seats, 300 field collectors, unlimited viewers" },
  { id: "custom", name: "Custom", detail: "Your own server or more people than Advanced" },
  { id: "unsure", name: "Not sure yet", detail: "We will help you choose" },
];

/** Public: a company or agency asks GeoEstate to set up an organization. Staff are emailed and follow up with an invoice. */
export default function RequestOrgPage() {
  const [f, setF] = useState<OrgRequestInput>({ organization: "", contact_name: "", email: "", phone: "", plan: "standard", team_size: "", message: "", website: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const set = <K extends keyof OrgRequestInput>(k: K, v: OrgRequestInput[K]) => setF((x) => ({ ...x, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await (await loadApi()).requestOrganization({ ...f, phone: f.phone?.trim() || undefined, team_size: f.team_size?.trim() || undefined,
        message: f.message?.trim() || undefined });
      setSent(true);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not send the request. Try again."); }
    finally { setBusy(false); }
  }

  if (sent) {
    return (
      <AuthFrame>
        <div className="auth-msg" role="status">
          <h1>Thank you</h1>
          <p>We have your request for <strong>{f.organization}</strong>. GeoEstate NIG Limited will contact you at <strong>{f.email}</strong> within two working days {f.plan === "demo" ? "to set up your one-month demo" : "with an invoice and next steps"}.</p>
          <p><Link to="/login">Back to sign in</Link></p>
        </div>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame>
      <form onSubmit={submit} className="request-org">
        <h1>Request an organization</h1>
        <p className="field-hint">For companies, agencies and NGOs. Plans are paid yearly by invoice from GeoEstate NIG Limited, or try one free for a month first; we set everything up and you add your team. Students and individuals can <Link to="/login">create a free account</Link> instead.</p>
        <div className="field"><label htmlFor="ro-org">Organization name</label>
          <input id="ro-org" required maxLength={120} autoComplete="organization" value={f.organization} onChange={(e) => set("organization", e.target.value)} /></div>
        <div className="field"><label htmlFor="ro-name">Your name</label>
          <input id="ro-name" required maxLength={120} autoComplete="name" value={f.contact_name} onChange={(e) => set("contact_name", e.target.value)} /></div>
        <div className="field"><label htmlFor="ro-email">Work email</label>
          <input id="ro-email" type="email" required autoComplete="email" value={f.email} onChange={(e) => set("email", e.target.value)} aria-describedby="ro-email-hint" />
          <span id="ro-email-hint" className="field-hint">This becomes the owner's sign-in.</span></div>
        <div className="field"><label htmlFor="ro-phone">Phone <span className="muted">(optional)</span></label>
          <input id="ro-phone" type="tel" maxLength={40} autoComplete="tel" value={f.phone} onChange={(e) => set("phone", e.target.value)} /></div>
        <fieldset className="request-plans">
          <legend>Plan</legend>
          {PLANS.map((p) => (
            <label key={p.id} className={`org-role-opt${f.plan === p.id ? " is-on" : ""}`}>
              <input type="radio" name="ro-plan" value={p.id} checked={f.plan === p.id} onChange={() => set("plan", p.id)} />
              <span><strong>{p.name}</strong><br /><span className="muted">{p.detail}</span></span>
            </label>
          ))}
        </fieldset>
        <div className="field"><label htmlFor="ro-team">Team size <span className="muted">(optional)</span></label>
          <input id="ro-team" maxLength={60} placeholder="e.g. 6 office staff, 40 field collectors" value={f.team_size} onChange={(e) => set("team_size", e.target.value)} /></div>
        <div className="field"><label htmlFor="ro-msg">What will you collect or map? <span className="muted">(optional)</span></label>
          <textarea id="ro-msg" rows={3} maxLength={2000} value={f.message} onChange={(e) => set("message", e.target.value)} /></div>
        {/* left empty by people; robots fill it in */}
        <div className="sr-only" aria-hidden="true"><label htmlFor="ro-web">Website</label>
          <input id="ro-web" tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => set("website", e.target.value)} /></div>
        {error && <div className="field-error" role="alert">{error}</div>}
        <Button type="submit" variant="primary" busy={busy}>Send request</Button>
        <p className="meta" style={{ marginTop: 12 }}>Already have an account? <Link to="/login">Sign in</Link></p>
      </form>
    </AuthFrame>
  );
}
