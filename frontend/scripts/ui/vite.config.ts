// Runs the page tests in jsdom. The real map needs WebGL, so a stand-in map replaces it and the tests drive the page the way the map would.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
export default defineConfig({
  plugins: [react()],
  resolve: { alias: [{ find: /^.*\/components\/MapView$/, replacement: path.resolve(__dirname, "FakeMapView.tsx") }] },
});
