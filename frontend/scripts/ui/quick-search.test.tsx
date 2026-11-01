// Ctrl K opens a search over maps, projects, forms, dashboards, datasets and pages; Enter opens the result.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act, waitFor } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { default: QuickSearch, score } = await import("../../src/components/QuickSearch");
  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");

  ok(score("health", "Health facility") > score("health", "Public health map"), "a match at the start ranks above one in the middle");
  ok(score("hlth fac", "Health facility") > 0 && score("xyz", "Health facility") === 0, "letters typed in order still match; others do not");

  let path = "";
  function Where() { path = useLocation().pathname; return null; }
  render(<MemoryRouter initialEntries={["/hub"]}><AuthProvider>
    <QuickSearch /><Routes><Route path="*" element={<Where />} /></Routes>
  </AuthProvider></MemoryRouter>);

  await act(async () => { fireEvent.keyDown(window, { key: "k", ctrlKey: true }); });
  const box = await screen.findByRole("combobox", { name: "Search" });
  ok(!!screen.getByRole("dialog", { name: "Search Geohub" }), "Ctrl K opens the search");
  const form = api.s.forms.find((f: any) => f.project_id === "p1");
  await waitFor(() => { if (!screen.queryAllByRole("option").some((o) => /Project/.test(o.textContent ?? ""))) throw new Error("loading"); }, { timeout: 4000 }).catch(() => undefined);
  await act(async () => { fireEvent.change(box, { target: { value: form.name.slice(0, 6) } }); });
  const opts = await screen.findAllByRole("option");
  ok(opts.some((o) => o.textContent?.includes(form.name) && /Form/.test(o.textContent ?? "")), `typing finds the form “${form.name}”`);
  const idx = opts.findIndex((o) => o.textContent?.includes(form.name) && /Form/.test(o.textContent ?? ""));
  for (let i = 0; i < idx; i++) await act(async () => { fireEvent.keyDown(box, { key: "ArrowDown" }); });
  ok(opts[idx]!.getAttribute("aria-selected") === "true" && box.getAttribute("aria-activedescendant") === opts[idx]!.id, "arrow keys move the highlight, and screen readers are told which");
  await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
  ok(path === `/collect/p1/forms/${form.id}` && !screen.queryByRole("dialog"), "Enter opens it and closes the search");

  await act(async () => { fireEvent.keyDown(document.body, { key: "/" }); });
  const box2 = await screen.findByRole("combobox", { name: "Search" });
  await act(async () => { fireEvent.change(box2, { target: { value: "zzzqqq" } }); });
  ok(/Nothing called “zzzqqq”/.test(document.body.textContent ?? ""), "no match says so");
  await act(async () => { fireEvent.keyDown(box2, { key: "Escape" }); });
  ok(!screen.queryByRole("dialog"), "Escape closes it");
})();
