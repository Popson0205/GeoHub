import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pwa from "./scripts/pwa-plugin.mjs";

export default defineConfig({
  plugins: [react(), pwa()],
  server: { port: 5173 },
  build: { chunkSizeWarningLimit: 1200 },
});
