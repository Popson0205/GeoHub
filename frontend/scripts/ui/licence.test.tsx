// What people see when their organization's licence needs attention (grace, read-only, suspended, a demo ending),
// and support visits: staff opening a customer's projects, and the customer seeing it.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act, within, cleanup } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes, useLocation } = await import("react-router-dom");
  const { ToastProvider, ConfirmProvider } = await import("../../src/components/ui");
  const { AuthProvider, RequireAuth } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { default: LicenceBanner, licenceNotice } = await import("../../src/components/LicenceBanner");
  const { default: AdminCustomerPage } = await import("../../src/pages/AdminCustomerPage");
  const { default: OrgSettingsPage } = await import("../../src/pages/OrgSettingsPage");
  const api: any = await loadApi();
  const text = () => document.body.textContent ?? "";
  const until = async (cond: () => boolean, ms = 5000) => { for (let t = 0; t < ms && !cond(); t += 100) await act(async () => { await new Promise((r) => setTimeout(r, 100)); }); };
  const click = async (el: HTMLElement) => { await act(async () => { fireEvent.click(el); }); };
  const iso = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  // what each state says, and to whom
  const grace = { status: "grace", ends: iso(-3), grace_ends: iso(11), kind: "paid" } as const;
  ok(/full use until/.test(licenceNotice(grace, true)?.text ?? "") && licenceNotice(grace, false) === null, "the grace period is for administrators to act on");
  const expired = { status: "expired", ends: iso(-20), grace_ends: iso(-6), kind: "paid" } as const;
  ok(licenceNotice(expired, false)?.tone === "bad" && /Read-only/.test(licenceNotice(expired, false)!.text) && /administrator can renew/.test(licenceNotice(expired, false)!.text),
    "read-only is told to everyone");
  ok(/demo ends/.test(licenceNotice({ status: "demo", ends: iso(5), grace_ends: iso(19), kind: "demo" }, true)?.text ?? "")
    && licenceNotice({ status: "demo", ends: iso(25), grace_ends: iso(39), kind: "demo" }, true) === null, "a demo's last week is announced");
  ok(licenceNotice({ status: "active", ends: iso(200), grace_ends: null, kind: "paid" }, true) === null && licenceNotice(null, true) === null, "nothing to say, nothing shown");

  await api.login("demo@geohub.test", "demo");
  const Where = () => <p data-testid="where">{useLocation().pathname}</p>;
  const app = (at: string) => render(<MemoryRouter initialEntries={[at]}><AuthProvider><ToastProvider><ConfirmProvider>
    <LicenceBanner />
    <Routes>
      <Route path="/admin/customers/:orgId" element={<AdminCustomerPage />} />
      <Route path="/settings/organization" element={<RequireAuth><OrgSettingsPage /></RequireAuth>} />
      <Route path="*" element={<RequireAuth><Where /></RequireAuth>} />
    </Routes>
  </ConfirmProvider></ToastProvider></AuthProvider></MemoryRouter>);

  // the organization's own state
  api.s.org = { ...api.s.org, subscription_ends: iso(-20) };
  api.save?.();
  app("/maps");
  await until(() => /Read-only/.test(text()));
  ok(/Read-only: the subscription ended/.test(screen.getByRole("alert").textContent ?? "") && !!screen.getByTestId("where"), "an expired organization shows a read-only banner, and still opens");
  cleanup();
  api.s.org = { ...api.s.org, subscription_ends: iso(300), suspended: true };
  app("/maps");
  await until(() => /is suspended/.test(text()));
  ok(!screen.queryByTestId("where") && !!screen.getByRole("button", { name: "Sign out" }), "a suspended organization sees only why, and can sign out");
  cleanup();
  api.s.org = { ...api.s.org, suspended: false };

  // the customer sees support visits
  app("/settings/organization");
  await until(() => !!screen.queryByRole("heading", { name: "Support visits" }));
  const sv = within(screen.getByRole("heading", { name: "Support visits" }).closest("section")!);
  await until(() => /Osogbo map/.test(sv.queryByRole("list")?.textContent ?? ""));
  ok(/Funke Ola/.test(text()) && /why the Osogbo map showed no records/.test(text()), "administrators see when support opened their projects, and why");
  cleanup();

  // staff open a customer's projects
  app("/admin/customers/org-a");
  await until(() => !!screen.queryByLabelText(/^Reason/));
  fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: "Ada asked why the Ikeja map is empty" } });
  fireEvent.change(screen.getByLabelText("For"), { target: { value: "1" } });
  await click(screen.getByRole("button", { name: "Open their projects" }));
  await until(() => /Open until/.test(text()));
  const links = within(document.querySelector(".customer-projects") as HTMLElement).getAllByRole("link");
  ok(links.length > 0 && links[0].getAttribute("href")!.startsWith("/collect/") && /Its owners and admins were told/.test(text()),
    "a support visit opens the customer's projects, with links to them");
  ok(/Ada asked why the Ikeja map is empty/.test(screen.getByRole("list", { name: "Support visits" }).textContent ?? ""), "and is listed with its reason");
  await click(screen.getByRole("button", { name: "End the visit" }));
  await until(() => !!screen.queryByRole("button", { name: "Open their projects" }));
  ok(api.s.supportVisits.every((v: any) => v.ended_at), "the visit can be ended");
  ok(/opened a support visit/.test(screen.getByRole("heading", { name: "Recent activity" }).closest("section")!.textContent ?? ""), "and is in the activity log");
  process.exit(process.exitCode ?? 0);
})();
