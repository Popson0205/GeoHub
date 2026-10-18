import { ApiError, tokens, type Api } from "../lib/api";
import { validateProperties, uuid } from "../lib/forms";
import type {
  Bundle, Change, Dataset, ExportFormat, Feature, FeatureCollection, Form, Geometry, GeometryType, ImageryAsset,
  Job, License, NewFeature, Project, Props, PullResult, PushResult, Session, User,
  GeoFeature, MapImportResult, MapLayers, TileSource, WorkMap,
} from "../lib/types";
import { DEMO_USER, seedDatasets, seedFeatureRows, seedForms, seedProjects } from "./seed";

type Row = Feature & { seq: number };
interface State {
  projects: Project[]; forms: Form[]; features: Row[]; imagery: ImageryAsset[]; datasets: Dataset[]; seq: number;
  maps?: WorkMap[]; mapFeatures?: (GeoFeature & { map_id: string })[];
}

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
  async importFeatures(projectId: string, file: File, formId: string): Promise<Job> {
    await wait(); this.auth();
    const name = file.name.toLowerCase();
    if (!name.endsWith(".geojson") && !name.endsWith(".json")) throw new ApiError(422, "Mock mode can only import GeoJSON. KML, GPX, GeoPackage, Shapefile and CSV need the real backend.");
    const form = this.s.forms.find((f) => f.id === formId);
    if (!form) throw new ApiError(404, "Form not found.");
    let data: { type?: string; features?: { geometry?: Geometry; properties?: Props }[] };
    try { data = JSON.parse(await file.text()); } catch { throw new ApiError(422, "The file is not valid JSON."); }
    let imported = 0; const errors: { row: number; message: string }[] = [];
    (data.features ?? []).forEach((f, i) => {
      if (!f.geometry || f.geometry.type !== form.geometry_type) { errors.push({ row: i + 1, message: `geometry must be a ${form.geometry_type}` }); return; }
      const props: Props = {}; for (const fld of form.fields) if (f.properties && fld.id in f.properties) props[fld.id] = f.properties[fld.id];
      this.s.features.push({ id: uuid(), project_id: projectId, form_id: form.id, form_version: form.version, geometry: f.geometry, properties: props, status: "submitted", version: 1, updated_at: new Date().toISOString(), seq: ++this.s.seq });
      imported++;
    });
    this.save();
    const job: Job = { id: uuid(), kind: "import", status: imported ? "done" : "failed", progress: 100, result: { imported, rejected: errors.length, errors }, error: imported ? undefined : "No rows could be imported. See the row errors." };
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

  // ---- standalone mapping workspaces ----
  private maps() { return (this.s.maps ??= []); }
  private mapFeats() { return (this.s.mapFeatures ??= []); }
  private mapOf(id: string) {
    const m = this.maps().find((x) => x.id === id);
    if (!m) throw new ApiError(404, "Map not found.");
    return m;
  }
  async listMaps() { await wait(); this.auth(); return this.maps().map((m) => ({ ...m, feature_count: this.mapFeats().filter((f) => f.map_id === m.id).length })); }
  async getMap(id: string) { await wait(60); this.auth(); const m = this.mapOf(id); return { ...m, feature_count: this.mapFeats().filter((f) => f.map_id === id).length }; }
  async createMap(name: string, description?: string) {
    await wait(); this.auth();
    const m: WorkMap = { id: uuid(), name, description: description ?? "", sources: [], feature_count: 0, updated_at: new Date().toISOString() };
    this.maps().unshift(m); this.save();
    return m;
  }
  async updateMap(id: string, patch: { name?: string; description?: string; sources?: TileSource[] }) {
    await wait(60); this.auth();
    const m = this.mapOf(id);
    if (patch.sources) {
      for (const s of patch.sources) {
        if (!/^https?:\/\//i.test(s.url) || !s.url.includes("{z}") || !s.url.includes("{x}") || !(s.url.includes("{y}") || s.url.includes("{-y}"))) {
          throw new ApiError(422, `Imagery source "${s.name}": the URL must start with http(s):// and contain {z}, {x} and {y}.`);
        }
      }
      m.sources = patch.sources.map((s) => ({ ...s, id: s.id || uuid().slice(0, 12) }));
    }
    if (patch.name !== undefined) m.name = patch.name;
    if (patch.description !== undefined) m.description = patch.description;
    m.updated_at = new Date().toISOString(); this.save();
    return { ...m, feature_count: this.mapFeats().filter((f) => f.map_id === id).length };
  }
  async deleteMap(id: string) {
    await wait(); this.auth(); this.mapOf(id);
    this.s.maps = this.maps().filter((m) => m.id !== id);
    this.s.mapFeatures = this.mapFeats().filter((f) => f.map_id !== id);
    this.s.imagery = this.s.imagery.filter((i) => i.map_id !== id);
    this.save();
  }
  async listMapFeatures(mapId: string) { await wait(60); this.auth(); this.mapOf(mapId); return this.mapFeats().filter((f) => f.map_id === mapId).map(({ map_id: _m, ...f }) => f); }
  async createMapFeature(mapId: string, f: { id: string; geometry: Geometry; properties: Props }) {
    await wait(60); this.auth(); this.mapOf(mapId);
    const row = { id: f.id, map_id: mapId, geometry: f.geometry, properties: f.properties, version: 1 };
    this.mapFeats().push(row); this.save();
    const { map_id: _m, ...out } = row;
    return out;
  }
  async updateMapFeature(mapId: string, id: string, patch: { geometry?: Geometry; properties?: Props; base_version?: number }) {
    await wait(60); this.auth();
    const f = this.mapFeats().find((x) => x.id === id && x.map_id === mapId);
    if (!f) throw new ApiError(404, "Feature not found.");
    if (patch.base_version !== undefined && patch.base_version !== f.version) throw new ApiError(409, "This feature changed since you opened it. Reload and try again.");
    if (patch.geometry) f.geometry = patch.geometry;
    if (patch.properties) f.properties = patch.properties;
    f.version += 1; this.save();
    const { map_id: _m, ...out } = f;
    return out;
  }
  async deleteMapFeature(mapId: string, id: string) {
    await wait(60); this.auth();
    this.s.mapFeatures = this.mapFeats().filter((f) => !(f.id === id && f.map_id === mapId)); this.save();
  }
  async importMapFeatures(mapId: string, features: { geometry: Geometry; properties: Props }[]): Promise<MapImportResult> {
    await wait(); this.auth(); this.mapOf(mapId);
    for (const f of features) this.mapFeats().push({ id: uuid(), map_id: mapId, geometry: f.geometry, properties: f.properties, version: 1 });
    this.save();
    return { imported: features.length, rejected: 0, errors: [] };
  }
  async exportMap(mapId: string) {
    const feats = await this.listMapFeatures(mapId);
    const fc = { type: "FeatureCollection", features: feats.map((f) => ({ type: "Feature", id: f.id, geometry: f.geometry, properties: f.properties })) };
    return new Blob([JSON.stringify(fc, null, 2)], { type: "application/geo+json" });
  }
  async listMapImagery(mapId: string): Promise<{ assets: ImageryAsset[]; layers: MapLayers }> {
    await wait(60); this.auth();
    return { assets: this.s.imagery.filter((i) => i.map_id === mapId), layers: { imagery: [] } };   // no tile server in mock mode
  }
  async uploadMapImagery(mapId: string, file: File) {
    await wait(500); this.auth(); this.mapOf(mapId);
    const a: ImageryAsset = { id: uuid(), map_id: mapId, name: file.name, status: "ready" };
    this.s.imagery.push(a); this.save();
    return a;
  }
  async deleteImagery(id: string) { await wait(60); this.s.imagery = this.s.imagery.filter((i) => i.id !== id); this.save(); }

  async listDatasets(q?: string) {
    await wait();
    const needle = (q ?? "").trim().toLowerCase();
    return this.s.datasets
      .filter((d) => d.license !== "Private" && (!needle || (d.title + d.description + d.tags.join(" ")).toLowerCase().includes(needle)))
      .map((d) => ({ ...d, feature_count: this.s.features.filter((f) => f.project_id === d.project_id && !f.deleted).length }));
  }
  async getDataset(slug: string) {
    const d = (await this.listDatasets()).find((x) => x.slug === slug);
    if (!d) throw new ApiError(404, "Dataset not found.");
    return d;
  }
  async datasetFeatures(slug: string): Promise<FeatureCollection> {
    const d = await this.getDataset(slug);
    return {
      type: "FeatureCollection",
      features: this.s.features.filter((f) => f.project_id === d.project_id && !f.deleted)
        .map((f) => ({ type: "Feature" as const, id: f.id, geometry: f.geometry, properties: f.properties })),
    };
  }
  async publishDataset(projectId: string, input: { form_id?: string; title: string; description: string; license: License }) {
    await wait(); this.auth();
    const slug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || uuid().slice(0, 8);
    const existing = this.s.datasets.find((d) => d.slug === slug);
    if (existing) { existing.latest_version += 1; existing.updated_at = new Date().toISOString(); this.save(); return existing; }
    const d: Dataset = {
      slug, project_id: projectId, title: input.title, description: input.description, license: input.license, tags: [], kind: "vector",
      feature_count: 0, latest_version: 1, updated_at: new Date().toISOString(), formats: ["geojson", "csv", "gpkg", "shp"],
    };
    this.s.datasets.push(d); this.save();
    return d;
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
