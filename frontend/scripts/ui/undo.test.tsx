// Deleting records in Collected data: they leave the table at once, Undo brings them back,
// and only when the Undo window closes are they deleted on the server.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "File", "Blob", "FileReader", "DragEvent"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act, cleanup } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { ToastProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { default: DataPage } = await import("../../src/pages/DataPage");

  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  const ids = async () => (await api.listFeatures("p1")).filter((f: any) => f.form_id === "f1").map((f: any) => f.id as string);
  const click = async (el: Element) => { await act(async () => { fireEvent.click(el); await new Promise((r) => setTimeout(r, 20)); }); };
  const rows = () => document.querySelectorAll("tbody tr").length;

  render(
    <MemoryRouter initialEntries={["/collect/p1/data"]}><AuthProvider><ToastProvider>
      <Routes><Route path="/collect/:projectId/data" element={<DataPage />} /></Routes>
    </ToastProvider></AuthProvider></MemoryRouter>);
  await screen.findByRole("button", { name: "Import CSV" }, { timeout: 4000 });
  const start = await ids();
  const shown = rows();
  const firstName = document.querySelector("tbody tr td:nth-child(3)")?.textContent;

  // Delete one record from its row menu
  await click(screen.getAllByRole("button", { name: "More for this record" })[0]);
  await click(screen.getByRole("menuitem", { name: "Delete" }));
  ok(rows() === shown - 1, "the record leaves the table straight away, with no confirmation dialog");
  ok(!!screen.queryByRole("button", { name: "Undo" }) && /Record deleted/.test(document.body.textContent ?? ""), "a message says it was deleted and offers Undo");
  ok((await ids()).length === start.length, "nothing is deleted on the server yet");

  await click(screen.getByRole("button", { name: "Undo" }));
  ok(rows() === shown && document.querySelector("tbody tr td:nth-child(3)")?.textContent === firstName, "Undo puts it back, in its old place");
  ok((await ids()).length === start.length && !screen.queryByRole("button", { name: "Undo" }), "and the server still has it");

  // Delete two picked records, then close the message: that confirms the delete
  const boxes = screen.getAllByRole("checkbox", { name: "Select record" });
  await act(async () => { fireEvent.click(boxes[0]); fireEvent.click(boxes[1]); });
  const bar = screen.getByRole("toolbar", { name: "Selected records" });
  await click(bar.querySelector("button:nth-of-type(3)")!);   // Approve, Reject, Delete
  ok(rows() === shown - 2 && /2 records deleted/.test(document.body.textContent ?? ""), "deleting two picked records hides both and says so");
  await click(screen.getByRole("button", { name: /^Dismiss message/ }));
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  ok((await ids()).length === start.length - 2, "closing the message deletes them on the server");

  // Leaving the page while Undo is still offered still deletes (the provider owns the pending delete)
  await click(screen.getAllByRole("button", { name: "More for this record" })[0]);
  await click(screen.getByRole("menuitem", { name: "Delete" }));
  await act(async () => { cleanup(); await new Promise((r) => setTimeout(r, 50)); });
  ok((await ids()).length === start.length - 3, "a delete still waiting for its Undo window is carried out when the page closes");
})();
