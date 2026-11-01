import { ApiError, tokens } from "./api";
import { config } from "./config";

/**
 * Errors from this browser, sent to the Geohub server (which logs them and passes them to Sentry when the
 * server has a SENTRY_DSN). Nothing is sent in demo mode. Each report gets a short reference the person can
 * quote to support, and the same error is sent once per visit, at most ten in all, so a loop cannot flood anything.
 */
export type ErrorKind = "render" | "error" | "unhandledrejection" | "chunk";
export interface ErrorReport {
  ref: string; kind: ErrorKind; name: string; message: string; stack?: string; component_stack?: string;
  url: string; release?: string; user_agent?: string; offline: boolean;
}

const MAX_PER_VISIT = 10;
const PENDING_KEY = "geohub.errors.pending";
const sent = new Set<string>();
let count = 0;
/** The last few reports, for "Copy details" and for tests. */
export const recent: ErrorReport[] = [];

/** Short and unambiguous: no 0/O or 1/I. */
export function makeRef(): string {
  const abc = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const n = new Uint8Array(5);
  crypto.getRandomValues(n);
  return `GH-${[...n].map((b) => abc[b % abc.length]).join("")}`;
}

/** The page address without its query and with share tokens and invite codes taken out. */
export function safeUrl(href = location.href): string {
  const u = new URL(href);
  const path = u.pathname.replace(/^\/(f|d|join)\/[^/]+/, "/$1/:token");
  return u.origin + path;
}

/** A newer build replaced the page's code files: reloading fixes it, so this is not reported as a bug. */
export function isChunkError(e: unknown): boolean {
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk \d+ failed/i.test(m);
}

/** Things that are not bugs in Geohub: browser extensions, benign browser warnings, requests the person cancelled. */
function ignorable(e: unknown): boolean {
  if (e instanceof ApiError && e.status < 500) return true;          // shown to the person where it happened
  const err = e instanceof Error ? e : null;
  const text = err ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(e);
  return /ResizeObserver loop|AbortError|The user aborted|(chrome|moz|safari(-web)?)-extension:\/\//.test(text) || text === "undefined" || text === "null";
}

function toReport(e: unknown, kind: ErrorKind, componentStack?: string): ErrorReport {
  const err = e instanceof Error ? e : new Error(typeof e === "string" ? e : (() => { try { return JSON.stringify(e); } catch { return String(e); } })());
  return {
    ref: makeRef(), kind, name: (err.name || "Error").slice(0, 120), message: (err.message || "(no message)").slice(0, 1000),
    stack: err.stack?.slice(0, 8000), component_stack: componentStack?.slice(0, 4000),
    url: safeUrl(), release: (import.meta.env.VITE_RELEASE as string | undefined) || undefined,
    user_agent: navigator.userAgent.slice(0, 400), offline: typeof navigator.onLine === "boolean" ? !navigator.onLine : false,
  };
}

async function send(r: ErrorReport): Promise<boolean> {
  try {
    const t = tokens.get();
    const res = await fetch(`${config.apiUrl}/client-errors`, {
      method: "POST", keepalive: true,
      headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) },
      body: JSON.stringify(r),
    });
    return res.ok || res.status === 422 || res.status === 429;   // a bad or throttled report is not worth retrying
  } catch { return false; }
}
function keepForLater(r: ErrorReport) {
  try {
    const l = JSON.parse(localStorage.getItem(PENDING_KEY) || "[]") as ErrorReport[];
    localStorage.setItem(PENDING_KEY, JSON.stringify([...l, r].slice(-5)));
  } catch { /* storage unavailable */ }
}
/** Send reports made while offline. Called at start-up and when the connection comes back. */
export async function flushPending() {
  if (config.useMock) return;
  let l: ErrorReport[] = [];
  try { l = JSON.parse(localStorage.getItem(PENDING_KEY) || "[]"); localStorage.removeItem(PENDING_KEY); } catch { return; }
  for (const r of l) if (!(await send(r))) keepForLater(r);
}

/** Report an error; returns its reference, or null when it was not worth reporting (or already sent this visit). */
export function reportError(e: unknown, kind: ErrorKind = "error", componentStack?: string): string | null {
  if (ignorable(e)) return null;
  const r = toReport(e, kind, componentStack);
  const key = `${r.name}|${r.message}`;
  if (sent.has(key) || count >= MAX_PER_VISIT) return recent.find((x) => `${x.name}|${x.message}` === key)?.ref ?? null;
  sent.add(key); count++;
  recent.unshift(r); recent.length = Math.min(recent.length, 5);
  if (config.useMock) { console.error(`[geohub] ${r.ref}`, e); return r.ref; }
  if (r.offline) keepForLater(r);
  else void send(r).then((ok) => { if (!ok) keepForLater(r); });
  return r.ref;
}

/** Text for "Copy details": what support needs, nothing private. */
export function detailsText(ref: string | null, e: unknown): string {
  const r = recent.find((x) => x.ref === ref);
  const err = e instanceof Error ? e : null;
  return [`Reference: ${ref ?? "none"}`, `Page: ${safeUrl()}`, `When: ${new Date().toISOString()}`,
    `Error: ${err ? `${err.name}: ${err.message}` : String(e)}`, `Browser: ${navigator.userAgent}`,
    r?.release ? `Version: ${r.release}` : ""].filter(Boolean).join("\n");
}

const RELOADED_KEY = "geohub.chunk-reload";
/** After an update, an old page asking for a code file that no longer exists reloads once to get the new version. */
export function reloadForUpdate(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_KEY) || 0);
    if (Date.now() - last < 60000) return false;                  // already tried just now: show the error instead
    sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
  } catch { return false; }
  location.reload();
  return true;
}

let installed = false;
/** Catch errors nothing else caught, anywhere in the app. */
export function installErrorHandlers() {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (ev) => {
    if (!ev.error && !ev.message) return;                          // a failed <img> or <script> load: not ours to report
    if (isChunkError(ev.error ?? ev.message)) { if (!reloadForUpdate()) reportError(ev.error ?? ev.message, "chunk"); return; }
    reportError(ev.error ?? new Error(ev.message), "error");
  });
  window.addEventListener("unhandledrejection", (ev) => {
    if (isChunkError(ev.reason)) { if (!reloadForUpdate()) reportError(ev.reason, "chunk"); return; }
    reportError(ev.reason, "unhandledrejection");
  });
  window.addEventListener("online", () => { void flushPending(); });
  void flushPending();
}
