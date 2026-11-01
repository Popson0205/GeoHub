// The Collected data table with many records: pages, search, sorting and choosing columns.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "File", "Blob", "FileReader", "DragEvent"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act, cleanup, within } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { ToastProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { default: DataPage } = await import("../../src/pages/DataPage");

  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  for (let i = 0; i < 60; i++)
    await api.createFeature({ id: `tb-${i}`, project_id: "p1", form_id: "f1", form_version: 1, geometry: { type: "Point", coordinates: [4.5 + i / 1000, 7.7] }, properties: { name: `Bulk ${String(i).padStart(2, "0")}`, type: i % 2 ? "Clinic" : "Pharmacy", beds: i } });
  for (const id of (await api.listFeatures("p1")).filter((f: any) => f.id.startsWith("tb-")).map((f: any) => f.id)) await api.reviewFeature(id, "approved");
  const total = (await api.listFeatures("p1")).filter((f: any) => f.form_id === "f1").length;

  const click = async (el: Element) => { await act(async () => { fireEvent.click(el); }); };
  const mount = () => render(
    <MemoryRouter initialEntries={["/collect/p1/data"]}><AuthProvider><ToastProvider>
      <Routes><Route path="/collect/:projectId/data" element={<DataPage />} /></Routes>
    </ToastProvider></AuthProvider></MemoryRouter>);
  const rows = () => [...document.querySelectorAll("tbody tr")];
  const col = (n: number) => rows().map((r) => r.querySelectorAll("td")[n]?.textContent ?? "");
  const pager = () => screen.getByRole("navigation", { name: "Pages of records" });

  mount();
  await screen.findByRole("button", { name: "Import CSV" }, { timeout: 4000 });
  ok(rows().length === 50 && pager().textContent!.includes(`1–50 of ${total}`), "a long list shows 50 rows at a time and says how many there are");
  await click(within(pager()).getByRole("button", { name: "Next" }));
  ok(rows().length === total - 50 && pager().textContent!.includes(`51–${total} of ${total}`), "Next shows the rest");

  // Ticking "all" picks only what is on screen
  await click(screen.getByRole("checkbox", { name: "Select all shown" }));
  ok(/^\d+ selected/.test(screen.getByRole("toolbar", { name: "Selected records" }).textContent ?? "") && screen.getByRole("toolbar", { name: "Selected records" }).textContent!.startsWith(`${total - 50} selected`), "select all picks the rows on this page, not every record");
  await click(within(screen.getByRole("toolbar", { name: "Selected records" })).getByRole("button", { name: "Clear" }));

  // Search
  fireEvent.change(screen.getByRole("searchbox", { name: "Search records" }), { target: { value: "bulk 4" } });
  await act(async () => {});
  ok(rows().length === 10 && /10 of \d+ match/.test(document.body.textContent ?? ""), "search finds matching records across the columns and says how many");
  ok(!screen.queryByRole("navigation", { name: "Pages of records" }), "and the pager goes away when everything fits");
  fireEvent.change(screen.getByRole("searchbox", { name: "Search records" }), { target: { value: "zzz" } });
  await act(async () => {});
  ok(/No records match “zzz”/.test(document.body.textContent ?? ""), "no match says so, with a way to clear the search");
  await click(screen.getByRole("button", { name: "Clear search" }));

  // Sort by number of beds: ascending, descending, then back to the original order
  const beds = () => screen.getByRole("button", { name: /^Number of beds/ });
  await click(beds());
  const bedsCol = [...document.querySelectorAll("thead th")].findIndex((th) => th.textContent?.startsWith("Number of beds"));
  const asc = col(bedsCol).filter(Boolean).map(Number);
  ok(asc.length > 0 && asc.every((v, i) => i === 0 || asc[i - 1] <= v) && beds().closest("th")!.getAttribute("aria-sort") === "ascending", "clicking a header sorts by it, smallest first, and says so");
  await click(beds());
  const descAll = col(bedsCol), desc = descAll.filter(Boolean).map(Number);
  ok(descAll[0] === "59" && desc[0] === 59 && desc.every((v, i) => i === 0 || desc[i - 1] >= v) && beds().closest("th")!.getAttribute("aria-sort") === "descending", "clicking again sorts largest first");
  await click(within(pager()).getByRole("button", { name: "Next" }));
  const tail = col(bedsCol), firstEmpty = tail.indexOf("");
  ok(firstEmpty > 0 && tail.slice(firstEmpty).every((v) => v === ""), "records without a value go last");
  await click(within(pager()).getByRole("button", { name: "First page" }));
  await click(beds());
  ok(beds().closest("th")!.getAttribute("aria-sort") === null, "a third click goes back to the original order");

  // Columns
  await click(screen.getByRole("button", { name: /^Columns/ }));
  await click(within(screen.getByRole("group", { name: "Columns to show" })).getByRole("checkbox", { name: "Condition" }));
  ok(![...document.querySelectorAll("thead th")].some((th) => th.textContent?.startsWith("Condition")), "a column can be hidden");
  ok(/Columns \(\d+ of \d+\)/.test(screen.getByRole("button", { name: /^Columns/ }).textContent ?? ""), "the Columns button says some are hidden");
  cleanup();
  mount();
  await screen.findByRole("button", { name: "Import CSV" }, { timeout: 4000 });
  ok(![...document.querySelectorAll("thead th")].some((th) => th.textContent?.startsWith("Condition")), "the choice is remembered next time");
})();
