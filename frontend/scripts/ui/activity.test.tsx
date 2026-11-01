// A project's activity: who did what, grouped into runs, filterable, and closed to non-managers.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act, within } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { ToastProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { default: ActivityPage, group } = await import("../../src/pages/ActivityPage");
  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");

  const t = (m: number) => new Date(Date.UTC(2026, 9, 10, 9, m)).toISOString();
  const ev = (id: number, m: number, actor: string, action = "feature.create") => ({ id, at: t(m), actor_id: actor, actor_name: actor, action, target_type: "feature", target_id: `r${id}`, target_name: "Wells", details: {} });
  const g = group([ev(5, 40, "a"), ev(4, 30, "a"), ev(3, 20, "a"), ev(2, 15, "b"), ev(1, 0, "a", "form.publish")]);
  ok(g.length === 3 && g[0]!.events.length === 3, "the same person adding records close together is one line; someone else breaks the run");

  const rec = api.s.features.find((f: any) => f.project_id === "p1" && f.status === "approved");
  await api.reviewFeature(rec.id, "rejected", "Photo is blurry");

  render(<MemoryRouter initialEntries={["/collect/p1/activity"]}><AuthProvider><ToastProvider>
    <Routes><Route path="/collect/:projectId/activity" element={<ActivityPage />} /></Routes>
  </ToastProvider></AuthProvider></MemoryRouter>);
  const today = await screen.findByRole("region", { name: "Today" }, { timeout: 4000 });
  const first = within(today).getAllByRole("listitem")[0]!;
  ok(/Demo User|returned a .*record for changes/.test(first.textContent ?? "") && /returned/.test(first.textContent ?? ""), `the newest entry says who returned which record (${first.textContent})`);
  ok(first.textContent?.includes("“Photo is blurry”") ?? false, "the reviewer's note shows under it");
  ok(screen.getAllByRole("region").length > 1, "older activity is split into days");
  ok(/added \d+ .*records/.test(document.body.textContent ?? ""), "runs of added records read as one line with a count");

  const more = screen.getAllByRole("button", { name: /Show each of the/ })[0]!;
  await act(async () => { fireEvent.click(more); });
  ok(more.getAttribute("aria-expanded") === "true", "a run can be opened to see each one");

  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "People" })); });
  await screen.findAllByText(/as a collector/, {}, { timeout: 4000 });
  const items = [...document.querySelectorAll(".activity-item")];
  ok(items.length > 0 && items.every((li) => li.classList.contains("kind-member")), "the People filter shows only changes to who is on the project");

  // a collector sees an explanation, not the log
  api.s.projects.find((p: any) => p.id === "p1").role = "collector";
  document.body.innerHTML = "<div id=root></div>";
  render(<MemoryRouter initialEntries={["/collect/p1/activity"]}><AuthProvider><ToastProvider>
    <Routes><Route path="/collect/:projectId/activity" element={<ActivityPage />} /></Routes>
  </ToastProvider></AuthProvider></MemoryRouter>);
  ok(!!(await screen.findByText(/Only owners and administrators/, {}, { timeout: 4000 })), "collectors are told the history is for owners and administrators");
})();
