// The project map: filter by review status and date, and points are clustered.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { ToastProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { probe } = await import("./FakeMapView");
  const { default: EditorPage } = await import("../../src/pages/EditorPage");
  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  await api.createFeature({ id: "mf-1", project_id: "p1", form_id: "f1", form_version: 1, geometry: { type: "Point", coordinates: [4.55, 7.77] }, properties: { name: "New one", type: "Clinic" } });
  const all = (await api.listFeatures("p1")).length;
  // make every seeded record look 40 days old, so "Last 7 days" keeps only the new one
  for (const f of api.s.features) if (f.id !== "mf-1") f.updated_at = old;   // the demo server's records, in memory

  render(<MemoryRouter initialEntries={["/collect/p1/review"]}><AuthProvider><ToastProvider>
    <Routes><Route path="/collect/:projectId/review" element={<EditorPage />} /></Routes>
  </ToastProvider></AuthProvider></MemoryRouter>);
  await screen.findByRole("group", { name: "Show on the map" }, { timeout: 4000 });
  const pts = () => (probe.props.features as any[]).length;
  const count = () => document.querySelector(".map-filters-count")?.textContent;
  ok(probe.props.cluster === true, "the project map clusters points");
  ok(count() === `${all} records` && pts() > 0, "everything shows to begin with, with the total");
  await act(async () => { fireEvent.change(screen.getByLabelText("Review status"), { target: { value: "submitted" } }); });
  ok(count() === `1 of ${all} records` && pts() === 1, "Waiting for review leaves only the record nobody has checked");
  await act(async () => { fireEvent.change(screen.getByLabelText("Review status"), { target: { value: "all" } }); });
  await act(async () => { fireEvent.change(screen.getByLabelText("Changed"), { target: { value: "7" } }); });
  ok(count() === `1 of ${all} records`, "Last 7 days leaves only what changed this week");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Clear" })); });
  ok(count() === `${all} records` && !screen.queryByRole("button", { name: "Clear" }), "Clear shows everything again");
})();
