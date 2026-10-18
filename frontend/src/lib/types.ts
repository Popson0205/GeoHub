// Domain types. They mirror the API contract ("Mapping Hub: Backend API Contract and Data Model").

export type Position = [number, number]; // [longitude, latitude], EPSG:4326
export type Geometry =
  | { type: "Point"; coordinates: Position }
  | { type: "LineString"; coordinates: Position[] }
  | { type: "Polygon"; coordinates: Position[][] };
export type GeometryType = Geometry["type"];

export const GEOMETRY_LABEL: Record<GeometryType, string> = { Point: "point", LineString: "line", Polygon: "area" };

export type Role = "owner" | "admin" | "collector" | "viewer";
export interface User { id: string; email: string; name: string }
export interface Session { access_token: string; refresh_token?: string; user: User }

export interface Project {
  id: string;
  name: string;
  description?: string;
  role: Role;
  feature_count: number;
  collector_count: number;
  updated_at: string;
}

export type FieldType = "text" | "number" | "choice" | "multi_choice" | "date" | "photo";
export interface FormField {
  id: string;
  label: string;
  type: FieldType;
  required?: boolean;
  choices?: string[];
  max_items?: number;
}
export interface Form {
  id: string;
  project_id: string;
  name: string;
  geometry_type: GeometryType;
  version: number;
  status: "draft" | "published";
  fields: FormField[];
}

export type FeatureStatus = "draft" | "submitted" | "approved" | "rejected";
export type Props = Record<string, unknown>;
export interface Feature {
  id: string; // client-generated UUID
  project_id: string;
  form_id: string;
  form_version: number;
  geometry: Geometry;
  properties: Props;
  status: FeatureStatus;
  version: number;
  updated_at: string;
  deleted?: boolean;
}
export type NewFeature = Pick<Feature, "id" | "project_id" | "form_id" | "form_version" | "geometry" | "properties">;

// ---- sync ----
export type ChangeOp = "create" | "update" | "delete";
export interface Change {
  change_id: string; // idempotency key
  id: string; // feature id
  op: ChangeOp;
  base_version: number; // 0 for create
  form_id?: string;
  form_version?: number;
  geometry?: Geometry;
  properties?: Props;
  client_updated_at: string;
}
export type PushResult =
  | { change_id: string; id: string; status: "applied"; version: number; merged?: boolean }
  | { change_id: string; id: string; status: "conflict"; server: Feature }
  | { change_id: string; id: string; status: "rejected"; errors: Record<string, string> };
export interface PullResult { changes: Feature[]; cursor: string; has_more: boolean }
export interface Bundle { forms: Form[]; features: Feature[]; cursor: string }

// ---- imagery, hub ----
export interface ImageryAsset {
  id: string;
  project_id?: string;
  map_id?: string;
  name: string;
  status: "uploading" | "processing" | "ready" | "failed";
  bounds?: [number, number, number, number];
  /** Why processing failed, in plain language (set when status is "failed"). */
  error?: string;
}
export type License = "ODbL" | "CC BY 4.0" | "CC0" | "Private";
/** UI label -> id the backend stores. */
export const LICENSE_TO_API = { "ODbL": "ODbL-1.0", "CC BY 4.0": "CC-BY-4.0", "CC0": "CC0-1.0", "Private": "Private" } as const;
export const LICENSE_FROM_API: Record<string, License> = { "ODbL-1.0": "ODbL", "CC-BY-4.0": "CC BY 4.0", "CC0-1.0": "CC0", "Private": "Private" };
export type ExportFormat = "geojson" | "gpkg" | "shp" | "csv";
export interface Dataset {
  slug: string;
  project_id: string;
  title: string;
  description: string;
  license: License;
  tags: string[];
  kind: "vector" | "imagery";
  bbox?: [number, number, number, number];
  feature_count: number;
  latest_version: number;
  updated_at: string;
  formats: ExportFormat[];
}
export interface Job {
  id: string;
  kind: string;
  status: "queued" | "running" | "done" | "failed";
  progress: number;
  download_url?: string;
  error?: string;
  /** Import jobs: { imported, rejected, errors: [{row, message}], dropped_columns } */
  result?: { imported?: number; rejected?: number; errors?: { row: number; message: string }[]; dropped_columns?: string[] };
}
export interface FeatureCollection {
  type: "FeatureCollection";
  features: { type: "Feature"; id: string; geometry: Geometry; properties: Props }[];
}

// ---- standalone mapping workspaces (independent of projects and forms) ----
/** Imagery added by URL, e.g. https://host/{z}/{x}/{y}.png */
export interface TileSource { id: string; name: string; type: "xyz"; url: string; maxzoom?: number; attribution?: string }
export interface WorkMap {
  id: string;
  name: string;
  description: string;
  sources: TileSource[];
  feature_count: number;
  updated_at: string;
}
/** A feature drawn in a map. `properties` are free-form tags (like OpenStreetMap), no form needed. */
export interface GeoFeature { id: string; geometry: Geometry; properties: Props; version: number }
export interface MapLayers {
  /** Uploaded imagery that is ready, with signed tile URLs. */
  imagery: { id: string; name: string; bounds?: [number, number, number, number]; url: string }[];
}
export interface MapImportResult { imported: number; rejected: number; errors: { row: number; message: string }[] }
