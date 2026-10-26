/* Geohub service worker: makes the app open and work with no connection.
 *  - the app shell (every built file) is cached at install, so it opens offline
 *  - /api is never cached: data lives in the app's own offline database and syncs separately
 *  - map tiles you have looked at are kept, so the area you work in still shows offline
 * The build step (scripts/pwa-plugin.mjs) fills in the file list and build id below. */
const BUILD = "__BUILD__";
const PRECACHE = /*__PRECACHE__*/[];
const SHELL = "geohub-shell-" + BUILD;
const TILES = "geohub-tiles-v1";
const MAX_TILES = 3000;
const TILE_RE = /\/\d{1,2}\/\d+\/\d+(@2x)?\.(png|jpe?g|webp|pbf|mvt)(\?.*)?$/i;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // "reload" skips the browser's HTTP cache so a new build never stores old files
    await cache.addAll(PRECACHE.map((u) => new Request(u, { cache: "reload" })));
    await cache.put("/index.html", await fetch("/index.html", { cache: "reload" }));
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("geohub-shell-") && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

// The page asks for the update to take over only when the person agrees, so a form is never reloaded mid-entry.
self.addEventListener("message", (e) => { if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting(); });

async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_TILES) await Promise.all(keys.slice(0, keys.length - MAX_TILES).map((k) => cache.delete(k)));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin && (url.pathname === "/api" || url.pathname.startsWith("/api/"))) return; // data: always the network

  // Map tiles: cached copy first, otherwise fetch and keep (only readable responses, never opaque ones)
  if (TILE_RE.test(url.pathname) && !(sameOrigin && url.pathname.startsWith("/api/"))) {
    event.respondWith((async () => {
      const cache = await caches.open(TILES);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok && res.type !== "opaque") { cache.put(req, res.clone()).then(() => trimTiles(cache)); }
        return res;
      } catch { return Response.error(); }
    })());
    return;
  }

  if (!sameOrigin) return;

  // Opening a page: the network when it answers quickly (so updates arrive), the saved app shell when it does not
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 4000);
        const res = await fetch(req, { signal: ctl.signal });
        clearTimeout(timer);
        if (res.ok) return res;
      } catch { /* offline or too slow */ }
      return (await caches.match("/index.html")) || Response.error();
    })());
    return;
  }

  // Built files, fonts, icons: the saved copy first; anything not yet saved is fetched and kept
  event.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === "basic") (await caches.open(SHELL)).put(req, res.clone());
    return res;
  })());
});
