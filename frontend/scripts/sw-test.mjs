// Runs the built service worker (dist/sw.js) against a fake cache and fake server across three deploys.
// Run `npm run build` first.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../dist/sw.js", import.meta.url), "utf8");
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const ORIGIN = "https://app.test";
const path = (r) => new URL(typeof r === "string" ? r : r.url, ORIGIN).pathname;
// A service worker resolves relative addresses against its own origin; Node's Request does not.
class SwRequest extends Request { constructor(u, init) { super(typeof u === "string" ? new URL(u, ORIGIN).href : u, init); } }

const store = new Map();   // cache name -> Map(path -> Response)
const fakeCaches = {
  async open(n) {
    if (!store.has(n)) store.set(n, new Map());
    const m = store.get(n);
    return { put: async (r, res) => void m.set(path(r), res), add: async (r) => void m.set(path(r), await server.fetch(r)),
             match: async (r) => m.get(path(r))?.clone(), keys: async () => [...m.keys()], delete: async (r) => m.delete(path(r)) };
  },
  async keys() { return [...store.keys()]; },
  async delete(n) { return store.delete(n); },
  async match(r) { for (const m of store.values()) if (m.has(path(r))) return m.get(path(r)).clone(); },
};
const server = { online: true, tag: "", async fetch(r) { if (!this.online) throw new Error("offline"); return new Response(`${this.tag}:${path(r)}`); } };

function load(build, files) {
  const handlers = {}; const state = { skipped: false };
  const self = { location: { origin: ORIGIN }, addEventListener: (t, h) => (handlers[t] = h), skipWaiting: async () => { state.skipped = true; }, clients: { claim: async () => {} } };
  const code = src.replace(/const BUILD = "[^"]*"/, `const BUILD = "${build}"`).replace(/const PRECACHE = \[.*?\];/, `const PRECACHE = ${JSON.stringify(files)};`);
  vm.runInNewContext(code, { self, caches: fakeCaches, fetch: (r) => server.fetch(r), Request: SwRequest, Response, URL, AbortController, setTimeout, clearTimeout, console });
  const fire = (type, extra = {}) => { let p; handlers[type]({ ...extra, waitUntil: (x) => (p = x), respondWith: (x) => (p = x) }); return p; };
  return {
    state, install: () => fire("install"), activate: () => fire("activate"),
    get: (url) => fire("fetch", { request: new SwRequest(url) }),
    open: (url) => fire("fetch", { request: new Proxy(new SwRequest(url), { get: (t, k) => (k === "mode" ? "navigate" : typeof t[k] === "function" ? t[k].bind(t) : t[k]) }) }),
  };
}
async function deploy(build, tag, files) { server.tag = tag; const sw = load(build, files); await sw.install(); await sw.activate(); return sw; }

(async () => {
  const v1 = await deploy("aaa", "v1", ["/", "/assets/a1.js"]);
  ok(v1.state.skipped, "a new version takes over without waiting");
  await deploy("bbb", "v2", ["/", "/assets/b2.js"]);
  ok(store.has("geohub-shell-aaa") && store.has("geohub-shell-bbb"), "the previous version is kept for a page still open on it");
  const v3 = await deploy("ccc", "v3", ["/", "/assets/c3.js"]);
  ok(!store.has("geohub-shell-aaa") && store.has("geohub-shell-bbb") && store.has("geohub-shell-ccc"), "versions older than the previous one are cleaned up");

  server.online = false;   // in the field, no signal
  ok(await (await v3.open("/collect")).text() === "v3:/index.html", "opening the app offline shows the newest version");
  ok(await (await v3.get("/assets/b2.js")).text() === "v2:/assets/b2.js", "a page still open on the previous version still finds its files");
  ok(await (await v3.get("/assets/c3.js")).text() === "v3:/assets/c3.js", "new files come from the new version");
  ok(v3.get("/api/projects") === undefined, "API requests are never intercepted");
})();
