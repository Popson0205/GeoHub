import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).confirm = () => true; (dom.window as any).confirm = () => true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act, cleanup } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { ToastProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { probe } = await import("./FakeMapView");
  const { default: Editor } = await import("../../src/pages/MapEditorPage");
  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  const wait = (ms = 300) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  const p = () => probe.props;
  const click = async (name: RegExp | string, i = 0) => { await act(async () => { fireEvent.click(screen.getAllByRole("button", { name })[i]); }); };
  const open = async (id: string) => { render(<MemoryRouter initialEntries={[`/maps/${id}`]}><AuthProvider><ToastProvider><Routes><Route path="/maps/:mapId" element={<Editor />} /></Routes></ToastProvider></AuthProvider></MemoryRouter>); await screen.findByText(/saved feature/); await wait(); };
  const poly = (x: number) => ({ type: "Polygon", coordinates: [[[x, 7], [x + 0.01, 7], [x + 0.01, 7.01], [x, 7.01], [x, 7]]] });

  const maps = await api.listMaps();
  const mid = maps.find((m: any) => m.name.includes("mapathon")).id;

  // ---- owner: stage several, save once; owner's own work is approved straight away ----
  const before = (await api.listMapFeatures(mid)).length;
  await open(mid);
  ok(p().features.some((f: any) => f.state === "review") && p().features.some((f: any) => f.state === "rejected"), "features waiting for review (purple) and rejected (red) are coloured apart");
  await click(/^Area$/);
  for (let i = 0; i < 2; i++) await act(async () => { p().onDraw(poly(4 + i * 0.1)); });
  ok(p().drawMode === "Polygon", "owner: draw tool stays on");
  await click(/^Save all/, 0); await wait(600);
  const after = await api.listMapFeatures(mid);
  ok(after.length === before + 2 && after.slice(-2).every((f: any) => f.status === "approved" && f.author === "Demo Collector"), "owner: two features saved at once, approved and attributed");
  ok(!!screen.queryByText(/Campaign portal/), "the editor links to the campaign portal");
  cleanup();

  // ---- make the demo user a contributor on this map (someone else owns it) ----
  const s = api.s;
  s.maps.find((m: any) => m.id === mid).owner_id = "u9"; s.maps.find((m: any) => m.id === mid).owner_name = "Tolu Adeleke";
  s.mapMembers.push({ map_id: mid, user_id: "u1", name: "Demo Collector", role: "contributor", joined_at: new Date().toISOString() });
  const others = (await api.listMapFeatures(mid)).find((f: any) => f.created_by === "u2" && f.status === "approved");
  const mine = (await api.listMapFeatures(mid)).find((f: any) => f.created_by === "u1");
  await open(mid);
  ok(!!screen.queryByText(/you are a contributor/), "contributor: the editor says what the person is");
  await act(async () => { p().onSelect(others.id, false); });
  ok(!!screen.queryByText(/approved this, so it is locked/) && !!screen.queryByText(/Drawn by Amina Bello/), "contributor: someone else's approved feature is shown as locked, with its author");
  const geomBefore = JSON.stringify(p().features.find((f: any) => f.id === others.id).geometry);
  await click(/^Move$/);
  await act(async () => { p().onMove([others.id], 0.5, 0.5); });
  ok(JSON.stringify(p().features.find((f: any) => f.id === others.id).geometry) === geomBefore && !screen.queryByText(/Unsaved changes/)?.textContent?.includes("1 edited"), "contributor: moving someone else's feature does nothing");
  ok((screen.getAllByRole("button", { name: /^Delete$/ }).every((b) => (b as HTMLButtonElement).disabled)), "contributor: Delete is disabled for it");
  await click(/^Select$/);
  await click(/^Area$/);
  await act(async () => { p().onDraw(poly(5)); });
  await click(/^Save all/, 0); await wait(600);
  const mine2 = (await api.listMapFeatures(mid)).filter((f: any) => f.created_by === "u1" && f.status === "submitted");
  ok(mine2.length >= 1, "contributor: a new feature is saved as waiting for review");
  void mine;
  cleanup();

  // ---- campaign over: contributors cannot draw ----
  s.maps.find((m: any) => m.id === mid).ends_at = new Date(Date.now() - 864e5).toISOString();
  await open(mid);
  await click(/^Area$/);
  ok(p().drawMode == null && !!screen.queryByText(/Contributors cannot draw right now/), "contributor: after the campaign ends the draw tools stay off and the page says why");
  process.exit(process.exitCode ?? 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
