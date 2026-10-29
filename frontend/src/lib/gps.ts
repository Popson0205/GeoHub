/** One reading from the device's GPS. */
export interface Fix { lon: number; lat: number; acc: number; alt: number | null; altAcc: number | null }

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
 * Combine several readings into one position. Readings much worse than the best one are dropped and the rest are
 * averaged, weighted by how accurate each claims to be. The accuracy reported is the best single reading's own figure:
 * averaging smooths jitter but does not make the device more accurate than it says, so the figure is not improved.
 */
export function combineFixes(fixes: Fix[]) {
  const best = Math.min(...fixes.map((f) => f.acc));
  const use = fixes.filter((f) => f.acc <= best * 2 + 1);
  let sw = 0, lon = 0, lat = 0;
  for (const f of use) { const w = weight(f.acc); sw += w; lon += f.lon * w; lat += f.lat * w; }
  const withAlt = use.filter((f) => f.alt != null && Number.isFinite(f.alt));
  let elev: number | null = null, vacc: number | null = null;
  if (withAlt.length) {
    let ew = 0, e = 0;
    for (const f of withAlt) { const w = weight(f.altAcc ?? f.acc * 2); ew += w; e += (f.alt as number) * w; }
    elev = e / ew;
    const accs = withAlt.map((f) => f.altAcc).filter((a): a is number => a != null && Number.isFinite(a));
    vacc = accs.length ? Math.min(...accs) : null;
  }
  return { lon: lon / sw, lat: lat / sw, hacc: best, elev, vacc, used: use.length };
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
