import { usableTiles } from "./basemap";

const env = import.meta.env;

// An empty setting (a Docker build argument left blank) counts as not set, so the free defaults apply.
// VITE_API_URL may be a path such as "/api" (API served from the same origin); make it absolute so MapLibre
// can use it inside tile URLs.
const rawApi = String(env.VITE_API_URL ?? "http://localhost:8000").replace(/\/$/, "");
const apiUrl = rawApi.startsWith("/") ? window.location.origin + rawApi : rawApi;

export const config = {
  useMock: String(env.VITE_USE_MOCK ?? "true") !== "false",
  apiUrl,
  /** Where "Request an organization" emails go (sales). Empty hides the link. */
  contactEmail: String(env.VITE_CONTACT_EMAIL || ""),
  // Both default to free OpenStreetMap tiles. CARTO without a key is swapped for OpenStreetMap (see basemap.ts).
  basemapUrl: usableTiles(env.VITE_BASEMAP_URL),
  basemapLightUrl: usableTiles(env.VITE_BASEMAP_LIGHT_URL),
};
