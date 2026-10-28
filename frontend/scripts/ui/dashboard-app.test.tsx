import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).confirm = () => true; (dom.window as any).confirm = () => true;
(dom.window as any).matchMedia = (dom.window as any).matchMedia ?? (() => ({ matches: true, addListener() {}, removeListener() {} }));
(dom.window as any).print = () => {};
for (const U of [dom.window.URL, globalThis.URL] as any[]) { U.createObjectURL = () => "blob:test"; U.revokeObjectURL = () => {}; }
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

// The whole Dashboard app, driven like a person would: gallery -> new dashboard -> build it -> save -> report.
await (async () => {
  const React = (await import("react")).default;
  const { render, screen, fireEvent, act, within } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes, Navigate } = await import("react-router-dom");
  const { ToastProvider, ConfirmProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { default: DashboardApp } = await import("../../src/pages/DashboardApp");
  const { default: DashboardPage } = await import("../../src/pages/DashboardPage");
  const { default: DashboardReports } = await import("../../src/pages/DashboardReports");

  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  const wait = (ms = 250) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  const click = async (el: Element) => { await act(async () => { fireEvent.click(el); }); await wait(60); };
  const btn = (name: RegExp | string) => screen.getByRole("button", { name });
  const text = () => document.body.textContent ?? "";

  render(
    <MemoryRouter initialEntries={["/dashboards?project=p1"]}><AuthProvider><ToastProvider><ConfirmProvider>
      <Routes>
        <Route path="/dashboards" element={<DashboardApp />} />
        <Route path="/dashboards/reports" element={<DashboardReports />} />
        <Route path="/dashboards/:dashboardId" element={<DashboardPage />} />
        <Route path="*" element={<Navigate to="/dashboards" />} />
      </Routes>
    </ConfirmProvider></ToastProvider></AuthProvider></MemoryRouter>);
  await screen.findByText("My Dashboards", {}, { timeout: 4000 });
  await wait(500);

  // ---- the gallery ----
  ok(text().includes("Geohub Dashboard") && text().includes("Reports") && text().includes("My Dashboards"), "the app has its own bar with Dashboards and Reports");
  const before = (await api.listDashboards("p1")).length;
  await click(btn("+ New dashboard"));
  await screen.findByText(/Visualize, monitor/, {}, { timeout: 5000 }).catch(() => undefined);

  // ---- the builder opens full screen, empty ----
  ok(text().includes("Visualize, monitor, and share information"), "a new dashboard opens in the builder, empty, with your welcome screen");
  ok((await api.listDashboards("p1")).length === before + 1, "creating it saved an Untitled dashboard on the server");
  ok((btn(/^Save/) as HTMLButtonElement).disabled, "nothing to save yet, so Save is off");

  // add a gauge
  await click(btn("Add element"));
  ok(text().includes("Embedded content") && text().includes("Rich text") && text().includes("Indicator"), "Add element lists the elements");
  await click(screen.getByRole("menuitem", { name: /Gauge/ }));
  ok(text().includes("Target (full dial)") && text().includes("Set the target the gauge measures against."), "adding a gauge selects it and asks for a target");
  ok(btn(/^Save\*/) !== null && text().includes("Discard"), "the toolbar now shows Save* and Discard");
  const target = document.querySelector("#wtg") as HTMLInputElement;
  await act(async () => { fireEvent.change(target, { target: { value: "100" } }); });
  ok(document.querySelector(".gauge") !== null, "once the target is set the gauge draws");

  // add a note and write in it
  await click(screen.getByRole("menuitem", { name: /Rich text/ }));
  await act(async () => { fireEvent.change(document.querySelector("#wc")!, { target: { value: "Hello **world**" } }); });
  ok(document.querySelector(".rich-text strong")?.textContent === "world", "a note renders bold text");

  // move the note to the side column through View > Sidebar
  await click(btn("View"));
  await click(screen.getByRole("tab", { name: "Sidebar" }));
  const moveSide = screen.getAllByRole("button", { name: "Move to side" });
  await click(moveSide[moveSide.length - 1]);
  ok(document.querySelector(".dash-side-col .rich-text") !== null, "the note moved into the side column");
  ok(document.querySelector(".dash-grid .rich-text") === null, "and left the grid");

  // header rename
  await click(screen.getByRole("tab", { name: "Header" }));
  await act(async () => { fireEvent.change(document.querySelector("#vhn")!, { target: { value: "Water overview" } }); });
  ok(document.querySelector(".dashboard-canvas-header h1")?.textContent === "Water overview", "renaming in View > Header changes the title at once");

  // theme
  await click(btn("Theme"));
  await click(screen.getByRole("button", { name: /Dark/ }));
  ok((document.querySelector(".dashboard-canvas-outer") as HTMLElement).style.getPropertyValue("--dash-bg") === "#12161c", "choosing Dark themes the canvas");
  ok(!(document.querySelector(".dashboard-sidebar") as HTMLElement).getAttribute("style"), "and only the canvas, not the tools");

  // time and region
  await click(btn("Time and region"));
  await click(screen.getByRole("button", { name: "Last 30 days" }));
  ok(document.querySelector(".chip-x.is-static")?.textContent === "Last 30 days", "the date range shows on the canvas");

  // save
  await click(btn(/^Save\*/));
  await wait(500);
  const saved = (await api.listDashboards("p1")).find((d: any) => d.name === "Water overview");
  ok(!!saved, "Save kept the new name");
  const w = saved?.config.pages[0].widgets ?? [];
  ok(w.some((x: any) => x.type === "gauge" && x.target === 100) && w.some((x: any) => x.type === "rich_text" && x.region === "sidebar"), "the gauge target and the side-column note were saved");
  ok(saved?.config.theme?.preset === "dark" && saved?.config.time_filter?.preset === "last_30_days", "the theme and date range were saved");
  ok(!text().includes("Save*"), "after saving there is nothing left to save");

  // ---- reports ----
  await click(screen.getByRole("link", { name: "Back to dashboards" }));
  await screen.findByText("Water overview", {}, { timeout: 5000 }).catch(() => undefined);
  ok(text().includes("Water overview") && text().includes("2 elements"), "the gallery shows the dashboard with its element count");
  await click(screen.getByRole("link", { name: "Reports" }));
  await click(await screen.findByRole("button", { name: "Make report" }, { timeout: 5000 }));
  await screen.findByRole("article", { name: "Report" }, { timeout: 5000 }).catch(() => undefined);
  ok(document.querySelector(".report-doc") !== null && text().includes("Water overview") && text().includes("Hello"), "Make report produces a printable report of the dashboard");
  ok(text().includes("Print / Save as PDF"), "and offers Print / Save as PDF");
})().catch((e) => { console.log("FAIL crashed: " + (e?.stack ?? e)); process.exitCode = 1; setTimeout(() => process.exit(1), 50); }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 100));
