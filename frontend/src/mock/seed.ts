import type { Dataset, Form, Project } from "../lib/types";

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
      { id: "beds", label: "Number of beds", type: "number" },
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
