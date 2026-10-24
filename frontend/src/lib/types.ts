// Domain types. They mirror the API contract ("Mapping Hub: Backend API Contract and Data Model").

export type Position = [number, number]; // [longitude, latitude], EPSG:4326
export type Geometry =
  | { type: "Point"; coordinates: Position }
  | { type: "LineString"; coordinates: Position[] }
  | { type: "Polygon"; coordinates: Position[][] };
export type GeometryType = Geometry["type"];

export const GEOMETRY_LABEL: Record<GeometryType, string> = { Point: "point", LineString: "line", Polygon: "polygon" };

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

// ---- form fields ----
// A form is a tree of fields. Three layers, kept apart on purpose:
//   type        what the element is (decides what is stored and how it is validated)
//   appearance  how it is drawn (decides which component renders it)
//   rules       when it applies and what it must satisfy (visible, required_if, min, max, pattern ...)
// Rules are flat properties on the field, so forms published before this model existed stay valid unchanged.
// The registry in lib/fieldSpec.ts says which properties apply to which type.
export type InputType = "text" | "number" | "date" | "time" | "datetime" | "choice" | "multi_choice" | "boolean" | "ranking" | "barcode";
export type MediaType = "photo" | "audio" | "video" | "file" | "signature";
export type FieldType = InputType | MediaType | "note" | "calculation" | "group" | "repeat";

/** Declarative on purpose: no scripts, no eval. The server re-runs the same rules. */
export type Condition =
  | { field: string; op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; value: string | number | boolean }
  | { field: string; op: "in" | "not_in" | "contains"; value: (string | number)[] | string | number }
  | { field: string; op: "filled" | "empty" }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };
export type Operand = { field: string } | { const: string | number };
/** A closed set of operations, not a formula string. */
export type Calc =
  | { fn: "concat"; args: Operand[]; sep?: string }
  | { fn: "sum" | "product" | "min" | "max" | "avg"; args: Operand[] }
  | { fn: "diff" | "ratio"; args: [Operand, Operand] }
  | { fn: "count_selected"; args: [Operand] }
  | { fn: "today" | "now" };

export interface FormField {
  id: string;
  label: string;
  type: FieldType;
  appearance?: string;
  hint?: string;
  placeholder?: string;
  // rules
  required?: boolean;
  required_if?: Condition;
  visible?: Condition;
  readonly?: boolean;
  default?: string | number | boolean | string[];
  min?: number | string;
  max?: number | string;
  min_length?: number;
  max_length?: number;
  min_items?: number;
  max_items?: number;
  pattern?: string;
  pattern_message?: string;
  // per type
  choices?: string[];
  integer?: boolean;          // number
  decimals?: number;          // number
  unit?: string;              // number
  must_be_true?: boolean;     // boolean; with required = an acknowledgement
  true_label?: string;
  false_label?: string;
  text?: string;              // note
  calc?: Calc;                // calculation
  store?: boolean;            // calculation: false = shown but not saved
  children?: FormField[];     // group, repeat
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
  visibility?: "public" | "private";
  /** Set when the dataset was published from a map (only visible to that map's members). */
  map_id?: string;
  /** People credited for the latest version of a dataset published from a map. */
  contributors?: { name: string; features: number }[];
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
/** What you can do on a map. Owners run it, reviewers approve work, contributors draw. */
export type MapRole = "owner" | "reviewer" | "contributor";
export type ReviewStatus = "submitted" | "approved" | "rejected";
export type CampaignStatus = "upcoming" | "open" | "ended";
export interface WorkMap {
  id: string;
  name: string;
  description: string;
  sources: TileSource[];
  feature_count: number;
  updated_at: string;
  role: MapRole;
  owner_name: string;
  member_count: number;
  /** Mapping campaign settings. Ignored unless `is_campaign`. */
  is_campaign: boolean;
  goal: string;
  starts_at?: string;
  ends_at?: string;
  /** Show a leaderboard to members. */
  competition: boolean;
  campaign_status?: CampaignStatus;
  /** Only the owner sees the code. Missing means joining by link is closed. */
  join_code?: string;
}
export interface MapSettings {
  name?: string; description?: string; sources?: TileSource[];
  is_campaign?: boolean; goal?: string; starts_at?: string | null; ends_at?: string | null; competition?: boolean; join_open?: boolean;
}
/** A feature drawn in a map. `properties` are free-form tags (like OpenStreetMap), no form needed. */
export interface GeoFeature {
  id: string; geometry: Geometry; properties: Props; version: number;
  /** Review state and who drew it (shared maps). */
  status?: ReviewStatus; created_by?: string; author?: string; review_note?: string; updated_at?: string; created_at?: string;
}
export interface MapMember { user_id: string; name: string; email?: string; role: MapRole; joined_at?: string }
export interface JoinPreview {
  name: string; description: string; goal: string; owner_name: string; member_count: number; competition: boolean;
  starts_at?: string; ends_at?: string; campaign_status?: CampaignStatus; already_member: boolean;
}
export interface Contributor {
  user_id: string; name: string; role: MapRole | "former"; rank: number;
  added: number; approved: number; pending: number; rejected: number; edited: number; first_at?: string; last_at?: string;
}
export interface ContributorsReport {
  contributors: Contributor[];
  totals: { contributors: number; added: number; approved: number; pending: number; rejected: number };
  daily: { day: string; count: number }[];
  starts_at?: string; ends_at?: string;
}
export interface Activity { feature_id: string; user_id?: string; name?: string; action: "added" | "edited"; at: string; geometry_type: "point" | "line" | "area"; status: ReviewStatus }
export interface PublishInput {
  title: string; slug: string; description: string; license: License; visibility: "public" | "private";
  geometry_type: "point" | "line" | "area"; tags: string[]; credit_contributors: boolean;
}
export interface MapLayers {
  /** Uploaded imagery that is ready, with signed tile URLs. */
  imagery: { id: string; name: string; bounds?: [number, number, number, number]; url: string }[];
}
export interface MapImportResult { imported: number; rejected: number; errors: { row: number; message: string }[] }


// ---- sharing a form by link, and who may collect with it ----
/** collaborators = only people added to the project (they sign in). public = anyone with the link, no sign-in. */
export type ShareMode = "collaborators" | "public";
export interface Sharing { share_mode: ShareMode; share_token: string; published: boolean }
export interface ProjectMember { id: string; user_id?: string; email: string; name?: string; role: Role; status: "active" | "invited" }
/** The form behind a share link. `access` is "member" when the person is a collaborator and should use the collector. */
export interface PublicForm { token: string; form: Form; project_name: string; access: "public" | "member" }


// ---- dashboards ----
// A saved layout of charts over one form's records. The numbers are never stored; they are computed when it opens.
export type WidgetType = "kpi" | "bar" | "pie" | "line" | "table" | "map";
export type Metric = "count" | "sum" | "avg" | "min" | "max";
export type Bucket = "day" | "week" | "month";
export interface Widget {
  id: string;
  type: WidgetType;
  title: string;
  wide?: boolean;            // true = always a full row. Otherwise the layout engine sizes it from its type
  form_id?: string;          // records from this form instead of the page's form (for joint overview pages)
  metric: Metric;
  metric_field?: string;     // the number field a sum / average / min / max is taken from
  field?: string;            // bar, pie: what to group by. line: the date to plot ("__updated" = when the record changed)
  bucket: Bucket;            // line: group by day, week or month
  limit: number;             // bar, pie: how many groups. table: how many rows
  columns: string[];         // table: field ids
}
/** One page of a dashboard, for example "Army". Its records come from one form unless a chart picks another. */
export interface DashPage { id: string; title: string; form_id?: string; widgets: Widget[] }
export interface DashboardConfig { description?: string; pages: DashPage[] }
export interface Dashboard { id: string; project_id: string; name: string; config: DashboardConfig; updated_at: string }
