import { toKml } from "../lib/kml";
import { readable } from "../lib/brand";
import { ApiError, MfaRequired, tokens, type Api } from "../lib/api";
import { normalizeConfig } from "../lib/dashboard";
import { publicDashboard } from "../lib/dashboardShare";
import { coerceCell, importableFields, parseCsv, parseNumber, parseShape } from "../lib/csvImport";
import { topLevelFields } from "../lib/fieldSpec";
import { validateProperties, uuid } from "../lib/forms";
import type { OrgBranding, MediaItem, FeatureStatus, AuditEvent, AuditKind, Org, OrgMember, OrgRole, EmailCheck, AccountInput, AccountResult, PasswordLink,
  AdminOrg, AdminOrgInput, AdminOrgPatch, OrgRequest, OrgRequestInput, RequestStatus, DomainRole, OrgDomain, SsoProvider, DatasetVisibility,
  Dashboard, DashboardConfig, ImportOptions,
  Bundle, Change, Dataset, ExportFormat, Feature, FeatureCollection, Form, Geometry, GeometryType, ImageryAsset,
  Job, License, NewFeature, Project, Props, PullResult, PushResult, Session, User,
  GeoFeature, MapImportResult, MapLayers, WorkMap,
  InstallationLicence, IssuedLicenceKey, ProductId, ProductInput, ProductLicence, SupportVisit, StaffMember, StaffNote, StaffActivity, StaffRole, StaffMe, LicenceEvent, LicenceStatus, AdminOrgDetail, AdminPerson,
  Team, ProjectTeam, TeamProjectRole, ImportResult, ImportRow, MfaStatus, ApiKey, AddableRole, PeopleKind,
  Activity, ContributorsReport, ProjectMember, PublicForm, Role, ShareMode, Sharing, JoinPreview, MapMember, MapRole, MapSettings, PublishInput, ReviewStatus,
  FormTemplate, FormField,
} from "../lib/types";
import { DEMO_USER, seedDatasets, seedFeatureRows, seedForms, seedProjects, seedSharedMaps } from "./seed";

type Row = Feature & { seq: number };
interface State {
  dashboards?: Dashboard[]; dashboardLinks?: Record<string, string>; projects: Project[]; forms: Form[]; features: Row[]; imagery: ImageryAsset[]; datasets: Dataset[]; seq: number;
  sharing?: Record<string, { share_mode: ShareMode; share_token: string }>;
  members?: Record<string, ProjectMember[]>;
  maps?: MockMap[]; mapFeatures?: MockFeat[];
  mapMembers?: { map_id: string; user_id: string; name: string; role: Exclude<MapRole, "owner">; joined_at: string }[];
  mapSnapshots?: Record<string, FeatureCollection["features"]>; mapKinds?: Record<string, "point" | "line" | "area">; mapSeeded?: boolean;
  audit?: (AuditEvent & { project_id: string })[];
  org?: { id: string; name: string; slug: string; plan: string; limits: Org["limits"]; subscription_starts?: string | null; subscription_ends?: string | null;
    branding?: OrgBranding; require_mfa?: boolean; suspended?: boolean; licence_kind?: "paid" | "demo" };
  orgMembers?: OrgMember[];
  adminOrgs?: AdminOrg[]; orgRequests?: OrgRequest[]; orgDomains?: OrgDomain[];
  supportVisits?: (SupportVisit & { org_id: string })[];
  staffList?: StaffMember[]; licenceLog?: Record<string, LicenceEvent[]>; staffNotes?: Record<string, StaffNote[]>; staffActivity?: StaffActivity[];
  licenceKeys?: Record<string, IssuedLicenceKey[]>;
  orgProducts?: Record<string, Partial<Record<ProductId, { plan: string; kind: "paid" | "demo"; starts: string | null; ends: string | null }>>>;
  teams?: { id: string; name: string; description: string; created_at: string; members: { user_id: string; lead: boolean }[] }[];
  projectTeams?: { project_id: string; team_id: string; role: TeamProjectRole }[];
  mfa?: { enabled_at: string | null; pending: boolean; recovery: string[] };
  apiKeys?: ApiKey[];
}
/** The mock keeps who owns a map and who drew each feature, like the real backend does. */
type MockMap = Omit<WorkMap, "role" | "owner_name" | "member_count" | "campaign_status" | "feature_count"> & { owner_id: string; owner_name: string; feature_count?: number };
type MockFeat = GeoFeature & { map_id: string; created_by: string; author: string; status: ReviewStatus; review_note?: string; created_at: string; updated_at: string; updated_by?: string };
const KIND_NAME = { point: "point", line: "line", area: "polygon" } as const;
const GEOM_KIND = (g: Geometry): "point" | "line" | "area" => (g.type === "Point" ? "point" : g.type === "LineString" ? "line" : "area");

const PLAN_NAMES: Record<string, string> = { individual: "Individual", standard: "Organization Standard", advanced: "Organization Advanced", custom: "Custom" };
const PLAN_CAPS: Record<string, Org["caps"]> = {
  individual: { seats: 1, collectors: 5, viewers: 5, teams: 0 }, standard: { seats: 10, collectors: 50, viewers: 50, teams: 2 },
  advanced: { seats: 30, collectors: 300, viewers: null, teams: 10 }, custom: { seats: null, collectors: null, viewers: null, teams: null },
};
/** In demo mode the authenticator app's code is always this. */
export const MOCK_MFA_CODE = "123456";
const KEY = "geohub.mock.v1";
const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as State;
  } catch { /* fall through to seed */ }
  return { projects: seedProjects, forms: seedForms, features: seedFeatureRows() as Row[], imagery: [], datasets: seedDatasets, seq: 100 };
}

/** In-memory stand-in for the backend so the whole frontend runs offline. State persists in localStorage. */
export class MockApi implements Api {
  private s: State = load();
  private jobs = new Map<string, { job: Job; polls: number; url?: string; error?: string }>();

  private save() { try { localStorage.setItem(KEY, JSON.stringify(this.s)); } catch { /* storage full */ } }
  private auth() { if (!tokens.get()) throw new ApiError(401, "Sign in to continue."); }
  private counts(p: Project): Project {
    const mine = this.s.features.filter((f) => f.project_id === p.id && !f.deleted);
    return { ...p, feature_count: mine.length, waiting_count: mine.filter((f) => f.status === "submitted").length };
  }
  private strip(r: Row): Feature { const { seq: _s, ...f } = r; return f; }
  /** The demo organization: the demo account owns it, with three collectors and one invitation. */
  private get orgState() {
    if (!this.s.org) {
      const day = 86400000, at = (d: number) => new Date(Date.now() - d * day).toISOString();
      const y = new Date().getFullYear();
      this.s.org = { id: "org1", name: "Osogbo Field Team", slug: "osogbo-field-team", plan: "standard", limits: {},
        subscription_starts: `${y}-01-15`, subscription_ends: `${y + 1}-01-14` };
      this.s.orgMembers = [
        { id: DEMO_USER.id, user_id: DEMO_USER.id, email: DEMO_USER.email, name: DEMO_USER.name, role: "owner", status: "active", joined_at: at(30) },
        { id: "u-ada", user_id: "u-ada", email: "ada@example.com", name: "Ada Okafor", role: "admin", status: "active", joined_at: at(20) },
        { id: "u-musa", user_id: "u-musa", email: "musa@example.com", name: "Musa Bello", role: "member", status: "active", joined_at: at(18) },
        { id: "u-tolu", user_id: "u-tolu", email: "tolu@example.com", name: "Tolu Adeyemi", role: "collector", status: "active", joined_at: at(18) },
        { id: "u-femi", user_id: "u-femi", email: "femi@example.com", name: "Femi Ojo", role: "viewer", status: "active", joined_at: at(9) },
        { id: "inv-1", user_id: null, email: "kemi@example.com", name: null, role: "member", status: "invited", joined_at: at(2) },
      ];
    }
    return { org: this.s.org, members: this.s.orgMembers! };
  }
  private me_(): User {
    const { org, members } = this.orgState;
    const role = members.find((m) => m.user_id === DEMO_USER.id)?.role ?? "member";
    // the demo account also plays GeoEstate staff, so the platform admin page can be tried
    const b = org.branding;
    const brand = org.plan !== "individual" && (b?.color || b?.logo_url) ? { color: b?.color ?? null, logo_url: b?.logo_url ?? null } : null;
    const mfaOn = !!this.s.mfa?.enabled_at;
    const ends = org.subscription_ends ?? null;
    const today = new Date().toISOString().slice(0, 10);
    const graceEnds = ends ? new Date(Date.parse(ends) + 14 * 86400000).toISOString().slice(0, 10) : null;
    const status = org.suspended ? "suspended" : !ends || ends >= today ? (org.licence_kind === "demo" ? "demo" : "active") : graceEnds! >= today ? "grace" : "expired";
    const licence = org.plan === "individual" ? null : { status, ends, grace_ends: graceEnds, kind: org.licence_kind ?? "paid" } as const;
    return { ...DEMO_USER, org: { id: org.id, name: org.name, slug: org.slug, role, plan: org.plan, brand, licence }, must_change_password: false, platform_admin: true, staff_role: "super_admin",
      mfa_enabled: mfaOn, mfa_setup_required: !!org.require_mfa && !mfaOn };
  }
  async getOrg(): Promise<Org> {
    await wait(); this.auth();
    const { org, members } = this.orgState;
    const me = this.me_().org!;
    const kind = (r: OrgRole) => (r === "collector" ? "collectors" : r === "viewer" ? "viewers" : "seats");
    const count = (k: string) => members.filter((m) => kind(m.role) === k).length;
    return { ...org, role: me.role, single_org: false, plan_name: PLAN_NAMES[org.plan] ?? org.plan,
      branding: org.branding ?? { color: null, logo_url: null, sender_name: null, reply_to: null },
      caps: { ...(PLAN_CAPS[org.plan] ?? PLAN_CAPS.individual), ...org.limits } as Org["caps"], require_mfa: !!org.require_mfa,
      usage: { seats: count("seats"), collectors: count("collectors"), viewers: count("viewers"), teams: (this.s.teams ?? []).length,
        projects: this.s.projects.length, records: this.s.features.filter((f) => !f.deleted).length } };
  }
  // GeoEstate ID (demo): Land Registry, LandCheck and FarmScan, at any address
  async idClient(clientId: string, _redirectUri: string) {
    await wait();
    const name = ({ land: "Land Registry", check: "LandCheck", farm: "FarmScan", gis: "PolyGIS" } as Record<string, string>)[clientId];
    if (!name) throw new ApiError(400, "This app is not registered with Geohub (ID_CLIENTS).", undefined, "unknown_client");
    return { id: clientId, name, product: clientId };
  }
  async idAuthorize(req: { client_id: string; redirect_uri: string; state?: string }) {
    const c = await this.idClient(req.client_id, req.redirect_uri);
    const has = (await this.orgProducts()).some((p) => p.product === c.product);
    if (!has && !this.me_().platform_admin) throw new ApiError(403, `${this.orgState.org.name} does not have ${c.name}. Ask GeoEstate NIG Limited for it, or for a month's demo.`, undefined, "no_product");
    const u = new URL(req.redirect_uri);
    u.searchParams.set("code", "demo-code"); if (req.state) u.searchParams.set("state", req.state);
    return { redirect_to: u.toString(), app: c.name };
  }
  async orgProducts(): Promise<ProductLicence[]> {
    await wait(); this.auth();
    const { org } = this.orgState;
    const lic = this.me_().org!.licence;
    const hub: ProductLicence = { product: "hub", name: "Geohub", plan: org.plan, plan_name: PLAN_NAMES[org.plan] ?? org.plan,
      licence_kind: org.licence_kind ?? "paid", status: (lic?.status ?? "free") as LicenceStatus, status_name: lic?.status ?? "Free",
      subscription_starts: org.subscription_starts ?? null, subscription_ends: lic?.ends ?? null, grace_ends: lic?.grace_ends ?? null,
      limits: {}, features: [], url: window.location.origin };
    return [hub, ...this.otherProducts(org.id, !!org.suspended)];
  }
  // ---- other GeoEstate products (demo): kept per organization
  private get productState() { return (this.s.orgProducts ??= {}); }
  private otherProducts(orgId: string, suspended: boolean): ProductLicence[] {
    const NAMES: Record<string, string> = { land: "Land Registry", check: "LandCheck", farm: "FarmScan", gis: "PolyGIS" };
    const today = new Date().toISOString().slice(0, 10);
    return (["land", "check", "farm", "gis"] as const).flatMap((k) => {
      const r = this.productState[orgId]?.[k];
      if (!r) return [];
      const grace = r.ends ? new Date(Date.parse(r.ends) + 14 * 86400000).toISOString().slice(0, 10) : null;
      const status: LicenceStatus = suspended ? "suspended" : !r.ends || r.ends >= today ? (r.kind === "demo" ? "demo" : "active") : grace! >= today ? "grace" : "expired";
      return [{ product: k, name: NAMES[k], plan: r.plan, plan_name: `${NAMES[k]} ${r.plan[0].toUpperCase()}${r.plan.slice(1)}`, licence_kind: r.kind,
        status, status_name: status[0].toUpperCase() + status.slice(1), subscription_starts: r.starts, subscription_ends: r.ends, grace_ends: grace,
        limits: {}, features: [], url: null }];
    });
  }
  private productsOf(o: AdminOrg): ProductLicence[] {
    const f = this.fill(o);
    return [{ product: "hub", name: "Geohub", plan: f.plan, plan_name: f.plan_name, licence_kind: f.licence_kind ?? "paid", status: f.status ?? "active",
      status_name: f.status ?? "active", subscription_starts: f.subscription_starts, subscription_ends: f.subscription_ends, grace_ends: f.grace_ends ?? null,
      limits: {}, features: [], url: window.location.origin }, ...this.otherProducts(o.id, !!o.suspended_at)];
  }
  async adminPutProduct(orgId: string, product: ProductId, input: ProductInput) {
    await wait(); this.staff();
    const o = this.customer(orgId);
    if (product === "hub") throw new ApiError(422, "That product is licensed on the organization itself.");
    if (o.plan === "individual") throw new ApiError(409, "Individual accounts cannot have other products.");
    let { subscription_starts: starts = null, subscription_ends: ends = null } = input;
    if (input.licence_kind === "demo") {
      const t = new Date(); starts ??= t.toISOString().slice(0, 10); ends ??= new Date(t.getTime() + 29 * 86400000).toISOString().slice(0, 10);
    }
    this.checkDates(starts, ends);
    const had = !!this.productState[orgId]?.[product];
    (this.productState[orgId] ??= {})[product] = { plan: input.plan, kind: input.licence_kind, starts, ends };
    const log = (this.staffState.log[orgId] ??= []);
    log.unshift({ id: Date.now() + log.length, product, action: had ? "change" : input.licence_kind === "demo" ? "demo" : "create", plan: input.plan,
      kind: input.licence_kind, starts, ends, limits: {}, invoice_ref: input.invoice_ref?.trim() || null, note: input.note?.trim() || null,
      actor_name: DEMO_USER.name, at: new Date().toISOString() });
    this.logStaff("product_set", orgId, { product }); this.save();
    return this.productsOf(o);
  }
  // ---- licence keys (demo: made-up keys, not signed)
  async adminLicenceKeySettings() { await wait(); this.staff(); return { can_issue: true, public_key: "DEMO-PUBLIC-KEY-not-for-real-installations-0" }; }
  async adminIssueLicenceKey(orgId: string, input: { installation: string; ends?: string; note?: string }): Promise<IssuedLicenceKey> {
    await wait(); this.staff();
    let site: URL;
    try { site = new URL(input.installation); } catch { throw new ApiError(422, "The installation's address must be a web address, e.g. https://geohub.client.gov.ng"); }
    const o = this.customer(orgId);
    const products = this.productsOf(o).map((p) => ({ product: p.product, name: p.name, plan_name: p.plan_name, starts: p.subscription_starts, ends: input.ends || p.subscription_ends }));
    const k: IssuedLicenceKey = { id: uuid(), customer: o.name, installation: `${site.protocol}//${site.host}`, issued_at: new Date().toISOString(),
      note: input.note?.trim() || null, issued_by: DEMO_USER.name, products, key: `GEOESTATE-LICENCE-1.${btoa(o.name).replace(/=+$/, "")}.demo-signature` };
    ((this.s.licenceKeys ??= {})[orgId] ??= []).unshift(k);
    this.logStaff("licence_key", orgId, { installation: k.installation }); this.save();
    return k;
  }
  async adminGetLicenceKey(id: string) {
    await wait(); this.staff();
    const k = Object.values(this.s.licenceKeys ?? {}).flat().find((x) => x.id === id);
    if (!k) throw new ApiError(404, "Licence key not found.");
    return k;
  }
  async orgLicenceKey(): Promise<InstallationLicence> { await wait(); return { required: false, installed: null, can_check: false, installation: window.location.origin }; }
  async installLicenceKey(_key: string): Promise<InstallationLicence> {
    await wait(); throw new ApiError(409, "This Geohub is run by GeoEstate: its licences are managed for you, without a key.");
  }
  async adminRemoveProduct(orgId: string, product: ProductId, note: string) {
    await wait(); this.staff();
    const o = this.customer(orgId);
    if (!this.productState[orgId]?.[product]) throw new ApiError(404, "This customer does not have that product.");
    delete this.productState[orgId]![product];
    const log = (this.staffState.log[orgId] ??= []);
    log.unshift({ id: Date.now() + log.length, product, action: "remove", plan: "none", kind: "paid", starts: null, ends: null, limits: {},
      invoice_ref: null, note: note.trim(), actor_name: DEMO_USER.name, at: new Date().toISOString() });
    this.logStaff("product_remove", orgId, { product }); this.save();
    return this.productsOf(o);
  }
  private orgAdmin() { const r = this.me_().org!.role; if (r === "member") throw new ApiError(403, "This needs an organization admin."); return r; }
  async renameOrg(name: string) { await wait(); this.auth(); this.orgAdmin(); this.orgState.org.name = name.trim(); this.save(); return this.getOrg(); }
  async listOrgMembers() {
    await wait(); this.auth();
    return this.orgState.members.map((m) => (m.user_id === DEMO_USER.id ? { ...m, mfa_enabled: !!this.s.mfa?.enabled_at } : m));
  }
  async inviteOrgMember(email: string, role: "admin" | "member"): Promise<OrgMember> {
    await wait(); this.auth();
    if (this.orgAdmin() !== "owner" && role === "admin") throw new ApiError(403, "Only an owner can add administrators.");
    const { org, members } = this.orgState;
    const e = email.trim().toLowerCase();
    if (members.some((m) => m.email === e && m.status === "active")) throw new ApiError(409, "That person is already in your organization.");
    if (org.limits.seats != null && members.length >= org.limits.seats) throw new ApiError(402, `Your organization's plan allows ${org.limits.seats} people. Ask the organization owner to upgrade, or remove some first.`);
    const existing = members.find((m) => m.email === e);
    if (existing) { existing.role = role; this.save(); return existing; }
    const m: OrgMember = { id: uuid(), user_id: null, email: e, name: null, role, status: "invited", joined_at: new Date().toISOString() };
    members.push(m); this.save();
    return m;
  }
  async setOrgMemberRole(userId: string, role: OrgRole) {
    await wait(); this.auth();
    if (this.orgAdmin() !== "owner") throw new ApiError(403, "This needs an organization owner.");
    const { members } = this.orgState;
    const m = members.find((x) => x.user_id === userId);
    if (!m) throw new ApiError(404, "That person is not in your organization.");
    if (m.role === "owner" && role !== "owner" && members.filter((x) => x.role === "owner").length === 1) throw new ApiError(409, "An organization needs at least one owner. Make someone else an owner first.");
    m.role = role; this.save();
    return m;
  }
  async removeOrgMember(userId: string) {
    await wait(); this.auth();
    const me = this.orgAdmin();
    const { members } = this.orgState;
    const m = members.find((x) => x.user_id === userId);
    if (!m) throw new ApiError(404, "That person is not in your organization.");
    if (userId === DEMO_USER.id) throw new ApiError(409, "To leave the organization yourself, use Leave.");
    if ((m.role === "owner" || m.role === "admin") && me !== "owner") throw new ApiError(403, "Only an owner can remove an owner or administrator.");
    members.splice(members.indexOf(m), 1); this.save();
  }
  async cancelOrgInvite(invitationId: string) {
    await wait(); this.auth(); this.orgAdmin();
    const { members } = this.orgState;
    const i = members.findIndex((x) => x.id === invitationId && x.status === "invited");
    if (i < 0) throw new ApiError(404, "Invitation not found.");
    members.splice(i, 1); this.save();
  }
  async createAccount(input: AccountInput): Promise<AccountResult> {
    await wait(); this.auth();
    if (this.orgAdmin() !== "owner" && input.role === "admin") throw new ApiError(403, "Only an owner can add administrators.");
    const { members } = this.orgState;
    const e = input.email.trim().toLowerCase();
    if (members.some((m) => m.email === e)) throw new ApiError(409, "That person is already in your organization.");
    const o = await this.getOrg();
    const k = input.role === "collector" ? "collectors" : input.role === "viewer" ? "viewers" : "seats";
    const cap = o.caps[k];
    if (cap != null && o.usage[k] >= cap) throw new ApiError(402, `Your plan (${o.plan_name}) includes ${cap} ${k === "seats" ? "team seats" : k === "collectors" ? "field collectors" : "viewers"}, and all are in use. Remove someone first, or contact GeoEstate to add more.`);
    const id = uuid();
    const m: OrgMember = { id, user_id: id, email: e, name: input.name.trim(), role: input.role, status: "active", joined_at: new Date().toISOString() };
    members.push(m); this.save();
    const temp = input.delivery === "temporary" ? "Kp7d-Qm3x-Ta9e" : null;
    return { member: m, temporary_password: temp, email_sent: !temp };
  }
  async sendSignInLink(userId: string) { await wait(); this.auth(); this.orgAdmin(); if (!this.orgState.members.some((m) => m.user_id === userId)) throw new ApiError(404, "That person is not in your organization."); }
  async passwordLink(token: string): Promise<PasswordLink> {
    await wait();
    if (token !== "demo-link") throw new ApiError(404, "This link is not valid. Ask for a new one.");
    return { email: DEMO_USER.email, name: DEMO_USER.name, purpose: "set", org_name: this.orgState.org.name };
  }
  async setPassword(token: string, _password: string): Promise<Session> {
    await this.passwordLink(token);
    return this.login(DEMO_USER.email, "demo");
  }
  async forgotPassword(_email: string) { await wait(); }
  // ---- branding
  private brandAdmin() {
    this.auth(); this.orgAdmin();
    if (this.orgState.org.plan === "individual") throw new ApiError(403, "Your own logo, colour and email sender come with Organization plans. Ask GeoEstate for one.");
    return (this.orgState.org.branding ??= { color: null, logo_url: null, sender_name: null, reply_to: null });
  }
  async updateBranding(patch: { color?: string; sender_name?: string; reply_to?: string }) {
    await wait(); const b = this.brandAdmin();
    if (patch.color != null) {
      const c = patch.color.trim();
      if (c && !/^#?[0-9a-f]{6}$/i.test(c)) throw new ApiError(422, "Use a colour like #0b5cad.", { color: "not a colour" });
      b.color = c ? readable(c.startsWith("#") ? c.toLowerCase() : `#${c.toLowerCase()}`) : null;
    }
    if (patch.sender_name != null) b.sender_name = patch.sender_name.replace(/[<>"]/g, "").trim() || null;
    if (patch.reply_to != null) {
      const r = patch.reply_to.trim().toLowerCase();
      if (r && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(r)) throw new ApiError(422, "Enter an email address for replies.", { reply_to: "not an email" });
      b.reply_to = r || null;
    }
    this.save(); return this.getOrg();
  }
  async uploadLogo(file: File) {
    await wait(); const b = this.brandAdmin();
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new ApiError(422, "Use a PNG, JPEG or WebP image for the logo.");
    if (file.size > 1_000_000) throw new ApiError(413, "The logo is larger than 1 MB. Use a smaller image.");
    b.logo_url = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => res(""); r.readAsDataURL(file); });
    this.save(); return this.getOrg();
  }
  async removeLogo() { await wait(); const b = this.brandAdmin(); b.logo_url = null; this.save(); return this.getOrg(); }
  // ---- Google / Microsoft sign-in (the demo account stands in), and company domains
  async listProviders(): Promise<SsoProvider[]> { await wait(); return ["google", "microsoft"]; }
  ssoStartUrl(provider: SsoProvider, next: string) { return `/sso?code=demo-${provider}&next=${encodeURIComponent(next)}`; }
  async ssoExchange(code: string) {
    if (!code.startsWith("demo-")) { await wait(); throw new ApiError(401, "This sign-in has expired. Sign in again."); }
    return this.login(DEMO_USER.email, "demo");
  }
  async joinOrganization(token: string) {
    await wait();
    if (token !== "demo-join") throw new ApiError(404, "This link is not valid. Ask for a new one.");
    return this.login(DEMO_USER.email, "demo");
  }
  private get domainState() { return (this.s.orgDomains ??= []); }
  private domainAdmin() {
    this.auth(); this.orgAdmin();
    if (this.orgState.org.plan === "individual") throw new ApiError(403, "Joining by company email domain comes with Organization plans. Ask GeoEstate for one.");
  }
  private domain(d: string) { const x = this.domainState.find((y) => y.domain === d); if (!x) throw new ApiError(404, "That domain is not one of your organization's."); return x; }
  async listDomains() { await wait(); this.auth(); this.orgAdmin(); return [...this.domainState]; }
  async addDomain(raw: string) {
    await wait(); this.domainAdmin();
    const d = raw.trim().toLowerCase().replace(/^@/, "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/.]+$/, "");
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(d)) throw new ApiError(422, "Enter a domain like yourcompany.com.", { domain: "not a domain" });
    if (["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com"].includes(d)) throw new ApiError(422, `${d} is a public email service, not your company's domain.`, { domain: "public" });
    if (this.domainState.some((x) => x.domain === d)) throw new ApiError(409, `${d} is already added to your organization.`);
    const x: OrgDomain = { domain: d, verified: false, auto_join: true, role: "member", created_at: new Date().toISOString(),
      record: { type: "TXT", name: d, value: `geohub-verification=${uuid().replace(/-/g, "").slice(0, 24)}` } };
    this.domainState.push(x); this.save();
    return x;
  }
  async verifyDomain(d: string) {
    await wait(500); this.domainAdmin();
    const x = this.domain(d);
    // demo: a domain ending in .test verifies; others say the record is missing
    if (!x.verified && !d.endsWith(".test")) throw new ApiError(422, `The TXT record was not found on ${d} yet. Add it at your domain registrar (name: @ or the domain itself; value: ${x.record.value}). New records can take up to an hour to appear.`);
    Object.assign(x, { verified: true, verified_at: x.verified_at ?? new Date().toISOString() }); this.save();
    return { ...x };
  }
  async updateDomain(d: string, patch: { auto_join?: boolean; role?: DomainRole }) {
    await wait(); this.domainAdmin();
    const x = this.domain(d);
    Object.assign(x, patch); this.save();
    return { ...x };
  }
  async removeDomain(d: string) { await wait(); this.auth(); this.orgAdmin(); this.domain(d); this.s.orgDomains = this.domainState.filter((x) => x.domain !== d); this.save(); }
  async adminAddDomain(orgId: string, raw: string) {
    await wait(); this.staff();
    const o = this.adminState.orgs.find((x) => x.id === orgId);
    if (!o) throw new ApiError(404, "Organization not found.");
    const d = raw.trim().toLowerCase().replace(/^@/, "");
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(d)) throw new ApiError(422, "Enter a domain like yourcompany.com.");
    if (this.adminState.orgs.some((x) => x.id !== orgId && (x.domains ?? []).includes(d))) throw new ApiError(409, `${d} belongs to another organization. Remove it there first.`);
    o.domains = [...(o.domains ?? []).filter((x) => x.replace(" (unverified)", "") !== d), d]; this.save();
    return { domain: d, verified: true, verified_at: new Date().toISOString(), auto_join: true, role: "member" as DomainRole,
      created_at: new Date().toISOString(), record: { type: "TXT" as const, name: d, value: "geohub-verification=checked-by-staff" } };
  }
  // ---- platform admin
  private get adminState() {
    if (!this.s.adminOrgs) {
      const d = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
      const ago = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
      const org = (id: string, name: string, plan: string, ends: number | null, owner: [string, string], usage: [number, number, number]): AdminOrg => ({
        id, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), plan, plan_name: PLAN_NAMES[plan], caps: { ...PLAN_CAPS[plan] }, limits: {},
        usage: { seats: usage[0], collectors: usage[1], viewers: usage[2], projects: 3, records: 1200 },
        subscription_starts: ends == null ? null : d(ends - 365), subscription_ends: ends == null ? null : d(ends), days_left: ends,
        owner_name: owner[0], owner_email: owner[1], created_at: ago(400 - (ends ?? 0)), licence_kind: "paid", suspended_at: null, suspended_reason: null,
        last_active: ago(2) });
      this.s.adminOrgs = [
        org("org-a", "Lagos Survey Ltd", "standard", 24, ["Ada Obi", "ada@lagossurvey.example.com"], [7, 31, 12]),
        org("org-b", "Kaduna State Land Agency", "advanced", 210, ["Musa Bello", "musa@kadland.example.com"], [22, 180, 64]),
        org("org-c", "Green Cities NGO", "custom", null, ["Tolu Adeyemi", "tolu@greencities.example.com"], [40, 400, 90]),
        org("org-d", "Ogun Farm Mapping", "standard", -5, ["Femi Ojo", "femi@ogunfarms.example.com"], [3, 12, 2]),
      ];
      this.s.adminOrgs = this.s.adminOrgs.map((o) => this.fill(o));
      this.s.orgRequests = [{ id: "req-1", organization: "Ibadan Water Board", contact_name: "Kemi Lawal", email: "kemi@ibwater.example.com",
        phone: "+234 803 000 0000", plan: "standard", team_size: "8 staff, 40 field collectors", message: "We map boreholes across Oyo State.",
        status: "new", note: null, org_id: null, created_at: ago(1), updated_at: ago(1) }];
    }
    return { orgs: this.s.adminOrgs, requests: this.s.orgRequests! };
  }
  private staff() { this.auth(); if (!this.me_().platform_admin) throw new ApiError(404, "Not found."); }
  // ---- the staff console (demo: you are a super admin)
  private get staffState() {
    this.s.staffList ??= [{ user_id: DEMO_USER.id, name: DEMO_USER.name, email: DEMO_USER.email, role: "super_admin", mfa_enabled: true, from_settings: true, last_active: new Date().toISOString() }];
    this.s.licenceLog ??= {}; this.s.staffNotes ??= {}; this.s.staffActivity ??= [];
    return { staff: this.s.staffList, log: this.s.licenceLog, notes: this.s.staffNotes, activity: this.s.staffActivity };
  }
  private logStaff(action: string, orgId: string | null, details: Record<string, unknown> = {}) {
    const o = orgId ? this.adminState.orgs.find((x) => x.id === orgId) : undefined;
    this.staffState.activity.unshift({ id: this.staffState.activity.length + 1, at: new Date().toISOString(), action: `platform.${action}`,
      actor_id: DEMO_USER.id, actor_name: DEMO_USER.name, org_id: orgId, org_name: o?.name ?? null, target_type: orgId ? "organization" : null, target_id: orgId, details });
  }
  private logLicence(o: AdminOrg, action: string, invoice_ref?: string, note?: string) {
    const log = (this.staffState.log[o.id] ??= []);
    log.unshift({ id: Date.now() + log.length, action, plan: o.plan, kind: o.licence_kind ?? "paid", starts: o.subscription_starts, ends: o.subscription_ends,
      limits: o.limits, invoice_ref: invoice_ref?.trim() || null, note: note?.trim() || null, actor_name: DEMO_USER.name, at: new Date().toISOString() });
  }
  async adminMe(): Promise<StaffMe> {
    await wait(40); this.staff();
    return { role: "super_admin", role_name: "Super admin", perms: ["customers.view", "audit.view", "customers.support", "licences.edit", "requests.edit", "staff.manage"], mfa_ok: true };
  }
  async adminListCustomers(filter: { q?: string; status?: LicenceStatus | "due" } = {}) {
    const all = (await this.adminListOrgs(filter.q)).map((o) => this.fill(o));
    if (filter.status === "due") return all.filter((o) => o.days_left != null && o.days_left >= 0 && o.days_left <= 60 && !o.suspended_at);
    return filter.status ? all.filter((o) => o.status === filter.status) : all;
  }
  private customer(id: string) { const o = this.adminState.orgs.find((x) => x.id === id); if (!o) throw new ApiError(404, "Organization not found."); return o; }
  async adminGetOrg(id: string): Promise<AdminOrgDetail> {
    await wait(); this.staff();
    const o = this.fill(this.customer(id));
    const ago = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
    const people: AdminPerson[] = [
      { user_id: `${id}-owner`, name: o.owner_name ?? "Owner", email: o.owner_email ?? "", role: "owner", mfa_enabled: true, last_active: ago(1), joined_at: o.created_at },
      { user_id: `${id}-p2`, name: "Bola Ade", email: `bola@${(o.owner_email ?? "x@client.example.com").split("@")[1]}`, role: "admin", mfa_enabled: false, last_active: ago(6), joined_at: o.created_at },
      { user_id: `${id}-p3`, name: "Chidi Eze", email: `chidi@${(o.owner_email ?? "x@client.example.com").split("@")[1]}`, role: "collector", mfa_enabled: false, last_active: null, joined_at: o.created_at },
    ];
    const s = this.staffState;
    if (!s.log[id]?.length) this.logLicence(o, "create");
    const projects = this.s.projects.map((p) => ({ id: p.id, name: p.name, records: this.s.features.filter((f) => f.project_id === p.id && !f.deleted).length, last_update: p.updated_at }));
    return { ...o, people, invited: 1, api_keys: 0, teams: 1, licences: [...s.log[id]], notes: [...(s.notes[id] ?? [])], projects,
      support_visits: this.visitsOf(id), products: this.productsOf(o), licence_keys: (this.s.licenceKeys?.[id] ?? []).map(({ key: _k, ...rest }) => rest),
      activity: s.activity.filter((a) => a.org_id === id) };
  }
  private visitsOf(orgId: string): SupportVisit[] {
    const now = Date.now();
    return (this.s.supportVisits ?? []).filter((v) => v.org_id === orgId)
      .map(({ org_id: _o, ...v }) => ({ ...v, active: !v.ended_at && Date.parse(v.ends_at) > now }))
      .sort((a, b) => b.started_at.localeCompare(a.started_at));
  }
  async adminStartVisit(orgId: string, reason: string, hours: number) {
    await wait(); this.staff(); this.customer(orgId);
    const list = (this.s.supportVisits ??= []);
    list.forEach((v) => { if (v.org_id === orgId && !v.ended_at) v.ended_at = new Date().toISOString(); });
    const v = { id: uuid(), org_id: orgId, staff_id: DEMO_USER.id, staff_name: DEMO_USER.name, reason: reason.trim(), started_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + hours * 3600000).toISOString(), ended_at: null, active: true };
    list.push(v); this.logStaff("support_start", orgId, { reason, hours }); this.save();
    return this.visitsOf(orgId).find((x) => x.id === v.id)!;
  }
  async adminEndVisit(visitId: string) {
    await wait(); this.staff();
    const v = (this.s.supportVisits ?? []).find((x) => x.id === visitId);
    if (!v) throw new ApiError(404, "Support visit not found.");
    v.ended_at ??= new Date().toISOString(); this.logStaff("support_end", v.org_id); this.save();
    return this.visitsOf(v.org_id).find((x) => x.id === visitId)!;
  }
  async listSupportVisits() {
    await wait(); this.auth(); this.orgAdmin();
    const d = 86400000;
    return [{ id: "sv-1", staff_id: "staff-1", staff_name: "Funke Ola (GeoEstate)", reason: "You asked why the Osogbo map showed no records",
      started_at: new Date(Date.now() - 3 * d).toISOString(), ends_at: new Date(Date.now() - 3 * d + 7200000).toISOString(),
      ended_at: new Date(Date.now() - 3 * d + 1800000).toISOString(), active: false }];
  }
  async adminSuspend(id: string, reason: string) {
    await wait(); this.staff();
    const o = this.customer(id); Object.assign(o, { suspended_at: new Date().toISOString(), suspended_reason: reason.trim() });
    const f = this.fill(o); Object.assign(o, f); this.logLicence(o, "suspend", undefined, reason); this.logStaff("org_suspend", id, { reason }); this.save();
    return f;
  }
  async adminReactivate(id: string) {
    await wait(); this.staff();
    const o = this.customer(id);
    if (!o.suspended_at) throw new ApiError(409, "This customer is not suspended.");
    Object.assign(o, { suspended_at: null, suspended_reason: null });
    const f = this.fill(o); Object.assign(o, f); this.logLicence(o, "reactivate"); this.logStaff("org_reactivate", id); this.save();
    return f;
  }
  async adminAddNote(orgId: string, body: string) {
    await wait(); this.staff(); this.customer(orgId);
    const n: StaffNote = { id: uuid(), body: body.trim(), author_id: DEMO_USER.id, author_name: DEMO_USER.name, created_at: new Date().toISOString() };
    (this.staffState.notes[orgId] ??= []).unshift(n); this.logStaff("note_add", orgId); this.save();
    return n;
  }
  async adminDeleteNote(noteId: string) {
    await wait(); this.staff();
    for (const [orgId, list] of Object.entries(this.staffState.notes)) {
      const i = list.findIndex((n) => n.id === noteId);
      if (i >= 0) { list.splice(i, 1); this.logStaff("note_delete", orgId); this.save(); return; }
    }
    throw new ApiError(404, "Note not found.");
  }
  async adminSendLink(orgId: string, userId: string) { await wait(); this.staff(); this.customer(orgId); this.logStaff("send_link", orgId, { user: userId }); this.save(); }
  async adminResetMfa(orgId: string, userId: string) {
    await wait(); this.staff(); this.customer(orgId);
    if (!userId.endsWith("-owner")) throw new ApiError(409, "They do not have two-step sign-in on.");
    this.logStaff("mfa_reset", orgId, { user: userId }); this.save();
  }
  async adminMakeOwner(orgId: string, userId: string) {
    await wait(); this.staff();
    const d = await this.adminGetOrg(orgId);
    const p = d.people.find((x) => x.user_id === userId);
    if (!p) throw new ApiError(404, "That person is not in this organization.");
    Object.assign(this.customer(orgId), { owner_name: p.name, owner_email: p.email });
    this.logStaff("owner_transfer", orgId, { user: userId }); this.save();
    const after = await this.adminGetOrg(orgId);
    after.people = after.people.map((x) => (x.email === p.email ? { ...x, role: "owner" } : x.role === "owner" && x.email !== p.email ? { ...x, role: "admin" } : x));
    return after;
  }
  async adminListStaff() { await wait(); this.staff(); return [...this.staffState.staff]; }
  async adminAddStaff(input: { email: string; name?: string; role: StaffRole }) {
    await wait(); this.staff();
    const email = input.email.trim().toLowerCase();
    if (this.staffState.staff.some((x) => x.email === email)) throw new ApiError(409, "That person is already on the staff. Change their role instead.");
    this.staffState.staff.push({ user_id: uuid(), name: input.name?.trim() || email.split("@")[0], email, role: input.role, mfa_enabled: false, from_settings: false,
      last_active: null, created_at: new Date().toISOString() });
    this.logStaff("staff_add", null, { email, role: input.role }); this.save();
    return [...this.staffState.staff];
  }
  async adminSetStaffRole(userId: string, role: StaffRole) {
    await wait(); this.staff();
    if (userId === DEMO_USER.id) throw new ApiError(409, "Ask another super admin to change your own role.");
    const m = this.staffState.staff.find((x) => x.user_id === userId);
    if (!m || m.from_settings) throw new ApiError(404, "That person is not on the staff, or is in PLATFORM_ADMINS (changed only there).");
    m.role = role; this.logStaff("staff_update", null, { role }); this.save();
    return [...this.staffState.staff];
  }
  async adminRemoveStaff(userId: string) {
    await wait(); this.staff();
    if (userId === DEMO_USER.id) throw new ApiError(409, "Ask another super admin to remove you.");
    const i = this.staffState.staff.findIndex((x) => x.user_id === userId && !x.from_settings);
    if (i < 0) throw new ApiError(404, "That person is not on the staff, or is in PLATFORM_ADMINS (removed only there).");
    const [m] = this.staffState.staff.splice(i, 1); this.logStaff("staff_remove", null, { email: m.email }); this.save();
    return [...this.staffState.staff];
  }
  async adminActivity(filter: { org_id?: string; actor_id?: string; before?: number } = {}) {
    await wait(); this.staff();
    return this.staffState.activity.filter((a) => (!filter.org_id || a.org_id === filter.org_id) && (!filter.before || a.id < filter.before));
  }
  async requestOrganization(input: OrgRequestInput) {
    await wait();
    if (input.website) return;
    const now = new Date().toISOString();
    this.adminState.requests.unshift({ ...input, id: uuid(), status: "new", note: null, org_id: null, created_at: now, updated_at: now });
    this.save();
  }
  async adminListOrgs(q?: string) {
    await wait(); this.staff();
    const t = (q ?? "").trim().toLowerCase();
    return this.adminState.orgs.filter((o) => !t || `${o.name} ${o.slug} ${o.owner_email}`.toLowerCase().includes(t));
  }
  private fill(o: AdminOrg): AdminOrg {
    const caps = { ...(PLAN_CAPS[o.plan] ?? PLAN_CAPS.individual), ...o.limits } as AdminOrg["caps"];
    const days = o.subscription_ends ? Math.round((Date.parse(o.subscription_ends) - Date.parse(new Date().toISOString().slice(0, 10))) / 86400000) : null;
    const kind = o.licence_kind ?? "paid";
    const status: LicenceStatus = o.suspended_at ? "suspended" : o.plan === "individual" ? "free" : days == null || days >= 0 ? (kind === "demo" ? "demo" : "active")
      : days >= -14 ? "grace" : "expired";
    const grace = o.subscription_ends ? new Date(Date.parse(o.subscription_ends) + 14 * 86400000).toISOString().slice(0, 10) : null;
    return { ...o, plan_name: PLAN_NAMES[o.plan] ?? o.plan, caps, days_left: days, licence_kind: kind, status, grace_ends: grace };
  }
  private checkDates(starts?: string | null, ends?: string | null) {
    if (starts && ends && ends < starts) throw new ApiError(422, "The subscription cannot end before it starts.", { subscription_ends: "before start" });
  }
  async adminCreateOrg(input: AdminOrgInput) {
    await wait(); this.staff();
    const demo = input.licence_kind === "demo";
    if (demo) {
      const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
      input = { ...input, plan: "advanced", subscription_starts: input.subscription_starts || day(0), subscription_ends: input.subscription_ends || day(29) };
    }
    this.checkDates(input.subscription_starts, input.subscription_ends);
    const { orgs, requests } = this.adminState;
    const email = input.owner_email.trim().toLowerCase();
    if (orgs.some((o) => o.owner_email === email)) throw new ApiError(409, "That email already belongs to an organization with work in it. Use another email for the owner.", { owner_email: "already in use" });
    const o = this.fill({ id: uuid(), name: input.name.trim(), slug: input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), plan: input.plan,
      plan_name: "", caps: PLAN_CAPS.individual, limits: input.limits ?? {}, usage: { seats: 1, collectors: 0, viewers: 0, projects: 0, records: 0 },
      subscription_starts: input.subscription_starts ?? null, subscription_ends: input.subscription_ends ?? null, days_left: null,
      owner_name: input.owner_name.trim(), owner_email: email, created_at: new Date().toISOString(), licence_kind: demo ? "demo" : "paid", last_active: null });
    orgs.unshift(o);
    this.logLicence(o, demo ? "demo" : "create", input.invoice_ref, input.note);
    this.logStaff("org_create", o.id, { plan: o.plan, kind: o.licence_kind });
    const r = requests.find((x) => x.id === input.request_id);
    if (r) Object.assign(r, { status: "set_up", org_id: o.id, updated_at: new Date().toISOString() });
    this.save();
    return o;
  }
  async adminUpdateOrg(id: string, patch: AdminOrgPatch) {
    await wait(); this.staff();
    const { orgs } = this.adminState;
    const i = orgs.findIndex((o) => o.id === id);
    if (i < 0) throw new ApiError(404, "Organization not found.");
    const o = orgs[i];
    const next = { ...o, ...(patch.name != null && { name: patch.name.trim() }), ...(patch.plan && { plan: patch.plan }), ...(patch.licence_kind && { licence_kind: patch.licence_kind }),
      ...(patch.limits && { limits: patch.limits }),
      ...(patch.clear_dates ? { subscription_starts: null, subscription_ends: null } : {
        subscription_starts: patch.subscription_starts ?? o.subscription_starts, subscription_ends: patch.subscription_ends ?? o.subscription_ends }) };
    this.checkDates(next.subscription_starts, next.subscription_ends);
    orgs[i] = this.fill(next);
    if (patch.plan || patch.licence_kind || patch.limits || patch.subscription_starts || patch.subscription_ends || patch.clear_dates) {
      const renewed = !!(patch.subscription_ends && o.subscription_ends && patch.subscription_ends > o.subscription_ends);
      this.logLicence(orgs[i], renewed ? "renew" : "change", patch.invoice_ref, patch.note);
    }
    this.logStaff("org_update", id); this.save();
    return orgs[i];
  }
  async adminListRequests() { await wait(); this.staff(); return [...this.adminState.requests]; }
  async adminUpdateRequest(id: string, patch: { status?: RequestStatus; note?: string }) {
    await wait(); this.staff();
    const r = this.adminState.requests.find((x) => x.id === id);
    if (!r) throw new ApiError(404, "Request not found.");
    Object.assign(r, patch.status ? { status: patch.status } : {}, patch.note != null ? { note: patch.note } : {}, { updated_at: new Date().toISOString() });
    this.save();
    return { ...r };
  }
  async changePassword(current: string, next: string) {
    await wait(); this.auth();
    if (current !== "demo") throw new ApiError(422, "The current password is not right.", { current_password: "not right" });
    if (next.length < 8) throw new ApiError(422, "Use at least 8 characters.", { new_password: "too short" });
  }
  async checkEmail(): Promise<EmailCheck> {
    await wait(600); this.auth(); this.orgAdmin();
    return { ok: false, provider: "log", steps: [{ status: "fail", name: "Email service",
      detail: "Demo mode has no email server. On your own server, set BREVO_API_KEY and MAIL_FROM, then try again." }] };
  }
  async leaveOrg() {
    await wait(); this.auth();
    throw new ApiError(409, "In demo mode you are the organization's only owner, so you cannot leave it.");
  }
  /** The project's history, like the server's audit log. Seeded with a believable past the first time it is read. */
  private get auditLog() {
    if (!this.s.audit) {
      const day = 86400000, now = Date.now();
      const people = [{ id: "u-ada", name: "Ada Okafor" }, { id: "u-musa", name: "Musa Bello" }, { id: "u-tolu", name: "Tolu Adeyemi" }];
      const seed: (AuditEvent & { project_id: string })[] = [];
      let id = 1;
      const add = (at: number, a: Omit<AuditEvent, "id" | "at">, pid = "p1") => seed.push({ id: id++, at: new Date(at).toISOString(), project_id: pid, ...a });
      add(now - 20 * day, { actor_id: DEMO_USER.id, actor_name: DEMO_USER.name, action: "project.create", target_type: "project", target_id: "p1", target_name: this.s.projects.find((p) => p.id === "p1")?.name, details: {} });
      add(now - 19 * day, { actor_id: DEMO_USER.id, actor_name: DEMO_USER.name, action: "form.publish", target_type: "form", target_id: "f1", target_name: this.s.forms.find((x) => x.id === "f1")?.name, details: { version: 1 } });
      for (const p of people) add(now - 18 * day, { actor_id: DEMO_USER.id, actor_name: DEMO_USER.name, action: "member.add", target_type: "user", target_id: p.id, target_name: p.name, details: { role: "collector" } });
      const rows = this.s.features.filter((r) => r.project_id === "p1" && !r.deleted);
      rows.forEach((r, i) => {
        const who = people[Math.floor(i / 4) % 3]!, at = now - (16 - Math.floor(i / 4)) * day + (i % 4) * 600000;   // each collector adds a few at a time
        add(at, { actor_id: who.id, actor_name: who.name, action: "feature.create", target_type: "feature", target_id: r.id, target_name: this.s.forms.find((x) => x.id === r.form_id)?.name, details: { form_id: r.form_id } });
        if (r.status === "approved" || r.status === "rejected")
          add(at + day / 2, { actor_id: DEMO_USER.id, actor_name: DEMO_USER.name, action: "feature.review", target_type: "feature", target_id: r.id, target_name: this.s.forms.find((x) => x.id === r.form_id)?.name, details: { decision: r.status } });
      });
      this.s.audit = seed.sort((a, b) => a.at.localeCompare(b.at)).map((e, i) => ({ ...e, id: i + 1 }));
    }
    return this.s.audit;
  }
  private log(projectId: string, action: string, target_type: string, target_id: string, details: Record<string, unknown> = {}) {
    const l = this.auditLog;
    const target_name = target_type === "feature" ? this.s.forms.find((x) => x.id === this.s.features.find((r) => r.id === target_id)?.form_id)?.name
      : target_type === "form" ? this.s.forms.find((x) => x.id === target_id)?.name
      : target_type === "user" ? (this.memberList(projectId).find((m) => m.id === target_id)?.name ?? this.memberList(projectId).find((m) => m.id === target_id)?.email)
      : target_type === "dashboard" ? this.dashboards.find((d) => d.id === target_id)?.name : undefined;
    l.push({ id: (l[l.length - 1]?.id ?? 0) + 1, at: new Date().toISOString(), project_id: projectId, actor_id: DEMO_USER.id, actor_name: DEMO_USER.name, action, target_type, target_id, target_name, details });
  }
  async listActivity(projectId: string, opts: { kind?: AuditKind; actor?: string; cursor?: string | null } = {}) {
    await wait(); this.auth();
    const prefix: Record<AuditKind, string[]> = { records: ["feature."], forms: ["form."], people: ["member."], publishing: ["dataset.", "export."], dashboards: ["dashboard."], project: ["project.", "imagery."] };
    const before = opts.cursor ? Number(opts.cursor) : Infinity;
    const all = this.auditLog.filter((e) => e.project_id === projectId && e.id < before
      && (!opts.kind || prefix[opts.kind].some((p) => e.action.startsWith(p))) && (!opts.actor || e.actor_id === opts.actor))
      .sort((a, b) => b.id - a.id);
    const items = all.slice(0, 50).map(({ project_id: _p, ...e }) => e);
    return { items, next_cursor: all.length > 50 ? String(items[items.length - 1]!.id) : null };
  }

  async login(email: string, password: string): Promise<Session> {
    await wait();
    if (email.trim().toLowerCase() !== DEMO_USER.email || password !== "demo") throw new ApiError(401, "Wrong email or password. In mock mode use demo@geohub.test / demo.");
    if (this.s.mfa?.enabled_at) throw new MfaRequired("mock-mfa");
    const s: Session = { access_token: "mock-token", refresh_token: "mock-refresh", user: this.me_() };
    tokens.set(s);
    return s;
  }
  // ---- two-step sign-in (demo: the app's code is always 123456)
  private get mfaState() { return (this.s.mfa ??= { enabled_at: null, pending: false, recovery: [] }); }
  private checkCode(code: string) {
    const c = code.replace(/\s/g, "").toLowerCase();
    if (c === MOCK_MFA_CODE) return;
    const i = this.mfaState.recovery.indexOf(c);
    if (i >= 0) { this.mfaState.recovery.splice(i, 1); this.save(); return; }
    throw new ApiError(401, `That code is not right. In demo mode the code is ${MOCK_MFA_CODE}.`);
  }
  async verifyMfa(token: string, code: string): Promise<Session> {
    await wait();
    if (token !== "mock-mfa") throw new ApiError(401, "The sign-in took too long. Sign in again.");
    this.checkCode(code);
    const s: Session = { access_token: "mock-token", refresh_token: "mock-refresh", user: this.me_() };
    tokens.set(s);
    return s;
  }
  async mfaStatus(): Promise<MfaStatus> {
    await wait(40); this.auth();
    const m = this.mfaState;
    return { enabled: !!m.enabled_at, enabled_at: m.enabled_at, recovery_codes_left: m.enabled_at ? m.recovery.length : 0, required_by_org: !!this.orgState.org.require_mfa };
  }
  async startMfaSetup() {
    await wait(); this.auth();
    if (this.mfaState.enabled_at) throw new ApiError(409, "Two-step sign-in is already on.");
    this.mfaState.pending = true; this.save();
    const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
    return { secret, otpauth_url: `otpauth://totp/Geohub:${encodeURIComponent(DEMO_USER.email)}?secret=${secret}&issuer=Geohub` };
  }
  private newCodes() { return Array.from({ length: 10 }, (_, i) => `demo${i}-code${i}`); }
  async enableMfa(code: string) {
    await wait(); this.auth();
    if (!this.mfaState.pending) throw new ApiError(409, "Start the setup first.");
    if (code.replace(/\s/g, "") !== MOCK_MFA_CODE) throw new ApiError(422, `That code is not right. In demo mode the code is ${MOCK_MFA_CODE}.`, { code: "not right" });
    const codes = this.newCodes();
    Object.assign(this.mfaState, { enabled_at: new Date().toISOString(), pending: false, recovery: codes.map((c) => c.toLowerCase()) });
    this.save();
    return codes;
  }
  async disableMfa(code: string) {
    await wait(); this.auth();
    if (this.orgState.org.require_mfa) throw new ApiError(409, "Your organization requires two-step sign-in, so it cannot be turned off.");
    this.checkCode(code);
    this.s.mfa = { enabled_at: null, pending: false, recovery: [] }; this.save();
  }
  async newRecoveryCodes(code: string) {
    await wait(); this.auth(); this.checkCode(code);
    const codes = this.newCodes(); this.mfaState.recovery = codes.map((c) => c.toLowerCase()); this.save();
    return codes;
  }
  async setRequireMfa(required: boolean) {
    await wait(); this.auth(); this.orgAdmin();
    if (this.orgState.org.plan === "individual") throw new ApiError(403, "Requiring two-step sign-in comes with Organization plans.");
    if (required && !this.mfaState.enabled_at) throw new ApiError(409, "Turn on two-step sign-in for yourself first, so you are not locked out.");
    this.orgState.org.require_mfa = required; this.save();
    return this.getOrg();
  }
  async resetMemberMfa(userId: string) {
    await wait(); this.auth(); this.orgAdmin();
    if (userId === DEMO_USER.id) throw new ApiError(409, "Turn off your own under Account security.");
  }
  // ---- API keys
  private get keyState() { return (this.s.apiKeys ??= []); }
  private paidOnly(what: string) { if (this.orgState.org.plan === "individual") throw new ApiError(403, `${what} come with Organization plans. Ask GeoEstate for one.`); }
  async listApiKeys(all = false) {
    await wait(); this.auth(); this.paidOnly("API keys");
    if (all) this.orgAdmin();
    return this.keyState.filter((k) => all || k.user_id === DEMO_USER.id).sort((a, b) => Number(!!a.revoked_at) - Number(!!b.revoked_at) || b.created_at.localeCompare(a.created_at));
  }
  async createApiKey(input: { name: string; access: "read" | "write"; expires_in_days?: number | null }) {
    await wait(); this.auth(); this.paidOnly("API keys");
    const key = `ghk_${uuid().replace(/-/g, "")}`;
    const k: ApiKey = { id: uuid(), name: input.name.trim(), prefix: key.slice(0, 12), access: input.access, created_at: new Date().toISOString(),
      expires_at: input.expires_in_days ? new Date(Date.now() + input.expires_in_days * 86400000).toISOString() : null,
      last_used_at: null, revoked_at: null, user_id: DEMO_USER.id, user_name: DEMO_USER.name, user_email: DEMO_USER.email };
    this.keyState.push(k); this.save();
    return { ...k, key };
  }
  async revokeApiKey(id: string) {
    await wait(); this.auth();
    const k = this.keyState.find((x) => x.id === id);
    if (!k) throw new ApiError(404, "Key not found.");
    k.revoked_at ??= new Date().toISOString(); this.save();
  }
  // ---- teams
  private get teamState() { return (this.s.teams ??= []); }
  private teamOut(t: NonNullable<State["teams"]>[number]): Team {
    const { members } = this.orgState;
    const admin = ["owner", "admin"].includes(this.me_().org!.role);
    const lead = t.members.some((m) => m.user_id === DEMO_USER.id && m.lead);
    return { id: t.id, name: t.name, description: t.description, created_at: t.created_at,
      members: t.members.flatMap((tm) => { const p = members.find((m) => m.user_id === tm.user_id); return p ? [{ user_id: tm.user_id, name: p.name ?? p.email, email: p.email, role: p.role, lead: tm.lead }] : []; })
        .sort((a, b) => Number(b.lead) - Number(a.lead) || a.name.localeCompare(b.name)),
      projects: (this.s.projectTeams ?? []).filter((pt) => pt.team_id === t.id).flatMap((pt) => { const p = this.s.projects.find((x) => x.id === pt.project_id); return p ? [{ project_id: p.id, name: p.name, role: pt.role }] : []; }),
      you_lead: lead, can_manage_people: admin || lead, can_edit: admin };
  }
  private team(id: string) { const t = this.teamState.find((x) => x.id === id); if (!t) throw new ApiError(404, "Team not found."); return t; }
  async listTeams() { await wait(); this.auth(); return this.teamState.map((t) => this.teamOut(t)).sort((a, b) => a.name.localeCompare(b.name)); }
  async createTeam(input: { name: string; description?: string }) {
    await wait(); this.auth(); this.orgAdmin();
    const cap = (await this.getOrg()).caps.teams;
    if (cap === 0) throw new ApiError(402, "Teams come with Organization plans. Ask GeoEstate for one.");
    if (cap != null && this.teamState.length >= cap) throw new ApiError(402, `Your plan includes ${cap} teams, and all are in use. Delete a team first, or contact GeoEstate to add more.`);
    if (this.teamState.some((t) => t.name.toLowerCase() === input.name.trim().toLowerCase())) throw new ApiError(409, "There is already a team with that name.", { name: "taken" });
    const t = { id: uuid(), name: input.name.trim(), description: input.description?.trim() ?? "", created_at: new Date().toISOString(), members: [] };
    this.teamState.push(t); this.save();
    return this.teamOut(t);
  }
  async updateTeam(id: string, patch: { name?: string; description?: string }) {
    await wait(); this.auth(); this.orgAdmin();
    const t = this.team(id);
    if (patch.name != null) t.name = patch.name.trim();
    if (patch.description != null) t.description = patch.description.trim();
    this.save(); return this.teamOut(t);
  }
  async deleteTeam(id: string) {
    await wait(); this.auth(); this.orgAdmin(); this.team(id);
    this.s.teams = this.teamState.filter((t) => t.id !== id);
    this.s.projectTeams = (this.s.projectTeams ?? []).filter((pt) => pt.team_id !== id); this.save();
  }
  async putTeamMember(teamId: string, userId: string, lead?: boolean) {
    await wait(); this.auth();
    const t = this.team(teamId), out = this.teamOut(t);
    if (!out.can_manage_people) throw new ApiError(403, "Only administrators and the team's leads can change who is in it.");
    const person = this.orgState.members.find((m) => m.user_id === userId);
    if (!person) throw new ApiError(404, "That person is not in your organization.");
    const cur = t.members.find((m) => m.user_id === userId);
    const next = lead ?? !!cur?.lead;
    if (next !== !!cur?.lead && !out.can_edit) throw new ApiError(403, "Only administrators choose a team's leads.");
    if (next && (person.role === "collector" || person.role === "viewer")) throw new ApiError(422, "A team lead needs a team seat (a member, administrator or owner).", { lead: "needs a team seat" });
    if (cur) cur.lead = next; else t.members.push({ user_id: userId, lead: next });
    this.save(); return this.teamOut(t);
  }
  async removeTeamMember(teamId: string, userId: string) {
    await wait(); this.auth();
    const t = this.team(teamId);
    if (!this.teamOut(t).can_manage_people) throw new ApiError(403, "Only administrators and the team's leads can change who is in it.");
    t.members = t.members.filter((m) => m.user_id !== userId); this.save();
    return this.teamOut(t);
  }
  private projectTeamsOut(projectId: string): ProjectTeam[] {
    return (this.s.projectTeams ?? []).filter((pt) => pt.project_id === projectId).flatMap((pt) => {
      const t = this.teamState.find((x) => x.id === pt.team_id);
      return t ? [{ team_id: t.id, name: t.name, role: pt.role, member_count: t.members.length }] : [];
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
  async listProjectTeams(projectId: string) { await wait(40); this.auth(); return this.projectTeamsOut(projectId); }
  async putProjectTeam(projectId: string, teamId: string, role: TeamProjectRole) {
    await wait(); this.auth(); this.team(teamId);
    const list = (this.s.projectTeams ??= []);
    const cur = list.find((pt) => pt.project_id === projectId && pt.team_id === teamId);
    if (cur) cur.role = role; else list.push({ project_id: projectId, team_id: teamId, role });
    this.save(); return this.projectTeamsOut(projectId);
  }
  async removeProjectTeam(projectId: string, teamId: string) {
    await wait(); this.auth();
    this.s.projectTeams = (this.s.projectTeams ?? []).filter((pt) => !(pt.project_id === projectId && pt.team_id === teamId));
    this.save(); return this.projectTeamsOut(projectId);
  }
  // ---- adding many people from a spreadsheet (demo: CSV only)
  async importPeople(file: File, opts: { preview: boolean; delivery: "email" | "temporary"; default_role: AddableRole }): Promise<ImportResult> {
    await wait(); this.auth(); this.orgAdmin();
    if (/\.xlsx$/i.test(file.name)) throw new ApiError(422, "In demo mode, choose a CSV file. The real server also reads Excel (.xlsx).", { file: "csv only in demo" });
    const parsed = parseCsv(await file.text());
    const head = parsed.headers.map((h) => h.trim().toLowerCase());
    const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
    const ci = { email: col("email", "e-mail"), name: col("name", "full name"), role: col("role"), team: col("team", "department"), projects: col("projects", "project") };
    if (ci.email < 0 || ci.name < 0) throw new ApiError(422, "The first row must name the columns, with at least “email” and “name”.", { file: "missing columns" });
    const ROLES: Record<string, AddableRole> = { admin: "admin", administrator: "admin", member: "member", collector: "collector", "field collector": "collector", viewer: "viewer" };
    const { members } = this.orgState;
    const seen = new Set<string>();
    const needed: Record<PeopleKind, number> = { seats: 0, collectors: 0, viewers: 0 };
    const rows: ImportRow[] = parsed.rows.map((r, i) => {
      const cell = (k: number) => (k >= 0 ? (r[k] ?? "").trim() : "");
      const email = cell(ci.email).toLowerCase(), name = cell(ci.name), rawRole = cell(ci.role).toLowerCase();
      const role = rawRole ? ROLES[rawRole] : opts.default_role;
      const team = cell(ci.team) || null, projects = cell(ci.projects).split(";").map((x) => x.trim()).filter(Boolean);
      const errs: string[] = [];
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) errs.push("Not an email address.");
      if (!name) errs.push("Name is empty.");
      if (seen.has(email)) errs.push("This email is in the file twice.");
      seen.add(email);
      if (!role) errs.push(`Unknown role “${rawRole}”.`);
      if (team && !this.teamState.some((t) => t.name.toLowerCase() === team.toLowerCase())) errs.push(`No team called “${team}”. Make it under Teams first.`);
      for (const p of projects) if (!this.s.projects.some((x) => x.name.toLowerCase() === p.toLowerCase())) errs.push(`No project called “${p}”.`);
      if (members.some((m) => m.email === email)) errs.push("Already in your organization.");
      if (!errs.length && role) needed[role === "collector" ? "collectors" : role === "viewer" ? "viewers" : "seats"]++;
      return { row: i + 2, email, name, role: role ?? rawRole, team, projects, status: errs.length ? "error" : "new", error: errs.join(" ") || null };
    });
    const o = await this.getOrg();
    const capacity = (Object.keys(needed) as PeopleKind[]).filter((k) => needed[k]).map((k) => ({ kind: k, needed: needed[k], left: o.caps[k] == null ? null : Math.max(0, o.caps[k]! - o.usage[k]) }));
    const ok = rows.every((r) => r.status !== "error") && capacity.every((c) => c.left == null || c.needed <= c.left);
    if (opts.preview) return { rows, capacity, ok, done: false };
    if (!ok) throw new ApiError(422, "Nothing was added. Fix the rows marked in the preview (or make room on the plan), then try again.");
    for (const r of rows) {
      const id = uuid();
      members.push({ id, user_id: id, email: r.email, name: r.name, role: r.role as OrgRole, status: "active", joined_at: new Date().toISOString() });
      const t = r.team ? this.teamState.find((x) => x.name.toLowerCase() === r.team!.toLowerCase()) : undefined;
      if (t) t.members.push({ user_id: id, lead: false });
      r.status = "created";
      if (opts.delivery === "temporary") r.temporary_password = `Demo-${String(r.row).padStart(4, "0")}-Pass`;
    }
    this.save();
    return { rows, capacity, ok: true, done: true, emails_queued: opts.delivery === "email" ? rows.length : 0 };
  }
  async logout() { tokens.clear(); }
  async register(): Promise<Session> { return this.login("demo@geohub.test", "demo"); }
  async me(): Promise<User> { await wait(40); this.auth(); return this.me_(); }

  async listProjects() { await wait(); this.auth(); return this.s.projects.map((p) => this.counts(p)); }
  async getProject(id: string) {
    await wait(60); this.auth();
    const p = this.s.projects.find((x) => x.id === id);
    if (!p) throw new ApiError(404, "Project not found.");
    return this.counts(p);
  }
  async createProject(name: string, description?: string) {
    await wait(); this.auth();
    const p: Project = { id: uuid(), name, description, role: "owner", feature_count: 0, collector_count: 1, updated_at: new Date().toISOString() };
    this.s.projects.unshift(p); this.save();
    return p;
  }

  async listForms(projectId: string) { await wait(60); this.auth(); return this.s.forms.filter((f) => f.project_id === projectId); }
  async getForm(id: string) {
    await wait(60); this.auth();
    const f = this.s.forms.find((x) => x.id === id);
    if (!f) throw new ApiError(404, "Form not found.");
    return f;
  }
  async formTemplates(): Promise<FormTemplate[]> {
    await wait(30); this.auth();
    return [{ id: "land_enumeration", name: "Plot enumeration", product: "land", geometry_type: "area", questions: 18,
      description: "Map each plot's boundary and record who occupies it, how they hold it and the papers they have. Connects to Land Registry as it is." }];
  }
  async createForm(projectId: string, name: string, geometry_type: GeometryType, template?: string) {
    await wait(); this.auth();
    // the demo's copy of the land template: the questions Land Registry reads (the server holds the full form)
    const land: FormField[] = template === "land_enumeration" ? [
      { id: "plot_no", label: "Plot number", type: "text", required: true },
      { id: "land_use", label: "Land use", type: "choice", required: true, choices: ["Residential", "Commercial", "Agricultural"] },
      { id: "occupant_name", label: "Full name", type: "text", required: true },
      { id: "occupant_phone", label: "Phone number", type: "text" },
    ] as FormField[] : [];
    const f: Form = { id: uuid(), project_id: projectId, name, geometry_type: template ? "Polygon" : geometry_type, version: 0, status: "draft",
      fields: land, template: template ?? null };
    this.s.forms.push(f); this.save();
    return f;
  }
  async saveForm(form: Form) {
    await wait(); this.auth();
    const i = this.s.forms.findIndex((x) => x.id === form.id);
    if (i < 0) throw new ApiError(404, "Form not found.");
    this.s.forms[i] = { ...this.s.forms[i], name: form.name, fields: form.fields }; this.save();
    return this.s.forms[i];
  }
  async publishForm(id: string) {
    await wait(); this.auth();
    const f = await this.getForm(id);
    if (!f.fields.length) throw new ApiError(422, "Add at least one field before publishing.");
    f.version += 1; f.status = "published"; this.log(f.project_id, "form.publish", "form", f.id, { version: f.version }); this.save();
    return f;
  }

  // ---- dashboards ----
  private get dashboards(): Dashboard[] { return (this.s.dashboards ??= []); }
  private get links(): Record<string, string> { return (this.s.dashboardLinks ??= {}); }      // dashboard id -> public token
  async listDashboards(projectId: string) { await wait(60); this.auth(); return this.dashboards.filter((d) => d.project_id === projectId).map((d) => ({ ...d, config: normalizeConfig(d.config), shared: !!this.links[d.id] })); }
  async getDashboard(id: string) {
    await wait(60); this.auth();
    const d = this.dashboards.find((x) => x.id === id);
    if (!d) throw new ApiError(404, "Dashboard not found.");
    d.config = normalizeConfig(d.config);          // a copy saved before pages existed still opens
    return { ...d, shared: !!this.links[d.id] };
  }
  async createDashboard(projectId: string, name: string, config: DashboardConfig = normalizeConfig(null)) {
    await wait(); this.auth();
    const d: Dashboard = { id: uuid(), project_id: projectId, name, config, updated_at: new Date().toISOString() };
    this.dashboards.push(d); this.save();
    return d;
  }
  async saveDashboard(p: Pick<Dashboard, "id" | "name" | "config">) {
    await wait(); this.auth();
    await this.getDashboard(p.id);                                  // 404 if it is gone
    const d = this.dashboards.find((x) => x.id === p.id)!;           // the stored one: getDashboard hands out a copy
    d.name = p.name; d.config = p.config; d.updated_at = new Date().toISOString(); this.save();
    return { ...d, shared: !!this.links[d.id] };
  }
  async deleteDashboard(id: string) { await wait(); this.auth(); this.s.dashboards = this.dashboards.filter((d) => d.id !== id); delete this.links[id]; this.save(); }
  async getDashboardSharing(id: string) { await wait(60); this.auth(); await this.getDashboard(id); return { public: !!this.links[id], share_token: this.links[id] ?? null }; }
  async setDashboardSharing(id: string, patch: { public?: boolean; regenerate_link?: boolean }) {
    await wait(); this.auth(); await this.getDashboard(id);
    const cur = this.links[id], fresh = () => uuid().replace(/-/g, "") + uuid().replace(/-/g, "");
    if (patch.public === false) delete this.links[id];
    else if (patch.public === true || (cur && patch.regenerate_link)) { if (!cur || patch.regenerate_link) this.links[id] = fresh(); }
    else if (patch.regenerate_link) throw new ApiError(409, "Turn the public link on first.");
    this.save();
    return { public: !!this.links[id], share_token: this.links[id] ?? null };
  }
  async getPublicDashboard(token: string) {
    await wait();
    const id = Object.keys(this.links).find((k) => this.links[k] === token);
    const d = id && this.dashboards.find((x) => x.id === id);
    if (!d) throw new ApiError(404, "This dashboard link is not valid, or it is no longer shared.");
    const project = this.s.projects.find((p) => p.id === d.project_id);
    return publicDashboard({ token, dashboard: { ...d, config: normalizeConfig(d.config) }, projectName: project?.name ?? "",
      forms: this.s.forms.filter((f) => f.project_id === d.project_id), features: this.s.features.filter((f) => f.project_id === d.project_id).map((r) => this.strip(r)) });
  }

  /** Mock: everyone is the demo user, so every rejected record counts as "mine". */
  async listReturned(projectId: string) { await wait(); this.auth(); return this.s.features.filter((f) => f.project_id === projectId && !f.deleted && f.status === "rejected").map((r) => this.strip(r)); }
  async listFeatures(projectId: string) { await wait(); this.auth(); return this.s.features.filter((f) => f.project_id === projectId && !f.deleted).map((r) => this.strip(r)); }
  async createFeature(nf: NewFeature) {
    await wait(); this.auth();
    const form = this.s.forms.find((f) => f.id === nf.form_id);
    if (form) {
      const errors = validateProperties(form, nf.properties);
      if (Object.keys(errors).length) throw new ApiError(422, "Some fields need attention.", errors);
    }
    const row: Row = { ...nf, status: "submitted", version: 1, updated_at: new Date().toISOString(), seq: ++this.s.seq };
    this.s.features.push(row); this.log(nf.project_id, "feature.create", "feature", row.id, { form_id: nf.form_id }); this.save();
    return this.strip(row);
  }
  async updateFeature(id: string, patch: { geometry?: Geometry; properties?: Props; base_version: number }) {
    await wait(); this.auth();
    const r = this.s.features.find((f) => f.id === id);
    if (!r || r.deleted) throw new ApiError(404, "Feature not found.");
    if (patch.base_version !== r.version) throw new ApiError(409, "Someone else changed this feature. Reload to see their version.");
    if (patch.geometry) r.geometry = patch.geometry;
    if (patch.properties) r.properties = patch.properties;
    r.version += 1; r.seq = ++this.s.seq; r.updated_at = new Date().toISOString(); this.log(r.project_id, "feature.edit", "feature", r.id); this.save();
    return this.strip(r);
  }
  async deleteFeature(id: string) {
    await wait(); this.auth();
    const r = this.s.features.find((f) => f.id === id);
    if (r) { r.deleted = true; r.seq = ++this.s.seq; r.version += 1; this.log(r.project_id, "feature.delete", "feature", r.id); this.save(); }
  }
  async reviewFeature(id: string, decision: "approved" | "rejected", note?: string) {
    await wait(); this.auth();
    const r = this.s.features.find((f) => f.id === id);
    if (!r || r.deleted) throw new ApiError(404, "Feature not found.");
    r.status = decision; r.review_note = note || undefined; r.version += 1; r.seq = ++this.s.seq; this.log(r.project_id, "feature.review", "feature", r.id, note ? { decision, note } : { decision }); this.save();
    return this.strip(r);
  }

  // ---- sharing and collaborators (mock: the share token is the form id's first 12 characters plus a salt) ----
  private share(formId: string) {
    const all = (this.s.sharing ??= {});
    return (all[formId] ??= { share_mode: "collaborators", share_token: uuid().replace(/-/g, "") });
  }
  async getSharing(formId: string): Promise<Sharing> {
    await wait(60); this.auth();
    const f = await this.getForm(formId);
    return { ...this.share(formId), published: f.version > 0 };
  }
  async setSharing(formId: string, patch: { share_mode?: ShareMode; regenerate_link?: boolean }): Promise<Sharing> {
    await wait(); this.auth();
    const f = await this.getForm(formId);
    if (patch.share_mode === "public" && f.version === 0) throw new ApiError(409, "Publish the form before making its link public.");
    const sh = this.share(formId);
    if (patch.share_mode) sh.share_mode = patch.share_mode;
    if (patch.regenerate_link) sh.share_token = uuid().replace(/-/g, "");
    this.save();
    return { ...sh, published: f.version > 0 };
  }
  private memberList(projectId: string): ProjectMember[] {
    const all = (this.s.members ??= {});
    return (all[projectId] ??= [{ id: DEMO_USER.id, user_id: DEMO_USER.id, email: DEMO_USER.email, name: DEMO_USER.name, role: "owner", status: "active" }]);
  }
  async listProjectMembers(projectId: string) { await wait(60); this.auth(); return [...this.memberList(projectId)]; }
  async addProjectMember(projectId: string, email: string, role: Exclude<Role, "owner">) {
    await wait(); this.auth();
    const list = this.memberList(projectId);
    const e = email.trim().toLowerCase();
    if (list.some((m) => m.email.toLowerCase() === e)) throw new ApiError(409, "That person is already on this project.");
    const m: ProjectMember = { id: uuid(), email: e, role, status: "invited" };
    list.push(m); this.log(projectId, "member.invite", "user", m.id, { role, email: e }); this.save();
    return m;
  }
  async setProjectMemberRole(projectId: string, memberId: string, role: Role) {
    await wait(); this.auth();
    const m = this.memberList(projectId).find((x) => x.id === memberId);
    if (!m) throw new ApiError(404, "Member not found.");
    m.role = role; this.log(projectId, "member.role_change", "user", m.id, { role }); this.save();
  }
  async removeProjectMember(projectId: string, memberId: string) {
    await wait(); this.auth();
    const list = this.memberList(projectId);
    const i = list.findIndex((x) => x.id === memberId);
    if (i >= 0) { this.log(projectId, "member.remove", "user", list[i]!.id); list.splice(i, 1); }
    this.save();
  }
  private formByToken(token: string): { form: Form; mode: ShareMode } {
    const found = this.s.forms.find((f) => this.s.sharing?.[f.id]?.share_token === token && f.version > 0);
    if (!found) throw new ApiError(404, "This form link is not valid, or the form is not published.");
    return { form: found, mode: this.s.sharing![found.id].share_mode };
  }
  async getPublicForm(token: string): Promise<PublicForm> {
    await wait();
    const { form, mode } = this.formByToken(token);
    const project = this.s.projects.find((p) => p.id === form.project_id);
    if (mode !== "public") {
      if (!tokens.get()) throw new ApiError(401, "Sign in to use this form.");
      return { token, form, project_name: project?.name ?? "", access: "member" };
    }
    return { token, form, project_name: project?.name ?? "", access: "public" };
  }
  async submitPublic(token: string, input: { id: string; geometry: Geometry; properties: Props }) {
    await wait();
    const { form, mode } = this.formByToken(token);
    if (mode !== "public") throw new ApiError(403, "This form is not public.");
    const errors = validateProperties(form, input.properties);
    if (Object.keys(errors).length) throw new ApiError(422, "Some fields need attention.", errors);
    if (this.s.features.some((f) => f.id === input.id)) return;
    const row: Row = { id: input.id, project_id: form.project_id, form_id: form.id, form_version: form.version, geometry: input.geometry, properties: input.properties, status: "submitted", version: 1, updated_at: new Date().toISOString(), seq: ++this.s.seq };
    this.s.features.push(row); this.save();
  }

  async uploadPublicMedia() { await wait(60); }
  async bundle(projectId: string): Promise<Bundle> {
    await wait(); this.auth();
    return {
      forms: this.s.forms.filter((f) => f.project_id === projectId && f.status === "published"),
      features: this.s.features.filter((f) => f.project_id === projectId && !f.deleted).map((r) => this.strip(r)),
      cursor: String(this.s.seq),
    };
  }
  async syncPush(projectId: string, changes: Change[]): Promise<PushResult[]> {
    await wait(); this.auth();
    const out: PushResult[] = [];
    for (const c of changes) {
      const form = this.s.forms.find((f) => f.id === c.form_id);
      if (c.op !== "delete" && form && c.properties) {
        const errors = validateProperties(form, c.properties);
        if (Object.keys(errors).length) { out.push({ change_id: c.change_id, id: c.id, status: "rejected", errors }); continue; }
      }
      const cur = this.s.features.find((f) => f.id === c.id);
      if (c.op === "create") {
        if (cur) { out.push({ change_id: c.change_id, id: c.id, status: "applied", version: cur.version }); continue; } // idempotent
        this.s.features.push({
          id: c.id, project_id: projectId, form_id: c.form_id!, form_version: c.form_version ?? 1, geometry: c.geometry!,
          properties: c.properties ?? {}, status: "submitted", version: 1, updated_at: new Date().toISOString(), seq: ++this.s.seq,
        });
        out.push({ change_id: c.change_id, id: c.id, status: "applied", version: 1 });
        this.log(projectId, "feature.create", "feature", c.id, { form_id: c.form_id });
      } else if (!cur || cur.deleted) {
        out.push({ change_id: c.change_id, id: c.id, status: "rejected", errors: { _: "Feature no longer exists." } });
      } else if (c.op === "delete") {
        cur.deleted = true; cur.version += 1; cur.seq = ++this.s.seq;
        out.push({ change_id: c.change_id, id: c.id, status: "applied", version: cur.version });
      } else if (c.base_version === cur.version) {
        if (c.geometry) cur.geometry = c.geometry;
        if (c.properties) cur.properties = c.properties;
        if (cur.status === "approved" || cur.status === "rejected") { cur.status = "submitted"; cur.review_note = undefined; }   // edited after review: needs a fresh review, as on the server
        cur.version += 1; cur.seq = ++this.s.seq; cur.updated_at = new Date().toISOString();
        out.push({ change_id: c.change_id, id: c.id, status: "applied", version: cur.version });
        this.log(projectId, "feature.edit", "feature", c.id);
      } else if (c.geometry && JSON.stringify(c.geometry) !== JSON.stringify(cur.geometry)) {
        out.push({ change_id: c.change_id, id: c.id, status: "conflict", server: this.strip(cur) });
      } else {
        // Stale base but the shape did not change: merge properties (contract rule 4).
        cur.properties = { ...cur.properties, ...(c.properties ?? {}) };
        if (cur.status === "approved" || cur.status === "rejected") { cur.status = "submitted"; cur.review_note = undefined; }
        cur.version += 1; cur.seq = ++this.s.seq;
        out.push({ change_id: c.change_id, id: c.id, status: "applied", version: cur.version, merged: true });
      }
    }
    this.save();
    return out;
  }
  async syncPull(projectId: string, cursor: string): Promise<PullResult> {
    await wait(60); this.auth();
    const since = Number(cursor) || 0;
    const rows = this.s.features.filter((f) => f.project_id === projectId && f.seq > since).sort((a, b) => a.seq - b.seq);
    const page = rows.slice(0, 500);
    return { changes: page.map((r) => this.strip(r)), cursor: String(page.length ? page[page.length - 1].seq : since), has_more: rows.length > page.length };
  }
  /** Mock: photos live in memory for this visit, so review mode can show them. */
  private media = new Map<string, { feature_id: string; field_id?: string; kind: string; url: string }>();
  async uploadMedia(_projectId: string, featureId: string, mediaId: string, blob: Blob, fieldId?: string) {
    await wait(200);
    const url = typeof URL !== "undefined" && typeof URL.createObjectURL === "function" ? URL.createObjectURL(blob) : "";
    this.media.set(mediaId, { feature_id: featureId, field_id: fieldId, kind: blob.type.startsWith("image/") ? "photo" : blob.type.split("/")[0] || "file", url });
  }
  async getFeatureMedia(featureId: string): Promise<MediaItem[]> {
    await wait(); this.auth();
    return [...this.media.entries()].filter(([, m]) => m.feature_id === featureId && m.url).map(([id, m]) => ({ id, field_id: m.field_id, kind: m.kind, url: m.url }));
  }

  async listImagery(projectId: string) { await wait(60); this.auth(); return this.s.imagery.filter((i) => i.project_id === projectId); }
  async getImagery(id: string) { await wait(40); const a = this.s.imagery.find((i) => i.id === id); if (!a) throw new ApiError(404, "Imagery not found."); return a; }
  async importFeatures(projectId: string, file: File, formId: string, opts: ImportOptions = {}): Promise<Job> {
    await wait(); this.auth();
    const name = file.name.toLowerCase();
    const isCsv = name.endsWith(".csv");
    if (!isCsv && !name.endsWith(".geojson") && !name.endsWith(".json")) throw new ApiError(422, "Mock mode can only import CSV and GeoJSON. KML, GPX, GeoPackage and Shapefile need the real backend.");
    const form = this.s.forms.find((f) => f.id === formId);
    if (!form) throw new ApiError(404, "Form not found.");
    if (form.version === 0) throw new ApiError(409, "Publish the form before importing into it.");
    const status = opts.status ?? "submitted";
    const errors: { row: number; message: string }[] = [];
    let imported = 0;
    const add = (geometry: Geometry, properties: Props) => {
      this.s.features.push({ id: uuid(), project_id: projectId, form_id: form.id, form_version: form.version, geometry, properties, status, version: 1, updated_at: new Date().toISOString(), seq: ++this.s.seq });
      imported++;
    };
    if (isCsv) {
      if (!opts.wkt && !(opts.lon && opts.lat)) throw new ApiError(422, "CSV imports need lon_column and lat_column, or wkt_column.");
      const parsed = parseCsv(await file.text(), ",");
      const fields = new Map(importableFields(form).map((f) => [f.id, f]));
      const col = (h?: string) => (h ? parsed.headers.indexOf(h) : -1);
      const inFile = new Set(parsed.headers.map((h) => opts.mapping?.[h] ?? h));        // questions with no column in the file are skipped, like on the server
      parsed.rows.forEach((row, n) => {
        const rowNo = n + 2, msgs: string[] = [], props: Props = {};
        parsed.headers.forEach((h, i) => {
          const f = fields.get(opts.mapping?.[h] ?? h);
          if (!f) return;
          const r = coerceCell(f, row[i], "dmy");
          if (r.error) msgs.push(r.error); else if (r.value !== undefined) props[f.id] = r.value as Props[string];
        });
        let geometry: Geometry | undefined;
        if (opts.wkt) { const s = parseShape(row[col(opts.wkt)] ?? ""); if ("error" in s) msgs.push(`geometry: ${s.error}`); else geometry = s.shape as Geometry; }
        else { const x = parseNumber(row[col(opts.lon)] ?? ""), y = parseNumber(row[col(opts.lat)] ?? ""); if (x === null || y === null) msgs.push("geometry: missing or unreadable geometry"); else geometry = { type: "Point", coordinates: [x, y] }; }
        if (geometry && geometry.type !== form.geometry_type) { msgs.push(`geometry: this form collects ${form.geometry_type} geometry, not ${geometry.type}`); geometry = undefined; }
        if (!msgs.length) for (const [k, m] of Object.entries(validateProperties(form, props))) if (inFile.has(k.split(".")[0]) && !(status === "draft" && /is required\.$/.test(m))) msgs.push(m);
        if (msgs.length || !geometry) errors.push({ row: rowNo, message: msgs.join("; ") }); else add(geometry, props);
      });
    } else {
      let data: { type?: string; features?: { geometry?: Geometry; properties?: Props }[] };
      try { data = JSON.parse(await file.text()); } catch { throw new ApiError(422, "The file is not valid JSON."); }
      (data.features ?? []).forEach((f, i) => {
        if (!f.geometry || f.geometry.type !== form.geometry_type) { errors.push({ row: i + 1, message: `geometry must be a ${form.geometry_type}` }); return; }
        const props: Props = {}; for (const fld of topLevelFields(form.fields)) if (f.properties && fld.id in f.properties) props[fld.id] = f.properties[fld.id];
        add(f.geometry, props);
      });
    }
    this.save();
    const job: Job = { id: uuid(), kind: "import", status: imported ? "done" : "failed", progress: 100, result: { imported, rejected: errors.length, errors, dropped_columns: [] }, error: imported ? undefined : "No rows could be imported. See the row errors." };
    this.jobs.set(job.id, { job, polls: 99, error: job.error });
    return job;
  }
  async uploadImagery(projectId: string, file: File) {
    await wait(500); this.auth();
    const a: ImageryAsset = { id: uuid(), project_id: projectId, name: file.name, status: "ready" };
    this.s.imagery.push(a); this.save();
    return a;
  }
  imageryTileUrl(): string | null { return null; } // no tile server in mock mode

  // ---- standalone mapping workspaces (shared maps with a team, review and contributor stats) ----
  private maps() {
    if (!this.s.mapSeeded) {                                                    // demo data: a running campaign, and one you can join
      this.s.mapSeeded = true;
      const seeded = seedSharedMaps();
      this.s.maps = [...seeded.maps, ...(this.s.maps ?? [])];
      this.s.mapMembers = [...seeded.members, ...(this.s.mapMembers ?? [])];
      this.s.mapFeatures = [...seeded.features, ...(this.s.mapFeatures ?? [])];
      this.save();
    }
    return (this.s.maps ??= []);
  }
  private mapFeats() { this.maps(); return (this.s.mapFeatures ??= []); }
  private members() { this.maps(); return (this.s.mapMembers ??= []); }
  private mapOf(id: string) {
    const m = this.maps().find((x) => x.id === id);
    if (!m) throw new ApiError(404, "Map not found.");
    return m;
  }
  private roleOn(m: MockMap): MapRole | null {
    if ((m.owner_id ?? DEMO_USER.id) === DEMO_USER.id) return "owner";
    return this.members().find((x) => x.map_id === m.id && x.user_id === DEMO_USER.id)?.role ?? null;
  }
  /** The map and the caller's role. People with no role get 404; members below `minimum` get 403. */
  private need(id: string, minimum: MapRole = "contributor"): { m: MockMap; role: MapRole } {
    const m = this.mapOf(id);
    const role = this.roleOn(m);
    if (!role) throw new ApiError(404, "Map not found.");
    const rank = { contributor: 1, reviewer: 2, owner: 3 };
    if (rank[role] < rank[minimum]) throw new ApiError(403, `This action needs the ${minimum} role on the map.`);
    return { m, role };
  }
  private campaignStatus(m: MockMap): WorkMap["campaign_status"] {
    if (!m.is_campaign) return undefined;
    const now = Date.now();
    if (m.starts_at && Date.parse(m.starts_at) > now) return "upcoming";
    if (m.ends_at && Date.parse(m.ends_at) < now) return "ended";
    return "open";
  }
  private mapOut(m: MockMap): WorkMap {
    const role = this.roleOn(m) ?? "contributor";
    const { owner_id: _o, ...rest } = m;
    return {
      ...rest, role, feature_count: this.mapFeats().filter((f) => f.map_id === m.id).length,
      member_count: this.members().filter((x) => x.map_id === m.id).length + 1, campaign_status: this.campaignStatus(m),
      join_code: role === "owner" ? m.join_code : undefined,
    };
  }
  private checkOpen(m: MockMap, role: MapRole) {
    if (role !== "contributor" || !m.is_campaign) return;
    const st = this.campaignStatus(m);
    if (st === "upcoming") throw new ApiError(409, "This campaign has not started yet.");
    if (st === "ended") throw new ApiError(409, "This campaign has ended, so contributors can no longer add or change features.");
  }
  private canChange(role: MapRole, f: MockFeat) { return role !== "contributor" || (f.created_by === DEMO_USER.id && f.status !== "approved"); }
  private featOut(f: MockFeat): GeoFeature { const { map_id: _m, updated_by: _u, ...out } = f; return out; }

  async listMaps() {
    await wait(); this.auth();
    return this.maps().filter((m) => this.roleOn(m)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map((m) => this.mapOut(m));
  }
  async getMap(id: string) { await wait(60); this.auth(); return this.mapOut(this.need(id).m); }
  async createMap(name: string, description?: string) {
    await wait(); this.auth();
    const m: MockMap = {
      id: uuid(), name, description: description ?? "", sources: [], updated_at: new Date().toISOString(), owner_id: DEMO_USER.id, owner_name: DEMO_USER.name,
      is_campaign: false, goal: "", competition: false,
    };
    this.maps().unshift(m); this.save();
    return this.mapOut(m);
  }
  async updateMap(id: string, patch: MapSettings) {
    await wait(60); this.auth();
    const { m } = this.need(id, "owner");
    if (patch.sources) {
      for (const s of patch.sources) {
        if (!/^https?:\/\//i.test(s.url) || !s.url.includes("{z}") || !s.url.includes("{x}") || !(s.url.includes("{y}") || s.url.includes("{-y}"))) {
          throw new ApiError(422, `Imagery source "${s.name}": the URL must start with http(s):// and contain {z}, {x} and {y}.`);
        }
      }
      m.sources = patch.sources.map((s) => ({ ...s, id: s.id || uuid().slice(0, 12) }));
    }
    const start = patch.starts_at !== undefined ? patch.starts_at : m.starts_at, end = patch.ends_at !== undefined ? patch.ends_at : m.ends_at;
    if (start && end && Date.parse(end) <= Date.parse(start)) throw new ApiError(422, "The end date must be after the start date.", { ends_at: "must be after the start" });
    if (patch.name !== undefined) m.name = patch.name;
    if (patch.description !== undefined) m.description = patch.description;
    if (patch.goal !== undefined) m.goal = patch.goal;
    if (patch.is_campaign !== undefined) m.is_campaign = patch.is_campaign;
    if (patch.competition !== undefined) m.competition = patch.competition;
    if (patch.starts_at !== undefined) m.starts_at = patch.starts_at ?? undefined;
    if (patch.ends_at !== undefined) m.ends_at = patch.ends_at ?? undefined;
    if (patch.join_open !== undefined) m.join_code = patch.join_open ? Math.random().toString(36).slice(2, 10) : undefined;
    m.updated_at = new Date().toISOString(); this.save();
    return this.mapOut(m);
  }
  async deleteMap(id: string) {
    await wait(); this.auth(); this.need(id, "owner");
    this.s.maps = this.maps().filter((m) => m.id !== id);
    this.s.mapFeatures = this.mapFeats().filter((f) => f.map_id !== id);
    this.s.mapMembers = this.members().filter((x) => x.map_id !== id);
    this.s.imagery = this.s.imagery.filter((i) => i.map_id !== id);
    this.save();
  }
  async listMapFeatures(mapId: string) { await wait(60); this.auth(); this.need(mapId); return this.mapFeats().filter((f) => f.map_id === mapId).map((f) => this.featOut(f)); }
  async createMapFeature(mapId: string, f: { id: string; geometry: Geometry; properties: Props }) {
    await wait(60); this.auth();
    const { m, role } = this.need(mapId);
    this.checkOpen(m, role);
    if (this.mapFeats().some((x) => x.id === f.id)) throw new ApiError(409, "A feature with this id already exists.");
    const now = new Date().toISOString();
    const row: MockFeat = {
      id: f.id, map_id: mapId, geometry: f.geometry, properties: f.properties, version: 1, created_by: DEMO_USER.id, author: DEMO_USER.name,
      status: role === "contributor" ? "submitted" : "approved", created_at: now, updated_at: now,
    };
    this.mapFeats().push(row); m.updated_at = now; this.save();
    return this.featOut(row);
  }
  async updateMapFeature(mapId: string, id: string, patch: { geometry?: Geometry; properties?: Props; base_version?: number }) {
    await wait(60); this.auth();
    const { m, role } = this.need(mapId);
    this.checkOpen(m, role);
    const f = this.mapFeats().find((x) => x.id === id && x.map_id === mapId);
    if (!f) throw new ApiError(404, "Feature not found.");
    if (!this.canChange(role, f)) throw new ApiError(403, "You can only change your own features, and not once a reviewer has approved them.");
    if (patch.base_version !== undefined && patch.base_version !== f.version) throw new ApiError(409, "This feature changed since you opened it. Reload and try again.");
    if (patch.geometry) f.geometry = patch.geometry;
    if (patch.properties) f.properties = patch.properties;
    f.version += 1; f.updated_at = new Date().toISOString(); f.updated_by = DEMO_USER.id;
    if (role === "contributor") { f.status = "submitted"; f.review_note = undefined; }
    this.save();
    return this.featOut(f);
  }
  async deleteMapFeature(mapId: string, id: string) {
    await wait(60); this.auth();
    const { m, role } = this.need(mapId);
    this.checkOpen(m, role);
    const f = this.mapFeats().find((x) => x.id === id && x.map_id === mapId);
    if (!f) throw new ApiError(404, "Feature not found.");
    if (!this.canChange(role, f)) throw new ApiError(403, "You can only delete your own features, and not once a reviewer has approved them.");
    this.s.mapFeatures = this.mapFeats().filter((x) => x !== f); this.save();
  }
  async importMapFeatures(mapId: string, features: { geometry: Geometry; properties: Props }[]): Promise<MapImportResult> {
    await wait(); this.auth();
    const { m, role } = this.need(mapId);
    this.checkOpen(m, role);
    const now = new Date().toISOString();
    for (const f of features) this.mapFeats().push({ id: uuid(), map_id: mapId, geometry: f.geometry, properties: f.properties, version: 1, created_by: DEMO_USER.id, author: DEMO_USER.name, status: role === "contributor" ? "submitted" : "approved", created_at: now, updated_at: now });
    this.save();
    return { imported: features.length, rejected: 0, errors: [] };
  }
  async exportMap(mapId: string) {
    const feats = await this.listMapFeatures(mapId);
    const fc = { type: "FeatureCollection", features: feats.map((f) => ({ type: "Feature", id: f.id, geometry: f.geometry, properties: f.properties })) };
    return new Blob([JSON.stringify(fc, null, 2)], { type: "application/geo+json" });
  }
  async listMapImagery(mapId: string): Promise<{ assets: ImageryAsset[]; layers: MapLayers }> {
    await wait(60); this.auth(); this.need(mapId);
    return { assets: this.s.imagery.filter((i) => i.map_id === mapId), layers: { imagery: [] } };   // no tile server in mock mode
  }
  async uploadMapImagery(mapId: string, file: File) {
    await wait(500); this.auth(); this.need(mapId, "owner");
    const a: ImageryAsset = { id: uuid(), map_id: mapId, name: file.name, status: "ready" };
    this.s.imagery.push(a); this.save();
    return a;
  }
  async deleteImagery(id: string) { await wait(60); this.s.imagery = this.s.imagery.filter((i) => i.id !== id); this.save(); }

  // ---- team, joining, review ----
  async listMembers(mapId: string): Promise<MapMember[]> {
    await wait(60); this.auth();
    const { m, role } = this.need(mapId);
    const showEmail = role === "owner";
    const owner: MapMember = { user_id: m.owner_id, name: m.owner_name, role: "owner", email: showEmail ? (m.owner_id === DEMO_USER.id ? DEMO_USER.email : undefined) : undefined };
    return [owner, ...this.members().filter((x) => x.map_id === mapId).map((x) => ({ user_id: x.user_id, name: x.name, role: x.role, joined_at: x.joined_at, email: showEmail ? `${x.name.toLowerCase().replace(/\s+/g, ".")}@example.com` : undefined }))];
  }
  async setMemberRole(mapId: string, userId: string, role: Exclude<MapRole, "owner">) {
    await wait(60); this.auth(); this.need(mapId, "owner");
    const x = this.members().find((y) => y.map_id === mapId && y.user_id === userId);
    if (!x) throw new ApiError(404, "That person is not a member of this map.");
    x.role = role; this.save();
  }
  async removeMember(mapId: string, userId: string) {
    await wait(60); this.auth(); this.need(mapId, userId === DEMO_USER.id ? "contributor" : "owner");
    this.s.mapMembers = this.members().filter((x) => !(x.map_id === mapId && x.user_id === userId)); this.save();
  }
  private byCode(code: string) {
    const m = this.maps().find((x) => x.join_code && x.join_code === code);
    if (!m) throw new ApiError(404, "This invitation link is not valid any more.");
    return m;
  }
  async joinPreview(code: string): Promise<JoinPreview> {
    await wait(60); this.auth();
    const m = this.byCode(code);
    return {
      name: m.name, description: m.description, goal: m.goal, owner_name: m.owner_name, competition: m.competition, starts_at: m.starts_at, ends_at: m.ends_at,
      campaign_status: this.campaignStatus(m), member_count: this.members().filter((x) => x.map_id === m.id).length + 1, already_member: !!this.roleOn(m),
    };
  }
  async joinMap(code: string) {
    await wait(); this.auth();
    const m = this.byCode(code);
    if (this.campaignStatus(m) === "ended") throw new ApiError(409, "This campaign has ended.");
    if (!this.roleOn(m)) { this.members().push({ map_id: m.id, user_id: DEMO_USER.id, name: DEMO_USER.name, role: "contributor", joined_at: new Date().toISOString() }); this.save(); }
    return this.mapOut(m);
  }
  async reviewFeatures(mapId: string, ids: string[], status: ReviewStatus, note = "") {
    await wait(); this.auth(); this.need(mapId, "reviewer");
    let n = 0;
    for (const f of this.mapFeats()) if (f.map_id === mapId && ids.includes(f.id)) { f.status = status; f.review_note = status === "approved" ? undefined : note.trim() || undefined; n++; }
    this.save();
    return n;
  }

  // ---- contributors portal ----
  async contributors(mapId: string): Promise<ContributorsReport> {
    await wait(); this.auth();
    const { m } = this.need(mapId);
    const from = m.starts_at ? Date.parse(m.starts_at) : -Infinity, to = m.ends_at ? Date.parse(m.ends_at) : Infinity;
    const all = this.mapFeats().filter((f) => f.map_id === mapId);
    const inWindow = all.filter((f) => { const t = Date.parse(f.created_at); return t >= from && t <= to; });
    const people = new Map<string, { name: string; role: MapRole | "former" }>();
    people.set(m.owner_id, { name: m.owner_name, role: "owner" });
    for (const x of this.members().filter((y) => y.map_id === mapId)) people.set(x.user_id, { name: x.name, role: x.role });
    for (const f of inWindow) if (!people.has(f.created_by)) people.set(f.created_by, { name: f.author, role: "former" });
    const rows = [...people].map(([user_id, p]) => {
      const mine = inWindow.filter((f) => f.created_by === user_id);
      const times = mine.map((f) => f.created_at).sort();
      return {
        user_id, name: p.name, role: p.role, rank: 0,
        added: mine.filter((f) => f.status !== "rejected").length, approved: mine.filter((f) => f.status === "approved").length,
        pending: mine.filter((f) => f.status === "submitted").length, rejected: mine.filter((f) => f.status === "rejected").length,
        edited: all.filter((f) => f.updated_by === user_id && f.created_by !== user_id).length, first_at: times[0], last_at: times[times.length - 1],
      };
    }).sort((a, b) => b.added - a.added || b.approved - a.approved || a.name.localeCompare(b.name));
    for (const r of rows) r.rank = 1 + rows.filter((o) => o.added > r.added).length;
    const daily = new Map<string, number>();
    for (const f of all) if (Date.parse(f.created_at) >= Date.now() - 60 * 864e5) { const d = f.created_at.slice(0, 10); daily.set(d, (daily.get(d) ?? 0) + 1); }
    const sum = (k: "added" | "approved" | "pending" | "rejected") => rows.reduce((t, r) => t + r[k], 0);
    return {
      contributors: rows, starts_at: m.starts_at, ends_at: m.ends_at,
      totals: { contributors: rows.filter((r) => r.added || r.rejected).length, added: sum("added"), approved: sum("approved"), pending: sum("pending"), rejected: sum("rejected") },
      daily: [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count })),
    };
  }
  async mapActivity(mapId: string): Promise<Activity[]> {
    await wait(60); this.auth(); this.need(mapId);
    return this.mapFeats().filter((f) => f.map_id === mapId).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 30)
      .map((f) => ({ feature_id: f.id, user_id: f.updated_by ?? f.created_by, name: f.updated_by && f.updated_by !== f.created_by ? this.nameOf(mapId, f.updated_by) : f.author, action: f.version > 1 ? "edited" as const : "added" as const, at: f.updated_at, geometry_type: GEOM_KIND(f.geometry), status: f.status }));
  }
  private nameOf(mapId: string, userId: string) { return userId === DEMO_USER.id ? DEMO_USER.name : this.members().find((x) => x.map_id === mapId && x.user_id === userId)?.name ?? "Someone"; }

  // ---- publishing a map to the Data hub ----
  private snapshot(m: MockMap, kind: "point" | "line" | "area") {
    return this.mapFeats().filter((f) => f.map_id === m.id && f.status === "approved" && GEOM_KIND(f.geometry) === kind)
      .map((f) => ({ type: "Feature" as const, id: f.id, geometry: f.geometry, properties: f.properties }));
  }
  private credits(m: MockMap, kind: "point" | "line" | "area") {
    const n = new Map<string, number>();
    for (const f of this.mapFeats()) if (f.map_id === m.id && f.status === "approved" && GEOM_KIND(f.geometry) === kind) n.set(f.author, (n.get(f.author) ?? 0) + 1);
    return [...n].map(([name, features]) => ({ name, features })).sort((a, b) => b.features - a.features || a.name.localeCompare(b.name));
  }
  async mapDatasets(mapId: string) { await wait(60); this.auth(); this.need(mapId); return this.s.datasets.filter((d) => d.map_id === mapId).map((d) => ({ ...d })); }
  async publishMap(mapId: string, input: PublishInput) {
    await wait(); this.auth();
    const { m } = this.need(mapId, "owner");
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.slug)) throw new ApiError(422, "The web address can only use lowercase letters, numbers and hyphens.", { slug: "invalid" });
    if (this.s.datasets.some((d) => d.slug === input.slug)) throw new ApiError(409, "That slug is taken.", { slug: "already in use" });
    const feats = this.snapshot(m, input.geometry_type);
    if (!feats.length) throw new ApiError(409, `There are no approved ${KIND_NAME[input.geometry_type]} features yet. Approve some in the Review tab first.`);
    const d: Dataset = {
      slug: input.slug, project_id: "", title: input.title, description: input.description, license: input.license, tags: input.tags, kind: "vector",
      feature_count: feats.length, latest_version: 1, updated_at: new Date().toISOString(), formats: ["geojson", "csv", "gpkg", "shp"],
      visibility: input.license === "Private" && input.visibility === "public" ? "private" : input.visibility, map_id: mapId,
      contributors: input.credit_contributors ? this.credits(m, input.geometry_type) : undefined,
    };
    this.s.datasets.push(d);
    (this.s.mapSnapshots ??= {})[d.slug] = feats;
    (this.s.mapKinds ??= {})[d.slug] = input.geometry_type;
    this.save();
    return { dataset: d, job: { id: uuid(), kind: "snapshot", status: "done" as const, progress: 100 } };
  }
  async newDatasetVersion(slug: string): Promise<Job> {
    await wait(); this.auth();
    const d = this.s.datasets.find((x) => x.slug === slug);
    if (!d?.map_id) throw new ApiError(404, "Dataset not found.");
    const { m } = this.need(d.map_id, "owner");
    const kind = this.s.mapKinds?.[slug] ?? "point";
    const feats = this.snapshot(m, kind);
    if (!feats.length) throw new ApiError(409, `There are no approved ${KIND_NAME[kind]} features to publish.`);
    (this.s.mapSnapshots ??= {})[slug] = feats;
    d.latest_version += 1; d.feature_count = feats.length; d.updated_at = new Date().toISOString();
    if (d.contributors) d.contributors = this.credits(m, kind);
    this.save();
    return { id: uuid(), kind: "snapshot", status: "done", progress: 100 };
  }

  async listDatasets(q?: string) {
    await wait();
    const needle = (q ?? "").trim().toLowerCase();
    return this.s.datasets
      .filter((d) => d.license !== "Private" && d.visibility !== "private" && (!needle || (d.title + d.description + d.tags.join(" ")).toLowerCase().includes(needle)))
      .map((d) => (d.map_id ? d : { ...d, feature_count: this.s.features.filter((f) => f.project_id === d.project_id && !f.deleted).length }));
  }
  async getDataset(slug: string) {
    const own = this.s.datasets.find((x) => x.slug === slug && x.map_id);       // a map's own datasets are readable by its members even when private
    if (own && tokens.get() && this.roleOn(this.mapOf(own.map_id!))) return { ...own };
    const d = (await this.listDatasets()).find((x) => x.slug === slug);
    if (!d) throw new ApiError(404, "Dataset not found.");
    return d;
  }
  async datasetFeatures(slug: string, opts?: { limit?: number }): Promise<FeatureCollection> {
    const d = await this.getDataset(slug);
    const cut = <T,>(l: T[]) => (opts?.limit ? l.slice(0, opts.limit) : l);
    if (d.map_id) return { type: "FeatureCollection", features: cut(this.s.mapSnapshots?.[slug] ?? []) };
    return {
      type: "FeatureCollection",
      features: cut(this.s.features.filter((f) => f.project_id === d.project_id && !f.deleted)
        .map((f) => ({ type: "Feature" as const, id: f.id, geometry: f.geometry, properties: f.properties }))),
    };
  }
  async publishDataset(projectId: string, input: { form_id?: string; title: string; description: string; license: License; visibility?: DatasetVisibility }) {
    await wait(); this.auth();
    const vis: DatasetVisibility = input.license === "Private" && (input.visibility ?? "public") === "public" ? "private" : (input.visibility ?? "public");
    if (vis === "organization" && this.orgState.org.plan === "individual") throw new ApiError(403, "Publishing to your organization only comes with Organization plans.");
    const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || uuid().slice(0, 8);
    const existing = this.s.datasets.find((d) => d.slug === slug);
    const doneJob: Job = { id: uuid(), kind: "snapshot", status: "done", progress: 100 };
    if (existing) { existing.latest_version += 1; existing.updated_at = new Date().toISOString(); this.save(); return { dataset: existing, job: doneJob }; }
    const d: Dataset = {
      slug, project_id: projectId, title: input.title, description: input.description, license: input.license, tags: [], kind: "vector",
      feature_count: 0, latest_version: 1, updated_at: new Date().toISOString(), formats: ["geojson", "csv", "gpkg", "shp"], visibility: vis,
    };
    this.s.datasets.push(d); this.save();
    return { dataset: d, job: doneJob };
  }
  async exportRecords(projectId: string, input: { form_id: string; format: "gpkg" | "shp" | "kml"; ids?: string[]; statuses?: FeatureStatus[] }): Promise<Job> {
    await wait(); this.auth();
    const id = uuid();
    const entry: { job: Job; polls: number; url?: string; error?: string } = { job: { id, kind: "export", status: "queued", progress: 0 }, polls: 0 };
    if (input.format !== "kml") entry.error = "Shapefile and GeoPackage files are made by the Geohub server, so they are not available in demo mode. KML, CSV and GeoJSON work here.";
    else {
      const form = this.s.forms.find((f) => f.id === input.form_id);
      const rows = this.s.features.filter((f) => f.project_id === projectId && f.form_id === input.form_id && !f.deleted
        && (!input.ids || input.ids.includes(f.id)) && (!input.statuses || input.statuses.includes(f.status))).map((r) => this.strip(r));
      const nameField = form?.fields.find((f) => f.type === "text")?.id;
      entry.url = URL.createObjectURL(new Blob([toKml(form?.name ?? "Records", rows, nameField)], { type: "application/vnd.google-earth.kml+xml" }));
    }
    this.jobs.set(id, entry);
    return entry.job;
  }
  async createExport(slug: string, format: ExportFormat): Promise<Job> {
    await wait();
    const id = uuid();
    const job: Job = { id, kind: "export", status: "queued", progress: 0 };
    const entry: { job: Job; polls: number; url?: string; error?: string } = { job, polls: 0 };
    if (format === "gpkg" || format === "shp") {
      entry.error = "GeoPackage and Shapefile are produced by the real backend. Use GeoJSON or CSV in mock mode.";
    } else {
      const fc = await this.datasetFeatures(slug);
      const text = format === "geojson" ? JSON.stringify(fc, null, 2) : toCsv(fc);
      entry.url = URL.createObjectURL(new Blob([text], { type: format === "geojson" ? "application/geo+json" : "text/csv" }));
    }
    this.jobs.set(id, entry);
    return job;
  }
  async getJob(id: string): Promise<Job> {
    await wait(150);
    const e = this.jobs.get(id);
    if (!e) throw new ApiError(404, "Job not found.");
    e.polls += 1;
    if (e.polls < 3) return { ...e.job, status: "running", progress: e.polls * 35 };
    if (e.error) return { ...e.job, status: "failed", progress: 100, error: e.error };
    return { ...e.job, status: "done", progress: 100, download_url: e.url };
  }
}

function toCsv(fc: FeatureCollection): string {
  const keys = Array.from(new Set(fc.features.flatMap((f) => Object.keys(f.properties))));
  const esc = (v: unknown) => { const s = v === undefined || v === null ? "" : Array.isArray(v) ? v.join("|") : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const head = ["id", ...keys, "longitude", "latitude", "wkt"].join(",");
  const rows = fc.features.map((f) => {
    const g = f.geometry;
    const pt = g.type === "Point" ? g.coordinates : null;
    const wkt = g.type === "Point" ? "" : g.type === "LineString"
      ? `LINESTRING(${g.coordinates.map((c) => c.join(" ")).join(",")})`
      : `POLYGON((${g.coordinates[0].map((c) => c.join(" ")).join(",")}))`;
    return [f.id, ...keys.map((k) => esc(f.properties[k])), pt ? pt[0] : "", pt ? pt[1] : "", wkt].map(esc).join(",");
  });
  return [head, ...rows].join("\n");
}
