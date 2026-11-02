// Capturing a location: the GPS is warmed up first, jumps are ignored, walking restarts it, and poor readings get tips.
import "fake-indexeddb/auto";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "localStorage", "HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// A phone GPS the test drives by hand.
const watches = new Map<number, (p: any) => void>();
let next = 1;
const geolocation = {
  watchPosition: (ok: (p: any) => void) => { const id = next++; watches.set(id, ok); return id; },
  clearWatch: (id: number) => { watches.delete(id); },
  getCurrentPosition: () => undefined,
};
Object.defineProperty(globalThis, "navigator", { value: { onLine: true, userAgent: "node", geolocation, permissions: { query: async () => ({ state: "granted", addEventListener() {}, removeEventListener() {} }) } }, configurable: true });
const at = (dx: number, dy: number, acc: number, speed: number | null = 0) => ({ coords: { longitude: 4.55 + dx / 110000, latitude: 7.79 + dy / 110000, accuracy: acc, altitude: null, altitudeAccuracy: null, speed } });
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { ToastProvider, ConfirmProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { default: CollectPage } = await import("../../src/pages/CollectPage");
  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  const send = async (p: any) => { await act(async () => { for (const cb of [...watches.values()]) cb(p); }); };
  const text = () => document.body.textContent ?? "";

  render(<MemoryRouter initialEntries={["/collect/p1"]}><AuthProvider><ToastProvider><ConfirmProvider>
    <Routes><Route path="/collect/:projectId" element={<CollectPage />} /></Routes>
  </ConfirmProvider></ToastProvider></AuthProvider></MemoryRouter>);
  const start = await screen.findByRole("button", { name: /^New/ }, { timeout: 5000 });
  await act(async () => { fireEvent.click(start); });
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  ok(watches.size === 1 && /Finding GPS/.test(text()), "before capturing, the GPS is already warming up (location was allowed before)");
  await send(at(0, 0, 6));
  ok(/GPS ready ±6 m/.test(text()), "and it shows how good a reading would be right now");

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Capture at my location" })); });
  ok(watches.size === 1, "capturing takes over from the warm-up instead of running two");
  for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0]]) await send(at(dx, dy, 7));
  ok(/averaging \(5 readings\)/.test(text()) && !!screen.getByRole("button", { name: "Use this location" }), "the warm reading counts at once; while averaging it counts readings and offers to stop early");
  await send(at(40, 0, 7));
  ok(/averaging \(5 readings\)/.test(text()), "a reading that jumps 40 m away is left out");
  await send(at(150, 0, 6, 1.8));
  ok(/You moved/.test(text()), "walking away restarts the reading and says why");
  for (const [dx, dy] of [[150, 1], [151, 0], [150, -1], [149, 0]]) await send(at(dx, dy, 4));
  ok(watches.size === 0 && /GPS ±4 m/.test(text()) && !/averaging/.test(text()), "it stops by itself once five readings agree within ±5 m");
  ok(!/may be off/.test(text()), "a good reading shows no warning");

  // a poor reading, stopped early by the person: tips and a way to measure again
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ })); });
  await act(async () => { fireEvent.click(await screen.findByRole("button", { name: /^New/ })); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Capture at my location" })); });
  for (const [dx, dy] of [[0, 0], [3, 2], [-2, 3]]) await send(at(dx, dy, 35));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Use this location" })); });
  ok(watches.size === 0 && /GPS ±35 m/.test(text()), "Use this location stops at once and keeps the reading");
  ok(/may be off/.test(text()) && /Google Location Accuracy/.test(text()), "a poor reading explains how to get a better one");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Measure again" })); });
  await send(at(0, 0, 9));
  ok(watches.size === 1 && /averaging/.test(text()) && !/1 readings/.test(text()) && !/may be off/.test(text()), "Measure again starts a fresh reading");
  setTimeout(() => process.exit(process.exitCode ?? 0), 20);   // the screen's 45-second cap is still waiting
})();
