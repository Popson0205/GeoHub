import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pwa from "./scripts/pwa-plugin.mjs";

export default defineConfig({
  plugins: [react(), pwa()],
  server: { port: 5173 },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Big libraries get their own files. They change less often than the app, so after an update a
        // returning user (or the offline cache) downloads only the app code that changed.
        manualChunks(id) {
          if (!id.includes("node_modules") || id.endsWith(".css")) return undefined;   // stylesheets stay with the page that imports them
          if (id.includes("maplibre-gl")) return "maplibre";
          if (id.includes("@turf") || id.includes("polyclip") || id.includes("polygon-clipping")) return "geometry";
          if (id.includes("dexie")) return "storage";
          if (/[\\/](react|react-dom|react-router|react-router-dom|scheduler|@remix-run)[\\/]/.test(id)) return "react";
          return undefined;
        },
      },
    },
  },
});
