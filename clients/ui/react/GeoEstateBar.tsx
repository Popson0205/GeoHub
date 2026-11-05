/**
 * GeoEstate's top bar for every GeoEstate app: logo, the app's name, the app switcher, who is signed in, sign out;
 * and under it the licence notice, worded as Geohub words it. Needs geoestate.css.
 *
 *   <GeoEstateBar app="Land Registry" logo="/geoestate-logo.png" user={claims} apps={apps} onSignOut={signOut} />
 *
 * `user` = the GeoEstate ID access token's claims; `apps` = GET {geohub api}/id/apps (kits: gid.apps(token)).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

export interface GeoEstateApp { product: string; name: string; status: string; status_name?: string; url: string | null; current: boolean }
export interface GeoEstateUserClaims {
  name: string; email: string; org: { name: string; role: string } | null; staff_role?: string | null;
  product: { name: string; plan_name: string; status: string; licence_kind: string; subscription_ends: string | null; grace_ends: string | null } | null;
}

const WHAT: Record<string, string> = { hub: "Field data, maps and dashboards", land: "Parcels, titles and transfers",
  check: "Location and due-diligence reports", farm: "Crop monitoring from satellite and drone" };
const NOTE: Record<string, [string, string]> = { demo: ["Demo", "ge-badge-info"], grace: ["Renewal due", "ge-badge-warn"],
  expired: ["Read-only", "ge-badge-bad"], suspended: ["Suspended", "ge-badge-bad"] };
const day = (d: string | null) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) : "");

/** What the licence means for the person today, in Geohub's words; null when there is nothing to say. */
export function licenceNotice(p: GeoEstateUserClaims["product"], app: string): { tone: "info" | "warn" | "bad"; text: string } | null {
  if (!p) return null;
  if (p.status === "suspended") return { tone: "bad", text: `Your organization's ${app} access is suspended. Contact GeoEstate NIG Limited to restore it.` };
  if (p.status === "expired") return { tone: "bad", text: `Your organization's ${app} subscription has ended, so it is read-only: you can view and export your work but not add or change anything. Renew with GeoEstate NIG Limited to carry on.` };
  if (p.status === "grace") return { tone: "warn", text: `Your organization's ${app} subscription ended on ${day(p.subscription_ends)}. Everything works until ${day(p.grace_ends)}; after that it is read-only. Renew with GeoEstate NIG Limited.` };
  if (p.status === "demo") return { tone: "info", text: `You are on a ${app} demo until ${day(p.subscription_ends)}. Ask GeoEstate NIG Limited for an invoice to keep using it.` };
  return null;
}

function Apps({ apps }: { apps: GeoEstateApp[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", away); window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", esc); };
  }, [open]);
  if (apps.length < 2) return null;
  return (
    <div className="ge-apps" ref={ref}>
      <button type="button" className="ge-apps-btn" aria-label="GeoEstate apps" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">{[5.5, 12, 18.5].flatMap((y) => [5.5, 12, 18.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.8" fill="currentColor" />))}</svg>
      </button>
      {open && (
        <div className="ge-apps-pop" role="menu" aria-label="GeoEstate apps">
          <div className="ge-apps-head"><strong>GeoEstate apps</strong><span>One sign-in for all of them</span></div>
          {apps.map((a) => {
            const body: ReactNode = <>
              <span className="ge-app-tile" aria-hidden="true">{a.name.slice(0, 1)}</span>
              <span className="ge-app-text"><strong>{a.name}</strong><span>{a.current ? "You are here" : WHAT[a.product] ?? ""}</span></span>
              {NOTE[a.status] && <span className={`ge-badge ${NOTE[a.status][1]}`}>{NOTE[a.status][0]}</span>}
            </>;
            const cls = `ge-app ge-app-${a.product}`;
            if (a.current) return <div key={a.product} className={`${cls} is-here`} role="menuitem" aria-current="page">{body}</div>;
            if (!a.url) return <div key={a.product} className={`${cls} is-off`} role="menuitem" aria-disabled="true">{body}</div>;
            return <a key={a.product} className={cls} role="menuitem" href={a.url}>{body}</a>;
          })}
        </div>
      )}
    </div>
  );
}

export default function GeoEstateBar({ app, logo, home = "/", user, apps = [], onSignOut }:
  { app: string; logo: string; home?: string; user: GeoEstateUserClaims | null; apps?: GeoEstateApp[]; onSignOut?: () => void }) {
  const notice = user ? licenceNotice(user.product, app) : null;
  return (
    <>
      <header className="ge-bar">
        <a className="ge-brand" href={home}><img src={logo} alt="GeoEstate" /><span>GeoEstate <strong>{app}</strong></span></a>
        <span className="ge-spacer" />
        {user && <Apps apps={apps} />}
        {user && <div className="ge-who">{user.name}<span>{user.org?.name ?? (user.staff_role ? "GeoEstate staff" : "")}</span></div>}
        {user && onSignOut && <button type="button" className="ge-btn ge-btn-ghost ge-btn-sm" onClick={onSignOut}>Sign out</button>}
      </header>
      {notice && <div className={`ge-notice ge-notice-${notice.tone}`} role="status">{notice.text}</div>}
    </>
  );
}
