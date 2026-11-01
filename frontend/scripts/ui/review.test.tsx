// Review mode in Collected data: records waiting for a decision, one at a time, with keyboard shortcuts.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "File", "Blob", "FileReader", "DragEvent"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
for (const U of [dom.window.URL, globalThis.URL] as any[]) { U.createObjectURL = () => "blob:test"; U.revokeObjectURL = () => undefined; }
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act, cleanup, waitFor } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { ToastProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { default: DataPage } = await import("../../src/pages/DataPage");

  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  const names = ["Iwo Road Clinic", "Ataoja Hospital", "Oke Fia Pharmacy"];
  for (const [i, name] of names.entries())
    await api.createFeature({ id: `rv-${i}`, project_id: "p1", form_id: "f1", form_version: 1, geometry: { type: "Point", coordinates: [4.55 + i / 100, 7.77] }, properties: { name, type: "Clinic", beds: 4 + i } });
  const status = async (id: string) => (await api.listFeatures("p1")).find((f: any) => f.id === id)?.status;
  ok((await api.getProject("p1")).waiting_count === 3, "the project counts the three records waiting for review");

  const key = async (k: string) => {
    await act(async () => { fireEvent.keyDown(document.body, { key: k }); });
    await waitFor(() => { if (document.querySelector(".review [aria-busy='true']")) throw new Error("still saving"); }, { timeout: 3000 });
  };
  const text = () => document.body.textContent ?? "";
  const mount = (url: string) => render(
    <MemoryRouter initialEntries={[url]}><AuthProvider><ToastProvider>
      <Routes><Route path="/collect/:projectId/data" element={<DataPage />} /></Routes>
    </ToastProvider></AuthProvider></MemoryRouter>);

  mount("/collect/p1/data");
  await screen.findByRole("button", { name: "Import CSV" }, { timeout: 4000 });
  const tab = screen.getByRole("link", { name: /Collected data/ });
  ok(/3 waiting for review/.test(tab.textContent ?? ""), "the Collected data tab shows 3 waiting for review");

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Review 3 waiting" })); });
  ok(!!screen.getByRole("region", { name: "Review records" }) && !document.querySelector("table"), "Review opens one record at a time instead of the table");
  ok(text().includes("Iwo Road Clinic") && text().includes("Number of beds") && /3 of 3 still waiting/.test(text()), "it shows the first record's answers and how many are left");
  ok(/Photos.*None/.test(text()) && text().includes("Not answered"), "unanswered questions and missing photos are marked, not left blank");
  ok(screen.getByRole("button", { name: /^Approve/ }).getAttribute("aria-keyshortcuts") === "A", "Approve says its shortcut to assistive tech, without the key in its name");

  await key("a");
  ok((await status("rv-0")) === "approved", "pressing A approves the record on the server");
  ok(text().includes("Ataoja Hospital") && /2 of 3 still waiting/.test(text()), "and the next waiting record opens");

  fireEvent.change(screen.getByPlaceholderText("Note to the collector (optional)"), { target: { value: "Wrong place" } });
  await key("r");
  const rejected = (await api.listFeatures("p1")).find((f: any) => f.id === "rv-1");
  ok(rejected?.status === "rejected", "pressing R rejects it");

  await key("k");
  ok(text().includes("Ataoja Hospital") && text().includes("Rejected"), "K goes back to the previous record, now marked Rejected");
  await key("j");
  ok(text().includes("Oke Fia Pharmacy"), "J moves forward");

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Approve/ })); });
  await screen.findByText("Every record has a decision", {}, { timeout: 3000 }).catch(() => null);
  ok(text().includes("Every record has a decision") && /2 approved and 1 rejected/.test(text()), "after the last one it says everything has a decision, with a summary");
  ok(!/waiting for review/.test(screen.getByRole("link", { name: /Collected data/ }).textContent ?? ""), "the tab no longer shows a waiting count");

  await key("Escape");
  ok(!!document.querySelector("table") && !screen.queryByRole("region", { name: "Review records" }), "Escape goes back to the table");
  cleanup();

  // A project card links straight into review with ?review=1
  await api.createFeature({ id: "rv-9", project_id: "p1", form_id: "f1", form_version: 1, geometry: { type: "Point", coordinates: [4.56, 7.78] }, properties: { name: "Late Clinic", type: "Clinic" } });
  mount("/collect/p1/data?review=1");
  await screen.findByRole("region", { name: "Review records" }, { timeout: 4000 });
  ok(text().includes("Late Clinic") && /1 of 1 still waiting/.test(text()), "opening the page with ?review=1 starts reviewing straight away");
})();
