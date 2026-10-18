import type { Geometry, GeoFeature, ReviewStatus } from "../../lib/types";

export const KIND_LABEL = { point: "Point", line: "Line", area: "Area" } as const;
export const kindOf = (g: Geometry): "point" | "line" | "area" => (g.type === "Point" ? "point" : g.type === "LineString" ? "line" : "area");
export const STATUS_LABEL: Record<ReviewStatus, string> = { submitted: "Waiting for review", approved: "Approved", rejected: "Rejected" };
export const STATUS_BADGE: Record<ReviewStatus, string> = { submitted: "badge-warn", approved: "badge-ok", rejected: "badge-bad" };
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const statusOf = (f: GeoFeature): ReviewStatus => f.status ?? "approved";

/** A short, readable summary of a feature's tags: "building=yes, levels=2". */
export function tagSummary(f: GeoFeature, max = 3): string {
  const e = Object.entries(f.properties).filter(([, v]) => v !== "" && v != null);
  if (!e.length) return "No tags";
  const shown = e.slice(0, max).map(([k, v]) => `${k}=${v}`).join(", ");
  return e.length > max ? `${shown} +${e.length - max}` : shown;
}

export function fmtDate(iso?: string, withTime = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return withTime ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}
export function ago(iso?: string): string {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
/** "3 days left", "starts in 2 days", "ended 4 days ago". */
export function timeLeft(starts?: string, ends?: string): string {
  const now = Date.now(), day = 864e5;
  const days = (ms: number) => Math.max(1, Math.round(Math.abs(ms) / day));
  if (starts && Date.parse(starts) > now) return `Starts in ${plural(days(Date.parse(starts) - now), "day")}`;
  if (ends && Date.parse(ends) < now) return `Ended ${plural(days(now - Date.parse(ends)), "day")} ago`;
  if (ends) return `${plural(days(Date.parse(ends) - now), "day")} left`;
  return "No end date";
}
/** <input type="datetime-local"> wants local time without a zone. */
export const toLocalInput = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

export function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function download(name: string, text: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export const slugify = (title: string) => title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
