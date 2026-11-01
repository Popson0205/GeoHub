// A page that fails to draw shows a recovery screen with a reference; errors are reported once, without private bits.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/f/SECRET-TOKEN?x=1", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "sessionStorage", "location", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const posted: any[] = [];
(globalThis as any).fetch = async (url: string, init: any) => { posted.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }); return { ok: true, status: 202 }; };
let copied = "";
Object.defineProperty(dom.window.navigator, "clipboard", { value: { writeText: async (t: string) => { copied = t; } } });
const quiet = console.error; console.error = () => undefined;     // React logs caught render errors

(async () => {
  const { render, screen, fireEvent, act } = await import("@testing-library/react");
  const { config } = await import("../../src/lib/config");
  const { ApiError } = await import("../../src/lib/api");
  const { reportError, safeUrl, isChunkError, makeRef } = await import("../../src/lib/errorReport");
  const { default: ErrorBoundary } = await import("../../src/components/ErrorBoundary");
  (config as any).useMock = false; (config as any).apiUrl = "https://api.example";

  ok(safeUrl() === "http://localhost/f/:token", "share tokens and the query string never leave the browser");
  ok(/^GH-[2-9A-HJ-NP-Z]{5}$/.test(makeRef()), "references are short and avoid look-alike letters");
  ok(isChunkError(new TypeError("Failed to fetch dynamically imported module: /assets/Data-abc.js")) && !isChunkError(new Error("x")), "a missing code file after an update is recognised");
  ok(reportError(new ApiError(404, "Not found")) === null, "API errors the page already shows are not reported");

  function Boom({ when }: { when: boolean }): JSX.Element { if (when) throw new TypeError("cannot read properties of undefined (reading 'map')"); return <p>Fine</p>; }
  const { rerender } = render(<ErrorBoundary resetKey="/a"><Boom when /></ErrorBoundary>);
  const alert = screen.getByRole("alert");
  ok(/Something went wrong on this page/.test(alert.textContent ?? "") && /saved work is safe/.test(alert.textContent ?? ""), "a crash shows a calm explanation instead of a blank page");
  const ref = alert.querySelector(".mono")?.textContent ?? "";
  ok(/^GH-/.test(ref), `it shows a reference to quote (${ref})`);
  await new Promise((r) => setTimeout(r, 20));
  ok(posted.length === 1 && posted[0].url === "https://api.example/client-errors" && posted[0].body.ref === ref && posted[0].body.kind === "render"
    && posted[0].body.url === "http://localhost/f/:token" && !!posted[0].body.component_stack, "the server gets the error, its reference, and where it happened");
  ok(!!screen.getByRole("button", { name: "Reload the page" }) && !!screen.getByRole("link", { name: "Go to the start" }), "it offers a reload and a way out");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy details" })); });
  ok(copied.includes(ref) && copied.includes("cannot read properties") && !copied.includes("SECRET"), "Copy details gives support what they need, without the share token");

  rerender(<ErrorBoundary resetKey="/a"><Boom when /></ErrorBoundary>);
  reportError(new TypeError("cannot read properties of undefined (reading 'map')"));
  ok(posted.length === 1, "the same error is sent once per visit");
  rerender(<ErrorBoundary resetKey="/b"><Boom when={false} /></ErrorBoundary>);
  ok(!!screen.getByText("Fine") && !screen.queryByRole("alert"), "going to another page clears it");

  Object.defineProperty(dom.window.navigator, "onLine", { value: false, configurable: true });
  reportError(new Error("while offline"));
  ok(posted.length === 1 && (localStorage.getItem("geohub.errors.pending") ?? "").includes("while offline"), "offline reports wait on the device");
  console.error = quiet;
})();
