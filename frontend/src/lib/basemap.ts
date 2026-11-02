/** Free OpenStreetMap tiles: no key, and the fallback whenever a provider needs one that was not given. */
export const OSM_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

/**
 * CARTO's basemaps now need an API key: without one every tile carries an "API KEY REQUIRED" stamp.
 * A CARTO address with no query string has no key, so it is replaced by OpenStreetMap rather than shown stamped.
 */
export function usableTiles(url: string | undefined, fallback = OSM_TILES): string {
  const u = (url ?? "").trim();
  if (!u) return fallback;
  if (/cartocdn\.com|carto\.com/i.test(u) && !u.includes("?")) return fallback;
  return u;
}

/** The credit each provider's terms ask for, worked out from the tile address. */
export function basemapCredit(url: string): string {
  const u = url.toLowerCase();
  if (u.includes("maptiler")) return "© MapTiler © OpenStreetMap contributors";
  if (u.includes("carto")) return "© OpenStreetMap contributors © CARTO";
  if (u.includes("stadiamaps")) return "© Stadia Maps © OpenMapTiles © OpenStreetMap contributors";
  if (u.includes("arcgis") || u.includes("esri")) return "Esri, HERE, Garmin, © OpenStreetMap contributors";
  if (u.includes("mapbox")) return "© Mapbox © OpenStreetMap contributors";
  return "© OpenStreetMap contributors";
}
/** The same credit, short enough for a card thumbnail. */
export const shortCredit = (url: string) => basemapCredit(url).replace(" contributors", "").replace(/^Esri, HERE, Garmin, /, "Esri ");

/** The light map is the street map itself (no light style configured): show it softened so shapes stand out. */
export const isPlainOsm = (url: string) => /(^|\/\/)(\w\.)?tile\.openstreetmap\.org\//.test(url);
