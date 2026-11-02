// Google / Microsoft sign-in buttons and return page, joining by company email domain, and the domains card.
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
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi, tokens } = await import("../../src/lib/api");
  const { default: LoginPage } = await import("../../src/pages/LoginPage");
  const { SsoReturnPage, JoinOrgPage } = await import("../../src/pages/SsoPages");
  const { default: OrgSettingsPage } = await import("../../src/pages/OrgSettingsPage");
  const api: any = await loadApi();
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 400)); });
  const text = () => document.body.textContent ?? "";
  const Where = () => <p data-testid="where">{useLocation().pathname}</p>;
  const app = (at: string) => render(<MemoryRouter initialEntries={[at]}><AuthProvider><ToastProvider><ConfirmProvider><Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/sso" element={<SsoReturnPage />} />
    <Route path="/join-organization" element={<JoinOrgPage />} />
    <Route path="/settings/organization" element={<OrgSettingsPage />} />
    <Route path="*" element={<Where />} />
  </Routes></ConfirmProvider></ToastProvider></AuthProvider></MemoryRouter>);

  // sign-in buttons, and the trip back
  app("/login");
  const google = await screen.findByRole("button", { name: "Continue with Google" }, { timeout: 3000 });
  ok(!!screen.getByRole("button", { name: "Continue with Microsoft" }) && /or with email/.test(text()), "Google and Microsoft buttons sit above the email form");
  await act(async () => { fireEvent.click(google); });
  await settle(); await settle();
  ok(screen.getByTestId("where").textContent === "/" && !!tokens.get(), "after Google, the person is signed in and lands where they were going");
  cleanup(); tokens.clear();

  app("/login?sso_error=Google%20did%20not%20confirm%20your%20email%20address");
  ok(/did not confirm your email/.test((await screen.findByRole("alert")).textContent ?? ""), "a failed sign-in comes back to the sign-in page with the reason");
  cleanup();

  app("/sso?code=expired");
  ok(/expired/.test((await screen.findByRole("alert", {}, { timeout: 3000 })).textContent ?? "") && !!screen.getByRole("link", { name: "Back to sign in" }), "a spent or expired code says so");
  cleanup();

  // the join link
  app("/join-organization?token=nope");
  ok(/not valid/.test((await screen.findByRole("alert", {}, { timeout: 3000 })).textContent ?? ""), "a bad join link is refused");
  cleanup();

  // the domains card
  await api.login("demo@geohub.test", "demo");
  app("/settings/organization");
  await screen.findByRole("heading", { name: "Company email domains" }, { timeout: 4000 });
  const card = () => within(screen.getByRole("heading", { name: "Company email domains" }).closest("section") as HTMLElement);
  fireEvent.change(card().getByLabelText("Domain"), { target: { value: "gmail.com" } });
  await act(async () => { fireEvent.click(card().getByRole("button", { name: "Add domain" })); });
  await settle();
  ok(/public email service/.test(card().getByRole("alert").textContent ?? ""), "a public email service cannot be a company domain");
  fireEvent.change(card().getByLabelText("Domain"), { target: { value: "https://www.OsogboSurvey.com/" } });
  await act(async () => { fireEvent.click(card().getByRole("button", { name: "Add domain" })); });
  await settle();
  ok(!!card().getByText("osogbosurvey.com") && !!card().getByText("Not verified") && /geohub-verification=/.test(text()), "a domain is added unverified, with the DNS record to add");
  await act(async () => { fireEvent.click(card().getByRole("button", { name: "Check now" })); });
  await settle(); await settle();
  ok(/was not found on osogbosurvey.com yet/.test(card().getByRole("alert").textContent ?? ""), "checking before the record exists says what to do");

  fireEvent.change(card().getByLabelText("Domain"), { target: { value: "osogbo.test" } });
  await act(async () => { fireEvent.click(card().getByRole("button", { name: "Add domain" })); });
  await settle();
  const item = () => within(card().getByText("osogbo.test").closest("li") as HTMLElement);
  await act(async () => { fireEvent.click(item().getByRole("button", { name: "Check now" })); });
  await settle(); await settle();
  ok(!!item().getByText("Verified") && (item().getByRole("checkbox", { name: /join automatically/ }) as HTMLInputElement).checked, "once the record is found the domain is verified and joining is on");
  await act(async () => { fireEvent.change(item().getByRole("combobox"), { target: { value: "collector" } }); });
  await settle();
  ok(api.s.orgDomains.find((d: any) => d.domain === "osogbo.test").role === "collector", "admins choose the role people join with");
  await act(async () => { fireEvent.click(item().getByRole("checkbox", { name: /join automatically/ })); });
  await settle();
  ok(api.s.orgDomains.find((d: any) => d.domain === "osogbo.test").auto_join === false, "and can turn joining off");
  await act(async () => { fireEvent.click(card().getByRole("button", { name: "Remove osogbosurvey.com" })); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remove domain" })); });
  await settle();
  ok(!api.s.orgDomains.some((d: any) => d.domain === "osogbosurvey.com"), "a domain can be removed");
  process.exit();
})();
