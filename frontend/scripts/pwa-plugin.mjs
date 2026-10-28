// Build step for the PWA: after Vite has written dist/, list every file the app needs offline and bake that list
// (plus a build id) into dist/sw.js. No extra dependency; the service worker source is public/sw.js.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export default function pwa() {
  let outDir = "dist";
  return {
    name: "geohub-pwa",
    apply: "build",
    enforce: "post",
    configResolved(c) { outDir = resolve(c.root, c.build.outDir); },
    closeBundle() {
      const swPath = join(outDir, "sw.js");
      const files = walk(outDir)
        .map((f) => "/" + relative(outDir, f).split("\\").join("/"))
        .filter((u) => u !== "/sw.js" && !u.endsWith(".map") && !u.endsWith(".woff") && u !== "/_redirects")
        .sort();
      const hash = createHash("sha1");
      for (const u of files) { hash.update(u); hash.update(readFileSync(join(outDir, u))); }
      const build = hash.digest("hex").slice(0, 12);
      const list = ["/", ...files.filter((u) => u !== "/index.html")];
      const sw = readFileSync(swPath, "utf8")
        .replace("/*__PRECACHE__*/[]", JSON.stringify(list))
        .replace("__BUILD__", build);
      writeFileSync(swPath, sw);
      console.log(`[pwa] service worker ${build}: ${list.length} files precached`);
    },
  };
}
