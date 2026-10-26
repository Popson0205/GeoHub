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


// Sharing, as a person would do it: an administrator makes a public link, a stranger opens it, the administrator switches it off.
await (async () => {
  const React = (await import("react")).default;
  const { render, screen, fireEvent, act, cleanup } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { ToastProvider, ConfirmProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { normalizeConfig } = await import("../../src/lib/dashboard");
  const { default: DashboardPage } = await import("../../src/pages/DashboardPage");
  const { default: PublicDashboardPage } = await import("../../src/pages/PublicDashboardPage");

  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  const wait = (ms = 250) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
  const click = async (el: Element) => { await act(async () => { fireEvent.click(el); }); await wait(80); };
  const text = () => document.body.textContent ?? "";
  const open = (path: string) => render(
    <MemoryRouter initialEntries={[path]}><AuthProvider><ToastProvider><ConfirmProvider>
      <Routes><Route path="/dashboards/:dashboardId" element={<DashboardPage />} /><Route path="/d/:token" element={<PublicDashboardPage />} /></Routes>
    </ConfirmProvider></ToastProvider></AuthProvider></MemoryRouter>);

  // records: one approved, one still waiting for review that must never be public
  const pt = { type: "Point", coordinates: [4.5, 7.7] };
  const mk = (id: string, props: Record<string, unknown>) => api.createFeature({ id, project_id: "p1", form_id: "f1", form_version: 1, geometry: pt, properties: props });
  await mk("share-a", { name: "ApprovedClinicName", type: "Clinic", beds: 4 });
  await mk("share-b", { name: "SECRET HOSPITAL NAME", type: "Hospital", beds: 90 });
  await api.reviewFeature("share-a", "approved");
  const d = await api.createDashboard("p1", "Shared demo", normalizeConfig({ pages: [{ id: "pg", title: "Overview", form_id: "f1", widgets: [{ id: "w1", type: "bar", field: "type" }] }] }));

  // ---- the administrator shares it ----
  open(`/dashboards/${d.id}`);
  await screen.findByRole("button", { name: /^Share/ }, { timeout: 5000 });
  await click(screen.getByRole("button", { name: /^Share/ }));
  await screen.findByText("Private.", {}, { timeout: 3000 });
  ok(text().includes("Only people on this project"), "a new dashboard is private, and the Sharing tab says so");
  await click(screen.getByRole("button", { name: "Create public link" }));
  const link = (await screen.findByLabelText("Public link", {}, { timeout: 3000 })) as HTMLInputElement;
  const token = link.value.split("/d/")[1];
  ok(link.value.startsWith("http://localhost/d/") && token.length >= 32, "turning sharing on shows a long, unguessable link");
  ok(text().includes("Only records that have been") && text().includes("Never photos"), "the tab spells out what the link will and will not show");
  ok((await api.listDashboards("p1")).find((x: any) => x.id === d.id)?.shared === true, "the gallery will show it as public");
  cleanup();

  // ---- a stranger opens the link: signed out, no toolbar ----
  await api.logout();
  open(`/d/${token}`);
  await screen.findByText(/Shared from/, {}, { timeout: 5000 });
  await wait(300);
  ok(text().includes("Shared demo") && text().includes("Osogbo health facilities survey"), "the link opens the dashboard without signing in");
  ok(!text().includes("Add element") && !text().includes("Data sources") && document.querySelector(".dashboard-sidebar") === null, "a visitor gets no builder toolbar");
  ok(document.querySelector(".dashboard-header-back") === null && screen.queryByRole("button", { name: /^Share/ }) === null, "no way back into the project, and no Share button");
  await api.login("demo@geohub.test", "demo");
  const all = (await api.listFeatures("p1")).filter((f: any) => f.form_id === "f1");
  const approved = all.filter((f: any) => f.status === "approved").length;
  await api.logout();
  ok(all.length === approved + 1 && text().includes(`${approved} records`), `the visitor sees the ${approved} approved records, not the ${all.length} that exist`);
  ok(!text().includes("ApprovedClinicName") && !text().includes("SECRET HOSPITAL NAME"), "names are not on the page: the dashboard does not use that field");
  const pub = JSON.stringify(await api.getPublicDashboard(token));
  ok(!pub.includes("SECRET HOSPITAL NAME") && !pub.includes("ApprovedClinicName") && !pub.includes("beds"), "nothing unused or unapproved is even sent to the browser");
  cleanup();

  // ---- the administrator turns it off ----
  await api.login("demo@geohub.test", "demo");
  await api.setDashboardSharing(d.id, { public: false });
  await api.logout();
  open(`/d/${token}`);
  await screen.findByText("This link doesn't work", {}, { timeout: 5000 });
  ok(text().includes("turned sharing off"), "after sharing is turned off the old link says so");
  let gone = false; try { await api.getPublicDashboard(token); } catch (e: any) { gone = e.status === 404; }
  ok(gone, "and the server refuses it");
  cleanup();
  await api.login("demo@geohub.test", "demo");
  const again = (await api.setDashboardSharing(d.id, { public: true })).share_token;
  ok(again !== token, "sharing again makes a new link; the old one never comes back");
})().catch((e) => { console.log("FAIL crashed: " + (e?.stack ?? e)); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode ?? 0), 100));
