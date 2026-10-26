import { ApiError, tokens, type Api } from "../lib/api";
import { normalizeConfig } from "../lib/dashboard";
import { publicDashboard } from "../lib/dashboardShare";
import { coerceCell, importableFields, parseCsv, parseNumber, parseShape } from "../lib/csvImport";
import { topLevelFields } from "../lib/fieldSpec";
import { validateProperties, uuid } from "../lib/forms";
import type {
  Dashboard, DashboardConfig, ImportOptions,
  Bundle, Change, Dataset, ExportFormat, Feature, FeatureCollection, Form, Geometry, GeometryType, ImageryAsset,
  Job, License, NewFeature, Project, Props, PullResult, PushResult, Session, User,
  GeoFeature, MapImportResult, MapLayers, WorkMap,
  Activity, ContributorsReport, ProjectMember, PublicForm, Role, ShareMode, Sharing, JoinPreview, MapMember, MapRole, MapSettings, PublishInput, ReviewStatus,
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
}
/** The mock keeps who owns a map and who drew each feature, like the real backend does. */
type MockMap = Omit<WorkMap, "role" | "owner_name" | "member_count" | "campaign_status" | "feature_count"> & { owner_id: string; owner_name: string; feature_count?: number };
type MockFeat = GeoFeature & { map_id: string; created_by: string; author: string; status: ReviewStatus; review_note?: string; created_at: string; updated_at: string; updated_by?: string };
const KIND_NAME = { point: "point", line: "line", area: "polygon" } as const;
const GEOM_KIND = (g: Geometry): "point" | "line" | "area" => (g.type === "Point" ? "point" : g.type === "LineString" ? "line" : "area");

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
    const n = this.s.features.filter((f) => f.project_id === p.id && !f.deleted).length;
    return { ...p, feature_count: n };
  }
  private strip(r: Row): Feature { const { seq: _s, ...f } = r; return f; }

  async login(email: string, password: string): Promise<Session> {
    await wait();
    if (email.trim().toLowerCase() !== DEMO_USER.email || password !== "demo") throw new ApiError(401, "Wrong email or password. In mock mode use demo@geohub.test / demo.");
    const s: Session = { access_token: "mock-token", refresh_token: "mock-refresh", user: DEMO_USER };
    tokens.set(s);
    return s;
  }
  async logout() { tokens.clear(); }
  async register(): Promise<Session> { return this.login("demo@geohub.test", "demo"); }
  async me(): Promise<User> { await wait(40); this.auth(); return DEMO_USER; }

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
  async createForm(projectId: string, name: string, geometry_type: GeometryType) {
    await wait(); this.auth();
    const f: Form = { id: uuid(), project_id: projectId, name, geometry_type, version: 0, status: "draft", fields: [] };
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
    f.version += 1; f.status = "published"; this.save();
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

  async listFeatures(projectId: string) { await wait(); this.auth(); return this.s.features.filter((f) => f.project_id === projectId && !f.deleted).map((r) => this.strip(r)); }
  async createFeature(nf: NewFeature) {
    await wait(); this.auth();
    const form = this.s.forms.find((f) => f.id === nf.form_id);
    if (form) {
      const errors = validateProperties(form, nf.properties);
      if (Object.keys(errors).length) throw new ApiError(422, "Some fields need attention.", errors);
    }
    const row: Row = { ...nf, status: "submitted", version: 1, updated_at: new Date().toISOString(), seq: ++this.s.seq };
    this.s.features.push(row); this.save();
    return this.strip(row);
  }
  async updateFeature(id: string, patch: { geometry?: Geometry; properties?: Props; base_version: number }) {
    await wait(); this.auth();
    const r = this.s.features.find((f) => f.id === id);
    if (!r || r.deleted) throw new ApiError(404, "Feature not found.");
    if (patch.base_version !== r.version) throw new ApiError(409, "Someone else changed this feature. Reload to see their version.");
    if (patch.geometry) r.geometry = patch.geometry;
    if (patch.properties) r.properties = patch.properties;
    r.version += 1; r.seq = ++this.s.seq; r.updated_at = new Date().toISOString(); this.save();
    return this.strip(r);
  }
  async deleteFeature(id: string) {
    await wait(); this.auth();
    const r = this.s.features.find((f) => f.id === id);
    if (r) { r.deleted = true; r.seq = ++this.s.seq; r.version += 1; this.save(); }
  }
  async reviewFeature(id: string, decision: "approved" | "rejected", _note?: string) {
    await wait(); this.auth();
    const r = this.s.features.find((f) => f.id === id);
    if (!r || r.deleted) throw new ApiError(404, "Feature not found.");
    r.status = decision; r.version += 1; r.seq = ++this.s.seq; this.save();
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
    list.push(m); this.save();
    return m;
  }
  async setProjectMemberRole(projectId: string, memberId: string, role: Role) {
    await wait(); this.auth();
    const m = this.memberList(projectId).find((x) => x.id === memberId);
    if (!m) throw new ApiError(404, "Member not found.");
    m.role = role; this.save();
  }
  async removeProjectMember(projectId: string, memberId: string) {
    await wait(); this.auth();
    const list = this.memberList(projectId);
    const i = list.findIndex((x) => x.id === memberId);
    if (i >= 0) list.splice(i, 1);
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
      } else if (!cur || cur.deleted) {
        out.push({ change_id: c.change_id, id: c.id, status: "rejected", errors: { _: "Feature no longer exists." } });
      } else if (c.op === "delete") {
        cur.deleted = true; cur.version += 1; cur.seq = ++this.s.seq;
        out.push({ change_id: c.change_id, id: c.id, status: "applied", version: cur.version });
      } else if (c.base_version === cur.version) {
        if (c.geometry) cur.geometry = c.geometry;
        if (c.properties) cur.properties = c.properties;
        cur.version += 1; cur.seq = ++this.s.seq; cur.updated_at = new Date().toISOString();
        out.push({ change_id: c.change_id, id: c.id, status: "applied", version: cur.version });
      } else if (c.geometry && JSON.stringify(c.geometry) !== JSON.stringify(cur.geometry)) {
        out.push({ change_id: c.change_id, id: c.id, status: "conflict", server: this.strip(cur) });
      } else {
        // Stale base but the shape did not change: merge properties (contract rule 4).
        cur.properties = { ...cur.properties, ...(c.properties ?? {}) };
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
  async uploadMedia() { await wait(200); }

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
        if (!msgs.length) for (const m of Object.values(validateProperties(form, props))) if (!(status === "draft" && /is required\.$/.test(m))) msgs.push(m);
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
      visibility: input.license === "Private" ? "private" : input.visibility, map_id: mapId,
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
  async publishDataset(projectId: string, input: { form_id?: string; title: string; description: string; license: License }) {
    await wait(); this.auth();
    const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || uuid().slice(0, 8);
    const existing = this.s.datasets.find((d) => d.slug === slug);
    const doneJob: Job = { id: uuid(), kind: "snapshot", status: "done", progress: 100 };
    if (existing) { existing.latest_version += 1; existing.updated_at = new Date().toISOString(); this.save(); return { dataset: existing, job: doneJob }; }
    const d: Dataset = {
      slug, project_id: projectId, title: input.title, description: input.description, license: input.license, tags: [], kind: "vector",
      feature_count: 0, latest_version: 1, updated_at: new Date().toISOString(), formats: ["geojson", "csv", "gpkg", "shp"],
    };
    this.s.datasets.push(d); this.save();
    return { dataset: d, job: doneJob };
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
