import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth";
import type { OrgLicence } from "../lib/types";

const day = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
const daysTo = (d: string) => Math.round((Date.parse(`${d}T00:00:00`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00`)) / 86400000);

/** What the banner says for a licence, and to whom: null when there is nothing to say. Exported for tests. */
export function licenceNotice(l: OrgLicence | null | undefined, admin: boolean): { tone: "warn" | "bad" | "info"; text: string } | null {
  if (!l) return null;
  if (l.status === "expired")
    return { tone: "bad", text: `Read-only: the subscription ended${l.ends ? ` on ${day(l.ends)}` : ""}. You can view and export your work, but not add or change anything.${admin ? " Renew with GeoEstate NIG Limited to carry on." : " Your administrator can renew it."}` };
  if (!admin) return null;
  if (l.status === "grace" && l.grace_ends)
    return { tone: "warn", text: `The subscription ended${l.ends ? ` on ${day(l.ends)}` : ""}. Everyone keeps full use until ${day(l.grace_ends)}; after that Geohub becomes read-only. Renew with GeoEstate NIG Limited.` };
  if (l.status === "demo" && l.ends && daysTo(l.ends) <= 7)
    return { tone: "info", text: `Your demo ends ${daysTo(l.ends) <= 0 ? "today" : `on ${day(l.ends)}`}. To keep using Geohub, ask GeoEstate NIG Limited for an invoice.` };
  if (l.status === "active" && l.ends && daysTo(l.ends) <= 7 && daysTo(l.ends) >= 0)
    return { tone: "info", text: `The subscription ends ${daysTo(l.ends) === 0 ? "today" : `on ${day(l.ends)}`}. Renew with GeoEstate NIG Limited to keep everything as it is.` };
  return null;
}

/** A line under the top bar when the organization's licence needs attention. */
export default function LicenceBanner() {
  const { user } = useAuth();
  const org = user?.org;
  const n = licenceNotice(org?.licence, org?.role === "owner" || org?.role === "admin");
  if (!n) return null;
  return (
    <div className={`licence-banner is-${n.tone}`} role={n.tone === "bad" ? "alert" : "status"}>
      <span>{n.text}</span>
      {(org?.role === "owner" || org?.role === "admin") && <Link to="/settings/organization">Organization</Link>}
    </div>
  );
}

/** Shown in place of everything else while the organization is suspended. */
export function SuspendedPage() {
  const { user, logout } = useAuth();
  return (
    <div className="container suspended-page">
      <section className="card" role="alert">
        <h1>{user?.org?.name ?? "Your organization"} is suspended</h1>
        <p>GeoEstate NIG Limited has suspended this organization's access to Geohub. Your work is kept safe and comes back as it was
          once the suspension is lifted.</p>
        <p>{user?.org?.role === "owner" || user?.org?.role === "admin" ? "Contact GeoEstate NIG Limited to restore access." : "Ask your organization's administrator, or contact GeoEstate NIG Limited."}</p>
        <button type="button" className="btn" onClick={() => void logout()}>Sign out</button>
      </section>
    </div>
  );
}
