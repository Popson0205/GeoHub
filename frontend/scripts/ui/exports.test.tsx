// Collected data downloads as KML (made in the demo too) and asks the server for Shapefile and GeoPackage.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "File", "Blob", "FileReader", "DragEvent"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let kml = "";
for (const U of [dom.window.URL, globalThis.URL] as any[]) { U.createObjectURL = (b: Blob) => { void b.text().then((t) => { kml = t; }); return "blob:kml-1"; }; U.revokeObjectURL = () => undefined; }
const clicked: string[] = [];
(dom.window as any).HTMLAnchorElement.prototype.click = function () { clicked.push(`${this.download}|${this.href}`); };
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act, waitFor } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { ToastProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { toKml } = await import("../../src/lib/kml");
  const { default: DataPage } = await import("../../src/pages/DataPage");
  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");

  const k = toKml("T & Co", [{ id: "a", status: "approved", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: { name: "<Mine>", tags: ["x", "y"] } } as any], "name");
  ok(k.includes("<name>T &amp; Co</name>") && k.includes("<name>&lt;Mine&gt;</name>") && k.includes("<value>x; y</value>") && k.includes("<outerBoundaryIs>"), "KML escapes text, joins lists and writes polygons");

  render(<MemoryRouter initialEntries={["/collect/p1/data"]}><AuthProvider><ToastProvider>
    <Routes><Route path="/collect/:projectId/data" element={<DataPage />} /></Routes>
  </ToastProvider></AuthProvider></MemoryRouter>);
  const open = async () => { const b = await screen.findByRole("button", { name: /^Download/ }, { timeout: 4000 }); await act(async () => { fireEvent.click(b); }); };
  await open();
  ok(!!screen.getByRole("menuitem", { name: /Shapefile/ }) && !!screen.getByRole("menuitem", { name: /GeoPackage/ }), "the Download menu offers Shapefile and GeoPackage");
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: /KML for Google Earth/ })); });
  await waitFor(() => { if (!clicked.length) throw new Error("not yet"); }, { timeout: 8000 }).catch(() => undefined);
  ok(clicked.some((c) => c.endsWith(".kml|blob:kml-1")), `KML downloads once ready (${clicked.join(", ")})`);
  const n = api.s.features.filter((f: any) => f.project_id === "p1" && f.form_id === api.s.forms.find((x: any) => x.project_id === "p1" && x.version > 0)?.id && !f.deleted).length;
  ok((kml.match(/<Placemark>/g) ?? []).length === n && n > 0, `the KML has one placemark per record (${n})`);

  await open();
  await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: /Shapefile/ })); });
  const msg = await screen.findByText(/made by the Geohub server/, {}, { timeout: 8000 }).catch(() => null);
  ok(!!msg, "in the demo, Shapefile says plainly that the server makes it");
})();
