// The home page: visitors get the introduction, people who are signed in get their own work.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "File", "Blob", "FileReader", "DragEvent"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  await import("fake-indexeddb/auto");
  const { render, screen, cleanup } = await import("@testing-library/react");
  const { MemoryRouter } = await import("react-router-dom");
  const { ToastProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { default: App } = await import("../../src/App");
  const api: any = await loadApi();
  const mount = () => render(<MemoryRouter initialEntries={["/"]}><AuthProvider><ToastProvider><App /></ToastProvider></AuthProvider></MemoryRouter>);
  const text = () => document.body.textContent ?? "";

  // Signed out
  await api.logout().catch(() => undefined);
  mount();
  await screen.findByText(/Geospatial data, from/, {}, { timeout: 5000 });
  ok(!text().includes("Needs your attention"), "a visitor sees the introduction, not a personal home");
  cleanup();

  // Signed in, with two records waiting
  await api.login("demo@geohub.test", "demo");
  for (const i of [0, 1])
    await api.createFeature({ id: `home-${i}`, project_id: "p1", form_id: "f1", form_version: 1, geometry: { type: "Point", coordinates: [4.55, 7.77] }, properties: { name: `Waiting ${i}`, type: "Clinic" } });
  mount();
  await screen.findByText("Needs your attention", {}, { timeout: 5000 });
  ok(/Good (morning|afternoon|evening), Demo/.test(text()), "it greets the person by first name");
  ok(text().includes("2 records waiting for review") && screen.getByRole("link", { name: "Review" }).getAttribute("href") === "/collect/p1/data?review=1", "records waiting for review are listed, with a link straight into review");
  const recent = screen.getAllByRole("link").filter((a) => a.classList.contains("recent-title")).map((a) => a.textContent);
  ok(recent.includes("Osogbo building mapathon") && recent.includes("Osogbo health facilities survey"), "recent work mixes maps and projects");
  ok(screen.getByRole("link", { name: "New project" }).getAttribute("href") === "/collect?new=1", "New project opens the create panel directly");
  ok(screen.getByRole("link", { name: /About Geohub/ }).getAttribute("href") === "/about", "the introduction is still reachable");
  const { waitFor } = await import("@testing-library/react");
  await waitFor(() => { if (!document.querySelector(".thumb-footprint .fp-area") || document.querySelectorAll(".thumb-footprint .fp-point").length < 14) throw new Error("not drawn yet"); }, { timeout: 5000 }).catch(() => undefined);
  ok(document.querySelectorAll(".thumb-footprint .fp-point").length >= 14 && document.querySelectorAll(".thumb-footprint .fp-area").length > 0, "cards draw the real records (points) and map features (areas), not a placeholder");
  cleanup();
})();
