/** One reading from the device's GPS. `speed` is metres per second when the device reports it. */
export interface Fix { lon: number; lat: number; acc: number; alt: number | null; altAcc: number | null; speed?: number | null }

/** Averaging stops on its own once the reading is this good (phones manage 3 to 5 m in open sky)… */
export const TARGET_M = 5;
/** …and readings worse than this are shown as poor, with tips. Matches the reviewer's "poor GPS" flag at 30 m loosely. */
export const POOR_M = 15;
export type GpsQuality = "good" | "fair" | "poor";
export const quality = (m: number): GpsQuality => (m <= TARGET_M ? "good" : m <= POOR_M ? "fair" : "poor");

const R = 6371000, RAD = Math.PI / 180;
/** Metres between two readings (equirectangular: exact enough over the few metres that matter here). */
export function metresBetween(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const x = (b.lon - a.lon) * RAD * Math.cos(((a.lat + b.lat) / 2) * RAD), y = (b.lat - a.lat) * RAD;
  return Math.hypot(x, y) * R;
}
const median = (xs: number[]) => { const v = [...xs].sort((p, q) => p - q), m = v.length >> 1; return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2; };

/**
 * Readings that jump far from the rest (a reflection off a building, a brief switch to Wi-Fi positioning)
 * are dropped. "Far" is judged against how tightly the other readings agree, so a steady receiver rejects
 * small jumps and a noisy one is not left with nothing.
 */
export function dropOutliers(fixes: Fix[]): Fix[] {
  if (fixes.length < 4) return fixes;
  const c = { lon: median(fixes.map((f) => f.lon)), lat: median(fixes.map((f) => f.lat)) };
  const d = fixes.map((f) => metresBetween(c, f));
  const limit = Math.max(3, 3 * median(d), Math.min(...fixes.map((f) => f.acc)));
  const kept = fixes.filter((_, i) => d[i]! <= limit);
  return kept.length >= 2 ? kept : fixes;
}

/** Values the collector records beside the form's own answers. The server accepts exactly these extra keys. */
export const GPS_KEYS = ["gps_elev_m", "gps_hacc_m", "gps_vacc_m", "gps_src"] as const;

export const withoutGps = (p: Record<string, unknown>) => {
  const out = { ...p };
  for (const k of GPS_KEYS) delete out[k];
  return out;
};

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const weight = (accuracy: number) => 1 / Math.max(accuracy, 0.5) ** 2;

/**
 * Combine several readings into one position. Readings much worse than the best one, and readings that jump away
 * from the rest, are dropped; the others are averaged, weighted by how accurate each claims to be.
 * The accuracy reported is honest: the best single reading's own figure, or how widely the kept readings scatter
 * if that is worse. Averaging smooths jitter but never makes the result look better than the device can do.
 */
export function combineFixes(fixes: Fix[]) {
  const best = Math.min(...fixes.map((f) => f.acc));
  const use = dropOutliers(fixes.filter((f) => f.acc <= best * 2 + 1));
  let sw = 0, lon = 0, lat = 0;
  for (const f of use) { const w = weight(f.acc); sw += w; lon += f.lon * w; lat += f.lat * w; }
  const centre = { lon: lon / sw, lat: lat / sw };
  // how far the kept readings scatter around the result (root mean square), as a check on the device's own figure
  const spread = use.length > 1 ? Math.sqrt(use.reduce((t, f) => t + metresBetween(centre, f) ** 2, 0) / use.length) : 0;
  const withAlt = use.filter((f) => f.alt != null && Number.isFinite(f.alt));
  let elev: number | null = null, vacc: number | null = null;
  if (withAlt.length) {
    let ew = 0, e = 0;
    for (const f of withAlt) { const w = weight(f.altAcc ?? f.acc * 2); ew += w; e += (f.alt as number) * w; }
    elev = e / ew;
    const accs = withAlt.map((f) => f.altAcc).filter((a): a is number => a != null && Number.isFinite(a));
    vacc = accs.length ? Math.min(...accs) : null;
  }
  return { lon: centre.lon, lat: centre.lat, hacc: Math.max(Math.min(...use.map((f) => f.acc)), spread), elev, vacc, used: use.length, dropped: fixes.length - use.length };
}

/**
 * The person is walking, not standing at the spot: the device says it is moving, or the two newest readings agree
 * with each other on a place well away from where the earlier ones put it. A single reading that jumps is not
 * walking (it is dropped as an outlier instead). Averaging then starts again, since mixing two places gives neither.
 */
export function isMoving(fixes: Fix[]): boolean {
  if (fixes.length < 2) return false;
  const last = fixes[fixes.length - 1]!;
  if (last.speed != null && Number.isFinite(last.speed) && last.speed > 1.2) return true;
  if (fixes.length < 4) return false;
  const prev = fixes[fixes.length - 2]!;
  const before = combineFixes(fixes.slice(0, -2));
  const far = (f: Fix) => metresBetween(before, f) > Math.max(10, 3 * before.hacc, 2 * f.acc);
  return far(last) && far(prev) && metresBetween(prev, last) <= Math.max(10, 2 * Math.max(prev.acc, last.acc));
}

/**
 * The box the map should zoom to for a position: about 1.5 times the reading's accuracy around it, never tighter than
 * 30 m (so a very good reading still shows some surroundings) and never wider than 2 km (so a poor one still zooms in).
 * Returned as [west, south, east, north] in degrees.
 */
export function viewAround(lon: number, lat: number, accuracyM: number): [number, number, number, number] {
  const metres = Math.max(30, Math.min(Number.isFinite(accuracyM) ? accuracyM * 1.5 : 100, 2000));
  const dLat = metres / 111320;
  const dLon = metres / (111320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

/** The extra values saved with a record collected by GPS. */
export function gpsProps(c: ReturnType<typeof combineFixes>): Record<string, number | string> {
  const out: Record<string, number | string> = { gps_hacc_m: round(c.hacc), gps_src: "gps" };
  if (c.elev != null) out.gps_elev_m = round(c.elev);
  if (c.vacc != null) out.gps_vacc_m = round(c.vacc);
  return out;
}
