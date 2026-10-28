import type { Dataset, Form, GeoFeature, MapRole, Project, ReviewStatus, WorkMap } from "../lib/types";

export const DEMO_USER = { id: "u1", email: "demo@geohub.test", name: "Demo Collector" };
export const CENTER: [number, number] = [4.5418, 7.7827]; // Osogbo

export const seedProjects: Project[] = [
  { id: "p1", name: "Osogbo health facilities survey", description: "Sample project", role: "owner", feature_count: 0, collector_count: 3, updated_at: new Date().toISOString() },
  { id: "p2", name: "Ido-Osun ward boundaries", description: "Sample project", role: "owner", feature_count: 0, collector_count: 1, updated_at: new Date().toISOString() },
];

export const seedForms: Form[] = [
  {
    id: "f1", project_id: "p1", name: "Health facility", geometry_type: "Point", version: 1, status: "published",
    fields: [
      { id: "name", label: "Name", type: "text", required: true },
      { id: "type", label: "Type", type: "choice", required: true, choices: ["Clinic", "Hospital", "Pharmacy"] },
      { id: "condition", label: "Condition", type: "choice", choices: ["Good", "Needs repair"] },
      { id: "beds", label: "Number of beds", type: "number", integer: true, min: 0 },
      { id: "has_power", label: "Has electricity", type: "boolean", appearance: "switch" },
      { id: "power_source", label: "Power source", type: "choice", choices: ["Grid", "Solar", "Generator"], visible: { field: "has_power", op: "eq", value: true }, required_if: { field: "has_power", op: "eq", value: true } },
      { id: "inspected", label: "Inspection date", type: "date", default: "$today" },
      { id: "photos", label: "Photos", type: "photo", max_items: 3 },
    ],
  },
  {
    id: "f2", project_id: "p1", name: "Building footprint", geometry_type: "Polygon", version: 1, status: "published",
    fields: [
      { id: "use", label: "Use", type: "choice", choices: ["Residential", "Commercial", "Public"] },
      { id: "levels", label: "Floors", type: "number" },
    ],
  },
];

export const seedDatasets: Dataset[] = [
  {
    slug: "health-facilities-osogbo", project_id: "p1", title: "Health facilities, Osogbo",
    description: "Sample dataset: clinics, hospitals and pharmacies with type and condition.",
    license: "ODbL", tags: ["health", "points"], kind: "vector", feature_count: 0, latest_version: 1,
    updated_at: new Date().toISOString(), formats: ["geojson", "csv", "gpkg", "shp"],
  },
];

const NAMES = ["Alpha Clinic", "Unity Hospital", "Green Cross Pharmacy", "Hope Clinic", "Grace Medical", "City Pharmacy", "Osun Care Centre", "Riverside Clinic", "Faith Pharmacy", "Central Hospital", "Mercy Clinic", "Palm Pharmacy"];
const TYPES = ["Clinic", "Hospital", "Pharmacy"];

export function seedFeatureRows() {
  const rows = NAMES.map((name, i) => {
    const a = (i * 2.399) % (Math.PI * 2);
    const r = 0.012 + (i % 5) * 0.006;
    return {
      id: `seed-f1-${i}`, project_id: "p1", form_id: "f1", form_version: 1,
      geometry: { type: "Point" as const, coordinates: [CENTER[0] + Math.cos(a) * r, CENTER[1] + Math.sin(a) * r] as [number, number] },
      properties: { name, type: TYPES[i % 3], condition: i % 4 === 0 ? "Needs repair" : "Good", beds: i % 3 === 1 ? 20 + i : undefined },
      status: "approved" as const, version: 1, updated_at: new Date().toISOString(), seq: i + 1,
    };
  });
  const sq = (x: number, y: number, s: number): [number, number][][] => [[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]];
  rows.push(
    {
      id: "seed-f2-0", project_id: "p1", form_id: "f2", form_version: 1,
      geometry: { type: "Polygon" as never, coordinates: sq(CENTER[0] + 0.004, CENTER[1] + 0.003, 0.0016) as never } as never,
      properties: { use: "Public", levels: 2 }, status: "approved", version: 1, updated_at: new Date().toISOString(), seq: 13,
    } as never,
    {
      id: "seed-f2-1", project_id: "p1", form_id: "f2", form_version: 1,
      geometry: { type: "Polygon" as never, coordinates: sq(CENTER[0] - 0.006, CENTER[1] - 0.002, 0.0012) as never } as never,
      properties: { use: "Residential", levels: 1 }, status: "approved", version: 1, updated_at: new Date().toISOString(), seq: 14,
    } as never,
  );
  return rows;
}


// ---- demo data for shared maps: a running campaign with a team, and a map you can join ----
type SeedMap = Omit<WorkMap, "role" | "member_count" | "campaign_status" | "feature_count"> & { owner_id: string };
type SeedFeat = GeoFeature & { map_id: string; created_by: string; author: string; status: ReviewStatus; review_note?: string; created_at: string; updated_at: string };
const PEOPLE = [
  { id: "u2", name: "Amina Bello", role: "contributor" as const, n: 9 },
  { id: "u3", name: "Chidi Okafor", role: "contributor" as const, n: 6 },
  { id: "u4", name: "Funmi Adeyemi", role: "reviewer" as const, n: 4 },
  { id: "u5", name: "Tunde Balogun", role: "contributor" as const, n: 3 },
];

export function seedSharedMaps(): { maps: SeedMap[]; members: { map_id: string; user_id: string; name: string; role: Exclude<MapRole, "owner">; joined_at: string }[]; features: SeedFeat[] } {
  const day = 864e5, now = Date.now();
  const mid = "00000000-0000-4000-8000-0000000000a1", other = "00000000-0000-4000-8000-0000000000a2";
  const maps: SeedMap[] = [
    {
      id: mid, name: "Osogbo building mapathon", description: "Trace every building in the Oke-Baale area from satellite imagery.", sources: [],
      updated_at: new Date(now - day / 4).toISOString(), owner_id: DEMO_USER.id, owner_name: DEMO_USER.name,
      is_campaign: true, goal: "Trace every building in Oke-Baale before the end of the month.", competition: true,
      starts_at: new Date(now - 8 * day).toISOString(), ends_at: new Date(now + 14 * day).toISOString(), join_code: "osogbo-mapathon",
    },
    {
      id: other, name: "Ibadan flood mapping", description: "Help mark flooded streets and drainage channels.", sources: [],
      updated_at: new Date(now - 2 * day).toISOString(), owner_id: "u9", owner_name: "Tolu Adeleke",
      is_campaign: true, goal: "Mark every flooded street after the October rains.", competition: true,
      starts_at: new Date(now - 3 * day).toISOString(), ends_at: new Date(now + 20 * day).toISOString(), join_code: "ibadan-flood",
    },
  ];
  const members = PEOPLE.map((p) => ({ map_id: mid, user_id: p.id, name: p.name, role: p.role, joined_at: new Date(now - 7 * day).toISOString() }));
  const features: SeedFeat[] = [];
  let seq = 0;
  const rnd = () => { seq += 1; const x = Math.sin(seq * 12.9898) * 43758.5453; return x - Math.floor(x); };
  const statuses: ReviewStatus[] = ["approved", "approved", "approved", "submitted", "submitted", "rejected"];
  for (const p of [...PEOPLE, { id: DEMO_USER.id, name: DEMO_USER.name, role: "owner" as const, n: 5 }]) {
    for (let i = 0; i < p.n; i++) {
      const cx = CENTER[0] + (rnd() - 0.5) * 0.02, cy = CENTER[1] + (rnd() - 0.5) * 0.02, w = 0.0004 + rnd() * 0.0004;
      const when = new Date(now - rnd() * 6 * day).toISOString();
      const reviewer = p.role === "reviewer" || p.role === "owner";
      const status: ReviewStatus = reviewer ? "approved" : statuses[Math.floor(rnd() * statuses.length)];
      features.push({
        id: `00000000-0000-4000-8000-${String(1000 + features.length).padStart(12, "0")}`, map_id: mid,
        geometry: { type: "Polygon", coordinates: [[[cx, cy], [cx + w, cy], [cx + w, cy + w], [cx, cy + w], [cx, cy]]] },
        properties: rnd() > 0.3 ? { building: "yes" } : { building: "house", levels: "1" }, version: 1, created_by: p.id, author: p.name, status,
        review_note: status === "rejected" ? "Outline does not match the roof. Please redraw." : undefined, created_at: when, updated_at: when,
      });
    }
  }
  return { maps, members, features };
}
