const env = import.meta.env;

export const config = {
  useMock: String(env.VITE_USE_MOCK ?? "true") !== "false",
  apiUrl: String(env.VITE_API_URL ?? "http://localhost:8000").replace(/\/$/, ""),
  basemapUrl: String(env.VITE_BASEMAP_URL ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png"),
};
