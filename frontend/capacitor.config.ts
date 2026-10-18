import type { CapacitorConfig } from "@capacitor/cli";

// Wraps the same web build as an Android app (the mobile collector).
// First time: npm run build && npx cap add android && npm run cap:sync
const config: CapacitorConfig = {
  appId: "com.geohub.collector",
  appName: "Geohub Collector",
  webDir: "dist",
  server: { androidScheme: "https" },
};

export default config;
