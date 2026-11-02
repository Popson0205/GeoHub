// The organization page: add people (email link or temporary password), counted by kind; roles; plan and renewal.
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
for (const k of ["window", "document", "navigator", "localStorage", "HTMLElement", "Node", "KeyboardEvent", "Event", "MouseEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
  try { Object.defineProperty(globalThis, k, { value: (dom.window as any)[k], configurable: true, writable: true }); } catch { /* read-only */ }
(dom.window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };

(async () => {
  const { render, screen, fireEvent, act, within, cleanup } = await import("@testing-library/react");
  const { MemoryRouter, Route, Routes } = await import("react-router-dom");
  const { ToastProvider, ConfirmProvider } = await import("../../src/components/ui");
  const { AuthProvider } = await import("../../src/lib/auth");
  const { loadApi } = await import("../../src/lib/api");
  const { default: OrgSettingsPage } = await import("../../src/pages/OrgSettingsPage");
  const api: any = await loadApi();
  await api.login("demo@geohub.test", "demo");
  const mount = () => render(<MemoryRouter initialEntries={["/settings/organization"]}><AuthProvider><ToastProvider><ConfirmProvider>
    <Routes><Route path="/settings/organization" element={<OrgSettingsPage />} /><Route path="/" element={<p>home</p>} /></Routes>
  </ConfirmProvider></ToastProvider></AuthProvider></MemoryRouter>);
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 400)); });
  const text = () => document.body.textContent ?? "";

  mount();
  await screen.findByRole("heading", { name: "Osogbo Field Team", level: 1 }, { timeout: 4000 });
  const people = within(screen.getByRole("table"));
  ok(people.getAllByRole("row").length === 6 && !!people.getByText(/\(you\)/), "everyone in the organization is listed, with you marked");
  ok(/Organization Standard/.test(text()) && /Subscription runs until/.test(text()), "the plan and when the subscription runs until are shown");
  const seats = screen.getByRole("meter", { name: "Team seats used" });
  ok(seats.getAttribute("aria-valuemax") === "10" && !!screen.getByRole("meter", { name: "Field collectors used" }) && !!screen.getByRole("meter", { name: "Viewers used" }), "people are counted by kind against the plan: team seats, field collectors, viewers");

  // add a field collector, with an emailed link
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Bola Ade" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "Bola@Example.com" } });
  ok(/49 left/.test(screen.getByRole("radio", { name: /Field collector/ }).closest("label")?.textContent ?? ""), "each role says how many places of its kind are left");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add person" })); });
  await settle();
  ok(/bola@example.com has been emailed a link to set their password/.test(text()), "an emailed link is the default way in");
  ok(api.s.orgMembers.some((m: any) => m.email === "bola@example.com" && m.role === "collector"), "the account is made at once, as a field collector");

  // a viewer, with a temporary password shown once
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Desk Officer" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "desk@example.com" } });
  await act(async () => { fireEvent.click(screen.getByRole("radio", { name: /Viewer/ })); fireEvent.click(screen.getByRole("radio", { name: /Give them a temporary password/ })); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Add person" })); });
  await settle();
  ok(/Kp7d-Qm3x-Ta9e/.test(text()) && /will not be shown again/.test(text()), "a temporary password is shown once, to hand over");

  // send a fresh sign-in link
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send a sign-in link to Musa Bello" })); });
  await settle();
  ok(/new sign-in link was emailed to musa@example.com/.test(text()), "an admin can send someone a fresh sign-in link");

  // change a role
  await act(async () => { fireEvent.change(screen.getByLabelText("Role of Musa Bello"), { target: { value: "admin" } }); });
  await settle();
  ok(api.s.orgMembers.find((m: any) => m.email === "musa@example.com").role === "admin", "an owner can change someone's role");

  // a full kind cannot be chosen
  cleanup();
  api.s.org.limits = { viewers: 2 };
  mount();
  await screen.findByRole("heading", { name: "Osogbo Field Team", level: 1 }, { timeout: 4000 });
  const viewerOpt = screen.getByRole("radio", { name: /Viewer/ }) as HTMLInputElement;
  ok(viewerOpt.disabled && /none left/.test(viewerOpt.closest("label")?.textContent ?? ""), "a kind with no places left cannot be picked");

  // remove, after confirming
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remove Tolu Adeyemi" })); });
  const dlg = await screen.findByRole("alertdialog").catch(() => screen.findByRole("dialog"));
  ok(/their place is freed/.test(dlg.textContent ?? ""), "removing someone says what they lose and that their place is freed");
  await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: "Remove from organization" })); });
  await settle();
  ok(!api.s.orgMembers.some((m: any) => m.email === "tolu@example.com"), "and removes them once confirmed");

  // the email check reports each step
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send me a test email" })); });
  await settle(); await settle();
  ok(/Email is not working yet/.test(text()) && /BREVO_API_KEY/.test(text()), "Send me a test email shows each step and what to fix");

  // a member sees the organization but cannot manage it
  cleanup();
  api.s.orgMembers.find((m: any) => m.email === "demo@geohub.test").role = "member";
  mount();
  await screen.findByRole("heading", { name: "Osogbo Field Team", level: 1 }, { timeout: 4000 });
  ok(!screen.queryByRole("button", { name: "Add person" }) && !screen.queryByRole("button", { name: /^Remove/ }) && !screen.queryByLabelText("Organization name"), "members see the people and plan but cannot add, remove or rename");
  ok(/You are a member/.test(text()), "and are told their role");
})();
