import { useEffect, useState } from "react";
import { loadApi } from "../lib/api";
import type { SupportVisit } from "../lib/types";

const when = (d: string) => new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Every time GeoEstate support opened the organization's projects, and why: for its owners and administrators. */
export default function SupportVisits() {
  const [visits, setVisits] = useState<SupportVisit[] | null>(null);
  useEffect(() => { void loadApi().then((api) => api.listSupportVisits()).then(setVisits, () => setVisits([])); }, []);
  if (!visits) return null;
  return (
    <section className="card" aria-labelledby="org-support-h">
      <h2 id="org-support-h">Support visits</h2>
      <p className="field-hint">When GeoEstate support opens your projects to help you, it shows here. They can see but not change anything.</p>
      {visits.length === 0 ? <p className="muted">None so far.</p> : (
        <ul className="org-visits">
          {visits.map((v) => (
            <li key={v.id}>
              <span><strong>{v.staff_name ?? "GeoEstate support"}</strong>{v.active && <span className="badge badge-info">Open now</span>}</span>
              <span>{v.reason}</span>
              <span className="muted tnum">{when(v.started_at)}{v.ended_at ? `, ended ${when(v.ended_at)}` : v.active ? `, until ${when(v.ends_at)}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
