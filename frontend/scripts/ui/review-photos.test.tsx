// Review mode shows a record's photos, with a larger view; Escape closes the photo, not the review.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "File", "Blob", "FileReader", "DragEvent"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
for (const U of [dom.window.URL, globalThis.URL] as any[]) { U.createObjectURL = () => "blob:photo-1"; U.revokeObjectURL = () => undefined; }
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { ToastProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { default: DataPage } = await import("../../src/pages/DataPage");
  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  const media = "0b3b1f0e-6a52-4a5c-9e51-2d8d3c1f9a01", waiting = "2c1d0e9f-1111-4a5c-9e51-2d8d3c1f9a02";
  await api.createFeature({ id: "ph-1", project_id: "p1", form_id: "f1", form_version: 1, geometry: { type: "Point", coordinates: [4.55, 7.77] }, properties: { name: "With Photo", type: "Clinic", photos: [media, waiting] } });
  await api.uploadMedia("p1", "ph-1", media, new Blob(["jpeg"], { type: "image/jpeg" }), "photos");

  render(<MemoryRouter initialEntries={["/collect/p1/data?review=1"]}><AuthProvider><ToastProvider>
    <Routes><Route path="/collect/:projectId/data" element={<DataPage />} /></Routes>
  </ToastProvider></AuthProvider></MemoryRouter>);
  await screen.findByRole("region", { name: "Review records" }, { timeout: 4000 });
  const thumb = await screen.findByRole("button", { name: /View Photos 1 of 1 larger/ }, { timeout: 3000 });
  ok(thumb.querySelector("img")?.getAttribute("src") === "blob:photo-1", "the uploaded photo shows as a thumbnail next to its question");
  ok(/2 photos, not uploaded yet|With Photo/.test(document.body.textContent ?? ""), "the record is the one with the photo");

  await act(async () => { fireEvent.click(thumb); });
  ok(!!screen.getByRole("dialog", { name: "Photo" }) && !!screen.getByRole("link", { name: "Open full size" }), "clicking it opens a larger view with a link to the full size");
  await act(async () => { fireEvent.keyDown(document.body, { key: "Escape" }); });
  ok(!screen.queryByRole("dialog", { name: "Photo" }) && !!screen.queryByRole("region", { name: "Review records" }), "Escape closes the photo but stays in review");
  await act(async () => { fireEvent.keyDown(document.body, { key: "a" }); await new Promise((r) => setTimeout(r, 300)); });
  ok((await api.listFeatures("p1")).find((f: any) => f.id === "ph-1")?.status === "approved", "the keyboard works again for deciding");
})();
