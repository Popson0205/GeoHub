const env = import.meta.env;

// VITE_API_URL may be a path such as "/api" (API served from the same origin); make it absolute so MapLibre
// can use it inside tile URLs.
const rawApi = String(env.VITE_API_URL ?? "http://localhost:8000").replace(/\/$/, "");
const apiUrl = rawApi.startsWith("/") ? window.location.origin + rawApi : rawApi;

export const config = {
  useMock: String(env.VITE_USE_MOCK ?? "true") !== "false",
  apiUrl,
  basemapUrl: String(env.VITE_BASEMAP_URL ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png"),
};
