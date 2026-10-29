import { NO_LOCATION } from "./dashboardShare";
import { config } from "./config";
import { normalizeConfig } from "./dashboard";
import type {
  Bundle, Change, Dataset, ExportFormat, Feature, FeatureCollection, Form, FormField, GeometryType, ImageryAsset,
  Job, License, NewFeature, Project, Props, PullResult, PushResult, Session, User, Geometry,
  GeoFeature, MapImportResult, MapLayers, WorkMap,
  Dashboard, DashboardConfig, DashboardSharing, ImportOptions, PublicDashboard,
  Activity, ContributorsReport, ProjectMember, PublicForm, Role, ShareMode, Sharing, JoinPreview, MapMember, MapRole, MapSettings, PublishInput, ReviewStatus,
} from "./types";
import { LICENSE_TO_API, LICENSE_FROM_API } from "./types";

export class ApiError extends Error {
  constructor(public status: number, message: string, public fields?: Record<string, string>) {
    super(message);
  }
}

/** Everything the UI needs from a backend. HttpApi talks to the real API; MockApi (src/mock) is in-memory. */
export interface Api {
  login(email: string, password: string): Promise<Session>;
  register(name: string, email: string, password: string): Promise<Session>;
  logout(): Promise<void>;
  me(): Promise<User>;

  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project>;
  createProject(name: string, description?: string): Promise<Project>;

  listForms(projectId: string): Promise<Form[]>;
  getForm(id: string): Promise<Form>;
  createForm(projectId: string, name: string, geometryType: GeometryType): Promise<Form>;
  saveForm(form: Form): Promise<Form>;
  publishForm(id: string): Promise<Form>;

  // ---- dashboards: saved chart layouts over a project's collected data ----
  listDashboards(projectId: string): Promise<Dashboard[]>;
  getDashboard(id: string): Promise<Dashboard>;
  createDashboard(projectId: string, name: string, config?: DashboardConfig): Promise<Dashboard>;
  saveDashboard(d: Pick<Dashboard, "id" | "name" | "config">): Promise<Dashboard>;
  deleteDashboard(id: string): Promise<void>;
  /** The public link of a dashboard (administrators only). `public: true` issues a link, `false` deletes it for good. */
  getDashboardSharing(id: string): Promise<DashboardSharing>;
  setDashboardSharing(id: string, patch: { public?: boolean; regenerate_link?: boolean }): Promise<DashboardSharing>;
  /** A dashboard by its public link. No sign-in needed. */
  getPublicDashboard(token: string): Promise<PublicDashboard>;

  listFeatures(projectId: string): Promise<Feature[]>;
  createFeature(f: NewFeature): Promise<Feature>;
  updateFeature(id: string, patch: { geometry?: Geometry; properties?: Props; base_version: number }): Promise<Feature>;
  deleteFeature(id: string): Promise<void>;
  /** Approve or reject a collected feature. Only approved features go to the Data hub. */
  reviewFeature(id: string, decision: "approved" | "rejected", note?: string): Promise<Feature>;

  // ---- sharing a form by link; collaborators on a project ----
  getSharing(formId: string): Promise<Sharing>;
  setSharing(formId: string, patch: { share_mode?: ShareMode; regenerate_link?: boolean }): Promise<Sharing>;
  listProjectMembers(projectId: string): Promise<ProjectMember[]>;
  addProjectMember(projectId: string, email: string, role: Exclude<Role, "owner">): Promise<ProjectMember>;
  setProjectMemberRole(projectId: string, memberId: string, role: Role): Promise<void>;
  removeProjectMember(projectId: string, memberId: string): Promise<void>;
  /** Works without signing in when the link is public. Throws 401 (sign in) or 403 (not a collaborator) otherwise. */
  getPublicForm(token: string): Promise<PublicForm>;
  submitPublic(token: string, input: { id: string; geometry: Geometry; properties: Props }): Promise<void>;
  /** A photo, recording or file for a record already sent through a public link. */
  uploadPublicMedia(token: string, featureId: string, mediaId: string, blob: Blob, fieldId?: string): Promise<void>;

  bundle(projectId: string): Promise<Bundle>;
  syncPush(projectId: string, changes: Change[]): Promise<PushResult[]>;
  syncPull(projectId: string, cursor: string): Promise<PullResult>;
  uploadMedia(projectId: string, featureId: string, mediaId: string, blob: Blob, fieldId?: string): Promise<void>;

  listImagery(projectId: string): Promise<ImageryAsset[]>;
  /** `bounds` places a picture that has no coordinates of its own (plain JPEG/PNG...). */
  uploadImagery(projectId: string, file: File, bounds?: [number, number, number, number]): Promise<ImageryAsset>;
  getImagery(id: string): Promise<ImageryAsset>;
  /** Import map data (GeoJSON, KML, GPX, GeoPackage, zipped Shapefile, CSV) as features of a form. Returns the job to poll. */
  importFeatures(projectId: string, file: File, formId: string, opts?: ImportOptions): Promise<Job>;
  /** XYZ tile URL template for a ready imagery asset, or null when tiles are unavailable. */
  imageryTileUrl(id: string): string | null;

  // ---- standalone mapping workspaces ----
  listMaps(): Promise<WorkMap[]>;
  getMap(id: string): Promise<WorkMap>;
  createMap(name: string, description?: string): Promise<WorkMap>;
  updateMap(id: string, patch: MapSettings): Promise<WorkMap>;
  deleteMap(id: string): Promise<void>;
  listMapFeatures(mapId: string): Promise<GeoFeature[]>;
  createMapFeature(mapId: string, f: { id: string; geometry: Geometry; properties: Props }): Promise<GeoFeature>;
  updateMapFeature(mapId: string, id: string, patch: { geometry?: Geometry; properties?: Props; base_version?: number }): Promise<GeoFeature>;
  deleteMapFeature(mapId: string, id: string): Promise<void>;
  importMapFeatures(mapId: string, features: { geometry: Geometry; properties: Props }[]): Promise<MapImportResult>;
  /** GeoJSON file of everything drawn in the map. */
  exportMap(mapId: string): Promise<Blob>;
  /** Uploaded imagery (GeoTIFF etc.) of a map, with signed tile URLs for the ones that are ready. */
  listMapImagery(mapId: string): Promise<{ assets: ImageryAsset[]; layers: MapLayers }>;
  uploadMapImagery(mapId: string, file: File, bounds?: [number, number, number, number]): Promise<ImageryAsset>;
  deleteImagery(id: string): Promise<void>;

  // ---- shared maps: team, review, contributors, publishing ----
  listMembers(mapId: string): Promise<MapMember[]>;
  setMemberRole(mapId: string, userId: string, role: Exclude<MapRole, "owner">): Promise<void>;
  removeMember(mapId: string, userId: string): Promise<void>;
  joinPreview(code: string): Promise<JoinPreview>;
  joinMap(code: string): Promise<WorkMap>;
  contributors(mapId: string): Promise<ContributorsReport>;
  mapActivity(mapId: string): Promise<Activity[]>;
  reviewFeatures(mapId: string, ids: string[], status: ReviewStatus, note?: string): Promise<number>;
  mapDatasets(mapId: string): Promise<Dataset[]>;
  /** Publish the approved features of one kind as a Data hub dataset. Poll the job until it is done. */
  publishMap(mapId: string, input: PublishInput): Promise<{ dataset: Dataset; job: Job }>;
  /** Take a fresh snapshot of a published dataset as its next version. */
  newDatasetVersion(slug: string): Promise<Job>;

  listDatasets(q?: string): Promise<Dataset[]>;
  getDataset(slug: string): Promise<Dataset>;
  /** All features of a dataset; `limit` stops after that many (enough for a preview). */
  datasetFeatures(slug: string, opts?: { limit?: number }): Promise<FeatureCollection>;
  /** Starts publishing. The snapshot is built by a background job: poll `job` with getJob before saying it worked. */
  publishDataset(projectId: string, input: { form_id: string; title: string; description: string; license: License }): Promise<{ dataset: Dataset; job: Job }>;
  createExport(slug: string, format: ExportFormat): Promise<Job>;
  getJob(id: string): Promise<Job>;
}

const TOKEN_KEY = "geohub.access";
const REFRESH_KEY = "geohub.refresh";
export const tokens = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set(s: Session) {
    localStorage.setItem(TOKEN_KEY, s.access_token);
    if (s.refresh_token) localStorage.setItem(REFRESH_KEY, s.refresh_token);
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

// ---- wire formats (what the backend sends) -> UI types ----
const GEOM_FROM_API: Record<string, GeometryType> = { point: "Point", line: "LineString", area: "Polygon" };
const GEOM_TO_API: Record<GeometryType, string> = { Point: "point", LineString: "line", Polygon: "area" };
/** What the server accepts for media fields (photos, signatures, audio, video, documents). Keep in step with backend/app/schemas.py. */
export const MEDIA_TYPES_OK = ["image/jpeg", "image/png", "image/webp", "audio/mpeg", "audio/mp4", "audio/webm", "audio/ogg", "audio/wav", "video/mp4", "video/webm", "video/quicktime", "application/pdf", "text/plain", "text/csv"];
const ALL_FORMATS: ExportFormat[] = ["geojson", "gpkg", "shp", "csv"];

/* eslint-disable @typescript-eslint/no-explicit-any */
type Wire = any;

const toProject = (p: Wire): Project => ({
  id: p.id, name: p.name, description: p.description, role: p.role,
  feature_count: p.feature_count, collector_count: p.collector_count, updated_at: p.last_update ?? p.created_at,
});
/** The server always sends `choices` (empty when a field has none); the UI treats "no choices" as absent. Groups and repeats nest. */
const fromWireField = (x: Wire): FormField => ({
  ...x,
  choices: x.choices?.length ? x.choices : undefined,
  children: x.children ? x.children.map(fromWireField) : undefined,
});
const toWireField = (f: FormField): Wire => ({ ...f, choices: f.choices ?? [], children: f.children ? f.children.map(toWireField) : undefined });
const toForm = (f: Wire, projectId?: string): Form => ({
  id: f.id ?? f.form_id,
  project_id: f.project_id ?? projectId ?? "",
  name: f.name,
  geometry_type: GEOM_FROM_API[f.geometry_type] ?? "Point",
  version: f.version,
  status: f.status ?? "published", // bundle forms are published versions
  fields: (f.fields ?? []).map(fromWireField),
});
const toFeature = (f: Wire): Feature => ({
  id: f.id, project_id: f.project_id, form_id: f.form_id, form_version: f.form_version,
  geometry: f.geometry, properties: f.properties ?? {}, status: f.status, version: f.version,
  updated_at: f.updated_at, deleted: f.deleted_at ? true : undefined,
});
const toImagery = (i: Wire): ImageryAsset => ({
  id: i.id, project_id: i.project_id ?? undefined, map_id: i.map_id ?? undefined, name: i.name, status: i.status, error: i.error ?? undefined,
  bounds: i.bounds && i.bounds.length === 4 ? (i.bounds as [number, number, number, number]) : undefined,
});
const toMap = (m: Wire): WorkMap => ({
  id: m.id, name: m.name, description: m.description ?? "", sources: m.sources ?? [], feature_count: m.feature_count ?? 0, updated_at: m.updated_at,
  role: m.role ?? "owner", owner_name: m.owner_name ?? "", member_count: m.member_count ?? 1,
  is_campaign: !!m.is_campaign, goal: m.goal ?? "", starts_at: m.starts_at ?? undefined, ends_at: m.ends_at ?? undefined,
  competition: !!m.competition, campaign_status: m.campaign_status ?? undefined, join_code: m.join_code ?? undefined,
});
const toGeo = (f: Wire): GeoFeature => ({
  id: f.id, geometry: f.geometry, properties: f.properties ?? {}, version: f.version,
  status: f.status, created_by: f.created_by ?? undefined, author: f.author ?? undefined, review_note: f.review_note || undefined,
  updated_at: f.updated_at, created_at: f.created_at,
});
const toMember = (m: Wire): MapMember => ({ user_id: m.user_id, name: m.name, email: m.email ?? undefined, role: m.role, joined_at: m.joined_at ?? undefined });
const toContributor = (c: Wire) => ({ ...c, first_at: c.first_at ?? undefined, last_at: c.last_at ?? undefined });
const toDataset = (d: Wire): Dataset => ({
  slug: d.slug, project_id: d.project_id ?? "", title: d.title, description: d.description,
  license: LICENSE_FROM_API[d.license as keyof typeof LICENSE_FROM_API] ?? (d.license as License),
  tags: d.tags ?? [], kind: "vector",
  bbox: d.bbox && d.bbox.length === 4 ? d.bbox : undefined,
  feature_count: d.feature_count, latest_version: d.latest_version, updated_at: d.published_at,
  formats: (d.formats ?? ALL_FORMATS) as ExportFormat[],
  visibility: d.visibility, map_id: d.map_id ?? undefined, contributors: d.contributors?.length ? d.contributors : undefined,
});
const toJob = (j: Wire): Job => ({
  id: j.id, kind: j.kind, status: j.status, progress: j.progress,
  download_url: j.result?.download_url, error: j.error ?? undefined, result: j.result ?? undefined,
});
const toPushResult = (r: Wire): PushResult => {
  if (r.status === "applied") return { change_id: r.change_id, id: r.id, status: "applied", version: r.version, merged: r.merged || undefined };
  if (r.status === "conflict") return { change_id: r.change_id, id: r.id, status: "conflict", server: toFeature(r.server) };
  return { change_id: r.change_id, id: r.id, status: "rejected", errors: flattenFields(r.fields, r.detail) };
};
/** Backend `fields` is { field_id: [messages] }; the UI shows one message per field. */
function flattenFields(fields?: Record<string, string[] | string> | null, detail?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields ?? {})) out[k] = Array.isArray(v) ? v.join(" ") : String(v);
  if (!Object.keys(out).length) out._ = detail || "The server did not accept this change.";
  return out;
}

/** The API sends nulls for unset options and the app uses undefined; these two functions are the only place that differs. */
function toDashboard(w: Wire): Dashboard {
  return { id: w.id, project_id: w.project_id, name: w.name, updated_at: w.updated_at, config: normalizeConfig(w.config), shared: w.shared === true };
}
function toWireConfig(c: DashboardConfig) {
  return {
    description: c.description ?? "",
    theme: c.theme ?? null,
    time_filter: c.time_filter ?? null,
    pages: c.pages.map((p) => ({
      id: p.id, title: p.title, form_id: p.form_id ?? null,
      widgets: p.widgets.map((x) => ({
        id: x.id, type: x.type, title: x.title, wide: x.wide ?? false, form_id: x.form_id ?? null, metric: x.metric,
        metric_field: x.metric_field ?? null, field: x.field ?? null, bucket: x.bucket, limit: x.limit, columns: x.columns,
        col: x.col ?? null, row: x.row ?? null, cols: x.cols ?? null, rows: x.rows ?? null,
        region: x.region ?? null, target: x.target ?? null, target_field: x.target_field ?? null, title_field: x.title_field ?? null,
        subtitle_fields: x.subtitle_fields ?? [], content: x.content ?? null, url: x.url ?? null,
        style: x.style ?? null, map_style: x.map_style ?? null,
      })),
    })),
  };
}

class HttpApi implements Api {
  /** Signed tile URLs from GET /projects/{id}/layers, filled in by listImagery(). */
  private tileUrls = new Map<string, string>();

  private async req<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
    const headers: Record<string, string> = {};
    const token = tokens.get();
    if (token) headers.Authorization = `Bearer ${token}`;
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(config.apiUrl + path, { method, headers, body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, "Can't reach the server. Check your connection.");
    }
    if (res.status === 401 && retry && localStorage.getItem(REFRESH_KEY)) {
      const r = await fetch(config.apiUrl + "/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: localStorage.getItem(REFRESH_KEY) }),
      });
      if (r.ok) {
        const s = (await r.json()) as Session;
        tokens.set(s);
        return this.req<T>(method, path, body, false);
      }
      tokens.clear();
    }
    if (!res.ok) {
      let detail = res.statusText;
      let fields: Record<string, string> | undefined;
      try {
        const p = await res.json(); // { type, title, status, detail, code, fields?: { name: [messages] } }
        detail = p.detail || p.title || detail;
        if (p.fields) fields = flattenFields(p.fields);
      } catch { /* not JSON */ }
      throw new ApiError(res.status, detail, fields);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  async login(email: string, password: string) {
    const s = await this.req<Session>("POST", "/auth/login", { email, password });
    tokens.set(s);
    return s;
  }
  async register(name: string, email: string, password: string) {
    const s = await this.req<Session>("POST", "/auth/register", { name, email, password });
    tokens.set(s);
    return s;
  }
  async logout() {
    try { await this.req<void>("POST", "/auth/logout", { refresh_token: localStorage.getItem(REFRESH_KEY) ?? "" }); } catch { /* ignore */ }
    tokens.clear();
  }
  me() { return this.req<User>("GET", "/me"); }

  async listProjects() {
    const out: Project[] = [];
    let cursor: string | null = null;
    do {
      const page: Wire = await this.req("GET", `/projects?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      out.push(...page.items.map(toProject));
      cursor = page.next_cursor;
    } while (cursor);
    return out;
  }
  async getProject(id: string) { return toProject(await this.req("GET", `/projects/${id}`)); }
  async createProject(name: string, description?: string) { return toProject(await this.req("POST", "/projects", { name, description: description ?? "" })); }

  async listForms(projectId: string) {
    const page = await this.req<Wire>("GET", `/projects/${projectId}/forms?limit=100`);
    return page.items.map((f: Wire) => toForm(f, projectId)) as Form[];
  }
  async getForm(id: string) { return toForm(await this.req("GET", `/forms/${id}`)); }
  async createForm(projectId: string, name: string, geometry_type: GeometryType) {
    return toForm(await this.req("POST", `/projects/${projectId}/forms`, { name, geometry_type: GEOM_TO_API[geometry_type] }), projectId);
  }
  async saveForm(form: Form) {
    return toForm(await this.req("PATCH", `/forms/${form.id}`, { name: form.name, fields: form.fields.map(toWireField) }));
  }
  async publishForm(id: string) { return toForm(await this.req("POST", `/forms/${id}/publish`)); }

  async listDashboards(projectId: string) {
    const page = await this.req<Wire>("GET", `/projects/${projectId}/dashboards`);
    return page.items.map(toDashboard) as Dashboard[];
  }
  async getDashboard(id: string) { return toDashboard(await this.req("GET", `/dashboards/${id}`)); }
  async createDashboard(projectId: string, name: string, config: DashboardConfig = normalizeConfig(null)) {
    return toDashboard(await this.req("POST", `/projects/${projectId}/dashboards`, { name, config: toWireConfig(config) }));
  }
  async saveDashboard(d: Pick<Dashboard, "id" | "name" | "config">) {
    return toDashboard(await this.req("PATCH", `/dashboards/${d.id}`, { name: d.name, config: toWireConfig(d.config) }));
  }
  async deleteDashboard(id: string) { await this.req("DELETE", `/dashboards/${id}`); }
  async getDashboardSharing(id: string) { return this.req<DashboardSharing>("GET", `/dashboards/${id}/sharing`); }
  async setDashboardSharing(id: string, patch: { public?: boolean; regenerate_link?: boolean }) { return this.req<DashboardSharing>("PATCH", `/dashboards/${id}/sharing`, patch); }
  async getPublicDashboard(token: string): Promise<PublicDashboard> {
    const w = await this.req<Wire>("GET", `/public/dashboards/${encodeURIComponent(token)}`);
    return {
      token: w.token, name: w.name, project_name: w.project_name, updated_at: w.updated_at, truncated: w.truncated === true, config: normalizeConfig(w.config),
      forms: (w.forms as Wire[]).map((f) => toForm({ ...f, status: "published" })),
      features: (w.features as Wire[]).map((f): Feature => ({ id: f.id, project_id: "", form_id: f.form_id, form_version: 0, geometry: f.geometry ?? NO_LOCATION, properties: f.properties ?? {}, status: "approved", version: 0, updated_at: f.updated_at })),
    };
  }

  async listFeatures(projectId: string) {
    const out: Feature[] = [];
    let cursor: string | null = null;
    do {
      const page: Wire = await this.req("GET", `/projects/${projectId}/features?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      out.push(...page.items.map(toFeature));
      cursor = page.next_cursor;
    } while (cursor);
    return out;
  }
  async createFeature(f: NewFeature) {
    const { project_id, ...body } = f;
    return toFeature(await this.req("POST", `/projects/${project_id}/features`, body));
  }
  async updateFeature(id: string, patch: { geometry?: Geometry; properties?: Props; base_version: number }) {
    return toFeature(await this.req("PATCH", `/features/${id}`, patch));
  }
  deleteFeature(id: string) { return this.req<void>("DELETE", `/features/${id}`); }
  async reviewFeature(id: string, decision: "approved" | "rejected", note?: string) { return toFeature(await this.req("POST", `/features/${id}/review`, { decision, note })); }

  async getSharing(formId: string) { return this.req<Sharing>("GET", `/forms/${formId}/sharing`); }
  async setSharing(formId: string, patch: { share_mode?: ShareMode; regenerate_link?: boolean }) { return this.req<Sharing>("PATCH", `/forms/${formId}/sharing`, patch); }
  async listProjectMembers(projectId: string) {
    const page = await this.req<Wire>("GET", `/projects/${projectId}/members?limit=200`);
    return page.items.map((m: Wire): ProjectMember => ({ id: m.id, user_id: m.user_id ?? undefined, email: m.email, name: m.name ?? undefined, role: m.role, status: m.status }));
  }
  async addProjectMember(projectId: string, email: string, role: Exclude<Role, "owner">) {
    const m = await this.req<Wire>("POST", `/projects/${projectId}/members`, { email, role });
    return { id: m.id, user_id: m.user_id ?? undefined, email: m.email, name: m.name ?? undefined, role: m.role, status: m.status } as ProjectMember;
  }
  async setProjectMemberRole(projectId: string, memberId: string, role: Role) { await this.req("PATCH", `/projects/${projectId}/members/${memberId}`, { role }); }
  removeProjectMember(projectId: string, memberId: string) { return this.req<void>("DELETE", `/projects/${projectId}/members/${memberId}`); }
  async getPublicForm(token: string): Promise<PublicForm> {
    const f = await this.req<Wire>("GET", `/public/forms/${token}`);
    return { token, project_name: f.project_name, access: f.access, form: toForm({ ...f, id: f.form_id, status: "published" }, f.project_id) };
  }
  async submitPublic(token: string, input: { id: string; geometry: Geometry; properties: Props }) { await this.req("POST", `/public/forms/${token}/submissions`, input); }
  async uploadPublicMedia(token: string, featureId: string, mediaId: string, blob: Blob, fieldId?: string) {
    const content_type = MEDIA_TYPES_OK.includes(blob.type) ? blob.type : "image/jpeg";
    const up = await this.req<{ upload_url: string; headers: Record<string, string> }>("POST", `/public/forms/${token}/media/upload-url`, { id: mediaId, content_type, size: blob.size });
    const put = await fetch(up.upload_url, { method: "PUT", body: blob, headers: up.headers });
    if (!put.ok) throw new ApiError(put.status, "Upload failed");
    await this.req("POST", `/public/forms/${token}/media/${mediaId}/complete`, { feature_id: featureId, field_id: fieldId ?? null });
  }

  async bundle(projectId: string): Promise<Bundle> {
    const b = await this.req<Wire>("GET", `/projects/${projectId}/bundle`);
    return { forms: b.forms.map((f: Wire) => toForm(f, projectId)), features: b.features.map(toFeature), cursor: b.truncated ? "" : b.cursor };
  }
  async syncPush(projectId: string, changes: Change[]) {
    const r = await this.req<Wire>("POST", "/sync/push", { project_id: projectId, changes });
    return r.results.map(toPushResult) as PushResult[];
  }
  async syncPull(projectId: string, cursor: string): Promise<PullResult> {
    const q = `project_id=${projectId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const r = await this.req<Wire>("GET", `/sync/pull?${q}`);
    return {
      changes: r.items.map((i: Wire) => ({ ...toFeature(i.feature), deleted: i.op === "delete" ? true : undefined })),
      cursor: r.next_cursor,
      has_more: r.has_more,
    };
  }
  async uploadMedia(projectId: string, featureId: string, mediaId: string, blob: Blob, fieldId?: string) {
    const content_type = MEDIA_TYPES_OK.includes(blob.type) ? blob.type : "image/jpeg";
    const up = await this.req<{ upload_url: string; headers: Record<string, string> }>("POST", "/media/upload-url", {
      id: mediaId, project_id: projectId, content_type, size: blob.size,
    });
    const put = await fetch(up.upload_url, { method: "PUT", body: blob, headers: up.headers });
    if (!put.ok) throw new ApiError(put.status, "Upload failed");
    await this.req("POST", `/media/${mediaId}/complete`, { feature_id: featureId, field_id: fieldId ?? null });
  }

  async listImagery(projectId: string) {
    const page = await this.req<Wire>("GET", `/projects/${projectId}/imagery?limit=100`);
    const items: ImageryAsset[] = page.items.map(toImagery);
    if (items.some((i) => i.status === "ready")) {
      // Map tiles can't send an Authorization header, so the API hands out short-lived signed tile URLs.
      try {
        const layers = await this.req<Wire>("GET", `/projects/${projectId}/layers`);
        for (const l of layers.imagery) this.tileUrls.set(l.id, l.tiles_url);
      } catch { /* falls back to ?access_token= below */ }
    }
    return items;
  }
  async getImagery(id: string) { return toImagery(await this.req("GET", `/imagery/${id}`)); }
  async importFeatures(projectId: string, file: File, formId: string, opts: ImportOptions = {}) {
    const fd = new FormData();
    fd.append("file", file, file.name);
    fd.append("form_id", formId);
    fd.append("status", opts.status ?? "submitted");
    if (opts.mapping) fd.append("mapping", JSON.stringify(opts.mapping));
    // CSV needs to know where the coordinates are. When the caller says, use that; otherwise guess the usual column names, and the backend rejects the rest.
    if (opts.wkt || (opts.lon && opts.lat)) {
      if (opts.wkt) fd.append("wkt_column", opts.wkt); else { fd.append("lon_column", opts.lon!); fd.append("lat_column", opts.lat!); }
    } else if (file.name.toLowerCase().endsWith(".csv")) {
      const head = (await file.slice(0, 4096).text()).split(/\r?\n/)[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
      const find = (...names: string[]) => head.find((h) => names.includes(h.toLowerCase()));
      const wkt = find("wkt", "geom", "geometry");
      const lon = find("lon", "lng", "long", "longitude", "x");
      const lat = find("lat", "latitude", "y");
      if (wkt) fd.append("wkt_column", wkt);
      else if (lon && lat) { fd.append("lon_column", lon); fd.append("lat_column", lat); }
      else throw new ApiError(422, "Could not find coordinate columns. Name them lon and lat (or wkt).");
    }
    return toJob(await this.req<Wire>("POST", `/projects/${projectId}/import`, fd));
  }
  uploadImagery(projectId: string, file: File, bounds?: [number, number, number, number]) {
    return this.uploadImageryTo(`/projects/${projectId}/imagery`, file, bounds);
  }
  private async uploadImageryTo(path: string, file: File, bounds?: [number, number, number, number]) {
    // Multipart upload straight to object storage: the API hands out one presigned URL per part.
    const init = await this.req<Wire>("POST", path, { name: file.name, filename: file.name, size: file.size, ...(bounds ? { bounds, crs: "EPSG:4326" } : {}) });
    const done: { part_number: number; etag: string }[] = [];
    for (const part of init.parts as { part_number: number; url: string }[]) {
      const chunk = file.slice((part.part_number - 1) * init.part_size, part.part_number * init.part_size);
      const put = await fetch(part.url, { method: "PUT", body: chunk });
      if (!put.ok) throw new ApiError(put.status, "Imagery upload failed");
      const etag = put.headers.get("ETag");
      if (!etag) throw new ApiError(0, "Storage did not return an ETag. The bucket CORS must expose the ETag header.");
      done.push({ part_number: part.part_number, etag });
    }
    return toImagery(await this.req("POST", `/imagery/${init.id}/complete`, { parts: done }));
  }
  imageryTileUrl(id: string) {
    const signed = this.tileUrls.get(id);
    if (signed) return signed;
    const t = tokens.get();
    return `${config.apiUrl}/tiles/imagery/${id}/{z}/{x}/{y}.png${t ? `?access_token=${encodeURIComponent(t)}` : ""}`;
  }

  // ---- standalone mapping workspaces ----
  async listMaps() { return (await this.req<Wire[]>("GET", "/maps")).map(toMap); }
  async getMap(id: string) { return toMap(await this.req("GET", `/maps/${id}`)); }
  async createMap(name: string, description?: string) { return toMap(await this.req("POST", "/maps", { name, description: description ?? "" })); }
  async updateMap(id: string, patch: MapSettings) { return toMap(await this.req("PATCH", `/maps/${id}`, patch)); }
  deleteMap(id: string) { return this.req<void>("DELETE", `/maps/${id}`); }
  async listMapFeatures(mapId: string) { return (await this.req<Wire[]>("GET", `/maps/${mapId}/features`)).map(toGeo); }

  // ---- shared maps ----
  async listMembers(mapId: string) { return (await this.req<Wire[]>("GET", `/maps/${mapId}/members`)).map(toMember); }
  async setMemberRole(mapId: string, userId: string, role: Exclude<MapRole, "owner">) { await this.req("PATCH", `/maps/${mapId}/members/${userId}`, { role }); }
  removeMember(mapId: string, userId: string) { return this.req<void>("DELETE", `/maps/${mapId}/members/${userId}`); }
  joinPreview(code: string) { return this.req<Wire>("GET", `/join/${encodeURIComponent(code)}`).then((j) => ({ ...j, starts_at: j.starts_at ?? undefined, ends_at: j.ends_at ?? undefined, campaign_status: j.campaign_status ?? undefined }) as JoinPreview); }
  async joinMap(code: string) { return toMap(await this.req("POST", `/join/${encodeURIComponent(code)}`)); }
  async contributors(mapId: string): Promise<ContributorsReport> {
    const r = await this.req<Wire>("GET", `/maps/${mapId}/contributors`);
    return { ...r, contributors: r.contributors.map(toContributor), starts_at: r.starts_at ?? undefined, ends_at: r.ends_at ?? undefined };
  }
  async mapActivity(mapId: string) { return (await this.req<Wire[]>("GET", `/maps/${mapId}/activity`)) as Activity[]; }
  async reviewFeatures(mapId: string, ids: string[], status: ReviewStatus, note = "") {
    let n = 0;
    for (let i = 0; i < ids.length; i += 1000) n += (await this.req<Wire>("POST", `/maps/${mapId}/features/review`, { ids: ids.slice(i, i + 1000), status, note })).updated;
    return n;
  }
  async mapDatasets(mapId: string) { return (await this.req<Wire[]>("GET", `/maps/${mapId}/datasets`)).map(toDataset); }
  async publishMap(mapId: string, input: PublishInput) {
    const r = await this.req<Wire>("POST", `/maps/${mapId}/publish`, {
      slug: input.slug, title: input.title, description: input.description, license: LICENSE_TO_API[input.license],
      tags: input.tags, visibility: input.license === "Private" ? "private" : input.visibility,
      geometry_type: input.geometry_type, credit_contributors: input.credit_contributors,
    });
    return { dataset: toDataset(r.dataset), job: toJob(r.job) };
  }
  newDatasetVersion(slug: string) { return this.req<Wire>("POST", `/datasets/${slug}/versions`, {}).then(toJob); }
  async createMapFeature(mapId: string, f: { id: string; geometry: Geometry; properties: Props }) { return toGeo(await this.req("POST", `/maps/${mapId}/features`, f)); }
  async updateMapFeature(mapId: string, id: string, patch: { geometry?: Geometry; properties?: Props; base_version?: number }) { return toGeo(await this.req("PATCH", `/maps/${mapId}/features/${id}`, patch)); }
  deleteMapFeature(mapId: string, id: string) { return this.req<void>("DELETE", `/maps/${mapId}/features/${id}`); }
  async importMapFeatures(mapId: string, features: { geometry: Geometry; properties: Props }[]) {
    const out: MapImportResult = { imported: 0, rejected: 0, errors: [] };
    for (let i = 0; i < features.length; i += 2000) {     // the API takes up to 10000 per call; stay well below request limits
      const r = await this.req<MapImportResult>("POST", `/maps/${mapId}/features/import`, { features: features.slice(i, i + 2000) });
      out.imported += r.imported; out.rejected += r.rejected;
      out.errors.push(...r.errors.map((e) => ({ ...e, row: e.row + i })));
    }
    out.errors = out.errors.slice(0, 20);
    return out;
  }
  async exportMap(mapId: string) {
    const token = tokens.get();
    const res = await fetch(`${config.apiUrl}/maps/${mapId}/export.geojson`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new ApiError(res.status, "Could not export the map.");
    return res.blob();
  }
  async listMapImagery(mapId: string) {
    const page = await this.req<Wire>("GET", `/maps/${mapId}/imagery?limit=100`);
    const assets: ImageryAsset[] = page.items.map(toImagery);
    const layers: MapLayers = { imagery: [] };
    if (assets.some((a) => a.status === "ready")) {
      const l = await this.req<Wire>("GET", `/maps/${mapId}/layers`);    // signed tile URLs: map tiles cannot send headers
      layers.imagery = l.imagery.map((i: Wire) => ({ id: i.id, name: i.name, bounds: i.bounds?.length === 4 ? i.bounds : undefined, url: i.tiles_url }));
    }
    return { assets, layers };
  }
  uploadMapImagery(mapId: string, file: File, bounds?: [number, number, number, number]) { return this.uploadImageryTo(`/maps/${mapId}/imagery`, file, bounds); }
  deleteImagery(id: string) { return this.req<void>("DELETE", `/imagery/${id}`); }

  async listDatasets(q?: string) {
    const out: Dataset[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ limit: "100" });
      if (q) params.set("q", q);
      if (cursor) params.set("cursor", cursor);
      const page: Wire = await this.req("GET", `/datasets?${params}`);
      out.push(...page.items.map(toDataset));
      cursor = page.next_cursor;
    } while (cursor);
    return out;
  }
  async getDataset(slug: string) { return toDataset(await this.req("GET", `/datasets/${slug}`)); }
  async datasetFeatures(slug: string, opts?: { limit?: number }) {
    const out: FeatureCollection = { type: "FeatureCollection", features: [] };
    const cap = opts?.limit;
    let cursor: string | null = null;
    do {
      const size = cap ? Math.min(1000, cap - out.features.length) : 1000;
      const page: Wire = await this.req("GET", `/datasets/${slug}/features?limit=${size}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      out.features.push(...page.features);
      cursor = page.next_cursor;
    } while (cursor && (!cap || out.features.length < cap));
    return out;
  }
  async publishDataset(projectId: string, input: { form_id: string; title: string; description: string; license: License }) {
    const r = await this.req<Wire>("POST", `/projects/${projectId}/datasets`, {
      form_id: input.form_id,
      slug: slugify(input.title),
      title: input.title,
      description: input.description,
      license: LICENSE_TO_API[input.license],
      visibility: input.license === "Private" ? "private" : "public",
      // There is no review screen in the web app yet, so new features stay "submitted". Include them.
      statuses: ["submitted", "approved"],
    });
    return { dataset: toDataset(r.dataset), job: toJob(r.job) };
  }
  createExport(slug: string, format: ExportFormat) { return this.req<Wire>("POST", `/datasets/${slug}/exports`, { format }).then(toJob); }
  getJob(id: string) { return this.req<Wire>("GET", `/jobs/${id}`).then(toJob); }
}

/** Backend slugs: lowercase letters, digits and hyphens, 2-63 chars, a short random suffix keeps them unique. */
function slugify(title: string): string {
  const base = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "dataset";
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}

// The mock is loaded lazily so it never ships in a real-API build's critical path.
let instance: Api | null = null;
export async function loadApi(): Promise<Api> {
  if (instance) return instance;
  if (config.useMock) {
    const { MockApi } = await import("../mock/mockApi");
    instance = new MockApi();
  } else {
    instance = new HttpApi();
  }
  return instance;
}
