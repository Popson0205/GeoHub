import { useEffect, useRef, useState } from "react";
import { loadApi } from "../lib/api";
import { useAuth } from "../lib/auth";
import type { ProductId, ProductLicence } from "../lib/types";
import { Icon } from "./icons";

const WHAT: Record<ProductId, string> = {
  hub: "Field data, maps and dashboards", land: "Parcels, titles and transfers", check: "Location and due-diligence reports",
  farm: "Crop monitoring from satellite and drone",
};
const NOTE: Partial<Record<ProductLicence["status"], string>> = { demo: "Demo", grace: "Renewal due", expired: "Read-only", suspended: "Suspended" };

const ALL: [ProductId, string][] = [["hub", "Geohub"], ["land", "Land Registry"], ["check", "LandCheck"], ["farm", "FarmScan"]];
const ASK = "geoestate.ng@gmail.com";

/** The GeoEstate products: the organization's own one click away, and the others it could add. */
export default function AppSwitcher() {
  const { user } = useAuth();
  const [apps, setApps] = useState<ProductLicence[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!user?.org) { setApps([]); return; }
    void loadApi().then((a) => a.orgProducts()).then(setApps, () => setApps([]));
  }, [user?.id, user?.org?.id]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", away); window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", esc); };
  }, [open]);
  if (!user) return null;
  const owned = new Set(apps.map((a) => a.product));
  const more = ALL.filter(([p]) => !owned.has(p) && p !== "hub");

  return (
    <div className="menu app-switcher" ref={ref}>
      <button type="button" className="icon-btn app-switcher-btn" aria-label="GeoEstate apps" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="apps" size={20} />
      </button>
      {open && (
        <div className="menu-pop app-switcher-pop" role="menu" aria-label="GeoEstate apps">
          <div className="menu-head"><strong>GeoEstate apps</strong><span>One sign-in for all of them</span></div>
          {apps.map((a) => {
            const here = a.product === "hub";
            const body = <>
              <span className={`app-tile app-${a.product}`} aria-hidden="true">{a.name.slice(0, 1)}</span>
              <span className="app-text"><strong>{a.name}</strong><span>{here ? "You are here" : WHAT[a.product]}</span></span>
              {NOTE[a.status] && <span className={`badge ${a.status === "demo" ? "badge-info" : a.status === "grace" ? "badge-warn" : "badge-bad"}`}>{NOTE[a.status]}</span>}
            </>;
            if (here) return <div key={a.product} className="menu-item app-item is-here" role="menuitem" aria-current="page">{body}</div>;
            if (!a.url) return <div key={a.product} className="menu-item app-item is-off" role="menuitem" aria-disabled="true" title="Not opened yet: GeoEstate is setting it up">{body}</div>;
            return <a key={a.product} className="menu-item app-item" role="menuitem" href={a.url}>{body}</a>;
          })}
          {more.length > 0 && <>
            <div className="menu-sub">More from GeoEstate</div>
            {more.map(([p, name]) => (
              <a key={p} className="menu-item app-item is-more" role="menuitem"
                href={`mailto:${ASK}?subject=${encodeURIComponent(`${name} for ${user.org?.name ?? "our organization"}`)}&body=${encodeURIComponent(`Hello GeoEstate,\n\nWe would like to try ${name}.\n\n${user.name}`)}`}>
                <span className={`app-tile app-${p}`} aria-hidden="true">{name.slice(0, 1)}</span>
                <span className="app-text"><strong>{name}</strong><span>{WHAT[p]}</span></span>
                <span className="badge">Ask for a demo</span>
              </a>
            ))}
          </>}
        </div>
      )}
    </div>
  );
}
