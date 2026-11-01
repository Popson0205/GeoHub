import type { Feature, Geometry } from "./types";

const esc = (s: unknown) => String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
const coords = (pts: number[][]) => pts.map((p) => `${p[0]},${p[1]}`).join(" ");
function geom(g: Geometry): string {
  if (g.type === "Point") return `<Point><coordinates>${coords([g.coordinates as number[]])}</coordinates></Point>`;
  if (g.type === "LineString") return `<LineString><coordinates>${coords(g.coordinates as number[][])}</coordinates></LineString>`;
  const [outer, ...holes] = g.coordinates as number[][][];
  return `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords(outer)}</coordinates></LinearRing></outerBoundaryIs>${holes.map((h) => `<innerBoundaryIs><LinearRing><coordinates>${coords(h)}</coordinates></LinearRing></innerBoundaryIs>`).join("")}</Polygon>`;
}

/** Records as KML (Google Earth): one placemark each, named by `nameField`, with every answer as extended data. */
export function toKml(title: string, records: Feature[], nameField?: string): string {
  const marks = records.map((r) => {
    const data = Object.entries({ ...r.properties, status: r.status })
      .map(([k, v]) => `<Data name="${esc(k)}"><value>${esc(Array.isArray(v) ? v.join("; ") : typeof v === "object" && v ? JSON.stringify(v) : v)}</value></Data>`).join("");
    return `<Placemark><name>${esc((nameField && r.properties[nameField]) || r.id)}</name><ExtendedData>${data}</ExtendedData>${geom(r.geometry)}</Placemark>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(title)}</name>\n${marks}\n</Document></kml>\n`;
}
