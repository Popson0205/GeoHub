// A raster dataset's page: the raster drawn as tiles with its colour ramp, what it holds, and a GeoTIFF download.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const clicked: string[] = [];
(dom.window as any).HTMLAnchorElement.prototype.click = function () { clicked.push(`${this.download}|${this.href}`); };
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act, waitFor } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { ToastProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { probe } = await import("./FakeMapView");
  const { default: DatasetPage } = await import("../../src/pages/DatasetPage");
  const api: any = await loadApi();
  const tiles = "https://hub.example/api/tiles/datasets/minna-elevation/2/{z}/{x}/{y}.png?sig=abc";
  const exports: string[] = [];
  api.getDataset = async () => ({
    slug: "minna-elevation", project_id: "", title: "Minna elevation", description: "10 m DEM from PolyGIS.", license: "CC BY 4.0", tags: ["dem"],
    kind: "raster", bbox: [6.553, 9.567, 6.555, 9.569], feature_count: 0, latest_version: 2, updated_at: "2026-11-14T10:00:00Z", formats: ["tif"],
    visibility: "organization", source: { app: "gis", name: "PolyGIS", ref: "l1", label: "Bosso Estate › minna_dem", kind: "raster" }, tiles_url: tiles,
    raster: { bands: [{ name: "Elevation (m)", min: 250, max: 516, mean: 383, nodata: -9999 }], width: 2400, height: 1800, crs: "EPSG:32632", resolution: 10,
              data_type: "Float32", size: 2_600_000, render: { kind: "single", band: 1, colormap: "spectral_r", rescale: [260, 500] } },
  });
  api.datasetFeatures = async () => { throw new Error("a raster's page does not read features"); };
  api.createExport = async (_slug: string, format: string) => { exports.push(format); return { id: "j1", kind: "export", status: "done", progress: 100, download_url: "https://s3.example/v2.tif" }; };

  render(<MemoryRouter initialEntries={["/hub/minna-elevation"]}><AuthProvider><ToastProvider>
    <Routes><Route path="/hub/:slug" element={<DatasetPage />} /></Routes>
  </ToastProvider></AuthProvider></MemoryRouter>);
  await screen.findByRole("heading", { name: "Minna elevation" }, { timeout: 4000 });

  const p = probe.props;
  ok(p.imagery?.length === 1 && p.imagery[0].url === tiles && p.features.length === 0, "the raster is drawn as tiles, with no outline over it");
  ok(JSON.stringify(p.flyTo?.bounds) === JSON.stringify([6.553, 9.567, 6.555, 9.569]), "the map goes to the raster's bounds");
  const legend = screen.getByRole("img", { name: "Colours from 260 to 500" });
  ok(!!legend && legend.textContent!.includes("Elevation (m)"), "a legend shows the ramp's range and the band");
  const ramp = legend.querySelector(".raster-ramp") as HTMLElement;
  ok(ramp.style.background.includes("rgb(94, 79, 162)") || ramp.style.background.includes("#5e4fa2"), "a reversed ramp (spectral_r) starts from its last colour");
  const about = screen.getByRole("region", { name: "Details" }).textContent ?? "";
  ok(about.includes("2,400 × 1,800 cells of 10 m") && about.includes("250 to 516") && about.includes("GeoTIFF, 2.6 MB") && about.includes("EPSG:32632"),
    `what the raster holds is listed (${about})`);
  ok(!about.includes("Features"), "a raster has no feature count");
  const buttons = screen.getByRole("region", { name: "Download" }).querySelectorAll("button");
  ok(buttons.length === 1 && buttons[0].textContent === "GeoTIFF", "it downloads as a GeoTIFF, and only that");
  ok(!!screen.getByText(/Map tiles \(XYZ, PNG\).*works for an hour/), "apps are told the tiles link is for a raster layer, and that a private one's lasts an hour");
  await act(async () => { fireEvent.click(buttons[0]); });
  await waitFor(() => { if (!clicked.length) throw new Error("not yet"); }, { timeout: 4000 }).catch(() => undefined);
  ok(exports.join() === "tif" && clicked[0] === "minna-elevation.tif|https://s3.example/v2.tif", `the GeoTIFF downloads (${clicked.join()})`);

  // a raster of classes (land cover): a legend of its classes, each with its colour
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  const base = await api.getDataset();
  api.getDataset = async () => ({ ...base, slug: "land-cover", title: "Land cover", raster: { ...base.raster, render: { kind: "classes", band: 1, classes: [
    { value: 10, color: "#006400", label: "Tree cover" }, { value: 20, color: "#ffbb22", label: "Shrubland" }, { value: 40, color: "#f096ff", label: "Cropland" },
    { value: 50, color: "#fa0000", label: "Built-up" }] } } });
  render(<MemoryRouter initialEntries={["/hub/land-cover"]}><AuthProvider><ToastProvider>
    <Routes><Route path="/hub/:slug" element={<DatasetPage />} /></Routes>
  </ToastProvider></AuthProvider></MemoryRouter>);
  await screen.findByRole("heading", { name: "Land cover" }, { timeout: 4000 });
  const items = screen.getByRole("list", { name: "Classes" }).querySelectorAll("li");
  ok(items.length === 4 && items[0].textContent === "Tree cover" && (items[0].querySelector(".raster-swatch") as HTMLElement).style.background.includes("rgb(0, 100, 0)"),
    "a land cover legend lists its classes in their colours");
  ok((screen.getByRole("region", { name: "Details" }).textContent ?? "").includes("Classes4 (Tree cover, Shrubland, Cropland…)"), "the details say how many classes");
})();
