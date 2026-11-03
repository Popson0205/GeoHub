import type { LicenceStatus, PeopleKind, PlanId, StaffActivity, StaffPerm, StaffRole } from "./types";

export const PLANS: { id: PlanId; name: string; price: string; people: string }[] = [
  { id: "standard", name: "Organization Standard", price: "$500 a year", people: "10 team seats · 50 field collectors · 50 viewers · 2 teams" },
  { id: "advanced", name: "Organization Advanced", price: "$1,000 a year", people: "30 team seats · 300 field collectors · unlimited viewers · 10 teams" },
  { id: "custom", name: "Custom", price: "Quoted", people: "No caps unless you set them below" },
];
export const PLAN_CAPS: Record<string, Record<PeopleKind, number | null>> = {
  individual: { seats: 1, collectors: 5, viewers: 5 }, standard: { seats: 10, collectors: 50, viewers: 50 },
  advanced: { seats: 30, collectors: 300, viewers: null }, custom: { seats: null, collectors: null, viewers: null },
};
export const KINDS: { key: PeopleKind; label: string }[] = [
  { key: "seats", label: "Team seats" }, { key: "collectors", label: "Field collectors" }, { key: "viewers", label: "Viewers" },
];
export const GRACE_DAYS = 14;
export const DEMO_DAYS = 30;

export const LICENCE: Record<LicenceStatus, { label: string; badge: string; help: string }> = {
  active: { label: "Active", badge: "badge-ok", help: "Paid and in date." },
  demo: { label: "Demo", badge: "badge-info", help: "A month's free trial of Organization Advanced." },
  grace: { label: "Grace period", badge: "badge-warn", help: `The end date has passed; full use for ${GRACE_DAYS} days, then read-only.` },
  expired: { label: "Expired", badge: "badge-bad", help: "Past the grace period: read-only until renewed." },
  suspended: { label: "Suspended", badge: "badge-bad", help: "Suspended by GeoEstate staff." },
  free: { label: "Free", badge: "badge-quiet", help: "An Individual account." },
};
export const STATUS_FILTERS: { id: LicenceStatus | "due" | ""; label: string }[] = [
  { id: "", label: "All" }, { id: "due", label: "Due in 60 days" }, { id: "demo", label: "Demo" }, { id: "grace", label: "Grace period" },
  { id: "expired", label: "Expired" }, { id: "suspended", label: "Suspended" },
];
export const ROLE_NAMES: Record<StaffRole, string> = { super_admin: "Super admin", account_manager: "Account manager", support: "Support", finance: "Finance" };
export const ROLE_HELP: Record<StaffRole, string> = {
  super_admin: "Everything, including adding and removing staff",
  account_manager: "Customers, licences and requests",
  support: "Views customers; resends links and resets two-step sign-in",
  finance: "Views customers, licences and staff activity",
};
export const can = (perms: StaffPerm[] | undefined, p: StaffPerm) => !!perms?.includes(p);

const iso = (d: Date) => d.toISOString().slice(0, 10);
export const today = () => iso(new Date());
/** A year's subscription ends the day before the same date next year. */
export function yearFrom(start: string): string {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + 1); d.setUTCDate(d.getUTCDate() - 1);
  return iso(d);
}
/** The day after a date: a renewal starts where the last year ended. */
export function dayAfter(d: string): string {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return iso(x);
}
export function demoEnd(start: string): string {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + DEMO_DAYS - 1);
  return iso(d);
}
/** How the renewal date reads in the list, and how urgent it is. */
export function renewal(days: number | null): { text: string; tone: "ok" | "warn" | "bad" | "quiet" } {
  if (days == null) return { text: "No end date", tone: "quiet" };
  if (days < 0) return { text: `Ended ${-days} day${days === -1 ? "" : "s"} ago`, tone: "bad" };
  if (days === 0) return { text: "Ends today", tone: "bad" };
  if (days <= 60) return { text: `${days} day${days === 1 ? "" : "s"} left`, tone: "warn" };
  return { text: `${days} days left`, tone: "ok" };
}
export const longDate = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
export function ago(at: string | null | undefined): string {
  if (!at) return "Never";
  const days = Math.floor((Date.now() - Date.parse(at)) / 86400000);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 60 ? `${days} days ago` : longDate(at);
}

const ACTION_WORDS: Record<string, string> = {
  org_create: "set up the customer", org_update: "changed the customer", org_suspend: "suspended the customer",
  org_reactivate: "lifted the suspension", domain_add: "added a verified domain", send_link: "sent a set-password link",
  mfa_reset: "turned off someone's two-step sign-in", owner_transfer: "made someone the owner", note_add: "added a note",
  note_delete: "deleted a note", staff_add: "added a staff member", staff_update: "changed a staff member's role",
  staff_remove: "removed a staff member", request_update: "updated a request",
  support_start: "opened a support visit", support_end: "ended a support visit",
  // what the customer's own people did
  "org.account_create": "created an account", "org.accounts_import": "added people from a spreadsheet", "org.member_add": "added someone",
  "org.member_invite": "invited someone", "org.member_remove": "removed someone", "org.role_change": "changed someone's role",
  "org.leave": "left the organization", "org.rename": "renamed the organization", "org.branding": "changed the branding", "org.logo": "changed the logo",
  "org.domain_add": "added a domain", "org.domain_verify": "verified a domain", "org.require_mfa": "changed the two-step sign-in rule",
  "org.mfa_reset": "reset someone's two-step sign-in", "org.api_key_create": "made an API key", "org.api_key_revoke": "revoked an API key",
  "org.join_domain": "joined by email domain", "team.create": "made a team", "team.update": "changed a team", "team.delete": "deleted a team",
};
/** A staff action in plain words: "Idris Super suspended the customer". */
export function describe(a: StaffActivity): string {
  const key = a.action.replace(/^platform\./, "");
  const what = ACTION_WORDS[key] ?? key.replace(/^\w+\./, "").replace(/_/g, " ");
  const extra = key === "org_suspend" && a.details.reason ? `: ${String(a.details.reason)}`
    : (key === "staff_add" || key === "staff_remove") && a.details.email ? ` (${String(a.details.email)})`
    : key === "staff_update" && a.details.role ? ` to ${ROLE_NAMES[a.details.role as StaffRole] ?? String(a.details.role)}`
    : key === "domain_add" && a.details.domain ? ` (${String(a.details.domain)})` : "";
  return `${what}${extra}`;
}
const LICENCE_ACTIONS: Record<string, string> = { create: "Set up", demo: "Demo started", renew: "Renewed", change: "Changed", suspend: "Suspended", reactivate: "Reactivated", remove: "Taken away" };
export const licenceAction = (a: string) => LICENCE_ACTIONS[a] ?? a;
