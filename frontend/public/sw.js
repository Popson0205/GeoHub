/* Geohub service worker: makes the app open and work with no connection.
 *  - the app shell (every built file) is cached at install, so it opens offline
 *  - /api is never cached: data lives in the app's own offline database and syncs separately
 *  - map tiles you have looked at are kept, so the area you work in still shows offline
 * The build step (scripts/pwa-plugin.mjs) fills in the file list and build id below. */
const BUILD = "__BUILD__";
const PRECACHE = /*__PRECACHE__*/[];
const DEV = BUILD === "__BUILD__"; // not built by `vite build`: act as a pass-through so the dev server is never cached
const SHELL = "geohub-shell-" + BUILD;
const META = "geohub-meta";
const TILES = "geohub-tiles-v1";
const MAX_TILES = 3000;
const TILE_RE = /\/\d{1,2}\/\d+\/\d+(@2x)?\.(png|jpe?g|webp|pbf|mvt)(\?.*)?$/i;

self.addEventListener("install", (event) => {
  if (DEV) { self.skipWaiting(); return; }
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // The page itself must be saved; every other file is saved on a best-effort basis, so one slow or missing file
    // never stops the app from installing. "reload" skips the browser's HTTP cache so a new build never stores old files.
    await cache.put("/index.html", await fetch("/index.html", { cache: "reload" }));
    await Promise.allSettled(PRECACHE.map((u) => cache.add(new Request(u, { cache: "reload" }))));
    // Take over straight away: nobody has to clear their data or close the app to get a new version.
    // Collected records live in the app's own database, which an update never touches.
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // Keep the version just before this one for a while: a page still open on it may need one of its files.
    const meta = await caches.open(META);
    const saved = await meta.match("/version");
    const info = saved ? await saved.json() : {};
    const prev = info.current && info.current !== BUILD ? info.current : info.prev;
    await meta.put("/version", new Response(JSON.stringify({ current: BUILD, prev: prev || null })));
    const keep = new Set([SHELL, prev ? "geohub-shell-" + prev : ""]);
    for (const k of await caches.keys()) if (k.startsWith("geohub-shell-") && !keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

// The page asks for the update to take over only when the person agrees, so a form is never reloaded mid-entry.
self.addEventListener("message", (e) => { if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting(); });

async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_TILES) await Promise.all(keys.slice(0, keys.length - MAX_TILES).map((k) => cache.delete(k)));
}

// This version's own copy first (so a new page never gets an old file), then any older version still kept.
async function fromShell(req) {
  return (await (await caches.open(SHELL)).match(req)) || (await caches.match(req));
}

self.addEventListener("fetch", (event) => {
  if (DEV) return;
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
        const res = await fetch(req, { signal: ctl.signal, cache: "no-cache" });
        clearTimeout(timer);
        if (res.ok) return res;
      } catch { /* offline or too slow */ }
      return (await fromShell("/index.html")) || Response.error();
    })());
    return;
  }

  // Built files, fonts, icons: the saved copy first; anything not yet saved is fetched and kept
  event.respondWith((async () => {
    const hit = await fromShell(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && res.type === "basic") (await caches.open(SHELL)).put(req, res.clone());
    return res;
  })());
});
